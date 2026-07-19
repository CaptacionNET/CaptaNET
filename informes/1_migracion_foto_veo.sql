-- ============================================================
-- CaptaNET · Informes: enlace a VEO
-- La foto ya existe (jugadores_club.foto_url); solo falta el campo
-- para pegar el enlace al partido grabado con VEO, si lo hay.
-- ============================================================

alter table jugadores_club add column if not exists link_veo text;
