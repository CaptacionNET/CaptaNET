-- ============================================================
-- CaptaNET · Gestión de Pruebas (v5)
-- Sugerencia automática de coincidencia con FFCV: al llegar una
-- inscripción se busca sola un posible jugador ya catalogado (mismo
-- nombre y año de nacimiento) y se guarda como "sugerencia", sin
-- fusionarlo. El club sigue confirmando el vínculo a mano desde la
-- ficha — esto solo evita tener que buscar una por una entre muchas.
-- ============================================================

alter table pruebas_inscripciones add column if not exists jugador_ffcv_sugerido_id uuid references jugadores(id);

create or replace function pruebas_sugerir_ffcv(p_nombre text, p_anio int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_palabras text[];
begin
  if p_nombre is null or trim(p_nombre) = '' then
    return null;
  end if;

  v_palabras := regexp_split_to_array(trim(normalizar_texto(p_nombre)), '\s+');

  select j.id into v_id
  from jugadores j
  where (p_anio is null or extract(year from j.fecha_nacimiento) = p_anio)
    and not exists (
      select 1 from unnest(v_palabras) as palabra
      where j.nombre_normalizado not ilike '%' || palabra || '%'
    )
  limit 1;

  return v_id;
end;
$$;

-- pruebas_inscribir (v3): igual que antes, pero además calcula la
-- sugerencia al dar de alta la inscripción.
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
     pruebas_sugerir_ffcv(p_nombre, v_anio))
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function pruebas_inscribir(text, text, date, text, text, text, text, text, text, text) to anon;

-- Relleno único para las inscripciones que ya existían antes de este cambio.
update pruebas_inscripciones
set jugador_ffcv_sugerido_id = pruebas_sugerir_ffcv(nombre, anio_nacimiento)
where jugador_ffcv_id is null and jugador_ffcv_sugerido_id is null;
