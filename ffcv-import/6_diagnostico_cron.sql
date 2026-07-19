-- ============================================================
-- CaptaNET · Diagnóstico (solo lectura) del cron del importador FFCV.
-- No cambia nada, solo enseña qué ha pasado en las últimas llamadas.
-- ============================================================

-- 1) ¿Existe la clave de servicio que necesita el cron? (no enseña el
--    valor, solo si está o no)
select clave, (valor is not null) as tiene_valor
from ffcv_config
where clave in ('cron_secret', 'service_role_key');

-- 2) Las últimas 15 ejecuciones reales del cron: si "status" no es
--    "succeeded", o si "return_message" tiene un error, ahí está la causa.
select
  jrd.start_time, jrd.status, jrd.return_message
from cron.job_run_details jrd
join cron.job j on j.jobid = jrd.jobid
where j.jobname = 'ffcv-procesar-ahora'
order by jrd.start_time desc
limit 15;
