-- ============================================================
-- CaptaNET · Gestión de Pruebas (v3)
-- Campo para anotar a qué equipo/categoría interna se propone al
-- jugador, usado por el botón "Enviar a plantillas".
-- ============================================================

alter table pruebas_inscripciones add column if not exists equipo_propuesto text;
