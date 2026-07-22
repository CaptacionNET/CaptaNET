-- ============================================================
-- CaptaNET · Módulo RUTA — guardar también el grupo del partido
-- Ya guardábamos categoría (modalidad) y liga (competición); ahora
-- también el grupo, para mostrarlo en la lista "Mis partidos".
-- ============================================================

alter table ruta_partidos add column if not exists grupo text;
