-- ============================================================
-- CaptaNET · Limpieza de políticas RLS
-- Dos cosas:
--   A) Cierra el último hueco de escalada de privilegios: la política
--      "Insertar perfiles" dejaba crear una fila nueva en profiles sin
--      ninguna restricción. Confirmado que no hace falta (no hay
--      trigger de alta automática en auth.users), así que se elimina,
--      y el disparador de protección se amplía para cubrir también
--      altas (antes solo cubría modificaciones).
--   B) Quita políticas duplicadas que se fueron acumulando en varias
--      tablas durante el desarrollo. No eran un agujero de seguridad
--      (todas tenían el mismo efecto que otra que se queda), solo
--      desorden — se deja una sola política por caso en cada tabla.
-- ============================================================

-- A) Ampliar el disparador de protección para que cubra también altas
create or replace function proteger_campos_sensibles_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if is_admin() then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    new.is_admin := old.is_admin;
    new.is_club_admin := old.is_club_admin;
    new.club_id := old.club_id;
  elsif tg_op = 'INSERT' then
    new.is_admin := false;
    new.is_club_admin := false;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_proteger_campos_sensibles_profile on profiles;
create trigger trg_proteger_campos_sensibles_profile
before insert or update on profiles
for each row
execute function proteger_campos_sensibles_profile();

-- Quitar la política de inserción sin restricciones: la de alta con
-- comprobación de admin (admin_inserta_perfiles) es la única que hace falta.
drop policy if exists "Insertar perfiles" on profiles;

-- B) Duplicados en profiles: se queda profiles_select, profiles_update
--    y admin_inserta_perfiles; el resto decía lo mismo con otro nombre.
drop policy if exists "Actualizar su propio perfil" on profiles;
drop policy if exists "Admin puede ver todos los perfiles" on profiles;
drop policy if exists "Usuario puede ver su propio perfil" on profiles;
drop policy if exists "usuario actualiza su perfil" on profiles;
drop policy if exists "usuario lee su perfil" on profiles;
drop policy if exists "usuario_actualiza_su_perfil" on profiles;
drop policy if exists "usuario_lee_su_perfil" on profiles;

-- Duplicados en las tablas de catálogo (categorias, equipos, ligas,
-- jugadores): se queda "_select" (lectura para cualquier usuario con
-- sesión) y "_write" (solo admin); sobraban dos réplicas de lo mismo.
drop policy if exists "admin ve todas los categorias" on categorias;
drop policy if exists "usuarios leen datos comunes" on categorias;
drop policy if exists "admin ve todas los equipos" on equipos;
drop policy if exists "usuarios leen datos comunes" on equipos;
drop policy if exists "admin ve todas los ligas" on ligas;
drop policy if exists "usuarios leen datos comunes" on ligas;
drop policy if exists "admin ve todas los jugadores" on jugadores;
drop policy if exists "usuarios leen datos comunes" on jugadores;

-- Duplicado en clubs: se queda clubs_select.
drop policy if exists "allow_select_clubs" on clubs;

-- Duplicados en jugadores_club: las 4 políticas antiguas ("club
-- select/insert/update/delete") hacían lo mismo que la política nueva
-- "jugadores_club_all", pero sin el añadido de acceso para admin.
-- Al quedarnos solo con la nueva no se pierde ningún acceso legítimo.
drop policy if exists "club select" on jugadores_club;
drop policy if exists "club insert" on jugadores_club;
drop policy if exists "club update" on jugadores_club;
drop policy if exists "club delete" on jugadores_club;
