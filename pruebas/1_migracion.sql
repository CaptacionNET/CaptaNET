-- ============================================================
-- CaptaNET · Gestión de Pruebas
-- Tabla de inscripciones a pruebas del club + RPC pública de alta
-- (usada por el formulario público pruebas.html, sin login) + RLS.
-- ============================================================

create table if not exists pruebas_inscripciones (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,

  -- datos rellenados por el jugador/familia en el formulario público
  nombre text not null,
  fecha_nacimiento date not null,
  anio_nacimiento int not null,
  email text,
  telefono text,
  nombre_contacto text,      -- padre/madre/tutor, si aplica
  posicion text,
  club_actual text,
  comentario text,           -- lo que cuenta el propio jugador al inscribirse

  -- gestión de la citación
  estado text not null default 'pendiente',  -- pendiente | citado | valorado | descartado | fichado
  dia_prueba date,
  hora_prueba time,
  lugar_prueba text,
  notificado_at timestamptz,

  -- valoración del día de la prueba (mismos campos que jugadores_club)
  tecnica int,
  tactica int,
  fisico text,
  actitud int,
  valoracion_comentario text,

  creado_at timestamptz not null default now()
);

create index if not exists idx_pruebas_club_anio on pruebas_inscripciones(club_id, anio_nacimiento);

alter table pruebas_inscripciones enable row level security;

drop policy if exists pruebas_select_club on pruebas_inscripciones;
create policy pruebas_select_club on pruebas_inscripciones
  for select to authenticated
  using (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

drop policy if exists pruebas_update_club on pruebas_inscripciones;
create policy pruebas_update_club on pruebas_inscripciones
  for update to authenticated
  using (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

drop policy if exists pruebas_delete_club on pruebas_inscripciones;
create policy pruebas_delete_club on pruebas_inscripciones
  for delete to authenticated
  using (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

-- Sin política de INSERT: el alta pública se hace solo a través de la
-- función pruebas_inscribir (security definer), nunca insertando en la
-- tabla directamente, así el anon no necesita ningún permiso sobre ella.

create or replace function pruebas_inscribir(
  p_slug text,
  p_nombre text,
  p_fecha_nacimiento date,
  p_email text,
  p_telefono text,
  p_nombre_contacto text,
  p_posicion text,
  p_club_actual text,
  p_comentario text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club_id uuid;
  v_id uuid;
begin
  select id into v_club_id from clubs where slug = p_slug;
  if v_club_id is null then
    raise exception 'Club no encontrado';
  end if;
  if p_nombre is null or trim(p_nombre) = '' then
    raise exception 'Falta el nombre';
  end if;
  if p_fecha_nacimiento is null then
    raise exception 'Falta la fecha de nacimiento';
  end if;

  insert into pruebas_inscripciones
    (club_id, nombre, fecha_nacimiento, anio_nacimiento, email, telefono, nombre_contacto, posicion, club_actual, comentario)
  values
    (v_club_id, trim(p_nombre), p_fecha_nacimiento, extract(year from p_fecha_nacimiento)::int,
     nullif(trim(p_email), ''), nullif(trim(p_telefono), ''), nullif(trim(p_nombre_contacto), ''),
     nullif(trim(p_posicion), ''), nullif(trim(p_club_actual), ''), nullif(trim(p_comentario), ''))
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function pruebas_inscribir(text, text, date, text, text, text, text, text, text) to anon;
