-- ============================================================
-- CaptaNET · Módulo RUTA — el admin del club ve la ruta de todos
-- Cada ojeador sigue viendo y editando SOLO su propia ruta, pero el
-- admin del club (y el admin global) pueden VER las rutas de todos los
-- ojeadores de su club. Editar/borrar sigue siendo solo del dueño.
-- ============================================================

drop policy if exists ruta_select_propia on ruta_partidos;
create policy ruta_select_propia on ruta_partidos
  for select to authenticated
  using (
    user_id = auth.uid()
    or (select is_admin from profiles where id = auth.uid())
    or (
      (select is_club_admin from profiles where id = auth.uid())
      and club_id = (select club_id from profiles where id = auth.uid())
    )
  );

-- Las políticas de insertar/actualizar/borrar NO cambian: siguen siendo
-- solo para el dueño (user_id = auth.uid()).
