-- ============================================================
-- CaptaNET · Gestión de Pruebas (v2)
-- Confirmación de asistencia por parte del jugador/familia (enlace
-- público en el email de convocatoria) + vínculo con el jugador FFCV
-- correspondiente, para poder abrir su ficha con un clic.
-- ============================================================

alter table pruebas_inscripciones add column if not exists respuesta_asistencia text;
alter table pruebas_inscripciones add column if not exists respuesta_comentario text;
alter table pruebas_inscripciones add column if not exists respondido_at timestamptz;
alter table pruebas_inscripciones add column if not exists jugador_ffcv_id uuid references jugadores(id);

alter table pruebas_inscripciones drop constraint if exists pruebas_respuesta_valida;
alter table pruebas_inscripciones add constraint pruebas_respuesta_valida
  check (respuesta_asistencia is null or respuesta_asistencia in ('si', 'no'));

-- Datos mínimos y públicos de una inscripción, para pintar la página de
-- confirmación de asistencia sin exponer el resto de columnas (email,
-- teléfono, valoración...) a quien tenga el enlace.
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
  select pi.nombre, c.nombre, pi.dia_prueba, pi.hora_prueba, pi.lugar_prueba, pi.respuesta_asistencia
  from pruebas_inscripciones pi
  join clubs c on c.id = pi.club_id
  where pi.id = p_id;
$$;

grant execute on function pruebas_obtener_publica(uuid) to anon;

create or replace function pruebas_responder(p_id uuid, p_respuesta text, p_comentario text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_respuesta not in ('si', 'no') then
    raise exception 'Respuesta no válida';
  end if;

  update pruebas_inscripciones
  set respuesta_asistencia = p_respuesta,
      respuesta_comentario = nullif(trim(p_comentario), ''),
      respondido_at = now()
  where id = p_id;

  if not found then
    raise exception 'Inscripción no encontrada';
  end if;
end;
$$;

grant execute on function pruebas_responder(uuid, text, text) to anon;
