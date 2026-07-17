-- ============================================================
-- CaptaNET · Consulta de auditoría (solo lectura, no modifica nada)
-- Lista qué tablas tienen RLS activado, qué políticas tiene cada una,
-- y qué funciones son ejecutables por "anon" (usuarios sin sesión) o
-- "authenticated" (cualquier usuario logueado). Pégala en el SQL
-- Editor de Supabase, ejecútala y pásame el resultado de las 3.
-- ============================================================

-- 1) ¿Qué tablas tienen RLS activado? (debería ser "true" en todas las
--    que tengan datos privados de un club: profiles, clubs, jugadores_club,
--    plantillas, plantilla_jugadores, pruebas_inscripciones...)
select schemaname, tablename, rowsecurity as rls_activado
from pg_tables
where schemaname = 'public'
order by tablename;

-- 2) Detalle de cada política: a qué tabla afecta, para qué operación
--    (select/insert/update/delete), para qué roles, y su condición.
select
  schemaname, tablename, policyname, cmd as operacion,
  roles, qual as condicion_using, with_check as condicion_with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 3) Funciones ejecutables por "anon" (usuarios SIN iniciar sesión) —
--    revisa que solo aparezcan las que de verdad deben ser públicas
--    (inscripción a pruebas, confirmación de asistencia, branding de
--    club, login/recuperación). Si aparece algo más ahí, avísame.
select
  p.proname as funcion,
  pg_get_function_identity_arguments(p.oid) as parametros,
  p.prosecdef as es_security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and has_function_privilege('anon', p.oid, 'execute')
order by p.proname;
