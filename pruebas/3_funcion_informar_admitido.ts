// ============================================================
// CaptaNET · Edge Function "pruebas-informar-admitido"
// Avisa por email (vía Resend) a una o varias inscripciones de que
// han sido propuestas para un equipo: nombre del equipo, horarios de
// entrenamiento y enlace de matrícula. A diferencia de la
// convocatoria, aquí solo el equipo es obligatorio — horarios y
// enlace de matrícula son opcionales, para poder avisar rápido sin
// tener que rellenar todos los campos. El email incluye un enlace
// para que el jugador conteste si le interesa o no la propuesta; al
// enviarse, el estado pasa a "firmar" (pendiente de completar el
// papeleo), no a "firmado" directamente.
//
// Body JSON:
//   {
//     inscripcion_ids: string[],
//     asunto: string,
//     equipo: string,
//     horarios?: string,
//     link_matricula?: string,
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

function construirCuerpo(nombre: string, equipo: string, horarios: string, linkMatricula: string): string {
  let html = `<p>Hola <b>${escapeHtml(nombre)}</b>,</p><p>¡Enhorabuena! Te proponemos para el equipo <b>${escapeHtml(equipo)}</b>.</p>`;
  if (horarios) html += `<p>🕒 Horarios de entrenamiento: ${escapeHtml(horarios).replace(/\n/g, "<br>")}</p>`;
  if (linkMatricula) {
    html += `
    <div style="margin-top:20px;">
      <a href="${escapeHtml(linkMatricula)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;">Rellenar matrícula</a>
    </div>`;
  }
  return html;
}

function bloqueRespuesta(slug: string | null, inscripcionId: string): string {
  if (!slug) return "";
  const url = `https://${slug}.captacion.net/confirmar_admision.html?id=${inscripcionId}`;
  return `
    <div style="margin-top:24px;padding-top:20px;border-top:1px solid #e2e4eb;">
      <p style="margin:0 0 12px;">¿Qué te parece la propuesta?</p>
      <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;">Responder</a>
    </div>`;
}

// El nombre del club va como "display name" del remitente, para que el
// jugador sepa de qué club es el aviso aunque reciba varios.
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

    const { inscripcion_ids, asunto, equipo, horarios, link_matricula } = await req.json();
    if (!Array.isArray(inscripcion_ids) || !inscripcion_ids.length) {
      return json({ error: "Faltan inscripcion_ids" }, 400);
    }
    if (!asunto) return json({ error: "Falta el asunto" }, 400);
    if (!equipo) return json({ error: "Falta el equipo admitido" }, 400);

    // RLS filtra automáticamente a las filas del club del que llama.
    const { data: filas, error: errFilas } = await userClient
      .from("pruebas_inscripciones")
      .select("id, nombre, email, club_id")
      .in("id", inscripcion_ids);
    if (errFilas) return json({ error: errFilas.message }, 500);

    const clubIds = [...new Set((filas || []).map(f => f.club_id))];
    const { data: clubes, error: errClubes } = await userClient
      .from("clubs").select("id, nombre, slug").in("id", clubIds);
    if (errClubes) return json({ error: errClubes.message }, 500);

    const enviados: string[] = [];
    const sinEmail: string[] = [];
    const fallidos: { id: string; error: string }[] = [];

    for (const fila of filas || []) {
      if (!fila.email) { sinEmail.push(fila.id); continue; }

      const club = (clubes || []).find(c => c.id === fila.club_id);

      const html = construirCuerpo(fila.nombre, equipo, horarios || "", link_matricula || "")
        + bloqueRespuesta(club?.slug || null, fila.id);

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

    if (enviados.length) {
      const { error: errUpdate } = await userClient
        .from("pruebas_inscripciones")
        .update({ estado: "firmar", equipo_propuesto: equipo })
        .in("id", enviados);
      if (errUpdate) console.error("[pruebas-informar-admitido] update tras envío:", errUpdate);
    }

    return json({ enviados: enviados.length, sin_email: sinEmail, fallidos });
  } catch (e) {
    console.error("[pruebas-informar-admitido]", e);
    return json({ error: String(e) }, 500);
  }
});
