-- ============================================================
-- CaptaNET · Módulo RUTA (ojeadores)
-- Cada usuario es un ojeador con su propia ruta de partidos.
-- Un partido de la ruta puede venir de la FFCV (tiene cod_partido)
-- o ser manual (amistoso / no está en la FFCV).
--
-- Los datos del partido (equipos, fecha, hora, campo...) se guardan
-- como "foto" en el momento de añadirlo, para no depender de volver a
-- pedirlos a la FFCV cada vez que se abre la ruta (y para que los
-- partidos manuales, que no existen en la FFCV, funcionen igual).
-- ============================================================

create table if not exists ruta_partidos (
  id uuid primary key default gen_random_uuid(),
  -- el ojeador dueño de esta ruta (cada usuario ve solo la suya)
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- club del ojeador, solo informativo (para posibles vistas de equipo a futuro)
  club_id uuid references clubs(id) on delete set null,

  -- origen FFCV (null si es un partido manual)
  cod_partido text,               -- = codacta de la FFCV
  es_manual boolean not null default false,

  -- datos del partido (foto al añadirlo)
  cod_equipo_local text,
  cod_equipo_visitante text,
  local text,
  visitante text,
  fecha date,
  hora text,
  campo text,
  competicion text,               -- nombre de la competición (informativo)
  categoria text,                 -- modalidad (MASCULÍ F11...) (informativo)

  -- por qué va el ojeador a este partido
  objetivos text,

  -- titulares marcados a mano y dorsales precargados del último acta:
  -- { "local": [{ "codjugador": "...", "dorsal": "9", "titular": true }], "visitante": [...] }
  alineacion jsonb,

  creado_at timestamptz not null default now()
);

-- Un mismo partido de FFCV no se añade dos veces a la ruta del mismo ojeador.
create unique index if not exists idx_ruta_partido_unico
  on ruta_partidos(user_id, cod_partido) where cod_partido is not null;

create index if not exists idx_ruta_user_fecha on ruta_partidos(user_id, fecha, hora);

alter table ruta_partidos enable row level security;

-- El ojeador solo ve y gestiona su propia ruta.
drop policy if exists ruta_select_propia on ruta_partidos;
create policy ruta_select_propia on ruta_partidos
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists ruta_insert_propia on ruta_partidos;
create policy ruta_insert_propia on ruta_partidos
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists ruta_update_propia on ruta_partidos;
create policy ruta_update_propia on ruta_partidos
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists ruta_delete_propia on ruta_partidos;
create policy ruta_delete_propia on ruta_partidos
  for delete to authenticated
  using (user_id = auth.uid());
