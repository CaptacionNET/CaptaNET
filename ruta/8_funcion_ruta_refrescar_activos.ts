// ============================================================
// CaptaNET · Edge Function "ruta-refrescar-activos"
// Recorre TODAS las competiciones F11/F8 activas de la FFCV (74
// competiciones, 726 grupos comprobado en vivo) y guarda en
// ruta_partidos_activos los partidos de la jornada actual de cada
// grupo. Así el buscador por campo de Horarios consulta una tabla
// local en vez de preguntarle a la FFCV en el momento de la búsqueda
// (recorrer los 726 grupos en caliente tarda varios minutos: no es
// viable hacerlo por cada tecleo). La rellena solo el cron — ver
// ruta/9_migracion_cron_activos.sql.
//
// Autorización: igual que ffcv-import — cabecera X-Cron-Secret ==
// ffcv_config.cron_secret, o admin global por JWT (para poder lanzarla
// a mano y comprobar cuánto tarda de verdad, sin esperar al cron).
//
// Nota de rendimiento: con concurrencia 10, ~1.500 llamadas a la FFCV
// (~0,3s cada una) tardan del orden de 45-75s en total. Si el plan de
// Supabase de este proyecto corta la función antes de acabar, hay que
// partir esto en cola + lotes (mismo patrón que ffcv_cola en
// ffcv-import) en vez de una sola pasada — probar primero esta versión
// simple y medir.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const FFCV = "https://ffcv.es/competiciones/api";
const NOVANET = "https://appwebffcv.novanet.es";
const MODALIDADES_PERMITIDAS = ["MASCULÍ F11", "MASCULÍ F8"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const CONCURRENCIA = 10;

const limpiar = (s: unknown) => (s == null ? "" : String(s)).trim();
const urlEscudo = (r: string | null | undefined) => (r ? `${NOVANET}${r}` : null);
const partidoJugado = (resultado: string) => /\d/.test(resultado || "");

async function ffcvGet(path: string): Promise<any> {
  const r = await fetch(`${FFCV}/${path}`, { headers: { "User-Agent": UA, "Accept": "application/json" }, cache: "no-cache" as any });
  if (!r.ok) throw new Error(`FFCV ${path} -> ${r.status}`);
  return await r.json();
}

function normalizarTexto(s: string): string {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Quita el sufijo de subcampo ("F-11", "F8-1", "Campo B", "Campo A1",
// "Campo D2"...) para que buscar el nombre de la instalación encuentre
// los partidos de todos sus subcampos a la vez. Heurística: "Campo X"
// cuenta como subcampo cuando X son 1-3 caracteres alfanuméricos cortos
// (letras, dígitos, o ambos combinados) que no sean una palabra común
// española corta (de/del/la/el/los/las/en) — así no se come "Campo
// Municipal" (demasiado largo) ni "Campo de Fútbol..." (por la
// exclusión de "de").
function normalizarCampo(campo: string): string {
  let t = normalizarTexto(campo);
  t = t.replace(/\bf-?\d+(-\d+)?\b/g, " ");
  t = t.replace(/\bcampo\s+(?!de\b|del\b|la\b|el\b|los\b|las\b|en\b)[a-z0-9]{1,3}\b/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

function fechaFfcvADate(f: string | null | undefined): Date | null {
  const m = (f || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`) : null;
}

// Misma lógica que el frontend (cargarJornadas en ruta.html): la
// primera jornada con fecha de hoy en adelante, o si no hay ninguna, la última.
function elegirJornadaActual(jornadas: { codjornada: string; fecha: string }[]): { codjornada: string; fecha: string } | null {
  if (!jornadas.length) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const idx = jornadas.findIndex(j => { const f = fechaFfcvADate(j.fecha); return f && f >= hoy; });
  return idx >= 0 ? jornadas[idx] : jornadas[jornadas.length - 1];
}

// Ejecuta fn sobre items con un máximo de `limite` en paralelo.
async function conPool<T, R>(items: T[], limite: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const resultados: R[] = new Array(items.length);
  let siguiente = 0;
  async function trabajador() {
    while (siguiente < items.length) {
      const i = siguiente++;
      try { resultados[i] = await fn(items[i]); } catch (e) { resultados[i] = null as any; console.error("[ruta-refrescar-activos] item falló:", e); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, trabajador));
  return resultados;
}

async function temporadaConCompeticiones(): Promise<{ temp: any; comps: any[] } | null> {
  const temps = (await ffcvGet("filtros/temporadas_fetch.php")).temporadas || [];
  temps.sort((a: any, b: any) => Number(b.cod_temporada) - Number(a.cod_temporada));
  for (const t of temps.slice(0, 3)) {
    let comps = (await ffcvGet(`filtros/competiciones_fetch.php?temporada=${t.cod_temporada}`)).competiciones || [];
    comps = comps.filter((c: any) => MODALIDADES_PERMITIDAS.includes(limpiar(c.nombre_grupo_categoria)));
    if (comps.length) return { temp: t, comps };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // --- Autorización: cron-secret o admin global (mismo patrón que ffcv-import) ---
    const cronSecret = req.headers.get("x-cron-secret");
    let autorizado = false;
    if (cronSecret) {
      const { data: cfg } = await admin.from("ffcv_config").select("valor").eq("clave", "cron_secret").maybeSingle();
      autorizado = !!cfg?.valor && cronSecret === cfg.valor;
    }
    if (!autorizado) {
      const authHeader = req.headers.get("Authorization") || "";
      const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: u } = await userClient.auth.getUser();
      if (u?.user) {
        const { data: perfil } = await userClient.from("profiles").select("is_admin").eq("id", u.user.id).single();
        autorizado = !!perfil?.is_admin;
      }
    }
    if (!autorizado) return json({ error: "No autorizado" }, 401);

    const inicio = Date.now();

    const tc = await temporadaConCompeticiones();
    if (!tc) return json({ error: "No hay temporada con competiciones F11/F8 publicadas" }, 200);
    const { temp, comps } = tc;
    const codTemp = limpiar(temp.cod_temporada);

    // 1) Grupos de cada competición.
    type CompGrupo = { comp: any; grupo: any };
    const listasGrupos = await conPool(comps, CONCURRENCIA, async (comp: any) => {
      const codComp = limpiar(comp.codigo);
      const grupos = ((await ffcvGet(`filtros/grupos_fetch.php?cod_competicion=${codComp}`)).grupos || []);
      return grupos.map((g: any) => ({ comp, grupo: g } as CompGrupo));
    });
    const pares: CompGrupo[] = listasGrupos.flat().filter(Boolean);

    // 2) Jornada actual + partidos de cada grupo.
    let totalPartidos = 0;
    const filas: any[] = [];
    await conPool(pares, CONCURRENCIA, async ({ comp, grupo }: CompGrupo) => {
      const codComp = limpiar(comp.codigo), codGrupo = limpiar(grupo.codigo);
      const jornadas = ((await ffcvGet(`filtros/jornadas_fetch.php?cod_competicion=${codComp}&cod_grupo=${codGrupo}`)).jornadas || [])
        .map((j: any) => ({ codjornada: limpiar(j.codjornada), fecha: limpiar(j.fecha_jornada) }));
      const jornadaActual = elegirJornadaActual(jornadas);
      if (!jornadaActual) return;

      const data = await ffcvGet(`partidos/resultados_por_grupo_jornada_data.php?cod_temporada=${codTemp}&cod_competicion=${codComp}&cod_grupo=${codGrupo}&cod_jornada=${jornadaActual.codjornada}`);
      const partidos = data.partidos || [];

      for (const p of partidos) {
        const campo = limpiar(p.campo);
        filas.push({
          cod_partido: limpiar(p.codacta) || null,
          cod_equipo_local: limpiar(p.cod_equipo_local) || null,
          cod_equipo_visitante: limpiar(p.cod_equipo_visitante) || null,
          local: limpiar(p.local),
          visitante: limpiar(p.visitante),
          escudo_local: urlEscudo(p.escudo_local),
          escudo_visitante: urlEscudo(p.escudo_visitante),
          fecha: (() => { const m = limpiar(p.fecha).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; })(),
          hora: limpiar(p.hora) || null,
          campo: campo || null,
          campo_normalizado: campo ? normalizarCampo(campo) : null,
          resultado: limpiar(p.resultado) || null,
          jugado: partidoJugado(p.resultado),
          modalidad: limpiar(comp.nombre_grupo_categoria),
          competicion_codigo: codComp,
          competicion_nombre: limpiar(comp.nombre),
          grupo_codigo: codGrupo,
          grupo_nombre: limpiar(grupo.nombre),
          jornada: jornadaActual.codjornada,
          actualizado_at: new Date().toISOString(),
        });
        totalPartidos++;
      }
    });

    // 3) Upsert por lotes (evita mandar miles de filas en una sola petición).
    for (let i = 0; i < filas.length; i += 500) {
      const lote = filas.slice(i, i + 500);
      const { error } = await admin.from("ruta_partidos_activos")
        .upsert(lote, { onConflict: "grupo_codigo,jornada,cod_equipo_local,cod_equipo_visitante" });
      if (error) console.error("[ruta-refrescar-activos] upsert:", error.message);
    }

    return json({
      ok: true,
      temporada: temp.nombre,
      competiciones: comps.length,
      grupos: pares.length,
      partidos: totalPartidos,
      duracion_ms: Date.now() - inicio,
    });
  } catch (e) {
    console.error("[ruta-refrescar-activos]", e);
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
