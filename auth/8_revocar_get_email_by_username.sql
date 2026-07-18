-- ============================================================
-- CaptaNET · Última limpieza: la función get_email_by_username ya no
-- la usa nadie desde el navegador (login y recuperación de contraseña
-- pasan por las Edge Functions login-usuario y recuperar-password).
-- ============================================================

revoke execute on function get_email_by_username(text) from anon;
