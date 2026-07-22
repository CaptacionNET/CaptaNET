// ============================================================
// CaptaNET · Edge Function "enviar-contacto"
// Formulario "Contacta con nosotros" de la página principal
// (index.html, sin sesión). Envía el mensaje por email (vía Resend) a
// la dirección de contacto interna, que nunca se expone en el cliente
// (no viaja en el body ni aparece en el HTML: vive solo aquí, en el
// servidor).
//
// Body JSON:
//   { nombre: string, email: string, mensaje: string, honeypot?: string }
// ============================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const DESTINATARIO = "arturo@captacion.net";
const REMITENTE = "contacto@notificaciones.captacion.net";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) return json({ error: "Falta configurar RESEND_API_KEY" }, 500);

    const { nombre, email, mensaje, honeypot } = await req.json();

    // Campo trampa invisible para bots: si viene relleno, se responde
    // como si todo hubiera ido bien pero no se envía nada.
    if (honeypot) return json({ ok: true });

    if (!nombre || !String(nombre).trim()) return json({ error: "Falta el nombre" }, 400);
    if (!email || !String(email).trim()) return json({ error: "Falta el email" }, 400);
    if (!mensaje || !String(mensaje).trim()) return json({ error: "Falta el mensaje" }, 400);

    const html = `
      <p><b>Nombre:</b> ${escapeHtml(nombre)}</p>
      <p><b>Email:</b> ${escapeHtml(email)}</p>
      <p><b>Mensaje:</b></p>
      <p>${escapeHtml(mensaje).replace(/\n/g, "<br>")}</p>`;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `"CaptaNET" <${REMITENTE}>`,
        to: DESTINATARIO,
        reply_to: String(email).trim(),
        subject: `Contacto desde CaptaNET · ${nombre}`,
        html,
      }),
    });

    if (!resp.ok) return json({ error: await resp.text() }, 500);

    return json({ ok: true });
  } catch (e) {
    console.error("[enviar-contacto]", e);
    return json({ error: String(e) }, 500);
  }
});
