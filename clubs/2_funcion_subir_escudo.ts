// ============================================================
// CaptaNET · Edge Function "subir-escudo-club"
// Sube el escudo de un club al mismo bucket R2 que ya usan las fotos
// de informes. Solo el admin global puede subir escudos (se gestionan
// desde el panel de administración). Solo sube el fichero y devuelve
// la URL pública: guardarla en clubs.escudo_url lo hace el cliente
// después con su propio permiso.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.18";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function r2Client() {
  return new AwsClient({
    accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID")!,
    secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY")!,
    service: "s3",
    region: "auto",
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "No autenticado" }, 401);

    const { data: perfil } = await userClient.from("profiles").select("is_admin").eq("id", u.user.id).single();
    if (!perfil?.is_admin) return json({ error: "Solo el administrador puede subir escudos" }, 403);

    const { club_id, data_uri } = await req.json();
    if (!club_id || !data_uri || !data_uri.startsWith("data:")) {
      return json({ error: "Faltan datos de la imagen" }, 400);
    }

    const coma = data_uri.indexOf(",");
    const mime = data_uri.slice(5, coma).split(";")[0] || "image/png";
    if (!mime.startsWith("image/")) return json({ error: "El archivo no es una imagen" }, 400);

    const bytes = Uint8Array.from(atob(data_uri.slice(coma + 1)), (c: string) => c.charCodeAt(0));
    if (bytes.length > 3 * 1024 * 1024) return json({ error: "La imagen pesa demasiado (máximo 3 MB)" }, 400);

    const extension = mime.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const nombreArchivo = `escudos/${club_id}-${Date.now()}.${extension}`;

    const account = Deno.env.get("R2_ACCOUNT_ID")!;
    const bucket = Deno.env.get("R2_BUCKET")!;
    const endpoint = `https://${account}.r2.cloudflarestorage.com/${bucket}/${nombreArchivo}`;

    const resp = await r2Client().fetch(endpoint, { method: "PUT", body: bytes, headers: { "Content-Type": mime } });
    if (!resp.ok) return json({ error: "Error subiendo la imagen: " + (await resp.text()) }, 500);

    return json({ url: `${Deno.env.get("R2_PUBLIC_URL")}/${nombreArchivo}` });
  } catch (e) {
    console.error("[subir-escudo-club]", e);
    return json({ error: String(e) }, 500);
  }
});
