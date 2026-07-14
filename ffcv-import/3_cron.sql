-- ============================================================
-- CaptaNET · Programador semanal del importador FFCV
-- Ejecutar en Supabase → SQL Editor (una vez).
-- Requiere las extensiones pg_cron y pg_net (Database → Extensions).
--
-- Cómo funciona:
--   - El LUNES a las 08:00 lanza "descubrir" (cataloga grupos, llena la cola).
--   - Cada 3 minutos (lunes y martes) lanza "procesar", que avanza un lote.
--     Como cada lote procesa unos equipos y para, recorre todo solo antes
--     de que acabe el margen de 2 días.
--
-- SUSTITUYE antes de ejecutar:
--   <FFCV_CRON_SECRET> -> el mismo valor que pusiste en el secreto FFCV_CRON_SECRET
-- (el ref de proyecto ya está puesto: bnqoisjvboytiphiwosj)
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) Descubrir: lunes 08:00
select cron.schedule(
  'ffcv-descubrir',
  '0 8 * * 1',
  $$
  select net.http_post(
    url     := 'https://bnqoisjvboytiphiwosj.supabase.co/functions/v1/importar-ffcv',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<FFCV_CRON_SECRET>'),
    body    := jsonb_build_object('accion','descubrir')
  );
  $$
);

-- 2) Procesar: cada 3 min, lunes (1) y martes (2) — margen de sobra para terminar
select cron.schedule(
  'ffcv-procesar',
  '*/3 * * * 1,2',
  $$
  select net.http_post(
    url     := 'https://bnqoisjvboytiphiwosj.supabase.co/functions/v1/importar-ffcv',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<FFCV_CRON_SECRET>'),
    body    := jsonb_build_object('accion','procesar','lote',40)
  );
  $$
);

-- Para ver los cron programados:   select * from cron.job;
-- Para ver si están funcionando:   select * from cron.job_run_details order by start_time desc limit 20;
-- Para borrar uno:                 select cron.unschedule('ffcv-procesar');
