-- ============================================================
-- CaptaNET · Módulo RUTA — guardar los escudos de los equipos
-- Para mostrarlos junto a cada equipo en la tabla de "Mis partidos".
-- ============================================================

alter table ruta_partidos add column if not exists escudo_local text;
alter table ruta_partidos add column if not exists escudo_visitante text;
