-- ============================================================
-- CaptaNET · Funciones de solo lectura para el Asistente (agente IA)
-- El agente (Edge Function ruta-agente) NUNCA genera SQL: solo puede
-- llamar a estas funciones ya definidas y parametrizadas, cada una
-- acotada a una consulta concreta. Así se evita el riesgo de dejar a
-- un LLM componer consultas libres contra la base de datos real.
-- Todas son SECURITY INVOKER (por defecto) y se llaman con el cliente
-- autenticado del usuario, así que respetan la RLS normal de cada tabla.
-- ============================================================

-- Devuelve las categorías de edad con ligas activas ahora mismo, para
-- que el agente pueda corregirse si el nombre de categoría que le dan
-- no encaja exactamente (p.ej. "infantiles" -> "Infantil").
create or replace function agente_listar_categorias()
returns table(categoria_edad text, num_ligas bigint)
language sql
stable
as $$
  select coalesce(l.categoria_edad_ffcv, l.nombre) as categoria_edad, count(*) as num_ligas
  from ligas l
  join categorias c on c.id = l.categoria_id
  join temporadas t on t.id = c.temporada_id
  where t.activa = true
  group by coalesce(l.categoria_edad_ffcv, l.nombre)
  order by num_ligas desc;
$$;

-- Máximo goleadores de una categoría de edad (temporada activa),
-- opcionalmente acotado a un año de nacimiento concreto (p.ej. para
-- distinguir "primer año" de "segundo año" dentro de una categoría de
-- dos años). p_categoria se compara contra categoria_edad_ffcv o,
-- si no existe, contra el nombre de la liga.
create or replace function agente_buscar_goleadores(
  p_categoria text,
  p_anio_nacimiento int default null,
  p_top_n int default 10
)
returns table(
  nombre text, equipo text, liga text, categoria_edad text,
  anio_nacimiento int, goles int, partidos_jugados int
)
language sql
stable
as $$
  select
    j.nombre, e.nombre as equipo, li.nombre as liga,
    coalesce(li.categoria_edad_ffcv, li.nombre) as categoria_edad,
    extract(year from j.fecha_nacimiento)::int as anio_nacimiento,
    j.goles, j.partidos_jugados
  from jugadores j
  join equipos e on e.id = j.equipo_id
  join grupos g on g.id = e.grupo_id
  join ligas li on li.id = g.liga_id
  join categorias c on c.id = li.categoria_id
  join temporadas t on t.id = c.temporada_id
  where t.activa = true
    and (li.categoria_edad_ffcv ilike '%' || p_categoria || '%' or li.nombre ilike '%' || p_categoria || '%')
    and (p_anio_nacimiento is null or extract(year from j.fecha_nacimiento)::int = p_anio_nacimiento)
    and j.goles is not null
  order by j.goles desc
  limit greatest(1, least(p_top_n, 50));
$$;

-- Ficha de estadísticas de uno o varios jugadores que coincidan con el
-- nombre (puede haber homónimos: se devuelven varios para que el
-- agente pueda distinguirlos por equipo/liga en su respuesta).
create or replace function agente_estadisticas_jugador(p_nombre text)
returns table(
  nombre text, equipo text, liga text, categoria_edad text,
  fecha_nacimiento date, posicion text, es_portero boolean,
  goles int, tarjetas_amarillas int, tarjetas_rojas int,
  tarjetas_doble_amarilla int, tarjetas_verde int,
  minutos_jugados int, partidos_jugados int, partidos_titular int, partidos_suplente int
)
language sql
stable
as $$
  select
    j.nombre, e.nombre as equipo, li.nombre as liga,
    coalesce(li.categoria_edad_ffcv, li.nombre) as categoria_edad,
    j.fecha_nacimiento, j.posicion, j.es_portero,
    j.goles, j.tarjetas_amarillas, j.tarjetas_rojas, j.tarjetas_doble_amarilla, j.tarjetas_verde,
    j.minutos_jugados, j.partidos_jugados, j.partidos_titular, j.partidos_suplente
  from jugadores j
  left join equipos e on e.id = j.equipo_id
  left join grupos g on g.id = e.grupo_id
  left join ligas li on li.id = g.liga_id
  where j.nombre_normalizado ilike '%' || normalizar_texto(p_nombre) || '%'
  order by j.goles desc nulls last
  limit 8;
$$;

-- Ranking de tarjetas de un tipo concreto, opcionalmente por categoría.
create or replace function agente_buscar_tarjetas(
  p_tipo text,           -- 'amarilla' | 'roja' | 'doble_amarilla' | 'verde'
  p_categoria text default null,
  p_top_n int default 10
)
returns table(
  nombre text, equipo text, liga text, categoria_edad text, cantidad int
)
language plpgsql
stable
as $$
begin
  if p_tipo not in ('amarilla', 'roja', 'doble_amarilla', 'verde') then
    raise exception 'Tipo de tarjeta no válido: %', p_tipo;
  end if;

  return query execute format($f$
    select j.nombre, e.nombre, li.nombre, coalesce(li.categoria_edad_ffcv, li.nombre), j.tarjetas_%s
    from jugadores j
    join equipos e on e.id = j.equipo_id
    join grupos g on g.id = e.grupo_id
    join ligas li on li.id = g.liga_id
    join categorias c on c.id = li.categoria_id
    join temporadas t on t.id = c.temporada_id
    where t.activa = true
      and j.tarjetas_%s is not null and j.tarjetas_%s > 0
      and ($1 is null or li.categoria_edad_ffcv ilike '%%' || $1 || '%%' or li.nombre ilike '%%' || $1 || '%%')
    order by j.tarjetas_%s desc
    limit greatest(1, least($2, 50))
  $f$, p_tipo, p_tipo, p_tipo, p_tipo)
  using p_categoria, p_top_n;
end;
$$;

grant execute on function agente_listar_categorias() to authenticated;
grant execute on function agente_buscar_goleadores(text, int, int) to authenticated;
grant execute on function agente_estadisticas_jugador(text) to authenticated;
grant execute on function agente_buscar_tarjetas(text, text, int) to authenticated;
