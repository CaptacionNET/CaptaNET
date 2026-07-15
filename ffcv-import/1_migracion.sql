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

-- Estadísticas de la temporada importada (partidos, goles, tarjetas, minutos)
alter table jugadores add column if not exists minutos_jugados      int;
alter table jugadores add column if not exists partidos_convocados  int;
alter table jugadores add column if not exists partidos_titular     int;
alter table jugadores add column if not exists partidos_suplente    int;
alter table jugadores add column if not exists partidos_jugados     int;
alter table jugadores add column if not exists goles                int;
alter table jugadores add column if not exists tarjetas_amarillas   int;
alter table jugadores add column if not exists tarjetas_rojas       int;
alter table jugadores add column if not exists tarjetas_doble_amarilla int;
alter table jugadores add column if not exists tarjetas_verde       int;
alter table jugadores add column if not exists es_portero           boolean;

-- Para poder pedir las estadísticas necesitamos saber la temporada FFCV (no la nuestra) de cada equipo
alter table equipos add column if not exists ffcv_cod_temporada text;

-- Un jugador de FFCV no debe duplicarse: índice único por código de licencia
create unique index if not exists jugadores_cod_ffcv_key
  on jugadores (cod_ffcv);

-- Para encajar la jerarquía de FFCV sin duplicar, guardamos su código en cada nivel.
-- temporada = temporada FFCV · categoria = modalidad · liga = competición · grupo = grupo
alter table temporadas add column if not exists cod_ffcv text;
alter table categorias add column if not exists cod_ffcv text;
alter table ligas      add column if not exists cod_ffcv text;
alter table grupos     add column if not exists cod_ffcv text;
alter table equipos    add column if not exists cod_ffcv text;

-- Orden propio de la FFCV para las ligas (así el desplegable del visor las
-- muestra en el mismo orden que en su web, no alfabético).
alter table ligas add column if not exists orden int;

-- Índices únicos NO parciales (los parciales no valen para el upsert onConflict).
-- Postgres permite varios NULL en un índice único, así que las filas manuales
-- (sin cod_ffcv) conviven sin problema.
create unique index if not exists temporadas_cod_ffcv_key on temporadas (cod_ffcv);
create unique index if not exists categorias_cod_ffcv_key on categorias (cod_ffcv);
create unique index if not exists ligas_cod_ffcv_key      on ligas (cod_ffcv);
create unique index if not exists grupos_cod_ffcv_key     on grupos (cod_ffcv);
create unique index if not exists equipos_cod_ffcv_key    on equipos (cod_ffcv);

-- 2) Catálogo de grupos de FFCV (lo rellena el descubridor automático)
create table if not exists ffcv_grupos (
  cod_grupo        text primary key,
  nombre_grupo     text,
  cod_competicion  text,
  nombre_competicion text,
  cod_temporada    text,
  nombre_temporada text,
  fecha_inicio     date,
  fecha_fin        date,
  modalidad        text,
  activo           boolean default true,   -- si la competición está en curso
  ultima_jornada   int,                    -- jornada con partidos (para listar equipos)
  descubierto      timestamptz default now()
);
alter table ffcv_grupos add column if not exists fecha_inicio date;
alter table ffcv_grupos add column if not exists fecha_fin date;
-- La temporada donde de verdad se GUARDAN los datos (la actual por calendario),
-- separada de cod_temporada (la que SÍ tiene ligas/grupos publicados y usamos para
-- descubrir los equipos). Mientras la FFCV no publique las ligas de la temporada
-- nueva, importamos con la estructura de la anterior pero etiquetado como la actual.
alter table ffcv_grupos add column if not exists cod_temporada_destino text;
alter table ffcv_grupos add column if not exists nombre_temporada_destino text;
alter table ffcv_grupos add column if not exists orden_liga int; -- orden de la competición según la FFCV

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

-- 6) Búsqueda de jugadores sin distinguir acentos ("jose" debe encontrar "José").
--    Guardamos una copia del nombre sin acentos y en minúsculas, mantenida al
--    día automáticamente por un trigger (así funciona tanto para los informes
--    creados a mano como para los jugadores que trae el importador de la FFCV).
create or replace function normalizar_texto(txt text) returns text as $$
  select lower(
    translate(
      coalesce(txt, ''),
      'ÁÀÄÂÃáàäâãÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔÕóòöôõÚÙÜÛúùüûÑñÇç',
      'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'
    )
  );
$$ language sql immutable;

alter table jugadores add column if not exists nombre_normalizado text;

create or replace function jugadores_actualizar_nombre_normalizado() returns trigger as $$
begin
  new.nombre_normalizado := normalizar_texto(new.nombre);
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_jugadores_nombre_normalizado on jugadores;
create trigger trg_jugadores_nombre_normalizado
  before insert or update of nombre on jugadores
  for each row execute function jugadores_actualizar_nombre_normalizado();

-- Rellena la columna para los jugadores que ya existían antes de crear el trigger.
update jugadores set nombre_normalizado = normalizar_texto(nombre)
  where nombre_normalizado is distinct from normalizar_texto(nombre);

-- Para que la búsqueda ("%palabra%") no se haga lenta con miles de jugadores.
create extension if not exists pg_trgm;
create index if not exists jugadores_nombre_normalizado_idx
  on jugadores using gin (nombre_normalizado gin_trgm_ops);

-- 7) Buscador de EQUIPOS (nueva sección): mismo tratamiento de acentos que
--    en jugadores, reutilizando la función normalizar_texto ya creada arriba.
alter table equipos add column if not exists nombre_normalizado text;

create or replace function equipos_actualizar_nombre_normalizado() returns trigger as $$
begin
  new.nombre_normalizado := normalizar_texto(new.nombre);
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_equipos_nombre_normalizado on equipos;
create trigger trg_equipos_nombre_normalizado
  before insert or update of nombre on equipos
  for each row execute function equipos_actualizar_nombre_normalizado();

update equipos set nombre_normalizado = normalizar_texto(nombre)
  where nombre_normalizado is distinct from normalizar_texto(nombre);

create index if not exists equipos_nombre_normalizado_idx
  on equipos using gin (nombre_normalizado gin_trgm_ops);

-- 8) Escudo del equipo: la FFCV lo publica en los datos de cada partido, se
-- enlaza directamente a su imagen pública (no hace falta subirla a R2).
-- Se rellena solo. Los equipos ya importados lo recibirán en la próxima
-- pasada del importador (semanal, o al lanzar "Importar FFCV" a mano).
alter table equipos add column if not exists escudo_url text;

-- 9) Nombre de categoría de edad que da la propia FFCV por competición
-- (p.ej. "Querubines", "Alevín 2º. Año"). Es más fiable que adivinar la
-- edad a partir del nombre de la liga: por ejemplo "Escola de Gegants"
-- no menciona ninguna edad en su nombre, pero la FFCV la cataloga como
-- "Querubines". Se usa como pista para agrupar/ordenar; si una liga no
-- la tiene (creada a mano, o pendiente de la próxima importación),
-- se sigue adivinando por el nombre como hasta ahora.
alter table ligas add column if not exists categoria_edad_ffcv text;
