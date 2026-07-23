-- ============================================================
-- CaptaNET · Gestión de Pruebas: rango horario en los eventos
-- Los eventos de prueba ya no tienen una duración fija de 1 hora:
-- ahora cada uno guarda su hora de inicio y (opcional) su hora de fin.
-- ============================================================

alter table pruebas_eventos rename column hora to hora_inicio;
alter table pruebas_eventos add column if not exists hora_fin time;

-- pruebas_obtener_publica (usada por confirmar_prueba.html): mismo
-- resultado de siempre, solo cambia de dónde saca la hora de inicio.
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
  select pi.nombre, c.nombre, pe.dia, pe.hora_inicio, pe.lugar, pi.respuesta_asistencia
  from pruebas_inscripciones pi
  join clubs c on c.id = pi.club_id
  left join pruebas_eventos pe on pe.id = pi.evento_id
  where pi.id = p_id;
$$;

grant execute on function pruebas_obtener_publica(uuid) to anon;
