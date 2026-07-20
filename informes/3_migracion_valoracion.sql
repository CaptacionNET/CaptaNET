-- ============================================================
-- CaptaNET · Informes: valoración del jugador
-- Estado del scouting sobre el jugador: descartar, seguir, interesante,
-- firmar, firmado.
-- ============================================================

alter table jugadores_club add column if not exists valoracion text;

alter table jugadores_club drop constraint if exists jugadores_club_valoracion_valida;
alter table jugadores_club add constraint jugadores_club_valoracion_valida
  check (valoracion is null or valoracion in ('descartar', 'seguir', 'interesante', 'firmar', 'firmado'));
