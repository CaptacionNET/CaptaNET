-- ============================================================
-- CaptaNET · Procesar el importador FFCV en segundo plano, YA
-- (sin esperar al lunes, y sin necesidad de tener el navegador abierto)
--
-- Pégalo y ejecútalo en Supabase → SQL Editor cada vez que quieras que
-- avance solo hasta terminar. Se llama a sí mismo cada minuto y se apaga
-- en cuanto ya no queda nada pendiente en la cola — no hay que pararlo a mano.
--
-- SUSTITUYE antes de ejecutar:
--   <FFCV_CRON_SECRET> -> el mismo valor que pusiste en el secreto FFCV_CRON_SECRET
-- ============================================================

select cron.schedule(
  'ffcv-procesar-ahora',
  '* * * * *',
  $$
  select case
    when (select count(*) from ffcv_cola where estado = 'pendiente') = 0
      then (select cron.unschedule('ffcv-procesar-ahora'))::text
    else (select net.http_post(
      url     := 'https://bnqoisjvboytiphiwosj.supabase.co/functions/v1/importar-ffcv',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<FFCV_CRON_SECRET>'),
      body    := jsonb_build_object('accion','procesar','lote',40)
    ))::text
  end;
  $$
);

-- Para ver el progreso en cualquier momento (sin abrir el panel):
--   select count(*) filter (where estado='pendiente') as pendientes, count(*) as total from ffcv_cola;
--
-- Para pararlo antes de que termine solo:
--   select cron.unschedule('ffcv-procesar-ahora');
