-- ============================================================
-- CaptaNET · Informes: equipo para el que se valora al jugador
-- ============================================================

alter table jugadores_club add column if not exists equipo_propuesto text;
