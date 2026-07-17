-- ============================================================
-- CaptaNET · Cierre de permisos públicos innecesarios
-- Todo lo de aquí abajo son funciones que un visitante SIN iniciar
-- sesión puede llamar hoy directamente (revisar sección "por qué" en
-- cada bloque), y que no deberían ser públicas. Quitarles el permiso
-- a "anon" no rompe nada: ninguna de ellas se llama desde el
-- navegador sin sesión, así que esto solo cierra una puerta que
-- estaba abierta de más.
-- ============================================================

-- 1) Control del importador FFCV (arrancar/parar/consultar el proceso
--    en segundo plano). Solo se llaman desde dentro de la Edge Function
--    "importar-ffcv", que usa la service_role key (no se ve afectada
--    por estos revoke). Que cualquiera en internet pudiera pararlas o
--    lanzarlas a la vez es justo el tipo de "ataque masivo" que
--    comentábamos: alguien podría machacar ffcv_programar_fondo() en
--    bucle y hacer que el sistema golpee la web de la FFCV sin parar.
revoke execute on function ffcv_detener_fondo() from anon;
revoke execute on function ffcv_programar_fondo() from anon;
revoke execute on function ffcv_estado_fondo() from anon;

-- 2) get_table_columns: no se usa desde ningún sitio del código actual
--    (parece un resto de una versión anterior del panel de admin).
--    Devuelve la estructura de las tablas, información que no debería
--    poder pedir cualquiera sin iniciar sesión.
revoke execute on function get_table_columns(text) from anon;

-- 3) Funciones internas de los triggers que mantienen el nombre sin
--    acentos actualizado. No están pensadas para llamarse a mano, así
--    que tampoco necesitan ser públicas.
revoke execute on function equipos_actualizar_nombre_normalizado() from anon;
revoke execute on function jugadores_actualizar_nombre_normalizado() from anon;

-- 4) get_email_by_username: sustituida hoy por las Edge Functions
--    "login-usuario" y "recuperar-password" (ver commit de seguridad).
--    Ejecuta esta línea solo DESPUÉS de comprobar que el login y la
--    recuperación de contraseña funcionan bien con las nuevas funciones.
revoke execute on function get_email_by_username(text) from anon;
