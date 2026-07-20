-- ============================================================
-- CaptaNET · Informes: valoración del jugador
-- Estado del scouting sobre el jugador: descartar, seguir, interesante,
-- firmar, firmado.
--
-- Se llama "valoracion_scouting" (no "valoracion") porque jugadores_club
-- ya tenía una columna "valoracion" de tipo entero, ajena a esta función,
-- que no se toca aquí.
-- ============================================================

alter table jugadores_club add column if not exists valoracion_scouting text;

alter table jugadores_club drop constraint if exists jugadores_club_valoracion_scouting_valida;
alter table jugadores_club add constraint jugadores_club_valoracion_scouting_valida
  check (valoracion_scouting is null or valoracion_scouting in ('descartar', 'seguir', 'interesante', 'firmar', 'firmado'));
