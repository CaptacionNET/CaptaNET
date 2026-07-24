-- ============================================================
-- CaptaNET · RUTA — catálogo de partidos activos (buscador por campo)
-- Tabla compartida (no por ojeador, no por club): una fila por partido
-- de la jornada actual de cada grupo activo F11/F8, para poder buscar
-- "qué se juega en tal campo" a través de TODAS las categorías/ligas
-- sin tener que preguntarle a la FFCV en el momento de la búsqueda
-- (recorrer los 726 grupos en vivo tarda varios minutos — ver el plan).
-- La rellena solo la Edge Function "ruta-refrescar-activos", lanzada
-- por el cron de ruta/9_migracion_cron_activos.sql.
-- ============================================================

create table if not exists ruta_partidos_activos (
  id uuid primary key default gen_random_uuid(),

  cod_partido text,               -- = codacta de la FFCV (puede no existir si aún no se ha generado)
  cod_equipo_local text,
  cod_equipo_visitante text,
  local text not null,
  visitante text not null,
  escudo_local text,
  escudo_visitante text,

  fecha date,
  hora text,
  campo text,
  campo_normalizado text,         -- campo sin acentos/mayúsculas ni sufijo de subcampo (F-11, Campo A...), para buscar

  resultado text,
  jugado boolean not null default false,

  modalidad text,                 -- "MASCULÍ F11" / "MASCULÍ F8"
  competicion_codigo text,
  competicion_nombre text,
  grupo_codigo text not null,
  grupo_nombre text,
  jornada text,

  actualizado_at timestamptz not null default now()
);

-- Un partido de un grupo no se duplica al refrescar (se actualiza en su sitio).
-- Los partidos sin cod_partido (acta aún no generada) se identifican por
-- grupo+jornada+equipos, que es estable entre refrescos.
create unique index if not exists idx_ruta_activos_unico
  on ruta_partidos_activos (grupo_codigo, jornada, cod_equipo_local, cod_equipo_visitante);

create index if not exists idx_ruta_activos_campo on ruta_partidos_activos using gin (campo_normalizado gin_trgm_ops);
create index if not exists idx_ruta_activos_actualizado on ruta_partidos_activos (actualizado_at);

alter table ruta_partidos_activos enable row level security;

-- Catálogo compartido de solo lectura: cualquier usuario con sesión lo
-- puede consultar (no hay datos privados de ningún club aquí, son
-- horarios públicos de la FFCV). Solo lo escribe la Edge Function con
-- service_role, que se salta RLS.
drop policy if exists ruta_activos_select on ruta_partidos_activos;
create policy ruta_activos_select on ruta_partidos_activos
  for select to authenticated
  using (true);
