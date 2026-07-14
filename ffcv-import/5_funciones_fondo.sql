-- ============================================================
-- CaptaNET · Funciones para lanzar/parar el "segundo plano" del
-- importador FFCV desde el propio panel (sin pegar SQL a mano).
-- Ejecutar UNA vez en Supabase → SQL Editor. Es un añadido nuevo,
-- no toca nada de lo que ya esté corriendo.
-- ============================================================

create or replace function ffcv_programar_fondo(p_secreto text)
returns text
language plpgsql
security definer
as $$
begin
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
      p_secreto
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

grant execute on function ffcv_programar_fondo(text) to service_role;
grant execute on function ffcv_detener_fondo()        to service_role;
grant execute on function ffcv_estado_fondo()          to service_role;
