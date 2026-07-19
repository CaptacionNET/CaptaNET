-- ============================================================
-- CaptaNET · Diagnóstico (solo lectura) de por qué no sale la flecha
-- de estadísticas en el historial de Gerard Hervás.
-- ============================================================

-- 1) ¿Qué llegó a guardarse realmente en su fila? Si "temporada_stats_cod"
--    sale null, el reprocesado no llegó a este jugador (o falló antes de
--    guardar). Si sale con valor, comparamos con lo que hay en "historial".
select
  cod_ffcv, nombre, temporada_stats_cod, temporada_stats_nombre,
  temporada_anterior_cod, ffcv_actualizado,
  historial
from jugadores
where cod_ffcv = '9764746';

-- 2) ¿Qué "ffcv_cod_temporada" tiene guardado su equipo? Si no coincide
--    con el "cod_temporada" de la fila de 2025-2026 en el historial de
--    arriba, ahí está el problema (el emparejamiento nunca puede casar).
select cod_ffcv, nombre, ffcv_cod_temporada, temporada_id
from equipos
where cod_ffcv = '14880';

-- 3) ¿Hubo algún error reciente al procesar su equipo?
select tipo, referencia, estado, error_msg, actualizado_en
from ffcv_cola
where referencia = '14880'
order by actualizado_en desc
limit 5;
