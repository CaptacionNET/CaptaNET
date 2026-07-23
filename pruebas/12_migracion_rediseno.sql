-- ============================================================
-- CaptaNET · Gestión de Pruebas: rediseño completo
-- Nuevos estados de valoración, cuestionario personalizado con
-- preguntas propias, escudo del club en el formulario público, alta
-- manual de jugadores, calendario de eventos de prueba (día/hora/año/
-- equipo objetivo) que sustituye a las columnas sueltas de cita, y
-- respuesta del jugador a la propuesta de equipo admitido.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Estados de valoración
-- ------------------------------------------------------------
update pruebas_inscripciones set estado = 'descartar' where estado = 'descartado';
update pruebas_inscripciones set estado = 'firmado' where estado = 'fichado';

alter table pruebas_inscripciones drop constraint if exists pruebas_estado_valido;
alter table pruebas_inscripciones add constraint pruebas_estado_valido
  check (estado in ('pendiente', 'citado', 'volver_a_citar', 'descartar', 'firmar', 'firmado', 'no_acude'));

-- ------------------------------------------------------------
-- 2. Cuestionario personalizado (preguntas propias del club)
-- ------------------------------------------------------------
create table if not exists pruebas_preguntas (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  texto text not null,
  orden int not null default 0,
  activa boolean not null default true,
  creado_at timestamptz not null default now()
);
create index if not exists idx_pruebas_preguntas_club on pruebas_preguntas(club_id, orden);

alter table pruebas_preguntas enable row level security;

drop policy if exists pruebas_preguntas_select on pruebas_preguntas;
create policy pruebas_preguntas_select on pruebas_preguntas
  for select to authenticated
  using (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

drop policy if exists pruebas_preguntas_insert on pruebas_preguntas;
create policy pruebas_preguntas_insert on pruebas_preguntas
  for insert to authenticated
  with check (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

drop policy if exists pruebas_preguntas_update on pruebas_preguntas;
create policy pruebas_preguntas_update on pruebas_preguntas
  for update to authenticated
  using (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

drop policy if exists pruebas_preguntas_delete on pruebas_preguntas;
create policy pruebas_preguntas_delete on pruebas_preguntas
  for delete to authenticated
  using (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

-- Lectura pública de las preguntas activas, para pintar el formulario
-- de inscripción sin necesitar sesión.
create or replace function pruebas_preguntas_publicas(p_slug text)
returns table(id uuid, texto text)
language sql
stable
security definer
set search_path = public
as $$
  select pp.id, pp.texto
  from pruebas_preguntas pp
  join clubs c on c.id = pp.club_id
  where c.slug = p_slug and pp.activa = true
  order by pp.orden, pp.creado_at;
$$;

grant execute on function pruebas_preguntas_publicas(text) to anon;

-- Respuestas del jugador a esas preguntas, guardadas junto con la
-- inscripción. La clave es el TEXTO de la pregunta en el momento de
-- enviar el formulario (no su id): así, si luego se edita o se borra
-- la pregunta, la respuesta histórica se sigue leyendo sin depender
-- de un join a una fila que puede haber cambiado o desaparecido.
alter table pruebas_inscripciones add column if not exists respuestas_extra jsonb not null default '{}'::jsonb;

-- ------------------------------------------------------------
-- 3. Escudo del club en el formulario público
-- ------------------------------------------------------------
drop function if exists pruebas_estado_publico(text);

create or replace function pruebas_estado_publico(p_slug text)
returns table(nombre text, cerrado boolean, fecha_limite date, escudo_url text)
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
    select c.nombre, club_pruebas_cerrado(c.id), c.pruebas_fecha_limite, c.escudo_url
    from clubs c where c.id = v_club_id;
end;
$$;

grant execute on function pruebas_estado_publico(text) to anon;

-- ------------------------------------------------------------
-- 4. Alta manual de jugadores desde el panel (no el formulario público)
-- ------------------------------------------------------------
-- Hasta ahora no existía ninguna política de INSERT: el alta pública
-- solo pasaba por pruebas_inscribir (security definer). Esta política
-- permite al club (o a un admin global) insertar filas directamente
-- desde el panel de gestión.
drop policy if exists pruebas_insert_club on pruebas_inscripciones;
create policy pruebas_insert_club on pruebas_inscripciones
  for insert to authenticated
  with check (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

-- ------------------------------------------------------------
-- 5. Día de prueba: calendario de eventos
-- ------------------------------------------------------------
create table if not exists pruebas_eventos (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  dia date not null,
  hora time,
  anio_nacimiento int,
  equipo_objetivo text,
  lugar text,
  creado_at timestamptz not null default now()
);
create index if not exists idx_pruebas_eventos_club on pruebas_eventos(club_id, dia, hora);

alter table pruebas_eventos enable row level security;

drop policy if exists pruebas_eventos_select on pruebas_eventos;
create policy pruebas_eventos_select on pruebas_eventos
  for select to authenticated
  using (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

drop policy if exists pruebas_eventos_insert on pruebas_eventos;
create policy pruebas_eventos_insert on pruebas_eventos
  for insert to authenticated
  with check (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

drop policy if exists pruebas_eventos_update on pruebas_eventos;
create policy pruebas_eventos_update on pruebas_eventos
  for update to authenticated
  using (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

drop policy if exists pruebas_eventos_delete on pruebas_eventos;
create policy pruebas_eventos_delete on pruebas_eventos
  for delete to authenticated
  using (
    club_id = (select club_id from profiles where id = auth.uid())
    or (select is_admin from profiles where id = auth.uid())
  );

alter table pruebas_inscripciones add column if not exists evento_id uuid references pruebas_eventos(id) on delete set null;
alter table pruebas_inscripciones add column if not exists campograma_pos_x numeric;
alter table pruebas_inscripciones add column if not exists campograma_pos_y numeric;
alter table pruebas_inscripciones add column if not exists excluido_dia_prueba boolean not null default false;

-- Backfill: crea un evento por cada combinación (club, día, hora,
-- lugar) que ya existiera en citaciones enviadas, y enlaza las
-- inscripciones correspondientes, para no perder esas citas antes de
-- borrar las columnas sueltas.
insert into pruebas_eventos (club_id, dia, hora, lugar, creado_at)
select distinct club_id, dia_prueba, hora_prueba, lugar_prueba, now()
from pruebas_inscripciones
where dia_prueba is not null;

update pruebas_inscripciones pi
set evento_id = pe.id
from pruebas_eventos pe
where pi.dia_prueba is not null
  and pe.club_id = pi.club_id
  and pe.dia = pi.dia_prueba
  and pe.hora is not distinct from pi.hora_prueba
  and pe.lugar is not distinct from pi.lugar_prueba;

-- pruebas_obtener_publica (usada por confirmar_prueba.html) ahora saca
-- día/hora/lugar del evento enlazado en vez de columnas sueltas en la
-- propia fila; la forma del resultado no cambia.
create or replace function pruebas_obtener_publica(p_id uuid)
returns table (
  nombre text,
  club_nombre text,
  dia_prueba date,
  hora_prueba time,
  lugar_prueba text,
  respuesta_asistencia text
)
language sql
security definer
set search_path = public
as $$
  select pi.nombre, c.nombre, pe.dia, pe.hora, pe.lugar, pi.respuesta_asistencia
  from pruebas_inscripciones pi
  join clubs c on c.id = pi.club_id
  left join pruebas_eventos pe on pe.id = pi.evento_id
  where pi.id = p_id;
$$;

grant execute on function pruebas_obtener_publica(uuid) to anon;

alter table pruebas_inscripciones drop column if exists dia_prueba;
alter table pruebas_inscripciones drop column if exists hora_prueba;
alter table pruebas_inscripciones drop column if exists lugar_prueba;

-- ------------------------------------------------------------
-- 6. Respuesta del jugador a la propuesta de equipo admitido
-- ------------------------------------------------------------
alter table pruebas_inscripciones add column if not exists respuesta_admision text;
alter table pruebas_inscripciones add column if not exists respuesta_admision_comentario text;
alter table pruebas_inscripciones add column if not exists respondido_admision_at timestamptz;

alter table pruebas_inscripciones drop constraint if exists pruebas_respuesta_admision_valida;
alter table pruebas_inscripciones add constraint pruebas_respuesta_admision_valida
  check (respuesta_admision is null or respuesta_admision in ('interesado', 'no_interesado'));

create or replace function pruebas_obtener_admision_publica(p_id uuid)
returns table (
  nombre text,
  club_nombre text,
  equipo_propuesto text,
  respuesta_admision text
)
language sql
security definer
set search_path = public
as $$
  select pi.nombre, c.nombre, pi.equipo_propuesto, pi.respuesta_admision
  from pruebas_inscripciones pi
  join clubs c on c.id = pi.club_id
  where pi.id = p_id;
$$;

grant execute on function pruebas_obtener_admision_publica(uuid) to anon;

create or replace function pruebas_responder_admision(p_id uuid, p_respuesta text, p_comentario text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_respuesta not in ('interesado', 'no_interesado') then
    raise exception 'Respuesta no válida';
  end if;

  update pruebas_inscripciones
  set respuesta_admision = p_respuesta,
      respuesta_admision_comentario = nullif(trim(p_comentario), ''),
      respondido_admision_at = now()
  where id = p_id;

  if not found then
    raise exception 'Inscripción no encontrada';
  end if;
end;
$$;

grant execute on function pruebas_responder_admision(uuid, text, text) to anon;

-- ------------------------------------------------------------
-- 7. pruebas_inscribir: gana p_respuestas_extra (respuestas al
--    cuestionario personalizado)
-- ------------------------------------------------------------
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
  p_honeypot text default null,
  p_respuestas_extra jsonb default '{}'::jsonb
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
     jugador_ffcv_sugerido_id, respuestas_extra)
  values
    (v_club_id, trim(p_nombre), p_fecha_nacimiento, v_anio,
     nullif(trim(p_email), ''), nullif(trim(p_telefono), ''), nullif(trim(p_nombre_contacto), ''),
     nullif(trim(p_posicion), ''), nullif(trim(p_club_actual), ''), nullif(trim(p_comentario), ''),
     pruebas_sugerir_ffcv(p_nombre, p_fecha_nacimiento, p_club_actual),
     coalesce(p_respuestas_extra, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function pruebas_inscribir(text, text, date, text, text, text, text, text, text, text, jsonb) to anon;
