// ============================================================
// CaptaNET · Edge Function "ruta-agente"
// Asistente de preguntas en lenguaje natural sobre los datos ya
// importados de la FFCV (goleadores, tarjetas, minutos...). Fase 1:
// acotado a lo que la base de datos ya tiene — las preguntas de
// clasificación/posición en tabla quedan fuera (no guardamos eso en
// ningún sitio), el propio prompt le pide a Claude decirlo en vez de
// inventar.
//
// Claude NUNCA genera SQL: solo puede llamar a un puñado de funciones
// de Postgres ya definidas y parametrizadas (ver
// ruta/11_migracion_agente_funciones.sql), ejecutadas con el cliente
// autenticado del usuario (respetan la RLS normal de cada tabla).
//
// Body JSON: { mensaje: string, historial?: AnthropicMessage[] }
// El frontend solo necesita guardar y reenviar `historial` tal cual
// (es el propio formato de mensajes de Anthropic) para que la
// conversación tenga memoria entre turnos — no necesita entenderlo.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MODELO = "claude-sonnet-5";
const MAX_TURNOS_HERRAMIENTA = 4;

const SYSTEM_PROMPT = `Eres el Asistente de datos de scouting de CaptaNET, para clubes de fútbol base de la Comunidad Valenciana.

Respondes preguntas sobre los jugadores ya importados de la FFCV en la temporada activa: goleadores, tarjetas, minutos jugados, datos básicos de un jugador concreto. Solo puedes usar las herramientas disponibles para consultar datos reales — nunca inventes cifras ni nombres.

Importante — fuera de tu alcance: NO tenemos guardada la clasificación ni la posición en la tabla de ninguna liga, en ningún sitio. Si te preguntan algo de ese estilo ("quién va primero", "un partido entre el primero y el segundo", etc.), dilo con claridad: no dispones de esa información todavía. No lo intentes deducir ni lo inventes.

Si el nombre de categoría que te dan no encuentra resultados, usa listar_categorias_disponibles para comprobar el nombre exacto antes de rendirte o de decir que no hay datos.

Responde siempre en español, de forma breve y concreta, citando los números reales que te devuelvan las herramientas.`;

const HERRAMIENTAS = [
  {
    name: "buscar_goleadores",
    description: "Máximos goleadores de una categoría de edad (temporada activa), opcionalmente acotado a un año de nacimiento exacto (útil para distinguir 'primer año' de 'segundo año' dentro de una categoría de dos años).",
    input_schema: {
      type: "object",
      properties: {
        categoria: { type: "string", description: "Categoría de edad, p.ej. 'Infantil', 'Cadete', 'Alevín'." },
        anio_nacimiento: { type: "integer", description: "Año de nacimiento exacto para acotar (opcional)." },
        top_n: { type: "integer", description: "Cuántos jugadores devolver como máximo (por defecto 10)." },
      },
      required: ["categoria"],
    },
  },
  {
    name: "estadisticas_jugador",
    description: "Busca uno o varios jugadores por nombre (puede haber homónimos) y devuelve su ficha completa de estadísticas de la temporada.",
    input_schema: {
      type: "object",
      properties: { nombre: { type: "string", description: "Nombre o parte del nombre del jugador." } },
      required: ["nombre"],
    },
  },
  {
    name: "buscar_tarjetas",
    description: "Ranking de jugadores por número de tarjetas de un tipo concreto, opcionalmente acotado a una categoría de edad.",
    input_schema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["amarilla", "roja", "doble_amarilla", "verde"] },
        categoria: { type: "string", description: "Categoría de edad (opcional)." },
        top_n: { type: "integer", description: "Cuántos jugadores devolver como máximo (por defecto 10)." },
      },
      required: ["tipo"],
    },
  },
  {
    name: "listar_categorias_disponibles",
    description: "Lista las categorías de edad con ligas activas ahora mismo, con el nombre exacto que hay que usar en las demás herramientas.",
    input_schema: { type: "object", properties: {} },
  },
];

async function ejecutarHerramienta(nombre: string, entrada: any, userClient: any): Promise<any> {
  if (nombre === "buscar_goleadores") {
    const { data, error } = await userClient.rpc("agente_buscar_goleadores", {
      p_categoria: entrada.categoria, p_anio_nacimiento: entrada.anio_nacimiento ?? null, p_top_n: entrada.top_n ?? 10,
    });
    return error ? { error: error.message } : { resultados: data };
  }
  if (nombre === "estadisticas_jugador") {
    const { data, error } = await userClient.rpc("agente_estadisticas_jugador", { p_nombre: entrada.nombre });
    return error ? { error: error.message } : { resultados: data };
  }
  if (nombre === "buscar_tarjetas") {
    const { data, error } = await userClient.rpc("agente_buscar_tarjetas", {
      p_tipo: entrada.tipo, p_categoria: entrada.categoria ?? null, p_top_n: entrada.top_n ?? 10,
    });
    return error ? { error: error.message } : { resultados: data };
  }
  if (nombre === "listar_categorias_disponibles") {
    const { data, error } = await userClient.rpc("agente_listar_categorias");
    return error ? { error: error.message } : { resultados: data };
  }
  return { error: `Herramienta desconocida: ${nombre}` };
}

// `conHerramientas = false` fuerza una respuesta de solo texto (sin
// `tools` en la petición, Claude no puede pedir ninguna) — se usa en el
// último turno permitido para no dejar nunca un tool_use sin su
// tool_result correspondiente en el historial devuelto al frontend.
async function llamarClaude(mensajes: any[], apiKey: string, conHerramientas: boolean): Promise<any> {
  const body: any = { model: MODELO, max_tokens: 1024, system: SYSTEM_PROMPT, messages: mensajes };
  if (conHerramientas) body.tools = HERRAMIENTAS;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Anthropic API -> ${resp.status}: ${await resp.text()}`);
  return await resp.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Falta configurar ANTHROPIC_API_KEY" }, 500);

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "No autenticado" }, 401);

    const { mensaje, historial } = await req.json().catch(() => ({}));
    if (!mensaje || !String(mensaje).trim()) return json({ error: "Falta el mensaje" }, 400);

    let mensajes: any[] = [...(Array.isArray(historial) ? historial : []), { role: "user", content: String(mensaje) }];
    let turnos = 0;

    while (true) {
      const permiteHerramientas = turnos < MAX_TURNOS_HERRAMIENTA;
      const respuesta = await llamarClaude(mensajes, apiKey, permiteHerramientas);
      const bloques: any[] = respuesta.content || [];
      const texto = bloques.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      const usosHerramienta = permiteHerramientas ? bloques.filter(b => b.type === "tool_use") : [];

      mensajes.push({ role: "assistant", content: bloques });

      if (!usosHerramienta.length) {
        return json({
          respuesta: texto || "No he podido generar una respuesta con los datos disponibles.",
          historial: mensajes,
        });
      }

      const resultados = [];
      for (const uso of usosHerramienta) {
        const resultado = await ejecutarHerramienta(uso.name, uso.input || {}, userClient);
        resultados.push({ type: "tool_result", tool_use_id: uso.id, content: JSON.stringify(resultado) });
      }
      mensajes.push({ role: "user", content: resultados });
      turnos++;
    }
  } catch (e) {
    console.error("[ruta-agente]", e);
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
