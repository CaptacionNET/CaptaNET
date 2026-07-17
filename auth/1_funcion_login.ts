// ============================================================
// CaptaNET · Edge Function "login-usuario"
// Convierte usuario+contraseña en una sesión, sin que el navegador
// llegue nunca a saber si el usuario existe o no: tanto si el usuario
// no existe como si la contraseña es incorrecta, la respuesta (y el
// tiempo que tarda) es la misma. Antes esto se hacía con una consulta
// RPC pública que devolvía el email real asociado al usuario, lo que
// permitía a cualquiera comprobar qué nombres de usuario existen y
// cuál es su email (ver commit de seguridad correspondiente).
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ERROR_GENERICO = "Usuario o contraseña incorrectos.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const { username, password } = await req.json();
    if (!username || !password) return json({ error: ERROR_GENERICO }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: perfil } = await adminClient
      .from("profiles").select("email").eq("username", username).maybeSingle();

    // Si el usuario no existe, probamos igualmente con un email inventado:
    // así la respuesta es indistinguible de "usuario real, contraseña mal".
    const email = perfil?.email || `sin-usuario-${crypto.randomUUID()}@invalido.captacion.net`;

    const authClient = createClient(supabaseUrl, anonKey);
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });

    if (error || !data.session) return json({ error: ERROR_GENERICO }, 401);

    return json({ session: data.session });
  } catch (e) {
    console.error("[login-usuario]", e);
    return json({ error: ERROR_GENERICO }, 401);
  }
});
