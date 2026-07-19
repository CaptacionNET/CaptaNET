// ============================================================
// CaptaNET · Edge Function "subir-foto-informe"
// Sube la foto que un club añade a mano en el informe de un jugador
// (distinta de la oficial de la FFCV) al mismo bucket R2 que ya usa
// el importador. Solo sube el fichero y devuelve la URL pública: el
// guardado en jugadores_club.foto_url lo hace el cliente después,
// con su propio permiso (RLS ya limita eso a su club).
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

    const { data: perfil } = await userClient.from("profiles").select("club_id").eq("id", u.user.id).single();
    if (!perfil?.club_id) return json({ error: "Tu cuenta no tiene un club asignado" }, 403);

    const { jugador_id, data_uri } = await req.json();
    if (!jugador_id || !data_uri || !data_uri.startsWith("data:")) {
      return json({ error: "Faltan datos de la imagen" }, 400);
    }

    const coma = data_uri.indexOf(",");
    const mime = data_uri.slice(5, coma).split(";")[0] || "image/jpeg";
    if (!mime.startsWith("image/")) return json({ error: "El archivo no es una imagen" }, 400);

    const bytes = Uint8Array.from(atob(data_uri.slice(coma + 1)), (c: string) => c.charCodeAt(0));
    if (bytes.length > 5 * 1024 * 1024) return json({ error: "La imagen pesa demasiado (máximo 5 MB)" }, 400);

    const extension = mime.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
    const nombreArchivo = `informes/${perfil.club_id}/${jugador_id}-${Date.now()}.${extension}`;

    const account = Deno.env.get("R2_ACCOUNT_ID")!;
    const bucket = Deno.env.get("R2_BUCKET")!;
    const endpoint = `https://${account}.r2.cloudflarestorage.com/${bucket}/${nombreArchivo}`;

    const resp = await r2Client().fetch(endpoint, { method: "PUT", body: bytes, headers: { "Content-Type": mime } });
    if (!resp.ok) return json({ error: "Error subiendo la imagen: " + (await resp.text()) }, 500);

    return json({ url: `${Deno.env.get("R2_PUBLIC_URL")}/${nombreArchivo}` });
  } catch (e) {
    console.error("[subir-foto-informe]", e);
    return json({ error: String(e) }, 500);
  }
});
