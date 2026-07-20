// ============================================================
// CaptaNET · Edge Function "pruebas-enviar-convocatoria"
// Envía por email (vía Resend) la convocatoria de la prueba a una
// o varias inscripciones seleccionadas, y marca esas filas como
// citadas. Se apoya en RLS: la consulta a pruebas_inscripciones se
// hace con el JWT del que llama, así que solo puede tocar filas de
// su propio club (o todas, si es admin global) sin comprobarlo a mano.
//
// Body JSON:
//   {
//     inscripcion_ids: string[],
//     asunto: string,
//     nota?: string,    // texto libre opcional, sin marcadores que rellenar
//     dia?: string,     // "YYYY-MM-DD", opcional: si viene, se guarda en la fila
//     hora?: string,    // "HH:MM", opcional
//     lugar?: string,   // opcional
//   }
// El cuerpo del email (saludo, día/hora/lugar, botón de confirmar) se
// construye aquí siempre igual — el panel ya no pide escribir ningún
// marcador tipo {{nombre}}, solo rellenar los campos normales.
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

function formatearFecha(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function construirCuerpo(nombre: string, diaFmt: string, hora: string, lugar: string, nota: string): string {
  let html = `<p>Hola <b>${escapeHtml(nombre)}</b>,</p><p>Te confirmamos tu prueba:</p>`;
  html += "<ul style='margin:6px 0;padding-left:18px;'>";
  html += `<li>📅 Día: ${diaFmt ? escapeHtml(diaFmt) : "por confirmar"}</li>`;
  html += `<li>🕒 Hora: ${hora ? escapeHtml(hora) : "por confirmar"}</li>`;
  html += `<li>📍 Lugar: ${lugar ? escapeHtml(lugar) : "por confirmar"}</li>`;
  html += "</ul>";
  if (nota) html += `<p>${escapeHtml(nota).replace(/\n/g, "<br>")}</p>`;
  return html;
}

// El nombre del club va como "display name" del remitente, para que el
// jugador sepa de qué club es la convocatoria aunque reciba varias.
function remitentePara(clubNombre: string | null): string {
  const limpio = (clubNombre || "CaptaNET").replace(/[\r\n"<>]/g, "").trim() || "CaptaNET";
  return `"${limpio}" <${DOMINIO_REMITENTE}>`;
}

function bloqueConfirmacion(slug: string | null, inscripcionId: string): string {
  if (!slug) return "";
  const url = `https://${slug}.captacion.net/confirmar_prueba.html?id=${inscripcionId}`;
  return `
    <div style="margin-top:24px;padding-top:20px;border-top:1px solid #e2e4eb;">
      <p style="margin:0 0 12px;">¿Podrás asistir?</p>
      <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;">Confirmar asistencia</a>
    </div>`;
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

    const { inscripcion_ids, asunto, nota, dia, hora, lugar } = await req.json();
    if (!Array.isArray(inscripcion_ids) || !inscripcion_ids.length) {
      return json({ error: "Faltan inscripcion_ids" }, 400);
    }
    if (!asunto) return json({ error: "Falta el asunto" }, 400);

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

    const diaFmt = formatearFecha(dia || null);
    const enviados: string[] = [];
    const sinEmail: string[] = [];
    const fallidos: { id: string; error: string }[] = [];

    for (const fila of filas || []) {
      if (!fila.email) { sinEmail.push(fila.id); continue; }

      const club = (clubes || []).find(c => c.id === fila.club_id);

      const html = construirCuerpo(fila.nombre, diaFmt, hora || "", lugar || "", nota || "")
        + bloqueConfirmacion(club?.slug || null, fila.id);

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
      const update: Record<string, unknown> = { estado: "citado", notificado_at: new Date().toISOString() };
      if (dia) update.dia_prueba = dia;
      if (hora) update.hora_prueba = hora;
      if (lugar) update.lugar_prueba = lugar;

      const { error: errUpdate } = await userClient
        .from("pruebas_inscripciones").update(update).in("id", enviados);
      if (errUpdate) console.error("[pruebas-enviar-convocatoria] update tras envío:", errUpdate);
    }

    return json({ enviados: enviados.length, sin_email: sinEmail, fallidos });
  } catch (e) {
    console.error("[pruebas-enviar-convocatoria]", e);
    return json({ error: String(e) }, 500);
  }
});
