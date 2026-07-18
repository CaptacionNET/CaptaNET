-- ============================================================
-- CaptaNET · Impide la escalada de privilegios vía "profiles"
-- Las políticas RLS de "profiles" dejan que cada usuario actualice su
-- propia fila, pero ninguna impide que cambie is_admin, is_club_admin
-- o club_id en esa misma actualización — cualquier usuario con cuenta
-- podría hacerse administrador global él mismo.
--
-- Este trigger actúa como última barrera, por debajo de las políticas:
-- si quien hace el cambio no es ya administrador, esos tres campos se
-- devuelven a su valor anterior pase lo que pase en la fila que llega.
-- Un administrador de verdad sigue pudiendo cambiarlos con normalidad
-- (por ejemplo desde el panel de Admin, al asignar un club o el rol).
-- ============================================================

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

  new.is_admin := old.is_admin;
  new.is_club_admin := old.is_club_admin;
  new.club_id := old.club_id;

  return new;
end;
$$;

drop trigger if exists trg_proteger_campos_sensibles_profile on profiles;
create trigger trg_proteger_campos_sensibles_profile
before update on profiles
for each row
execute function proteger_campos_sensibles_profile();
