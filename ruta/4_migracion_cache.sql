-- ============================================================
-- CaptaNET · Módulo RUTA — caché de respuestas de la FFCV
-- Guarda unos minutos las respuestas que se piden a la FFCV
-- (horarios, jornadas, actas...) para no repetir la misma llamada si
-- varios ojeadores miran el mismo partido o si uno refresca. Reduce
-- la carga sobre la FFCV.
--
-- Solo la Edge Function (service_role) la usa; RLS activada sin
-- políticas = ningún usuario normal la toca.
-- ============================================================

create table if not exists ffcv_cache (
  clave  text primary key,
  valor  jsonb not null,
  expira timestamptz not null
);

create index if not exists idx_ffcv_cache_expira on ffcv_cache(expira);

alter table ffcv_cache enable row level security;
