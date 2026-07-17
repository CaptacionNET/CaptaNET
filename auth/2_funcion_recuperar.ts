// ============================================================
// CaptaNET · Edge Function "recuperar-password"
// Envía el email de recuperación de contraseña sin revelar nunca al
// navegador si el usuario existe: la respuesta es siempre { ok: true },
// exista o no ese nombre de usuario.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const { username, redirectTo } = await req.json();

    if (username) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

      const adminClient = createClient(supabaseUrl, serviceKey);
      const { data: perfil } = await adminClient
        .from("profiles").select("email").eq("username", username).maybeSingle();

      if (perfil?.email) {
        const authClient = createClient(supabaseUrl, anonKey);
        await authClient.auth.resetPasswordForEmail(perfil.email, { redirectTo });
      }
    }

    return json({ ok: true });
  } catch (e) {
    console.error("[recuperar-password]", e);
    return json({ ok: true });
  }
});
