-- ============================================================
-- CaptaNET · Estadísticas por temporada
-- La FFCV no deja consultar las estadísticas de temporadas pasadas
-- (comprobado a mano: jugador_api.php siempre responde con las de la
-- temporada activa del jugador, ignorando el cod_temporada pedido si
-- no coincide). Así que en cuanto empiece una temporada nueva, las
-- estadísticas actuales dejan de poder recuperarse de la FFCV para
-- siempre — la única oportunidad de conservarlas es guardar una copia
-- justo antes de que el importador las sobrescriba con las nuevas.
--
-- temporada_stats_cod / temporada_stats_nombre: de qué temporada son
-- los números que hay ahora mismo en goles/partidos_jugados/etc.
-- temporada_anterior_*: la "foto" de la temporada justo anterior,
-- guardada automáticamente por el importador la primera vez que ve
-- que la temporada ha cambiado respecto a lo que tenía guardado.
-- ============================================================

alter table jugadores add column if not exists temporada_stats_cod text;
alter table jugadores add column if not exists temporada_stats_nombre text;

alter table jugadores add column if not exists temporada_anterior_cod text;
alter table jugadores add column if not exists temporada_anterior_nombre text;
alter table jugadores add column if not exists goles_anterior int;
alter table jugadores add column if not exists partidos_convocados_anterior int;
alter table jugadores add column if not exists partidos_titular_anterior int;
alter table jugadores add column if not exists partidos_suplente_anterior int;
alter table jugadores add column if not exists partidos_jugados_anterior int;
alter table jugadores add column if not exists minutos_jugados_anterior int;
alter table jugadores add column if not exists tarjetas_amarillas_anterior int;
alter table jugadores add column if not exists tarjetas_rojas_anterior int;
alter table jugadores add column if not exists tarjetas_doble_amarilla_anterior int;
alter table jugadores add column if not exists tarjetas_verde_anterior int;
