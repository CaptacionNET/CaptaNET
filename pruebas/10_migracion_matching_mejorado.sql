-- ============================================================
-- CaptaNET · Gestión de Pruebas (v6)
-- Mejora la sugerencia automática de FFCV: además del año de
-- nacimiento, ahora usa (por orden de preferencia) la fecha de
-- nacimiento completa y el club actual que puso el jugador al
-- inscribirse, para no equivocarse cuando hay varios homónimos del
-- mismo año. Si ninguno de esos afinados encuentra nada, cae al
-- comportamiento anterior (solo nombre + año) como último recurso.
-- ============================================================

drop function if exists pruebas_sugerir_ffcv(text, int);

create or replace function pruebas_sugerir_ffcv(
  p_nombre text,
  p_fecha_nacimiento date,
  p_club_actual text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_palabras text[];
  v_palabras_club text[];
begin
  if p_nombre is null or trim(p_nombre) = '' then
    return null;
  end if;

  v_palabras := regexp_split_to_array(trim(normalizar_texto(p_nombre)), '\s+');
  v_palabras_club := case
    when p_club_actual is null or trim(p_club_actual) = '' then null
    else regexp_split_to_array(trim(normalizar_texto(p_club_actual)), '\s+')
  end;

  -- Nivel 1: nombre + fecha de nacimiento exacta (día y mes incluidos) + club parecido
  if p_fecha_nacimiento is not null and v_palabras_club is not null then
    select j.id into v_id
    from jugadores j
    left join equipos e on e.id = j.equipo_id
    where j.fecha_nacimiento = p_fecha_nacimiento
      and not exists (select 1 from unnest(v_palabras) p where j.nombre_normalizado not ilike '%' || p || '%')
      and not exists (select 1 from unnest(v_palabras_club) p where normalizar_texto(coalesce(e.nombre, '')) not ilike '%' || p || '%')
    limit 1;
    if v_id is not null then return v_id; end if;
  end if;

  -- Nivel 2: nombre + fecha de nacimiento exacta
  if p_fecha_nacimiento is not null then
    select j.id into v_id
    from jugadores j
    where j.fecha_nacimiento = p_fecha_nacimiento
      and not exists (select 1 from unnest(v_palabras) p where j.nombre_normalizado not ilike '%' || p || '%')
    limit 1;
    if v_id is not null then return v_id; end if;
  end if;

  -- Nivel 3: nombre + año de nacimiento + club parecido
  if p_fecha_nacimiento is not null and v_palabras_club is not null then
    select j.id into v_id
    from jugadores j
    left join equipos e on e.id = j.equipo_id
    where extract(year from j.fecha_nacimiento) = extract(year from p_fecha_nacimiento)
      and not exists (select 1 from unnest(v_palabras) p where j.nombre_normalizado not ilike '%' || p || '%')
      and not exists (select 1 from unnest(v_palabras_club) p where normalizar_texto(coalesce(e.nombre, '')) not ilike '%' || p || '%')
    limit 1;
    if v_id is not null then return v_id; end if;
  end if;

  -- Nivel 4 (como antes): solo nombre + año de nacimiento
  select j.id into v_id
  from jugadores j
  where (p_fecha_nacimiento is null or extract(year from j.fecha_nacimiento) = extract(year from p_fecha_nacimiento))
    and not exists (select 1 from unnest(v_palabras) p where j.nombre_normalizado not ilike '%' || p || '%')
  limit 1;

  return v_id;
end;
$$;

-- pruebas_inscribir (v4): ahora pasa la fecha completa y el club a la
-- función de sugerencia, en vez de solo el año.
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
     pruebas_sugerir_ffcv(p_nombre, p_fecha_nacimiento, p_club_actual))
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function pruebas_inscribir(text, text, date, text, text, text, text, text, text, text) to anon;

-- Vuelve a calcular la sugerencia para las inscripciones que ya
-- tenían una (con el criterio anterior, solo año) y para las que aún
-- no tenían ninguna, ahora con fecha completa y club.
update pruebas_inscripciones
set jugador_ffcv_sugerido_id = pruebas_sugerir_ffcv(nombre, fecha_nacimiento, club_actual)
where jugador_ffcv_id is null;
