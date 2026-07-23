-- ============================================================
-- CaptaNET · Escudo del club
-- Se muestra en el login del club y en la cabecera de la app una vez
-- dentro. Solo el admin lo sube (desde el panel de administración).
-- ============================================================

alter table clubs add column if not exists escudo_url text;

-- Branding público por slug (sin sesión), para el login de cada club.
-- No se toca get_club_nombre_by_slug (sigue en uso) — esta es nueva,
-- con el escudo además del nombre.
create or replace function club_branding_by_slug(p_slug text)
returns table(nombre text, escudo_url text)
language sql
stable
security definer
set search_path = public
as $$
  select c.nombre, c.escudo_url from clubs c where c.slug = p_slug;
$$;

grant execute on function club_branding_by_slug(text) to anon;
