-- ============================================================
-- CaptaNET · Funciones para lanzar/parar el "segundo plano" del
-- importador FFCV desde el propio panel (sin pegar SQL a mano).
-- Ejecutar en Supabase → SQL Editor.
--
-- ACTUALIZACIÓN: antes el secreto del cron vivía en DOS sitios
-- independientes (la variable de entorno FFCV_CRON_SECRET de la Edge
-- Function, y una copia clavada dentro del propio cron al activarlo).
-- Si esas dos copias se desincronizaban por cualquier motivo, el cron
-- se quedaba llamando cada minuto y fallando con 401 para siempre, en
-- silencio ("Corriendo en el servidor" en verde, pero sin avanzar).
-- Ahora el secreto vive en UN solo sitio (la tabla ffcv_config) y
-- tanto el cron como la Edge Function comparan siempre ese mismo
-- valor. Si ya tenías la versión anterior instalada, vuelve a
-- ejecutar este archivo entero: sustituye la función vieja.
-- ============================================================

create extension if not exists pgcrypto; -- para gen_random_bytes()

create table if not exists ffcv_config (
  clave text primary key,
  valor text not null
);
alter table ffcv_config enable row level security;
-- Sin políticas: nadie con la clave anónima/autenticada puede leerla.
-- Solo las funciones SECURITY DEFINER de aquí abajo y el service_role
-- (que usa la Edge Function) pueden acceder.

-- Se genera solo, una vez, la primera vez que se ejecuta este archivo.
insert into ffcv_config (clave, valor)
  select 'cron_secret', encode(gen_random_bytes(24), 'hex')
  where not exists (select 1 from ffcv_config where clave = 'cron_secret');

-- La versión anterior recibía el secreto por parámetro (podía quedar
-- desincronizada); esta lo lee siempre de ffcv_config.
drop function if exists ffcv_programar_fondo(text);

create or replace function ffcv_programar_fondo()
returns text
language plpgsql
security definer
as $$
declare
  v_secreto text;
begin
  select valor into v_secreto from ffcv_config where clave = 'cron_secret';
  if v_secreto is null then
    raise exception 'No hay cron_secret en ffcv_config';
  end if;

  perform cron.schedule(
    'ffcv-procesar-ahora',
    '* * * * *',
    format(
      $job$
      select case
        when (select count(*) from ffcv_cola where estado = 'pendiente') = 0
          then (select cron.unschedule('ffcv-procesar-ahora'))::text
        else (select net.http_post(
          url     := 'https://bnqoisjvboytiphiwosj.supabase.co/functions/v1/importar-ffcv',
          headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','%s'),
          body    := jsonb_build_object('accion','procesar','lote',40)
        ))::text
      end;
      $job$,
      v_secreto
    )
  );
  return 'programado';
end;
$$;

create or replace function ffcv_detener_fondo()
returns text
language plpgsql
security definer
as $$
begin
  if exists (select 1 from cron.job where jobname = 'ffcv-procesar-ahora') then
    perform cron.unschedule('ffcv-procesar-ahora');
    return 'detenido';
  end if;
  return 'no_estaba_activo';
end;
$$;

create or replace function ffcv_estado_fondo()
returns boolean
language sql
security definer
as $$
  select exists (select 1 from cron.job where jobname = 'ffcv-procesar-ahora');
$$;

grant execute on function ffcv_programar_fondo()     to service_role;
grant execute on function ffcv_detener_fondo()        to service_role;
grant execute on function ffcv_estado_fondo()          to service_role;
