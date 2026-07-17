-- ============================================================
-- CaptaNET · Gestión de Pruebas (v4)
-- Protección anti-spam del formulario público: límite de envíos por
-- club en una ventana de tiempo (bloquea ráfagas automatizadas,
-- vengan de un único script o de varias IPs a la vez) + un campo
-- "honeypot" que los humanos nunca rellenan pero los bots sí.
-- ============================================================

-- Cambiamos la lista de parámetros (añadimos p_honeypot), así que hay que
-- borrar la función anterior explícitamente: si no, "create or replace"
-- deja las dos versiones a la vez y PostgREST no sabe cuál usar.
drop function if exists pruebas_inscribir(text, text, date, text, text, text, text, text, text);

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
begin
  -- Campo trampa: invisible para personas, pero los bots que rellenan
  -- todos los campos del formulario lo acaban rellenando. Si viene con
  -- algo, fingimos éxito sin guardar nada, para no delatar el filtro.
  if p_honeypot is not null and trim(p_honeypot) <> '' then
    return null;
  end if;

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

  select count(*) into v_recientes
  from pruebas_inscripciones
  where club_id = v_club_id and creado_at > now() - interval '5 minutes';

  if v_recientes >= 30 then
    raise exception 'Se han recibido demasiadas inscripciones seguidas. Inténtalo de nuevo en unos minutos.';
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

grant execute on function pruebas_inscribir(text, text, date, text, text, text, text, text, text, text) to anon;
