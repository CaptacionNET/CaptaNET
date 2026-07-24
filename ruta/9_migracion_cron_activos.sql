-- ============================================================
-- CaptaNET · Programador del refresco de partidos activos (RUTA)
-- Ejecutar en Supabase → SQL Editor (una vez).
-- Requiere las extensiones pg_cron y pg_net (Database → Extensions) —
-- ya deberían estar activas si se ejecutó ffcv-import/3_cron.sql.
--
-- Los horarios de la FFCV se publican/actualizan los lunes por la
-- noche, así que no hace falta refrescar a diario:
--   - Martes a las 6:00, 10:00 y 17:00.
--   - Miércoles, jueves y viernes a las 11:00 y 16:00.
-- (9 ejecuciones/semana. Cada pase completo tarda del orden de 1-2
-- minutos con la concurrencia actual — ver ruta/8_funcion_ruta_refrescar_activos.ts.)
--
-- SUSTITUYE antes de ejecutar:
--   <FFCV_CRON_SECRET> -> el mismo valor que ya usa ffcv-import (tabla ffcv_config, clave 'cron_secret')
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Martes: 6:00, 10:00 y 17:00
select cron.schedule(
  'ruta-refrescar-activos-martes',
  '0 6,10,17 * * 2',
  $$
  select net.http_post(
    url     := 'https://bnqoisjvboytiphiwosj.supabase.co/functions/v1/ruta-refrescar-activos',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<FFCV_CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);

-- Miércoles, jueves y viernes: 11:00 y 16:00
select cron.schedule(
  'ruta-refrescar-activos-xjv',
  '0 11,16 * * 3,4,5',
  $$
  select net.http_post(
    url     := 'https://bnqoisjvboytiphiwosj.supabase.co/functions/v1/ruta-refrescar-activos',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<FFCV_CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);

-- Para ver los cron programados:   select * from cron.job;
-- Para ver si están funcionando:   select * from cron.job_run_details order by start_time desc limit 20;
-- Para borrar uno:                 select cron.unschedule('ruta-refrescar-activos-martes');
