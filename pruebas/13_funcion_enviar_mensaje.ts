// ============================================================
// CaptaNET · Edge Function "pruebas-enviar-mensaje"
// Envía por email (vía Resend) un mensaje personalizado y libre a una
// o varias inscripciones seleccionadas — para cualquier comunicación
// que no encaje en "convocatoria" ni en "equipo admitido" (avisos,
// aclaraciones, etc.). No toca el estado de la inscripción: es solo
// un mensaje, no representa un paso del proceso.
//
// Body JSON:
//   {
//     inscripcion_ids: string[],
//     asunto: string,
//     cuerpo: string,   // texto libre, se muestra tal cual (con saltos de línea)
//   }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const DOMINIO_REMITENTE = "pruebas@notificaciones.captacion.net";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function construirCuerpo(nombre: string, cuerpo: string): string {
  return `<p>Hola <b>${escapeHtml(nombre)}</b>,</p><p>${escapeHtml(cuerpo).replace(/\n/g, "<br>")}</p>`;
}

// El nombre del club va como "display name" del remitente, para que el
// jugador sepa de qué club es el mensaje aunque reciba varios.
function remitentePara(clubNombre: string | null): string {
  const limpio = (clubNombre || "CaptaNET").replace(/[\r\n"<>]/g, "").trim() || "CaptaNET";
  return `"${limpio}" <${DOMINIO_REMITENTE}>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) return json({ error: "Falta configurar RESEND_API_KEY" }, 500);

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "No autenticado" }, 401);

    const { inscripcion_ids, asunto, cuerpo } = await req.json();
    if (!Array.isArray(inscripcion_ids) || !inscripcion_ids.length) {
      return json({ error: "Faltan inscripcion_ids" }, 400);
    }
    if (!asunto) return json({ error: "Falta el asunto" }, 400);
    if (!cuerpo) return json({ error: "Falta el mensaje" }, 400);

    // RLS filtra automáticamente a las filas del club del que llama.
    const { data: filas, error: errFilas } = await userClient
      .from("pruebas_inscripciones")
      .select("id, nombre, email, club_id")
      .in("id", inscripcion_ids);
    if (errFilas) return json({ error: errFilas.message }, 500);

    const clubIds = [...new Set((filas || []).map(f => f.club_id))];
    const { data: clubes, error: errClubes } = await userClient
      .from("clubs").select("id, nombre").in("id", clubIds);
    if (errClubes) return json({ error: errClubes.message }, 500);

    const enviados: string[] = [];
    const sinEmail: string[] = [];
    const fallidos: { id: string; error: string }[] = [];

    for (const fila of filas || []) {
      if (!fila.email) { sinEmail.push(fila.id); continue; }

      const club = (clubes || []).find(c => c.id === fila.club_id);
      const html = construirCuerpo(fila.nombre, cuerpo);

      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: remitentePara(club?.nombre || null), to: fila.email, subject: asunto, html }),
      });

      if (!resp.ok) {
        fallidos.push({ id: fila.id, error: await resp.text() });
        continue;
      }
      enviados.push(fila.id);
    }

    return json({ enviados: enviados.length, sin_email: sinEmail, fallidos });
  } catch (e) {
    console.error("[pruebas-enviar-mensaje]", e);
    return json({ error: String(e) }, 500);
  }
});
