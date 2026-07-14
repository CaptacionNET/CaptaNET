-- ============================================================
-- CaptaNET · Programador semanal del importador FFCV
-- Ejecutar en Supabase → SQL Editor (una vez).
-- Requiere las extensiones pg_cron y pg_net (Database → Extensions).
--
-- Cómo funciona:
--   - El SÁBADO a las 03:00 lanza "descubrir" (cataloga grupos, llena la cola).
--   - Cada 3 minutos (sábado y domingo) lanza "procesar", que avanza un lote.
--     Como cada lote procesa unos equipos y para, en 1-2 días recorre todo solo.
--
-- SUSTITUYE antes de ejecutar:
--   <PROJECT_REF>      -> tu ref de proyecto (bnqoisjvboytiphiwosj)
--   <FFCV_CRON_SECRET> -> el mismo valor que pongas en el secreto FFCV_CRON_SECRET
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) Descubrir: sábado 03:00
select cron.schedule(
  'ffcv-descubrir',
  '0 3 * * 6',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/importar-ffcv',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<FFCV_CRON_SECRET>'),
    body    := jsonb_build_object('accion','descubrir')
  );
  $$
);

-- 2) Procesar: cada 3 min, solo sábado (6) y domingo (0)
select cron.schedule(
  'ffcv-procesar',
  '*/3 * * * 6,0',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/importar-ffcv',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<FFCV_CRON_SECRET>'),
    body    := jsonb_build_object('accion','procesar','lote',40)
  );
  $$
);

-- Para ver los cron programados:   select * from cron.job;
-- Para borrar uno:                 select cron.unschedule('ffcv-procesar');
