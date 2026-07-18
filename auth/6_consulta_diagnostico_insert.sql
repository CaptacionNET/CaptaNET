-- ============================================================
-- CaptaNET · Diagnóstico (solo lectura): ¿hay algún trigger que cree
-- automáticamente la fila de "profiles" cuando se registra un usuario
-- nuevo en auth.users? Necesario para saber si se puede endurecer la
-- política de inserción de "profiles" sin romper el alta de usuarios.
-- ============================================================

select
  event_object_schema, event_object_table, trigger_name, action_timing, event_manipulation
from information_schema.triggers
where event_object_schema = 'auth' and event_object_table = 'users'
order by trigger_name;
