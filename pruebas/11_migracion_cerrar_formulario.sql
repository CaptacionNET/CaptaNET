-- ============================================================
-- CaptaNET · Gestión de Pruebas: cerrar el formulario público
-- Permite a cada club apagar su formulario de inscripción a pruebas
-- (interruptor on/off) y/o poner una fecha límite a partir de la cual
-- deja de aceptar inscripciones automáticamente.
-- ============================================================

alter table clubs add column if not exists pruebas_activo boolean not null default true;
alter table clubs add column if not exists pruebas_fecha_limite date;

-- Único sitio donde vive la lógica de "¿está cerrado?", para que la
-- página pública y la inscripción en sí (pruebas_inscribir) usen
-- siempre el mismo criterio y no se puedan desincronizar.
create or replace function club_pruebas_cerrado(p_club_id uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not coalesce(c.pruebas_activo, true)
      or (c.pruebas_fecha_limite is not null and c.pruebas_fecha_limite < current_date)
  from clubs c where c.id = p_club_id;
$$;

-- Estado público del formulario (sin sesión), para que pruebas.html
-- decida si mostrar el formulario o un aviso de que está cerrado.
create or replace function pruebas_estado_publico(p_slug text)
returns table(nombre text, cerrado boolean, fecha_limite date)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club_id uuid;
begin
  select id into v_club_id from clubs where slug = p_slug;
  if v_club_id is null then
    return;
  end if;

  return query
    select c.nombre, club_pruebas_cerrado(c.id), c.pruebas_fecha_limite
    from clubs c where c.id = v_club_id;
end;
$$;

grant execute on function pruebas_estado_publico(text) to anon;

-- Configuración del formulario para el propio club (autenticado).
create or replace function pruebas_config_club()
returns table(activo boolean, fecha_limite date)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id from profiles where id = auth.uid();
  if v_club_id is null then
    return;
  end if;

  return query select c.pruebas_activo, c.pruebas_fecha_limite from clubs c where c.id = v_club_id;
end;
$$;

grant execute on function pruebas_config_club() to authenticated;

create or replace function pruebas_config_actualizar(p_activo boolean, p_fecha_limite date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club_id uuid;
  v_autorizado boolean;
begin
  select club_id, (is_club_admin or is_admin) into v_club_id, v_autorizado
  from profiles where id = auth.uid();

  if v_club_id is null or not coalesce(v_autorizado, false) then
    raise exception 'No autorizado';
  end if;

  update clubs set pruebas_activo = p_activo, pruebas_fecha_limite = p_fecha_limite where id = v_club_id;
end;
$$;

grant execute on function pruebas_config_actualizar(boolean, date) to authenticated;

-- pruebas_inscribir (v5): igual que antes, pero ahora también rechaza
-- la inscripción si el club ha cerrado su formulario (interruptor
-- apagado o fecha límite ya pasada), aunque alguien intente saltarse
-- el aviso de la página y llamar directamente a esta función.
drop function if exists pruebas_inscribir(text, text, date, text, text, text, text, text, text, text);

create or replace function pruebas_inscribir(
  p_slug text,
  p_nombre text,
  p_fecha_nacimiento date,
  p_email text,
  p_telefono text,
  p_nombre_contacto text,
  p_posicion text,
  p_club_actual text,
  p_comentario text,
  p_honeypot text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club_id uuid;
  v_id uuid;
  v_recientes int;
  v_anio int;
begin
  if p_honeypot is not null and trim(p_honeypot) <> '' then
    return null;
  end if;

  select id into v_club_id from clubs where slug = p_slug;
  if v_club_id is null then
    raise exception 'Club no encontrado';
  end if;
  if club_pruebas_cerrado(v_club_id) then
    raise exception 'El formulario de pruebas de este club no está disponible ahora mismo.';
  end if;
  if p_nombre is null or trim(p_nombre) = '' then
    raise exception 'Falta el nombre';
  end if;
  if p_fecha_nacimiento is null then
    raise exception 'Falta la fecha de nacimiento';
  end if;

  select count(*) into v_recientes
  from pruebas_inscripciones
  where club_id = v_club_id and creado_at > now() - interval '5 minutes';

  if v_recientes >= 30 then
    raise exception 'Se han recibido demasiadas inscripciones seguidas. Inténtalo de nuevo en unos minutos.';
  end if;

  v_anio := extract(year from p_fecha_nacimiento)::int;

  insert into pruebas_inscripciones
    (club_id, nombre, fecha_nacimiento, anio_nacimiento, email, telefono, nombre_contacto, posicion, club_actual, comentario,
     jugador_ffcv_sugerido_id)
  values
    (v_club_id, trim(p_nombre), p_fecha_nacimiento, v_anio,
     nullif(trim(p_email), ''), nullif(trim(p_telefono), ''), nullif(trim(p_nombre_contacto), ''),
     nullif(trim(p_posicion), ''), nullif(trim(p_club_actual), ''), nullif(trim(p_comentario), ''),
     pruebas_sugerir_ffcv(p_nombre, p_fecha_nacimiento, p_club_actual))
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function pruebas_inscribir(text, text, date, text, text, text, text, text, text, text) to anon;
