// ============================================================
// CaptaNET · Edge Function "ruta-ffcv"
// Puente en vivo con la FFCV para el módulo RUTA (ojeadores).
// A diferencia de "importar-ffcv" (que rellena la base de datos por
// lotes vía cron), esto responde a peticiones puntuales del ojeador
// para ver horarios al día y el acta de un partido. No escribe en la
// base de datos: solo consulta la FFCV y devuelve datos normalizados.
//
// Se hace de puente en el servidor (no directo desde el navegador)
// porque la FFCV no permite peticiones cross-origin desde captacion.net.
//
// Acciones (body JSON { accion: "..." }):
//   "catalogo"        -> temporada vigente + competiciones (F11/F8) para el filtro
//   "grupos"          -> grupos de una competición (con nº de jornadas)
//   "partidos"        -> partidos de una jornada (local, visitante, hora, campo, resultado, codacta)
//   "detalle_partido" -> alineaciones: del acta si el partido acabó (titulares y
//                        dorsales reales), o plantilla de cada equipo con los
//                        dorsales precargados de su último acta disponible.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const FFCV = "https://ffcv.es/competiciones/api";
const NOVANET = "https://appwebffcv.novanet.es";
const MODALIDADES_PERMITIDAS = ["MASCULÍ F11", "MASCULÍ F8"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

const limpiar = (s: unknown) => (s == null ? "" : String(s)).trim();
const urlEscudo = (r: string | null | undefined) => (r ? `${NOVANET}${r}` : null);
// La FFCV marca un partido como jugado cuando el resultado tiene dígitos ("1 - 6").
const partidoJugado = (resultado: string) => /\d/.test(resultado || "");

async function ffcvGet(path: string): Promise<any> {
  const r = await fetch(`${FFCV}/${path}`, { headers: { "User-Agent": UA, "Accept": "application/json" }, cache: "no-cache" as any });
  if (!r.ok) throw new Error(`FFCV ${path} -> ${r.status}`);
  return await r.json();
}

// Temporada más reciente que tiene competiciones de las modalidades que nos
// interesan (durante el parón entre temporadas, la nueva aún no las publica).
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

function normalizarJugadorActa(j: any) {
  return {
    codjugador: limpiar(j.codjugador),
    nombre: limpiar(j.nombre_jugador || j.nombre_real || j.nombre_visible),
    dorsal: limpiar(j.dorsal),
    posicion: limpiar(j.posicion),
    titular: limpiar(j.titular) === "1",
    suplente: limpiar(j.suplente) === "1",
    capitan: limpiar(j.capitan) === "1",
    portero: limpiar(j.portero) === "1",
  };
}

function normalizarJugadorPlantilla(j: any, dorsalesPrecargados: Record<string, string>) {
  const cod = limpiar(j.codjugador);
  return {
    codjugador: cod,
    nombre: limpiar(j.nombre),
    dorsal: dorsalesPrecargados[cod] || limpiar(j.dorsal),
    posicion: limpiar(j.posicion),
    titular: null,          // lo marca el ojeador a mano
    suplente: false,
    capitan: false,
    portero: false,
  };
}

// Busca hacia atrás (desde la jornada dada) el último partido jugado de cada
// equipo dentro del mismo grupo, y devuelve el mapa codjugador -> dorsal que
// llevaron en su acta más reciente. Cada jornada se pide una sola vez.
async function precargarDorsales(
  codTemp: string, codComp: string, codGrupo: string, jornada: number,
  codLocal: string, codVisitante: string,
): Promise<{ local: Record<string, string>; visitante: Record<string, string> }> {
  const out = { local: {} as Record<string, string>, visitante: {} as Record<string, string> };
  let faltaLocal = !!codLocal, faltaVisitante = !!codVisitante;
  const desde = Math.max(1, jornada - 1);
  const hasta = Math.max(1, jornada - 10);

  for (let d = desde; d >= hasta && (faltaLocal || faltaVisitante); d--) {
    let partidos: any[] = [];
    try {
      partidos = (await ffcvGet(`partidos/resultados_por_grupo_jornada_data.php?cod_temporada=${codTemp}&cod_competicion=${codComp}&cod_grupo=${codGrupo}&cod_jornada=${d}`)).partidos || [];
    } catch { continue; }

    for (const p of partidos) {
      if (!partidoJugado(p.resultado) || !p.codacta) continue;
      const tocaLocal = faltaLocal && (p.cod_equipo_local === codLocal || p.cod_equipo_visitante === codLocal);
      const tocaVisitante = faltaVisitante && (p.cod_equipo_local === codVisitante || p.cod_equipo_visitante === codVisitante);
      if (!tocaLocal && !tocaVisitante) continue;

      let acta: any;
      try { acta = await ffcvGet(`partidos/ficha_partido_ajax.php?cod_partido=${p.codacta}`); } catch { continue; }
      if (limpiar(acta.acta_cerrada) !== "1") continue;

      const rellenar = (equipoBuscado: string, destino: Record<string, string>) => {
        const jugadores = p.cod_equipo_local === equipoBuscado ? acta.jugadores_equipo_local : acta.jugadores_equipo_visitante;
        for (const j of (jugadores || [])) {
          const cod = limpiar(j.codjugador), dorsal = limpiar(j.dorsal);
          if (cod && dorsal) destino[cod] = dorsal;
        }
      };
      if (tocaLocal) { rellenar(codLocal, out.local); faltaLocal = false; }
      if (tocaVisitante) { rellenar(codVisitante, out.visitante); faltaVisitante = false; }
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    // Solo usuarios con sesión (los datos no son de club, pero no queremos abrir el puente a cualquiera).
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "No autenticado" }, 401);

    const body = await req.json().catch(() => ({}));
    const accion = body.accion;

    if (accion === "catalogo") {
      const r = await temporadaConCompeticiones();
      if (!r) return json({ cod_temporada: null, temporada: null, competiciones: [] });
      const competiciones = r.comps
        .map((c: any) => ({ codigo: limpiar(c.codigo), nombre: limpiar(c.nombre), modalidad: limpiar(c.nombre_grupo_categoria) }))
        .sort((a, b) => a.modalidad.localeCompare(b.modalidad) || a.nombre.localeCompare(b.nombre));
      return json({ cod_temporada: limpiar(r.temp.cod_temporada), temporada: limpiar(r.temp.nombre), competiciones });
    }

    if (accion === "grupos") {
      const codComp = limpiar(body.cod_competicion);
      if (!codComp) return json({ error: "Falta cod_competicion" }, 400);
      const grupos = ((await ffcvGet(`filtros/grupos_fetch.php?cod_competicion=${codComp}`)).grupos || [])
        .map((g: any) => ({ codigo: limpiar(g.codigo), nombre: limpiar(g.nombre), total_jornadas: Number(g.total_jornadas) || null }));
      return json({ grupos });
    }

    if (accion === "jornadas") {
      const codComp = limpiar(body.cod_competicion), codGrupo = limpiar(body.cod_grupo);
      if (!codComp || !codGrupo) return json({ error: "Falta cod_competicion/cod_grupo" }, 400);
      const jornadas = ((await ffcvGet(`filtros/jornadas_fetch.php?cod_competicion=${codComp}&cod_grupo=${codGrupo}`)).jornadas || [])
        .map((j: any) => ({ codjornada: limpiar(j.codjornada), nombre: limpiar(j.nombre), fecha: limpiar(j.fecha_jornada) }));
      return json({ jornadas });
    }

    if (accion === "partidos") {
      const codTemp = limpiar(body.cod_temporada), codComp = limpiar(body.cod_competicion);
      const codGrupo = limpiar(body.cod_grupo), codJor = limpiar(body.cod_jornada);
      if (!codTemp || !codComp || !codGrupo || !codJor) return json({ error: "Faltan parámetros de partido" }, 400);
      const data = await ffcvGet(`partidos/resultados_por_grupo_jornada_data.php?cod_temporada=${codTemp}&cod_competicion=${codComp}&cod_grupo=${codGrupo}&cod_jornada=${codJor}`);
      const partidos = (data.partidos || []).map((p: any) => ({
        cod_partido: limpiar(p.codacta) || null,
        local: limpiar(p.local), visitante: limpiar(p.visitante),
        cod_equipo_local: limpiar(p.cod_equipo_local), cod_equipo_visitante: limpiar(p.cod_equipo_visitante),
        fecha: limpiar(p.fecha), hora: limpiar(p.hora), campo: limpiar(p.campo),
        resultado: limpiar(p.resultado), jugado: partidoJugado(p.resultado),
        escudo_local: urlEscudo(p.escudo_local), escudo_visitante: urlEscudo(p.escudo_visitante),
      }));
      return json({ jornada: limpiar(data.jornada) || codJor, partidos });
    }

    if (accion === "detalle_partido") {
      const codPartido = limpiar(body.cod_partido);
      const codLocal = limpiar(body.cod_equipo_local), codVisitante = limpiar(body.cod_equipo_visitante);

      // 1) Si el acta ya está cerrada, sale con titulares y dorsales reales.
      if (codPartido) {
        let acta: any = null;
        try { acta = await ffcvGet(`partidos/ficha_partido_ajax.php?cod_partido=${codPartido}`); } catch { acta = null; }
        // Se usa el acta si el partido ya acabó (acta cerrada) o si el club ya
        // ha subido la alineación (hay algún titular marcado) — así el ojeador
        // puede ver "en directo" quién juega en cuanto la suben, poco antes del
        // inicio, sin esperar al final del partido.
        const jugActa = [...(acta?.jugadores_equipo_local || []), ...(acta?.jugadores_equipo_visitante || [])];
        const hayAlineacion = jugActa.some((j: any) => limpiar(j.titular) === "1");
        if (acta && (limpiar(acta.acta_cerrada) === "1" || hayAlineacion)) {
          return json({
            fuente: "acta",
            cerrada: limpiar(acta.acta_cerrada) === "1",
            en_juego: limpiar(acta.partido_en_juego) === "1",
            esquema_local: limpiar(acta.esquema_local), esquema_visitante: limpiar(acta.esquema_visitante),
            jugadores_local: (acta.jugadores_equipo_local || []).map(normalizarJugadorActa),
            jugadores_visitante: (acta.jugadores_equipo_visitante || []).map(normalizarJugadorActa),
          });
        }
      }

      // 2) Partido aún no jugado: plantilla de cada equipo + dorsales del último acta.
      if (!codLocal && !codVisitante) return json({ fuente: "plantilla", jugadores_local: [], jugadores_visitante: [] });

      let dorsales = { local: {} as Record<string, string>, visitante: {} as Record<string, string> };
      const codTemp = limpiar(body.cod_temporada), codComp = limpiar(body.cod_competicion), codGrupo = limpiar(body.cod_grupo);
      const codJor = Number(body.cod_jornada) || 0;
      if (codTemp && codComp && codGrupo && codJor) {
        try { dorsales = await precargarDorsales(codTemp, codComp, codGrupo, codJor, codLocal, codVisitante); } catch { /* sin precarga */ }
      }

      const plantillaDe = async (codEquipo: string, mapaDorsales: Record<string, string>) => {
        if (!codEquipo) return [];
        try {
          const pl = await ffcvGet(`equipos/plantilla_home.php?cod_equipo=${codEquipo}`);
          return (pl.jugadores_equipo || []).map((j: any) => normalizarJugadorPlantilla(j, mapaDorsales));
        } catch { return []; }
      };

      return json({
        fuente: "plantilla",
        jugadores_local: await plantillaDe(codLocal, dorsales.local),
        jugadores_visitante: await plantillaDe(codVisitante, dorsales.visitante),
      });
    }

    return json({ error: "Acción no reconocida" }, 400);
  } catch (e) {
    console.error("[ruta-ffcv]", e);
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
