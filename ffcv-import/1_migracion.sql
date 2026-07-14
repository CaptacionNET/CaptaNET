-- ============================================================
-- CaptaNET · Importador FFCV — Migración de base de datos
-- Ejecutar UNA vez en Supabase → SQL Editor
-- ============================================================

-- 1) Columnas nuevas en jugadores para los datos de FFCV
--    (no guardamos DNI ni email por decisión de privacidad)
alter table jugadores add column if not exists cod_ffcv       text;      -- código de licencia FFCV (identificador único del jugador)
alter table jugadores add column if not exists fecha_nacimiento date;     -- fecha de nacimiento completa
alter table jugadores add column if not exists posicion       text;      -- posición (Medio centro, etc.)
alter table jugadores add column if not exists dorsal         text;      -- dorsal
alter table jugadores add column if not exists foto_url       text;      -- foto alojada en R2
alter table jugadores add column if not exists historial      jsonb;     -- historial de temporadas (equipo + categoría)
alter table jugadores add column if not exists ffcv_actualizado timestamptz; -- última vez que se refrescó desde FFCV

-- Un jugador de FFCV no debe duplicarse: índice único por código de licencia
create unique index if not exists jugadores_cod_ffcv_key
  on jugadores (cod_ffcv) where cod_ffcv is not null;

-- Para encajar la jerarquía de FFCV sin duplicar, guardamos su código en cada nivel.
-- categoria = modalidad FFCV · liga = competición FFCV · grupo = grupo FFCV
alter table categorias add column if not exists cod_ffcv text;
alter table ligas      add column if not exists cod_ffcv text;
alter table grupos     add column if not exists cod_ffcv text;
alter table equipos    add column if not exists cod_ffcv text;

create unique index if not exists categorias_cod_ffcv_key on categorias (cod_ffcv) where cod_ffcv is not null;
create unique index if not exists ligas_cod_ffcv_key      on ligas (cod_ffcv)      where cod_ffcv is not null;
create unique index if not exists grupos_cod_ffcv_key     on grupos (cod_ffcv)     where cod_ffcv is not null;
create unique index if not exists equipos_cod_ffcv_key    on equipos (cod_ffcv)    where cod_ffcv is not null;

-- 2) Catálogo de grupos de FFCV (lo rellena el descubridor automático)
create table if not exists ffcv_grupos (
  cod_grupo        text primary key,
  nombre_grupo     text,
  cod_competicion  text,
  nombre_competicion text,
  cod_temporada    text,
  nombre_temporada text,
  modalidad        text,
  activo           boolean default true,   -- si la competición está en curso
  ultima_jornada   int,                    -- jornada con partidos (para listar equipos)
  descubierto      timestamptz default now()
);

-- 3) Cola / progreso de importación (permite reanudar entre ejecuciones)
create table if not exists ffcv_cola (
  id            bigint generated always as identity primary key,
  tipo          text not null,             -- 'grupo' | 'equipo'
  referencia    text not null,             -- cod_grupo o cod_equipo
  estado        text not null default 'pendiente', -- pendiente | procesando | hecho | error
  intentos      int default 0,
  error_msg     text,
  creado        timestamptz default now(),
  procesado     timestamptz,
  unique (tipo, referencia)
);

create index if not exists ffcv_cola_pendiente_idx
  on ffcv_cola (estado) where estado = 'pendiente';

-- 4) Registro de cada pasada semanal (para ver el estado desde admin)
create table if not exists ffcv_ejecuciones (
  id            bigint generated always as identity primary key,
  iniciado      timestamptz default now(),
  finalizado    timestamptz,
  grupos_total  int default 0,
  equipos_total int default 0,
  jugadores_nuevos int default 0,
  jugadores_actualizados int default 0,
  estado        text default 'en_curso'   -- en_curso | completado | error
);

-- 5) RLS: estas tablas son solo de gestión interna (admin global).
--    Las funciones usan service_role (se saltan RLS). Bloqueamos el resto.
alter table ffcv_grupos      enable row level security;
alter table ffcv_cola        enable row level security;
alter table ffcv_ejecuciones enable row level security;

-- Solo admin global puede leer el estado desde el panel
drop policy if exists ffcv_grupos_admin_read on ffcv_grupos;
create policy ffcv_grupos_admin_read on ffcv_grupos
  for select using (is_admin());

drop policy if exists ffcv_ejec_admin_read on ffcv_ejecuciones;
create policy ffcv_ejec_admin_read on ffcv_ejecuciones
  for select using (is_admin());

drop policy if exists ffcv_cola_admin_read on ffcv_cola;
create policy ffcv_cola_admin_read on ffcv_cola
  for select using (is_admin());
