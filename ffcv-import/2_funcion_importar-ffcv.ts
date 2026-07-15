// ============================================================
// CaptaNET · Edge Function "importar-ffcv"
// Importa jugadores desde la web pública de la FFCV, por lotes,
// de forma reanudable (pensado para ejecutarse en bucle vía cron).
//
// Acciones (body JSON { accion: "..." }):
//   "descubrir" -> recorre la temporada actual, cataloga todos los
//                  grupos y llena la cola de trabajo. Empieza una pasada.
//   "procesar"  -> procesa un lote de la cola (equipos/grupos pendientes)
//                  dentro de un presupuesto de tiempo corto. Se llama en bucle.
//   "estado"    -> devuelve el progreso actual.
//
// Autorización: admin global (JWT) O cabecera X-Cron-Secret == FFCV_CRON_SECRET.
// No se guardan DNI ni email (decisión de privacidad).
// Toda operación de base de datos comprueba su error y lo lanza:
// así un fallo real se ve en ffcv_cola.error_msg en vez de desaparecer en silencio.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.18";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const FFCV = "https://ffcv.es/competiciones/api";
// Solo nos interesa fútbol 11 y fútbol 8 (nada de Valenta, Futsal, Playa, Gegants...)
const MODALIDADES_PERMITIDAS = ["MASCULÍ F11", "MASCULÍ F8"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const PRESUPUESTO_MS = 25_000;            // corto a propósito: el navegador vuelve a llamar en bucle
const PAUSA_MS = 350;                     // pausa entre llamadas a FFCV (ritmo suave)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ffcvGet(path: string): Promise<any> {
  await sleep(PAUSA_MS);
  const r = await fetch(`${FFCV}/${path}`, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`FFCV ${path} -> ${r.status}`);
  return await r.json();
}

// Ejecuta una operación de Supabase y lanza si viene error (nunca falla en silencio)
async function db<T>(etiqueta: string, promesa: PromiseLike<{ data: T; error: any }>): Promise<T> {
  const { data, error } = await promesa;
  if (error) throw new Error(`${etiqueta}: ${error.message || JSON.stringify(error)}`);
  return data;
}

// ---------- R2 (fotos) ----------
function r2Client() {
  return new AwsClient({
    accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID")!,
    secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY")!,
    service: "s3",
    region: "auto",
  });
}
async function subirFotoR2(dataUri: string, nombreArchivo: string): Promise<string | null> {
  try {
    if (!dataUri || !dataUri.startsWith("data:")) return null;
    const coma = dataUri.indexOf(",");
    const meta = dataUri.slice(5, coma);
    const mime = meta.split(";")[0] || "image/jpeg";
    const b64 = dataUri.slice(coma + 1);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const account = Deno.env.get("R2_ACCOUNT_ID")!;
    const bucket = Deno.env.get("R2_BUCKET")!;
    const endpoint = `https://${account}.r2.cloudflarestorage.com/${bucket}/${nombreArchivo}`;
    const aws = r2Client();
    const res = await aws.fetch(endpoint, { method: "PUT", body: bytes, headers: { "Content-Type": mime } });
    if (!res.ok) return null;
    return `${Deno.env.get("R2_PUBLIC_URL")}/${nombreArchivo}`;
  } catch {
    return null;
  }
}

// ---------- utilidades ----------
function parseFecha(f: string | null | undefined): string | null {
  if (!f || !/^\d{2}-\d{2}-\d{4}$/.test(f)) return null;
  const [d, m, a] = f.split("-");
  return `${a}-${m}-${d}`;
}
const limpiar = (s: string | null | undefined) => (s || "").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey);

    // --- Autorización: cron-secret o admin global ---
    const cronSecret = req.headers.get("x-cron-secret");
    const esCron = cronSecret && cronSecret === Deno.env.get("FFCV_CRON_SECRET");
    if (!esCron) {
      const authHeader = req.headers.get("Authorization") || "";
      const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: u } = await userClient.auth.getUser();
      if (!u?.user) return json({ error: "No autenticado" }, 401);
      const { data: perfil } = await userClient.from("profiles").select("is_admin").eq("id", u.user.id).single();
      if (!perfil?.is_admin) return json({ error: "Solo el administrador puede importar" }, 403);
    }

    const { accion, lote, soloCompeticion, modalidades } = await req.json().catch(() => ({ accion: "estado" }));

    // ========================================================
    // ESTADO
    // ========================================================
    if (accion === "estado") {
      const [{ count: pend }, { count: total }, { count: err }, { data: ejec }, { data: fondoActivo }] = await Promise.all([
        admin.from("ffcv_cola").select("*", { count: "exact", head: true }).eq("estado", "pendiente"),
        admin.from("ffcv_cola").select("*", { count: "exact", head: true }),
        admin.from("ffcv_cola").select("*", { count: "exact", head: true }).eq("estado", "error"),
        admin.from("ffcv_ejecuciones").select("*").order("iniciado", { ascending: false }).limit(1),
        admin.rpc("ffcv_estado_fondo"),
      ]);
      const { data: ultimoError } = await admin.from("ffcv_cola").select("tipo,referencia,error_msg")
        .eq("estado", "error").order("id", { ascending: false }).limit(1).maybeSingle();
      return json({
        pendientes: pend ?? 0, total_cola: total ?? 0, con_error: err ?? 0,
        ultimo_error: ultimoError, ultima_ejecucion: ejec?.[0] ?? null,
        fondo_activo: !!fondoActivo,
      });
    }

    // ========================================================
    // FONDO — activa/desactiva el procesado automático cada minuto
    // (corre en el servidor, no depende de tener el navegador abierto)
    // ========================================================
    if (accion === "activar_fondo") {
      const secreto = Deno.env.get("FFCV_CRON_SECRET");
      if (!secreto) return json({ error: "Falta el secreto FFCV_CRON_SECRET en la configuración" }, 500);
      const { error } = await admin.rpc("ffcv_programar_fondo", { p_secreto: secreto });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (accion === "desactivar_fondo") {
      const { error } = await admin.rpc("ffcv_detener_fondo");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ========================================================
    // DESCUBRIR — cataloga grupos de la temporada actual y llena la cola
    // ========================================================
    if (accion === "descubrir") {
      const temps = (await ffcvGet("filtros/temporadas_fetch.php")).temporadas || [];
      temps.sort((a: any, b: any) => Number(b.cod_temporada) - Number(a.cod_temporada));

      // temporadaActual = la real por calendario (donde queremos que "vivan" los jugadores).
      // elegida = la más reciente que SÍ tiene ligas/grupos publicados (de donde sacamos
      // la estructura). Mientras la FFCV no publique las ligas de temporadaActual, ambas
      // no coinciden y usamos la estructura de la anterior como referencia temporal;
      // en cuanto la FFCV las publique, elegida === temporadaActual automáticamente.
      const temporadaActual = temps[0];
      if (!temporadaActual) return json({ error: "No hay temporadas en FFCV" }, 500);

      // Se puede elegir desde el panel qué modalidades traer (por defecto, las dos).
      const modalidadesPedidas: string[] = Array.isArray(modalidades) && modalidades.length
        ? modalidades
        : MODALIDADES_PERMITIDAS;

      let elegida: any = null;
      let competiciones: any[] = [];
      for (const t of temps.slice(0, 3)) {
        let comps = (await ffcvGet(`filtros/competiciones_fetch.php?temporada=${t.cod_temporada}`)).competiciones || [];
        // Solo fútbol 11 y/o fútbol 8, según lo pedido (nada de Valenta, Futsal, Playa, Gegants...)
        comps = comps.filter((c: any) => modalidadesPedidas.includes(limpiar(c.nombre_grupo_categoria)));
        if (soloCompeticion) {
          const filtro = String(soloCompeticion).toLowerCase();
          comps = comps.filter((c: any) => limpiar(c.nombre).toLowerCase().includes(filtro));
        }
        const activas = comps.filter((c: any) => c.Activa === "1");
        if (activas.length) { elegida = t; competiciones = activas; break; }
        if (!elegida && comps.length) { elegida = t; competiciones = comps; }
      }
      if (!elegida) return json({ error: "No se encontró temporada con competiciones (revisa el filtro)" }, 500);

      // Temporada propia de CaptaNET donde se guardan los datos: SIEMPRE la actual por
      // calendario, no la de la estructura (se reutiliza en cada pasada).
      const temporadaRow = await db("upsert temporadas",
        admin.from("temporadas")
          .upsert({
            cod_ffcv: temporadaActual.cod_temporada,
            nombre: `FFCV ${limpiar(temporadaActual.nombre)}`,
            fecha_inicio: temporadaActual.fecha_inicio || null,
            fecha_fin: temporadaActual.fecha_fin || null,
          }, { onConflict: "cod_ffcv" })
          .select("id").single());

      // Esta es la temporada con datos reales de verdad: que sea la que el visor
      // muestra por defecto (si no, la app abre en la temporada "activa" del calendario,
      // que puede estar recién empezada y sin jugadores importados todavía).
      await db("desactivar otras temporadas", admin.from("temporadas").update({ activa: false }).neq("id", temporadaRow.id));
      await db("activar temporada importada", admin.from("temporadas").update({ activa: true }).eq("id", temporadaRow.id));

      const filasGrupos: any[] = [];
      const filasCola: any[] = [];
      for (const comp of competiciones) {
        const modalidad = limpiar(comp.nombre_grupo_categoria) || "Sin modalidad";
        const grupos = (await ffcvGet(`filtros/grupos_fetch.php?cod_competicion=${comp.codigo}`)).grupos || [];
        for (const g of grupos) {
          filasGrupos.push({
            cod_grupo: g.codigo,
            nombre_grupo: limpiar(g.nombre),
            cod_competicion: comp.codigo,
            nombre_competicion: limpiar(comp.nombre),
            cod_temporada: elegida.cod_temporada,               // estructura (para partidos/jornadas)
            nombre_temporada: limpiar(elegida.nombre),
            cod_temporada_destino: temporadaActual.cod_temporada, // donde se guarda de verdad
            nombre_temporada_destino: limpiar(temporadaActual.nombre),
            fecha_inicio: temporadaActual.fecha_inicio || null,
            fecha_fin: temporadaActual.fecha_fin || null,
            modalidad,
            activo: comp.Activa === "1",
            ultima_jornada: Number(g.total_jornadas) || null,
            orden_liga: comp.Orden != null ? Number(comp.Orden) : null, // orden de la competición según la FFCV
            // Nombre "limpio" de categoría que da la propia FFCV (p.ej. "Querubines",
            // "Alevín 2º. Año"): mejor punto de partida que adivinar por el nombre de
            // la competición, que a veces no la menciona (p.ej. "Escola de Gegants").
            categoria_edad_ffcv: limpiar(comp.NombreCategoria) || null,
          });
          filasCola.push({ tipo: "grupo", referencia: g.codigo, estado: "pendiente" });
        }
      }

      await db("limpiar cola", admin.from("ffcv_cola").delete().neq("id", 0));
      for (let i = 0; i < filasGrupos.length; i += 500)
        await db("guardar ffcv_grupos", admin.from("ffcv_grupos").upsert(filasGrupos.slice(i, i + 500), { onConflict: "cod_grupo" }));
      for (let i = 0; i < filasCola.length; i += 500)
        await db("encolar grupos", admin.from("ffcv_cola").upsert(filasCola.slice(i, i + 500), { onConflict: "tipo,referencia" }));

      await db("registrar ejecución", admin.from("ffcv_ejecuciones").insert({ grupos_total: filasGrupos.length, estado: "en_curso" }));
      return json({
        ok: true,
        temporada: temporadaActual.nombre,
        temporada_estructura: elegida.nombre !== temporadaActual.nombre ? elegida.nombre : null,
        temporada_id: temporadaRow.id,
        grupos_encolados: filasGrupos.length,
        modalidades: modalidadesPedidas,
      });
    }

    // ========================================================
    // PROCESAR — trabaja la cola dentro del presupuesto de tiempo
    // ========================================================
    if (accion === "procesar") {
      const t0 = Date.now();
      const maxItems = Number(lote) || 25;
      let hechos = 0, nuevos = 0, actualizados = 0, equipos = 0;

      while (Date.now() - t0 < PRESUPUESTO_MS && hechos < maxItems) {
        const fila = await db("leer cola",
          admin.from("ffcv_cola").select("*").eq("estado", "pendiente").order("id").limit(1).maybeSingle());
        if (!fila) break;
        await db("marcar procesando", admin.from("ffcv_cola").update({ estado: "procesando" }).eq("id", fila.id));

        try {
          if (fila.tipo === "grupo") {
            const r = await procesarGrupo(admin, fila.referencia);
            equipos += r.equipos;
          } else if (fila.tipo === "equipo") {
            const r = await procesarEquipo(admin, fila.referencia);
            nuevos += r.nuevos; actualizados += r.actualizados;
          }
          await db("marcar hecho", admin.from("ffcv_cola").update({ estado: "hecho", procesado: new Date().toISOString() }).eq("id", fila.id));
          hechos++;
        } catch (e) {
          await admin.from("ffcv_cola").update({
            estado: (fila.intentos ?? 0) >= 2 ? "error" : "pendiente",
            intentos: (fila.intentos ?? 0) + 1,
            error_msg: String(e?.message || e).slice(0, 500),
          }).eq("id", fila.id);
        }
      }

      const { data: ej } = await admin.from("ffcv_ejecuciones").select("*").eq("estado", "en_curso").order("iniciado", { ascending: false }).limit(1).maybeSingle();
      if (ej) {
        await admin.from("ffcv_ejecuciones").update({
          equipos_total: (ej.equipos_total ?? 0) + equipos,
          jugadores_nuevos: (ej.jugadores_nuevos ?? 0) + nuevos,
          jugadores_actualizados: (ej.jugadores_actualizados ?? 0) + actualizados,
        }).eq("id", ej.id);
      }

      const { count: pend } = await admin.from("ffcv_cola").select("*", { count: "exact", head: true }).eq("estado", "pendiente");
      if ((pend ?? 0) === 0 && ej) {
        await admin.from("ffcv_ejecuciones").update({ estado: "completado", finalizado: new Date().toISOString() }).eq("id", ej.id);
      }
      return json({ ok: true, procesados: hechos, equipos_nuevos: equipos, jugadores_nuevos: nuevos, jugadores_actualizados: actualizados, pendientes: pend ?? 0 });
    }

    return json({ error: "Acción no reconocida" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

// ------------------------------------------------------------
// Procesa un GRUPO: encaja la jerarquía (con su temporada) y encola sus equipos
// ------------------------------------------------------------
async function procesarGrupo(admin: any, codGrupo: string): Promise<{ equipos: number }> {
  const g = await db("leer ffcv_grupos", admin.from("ffcv_grupos").select("*").eq("cod_grupo", codGrupo).single());

  // Se guarda bajo la temporada DESTINO (la actual por calendario), no la de estructura.
  const temporadaRow = await db("upsert temporada del grupo",
    admin.from("temporadas").upsert({
      cod_ffcv: g.cod_temporada_destino,
      nombre: `FFCV ${g.nombre_temporada_destino}`,
      fecha_inicio: g.fecha_inicio || null,
      fecha_fin: g.fecha_fin || null,
    }, { onConflict: "cod_ffcv" }).select("id").single());
  const temporadaId = temporadaRow.id;

  const catId = await upsertNivel(admin, "categorias",
    { cod_ffcv: `${g.cod_temporada_destino}_${g.modalidad}`, nombre: g.modalidad, temporada_id: temporadaId }, {});
  const ligaId = await upsertNivel(admin, "ligas",
    { cod_ffcv: g.cod_competicion, nombre: g.nombre_competicion, temporada_id: temporadaId, orden: g.orden_liga, categoria_edad_ffcv: g.categoria_edad_ffcv },
    { categoria_id: catId });
  const grupoId = await upsertNivel(admin, "grupos",
    { cod_ffcv: g.cod_grupo, nombre: g.nombre_grupo, temporada_id: temporadaId }, { liga_id: ligaId });

  // listar equipos del grupo a partir de los partidos (varias jornadas por si alguna viene vacía)
  const total = g.ultima_jornada || 34;
  const codes = new Map<string, { nombre: string; escudo: string | null }>();
  const orden: number[] = [];
  const medio = Math.max(1, Math.floor(total / 2));
  for (let d = 0; d < total; d++) {
    const a = medio + d, b = medio - d;
    if (a <= total) orden.push(a);
    if (b >= 1 && b !== a) orden.push(b);
    if (orden.length >= 8) break;
  }
  for (const j of orden) {
    const data = await ffcvGet(`partidos/resultados_por_grupo_jornada_data.php?cod_temporada=${g.cod_temporada}&cod_competicion=${g.cod_competicion}&cod_grupo=${codGrupo}&cod_jornada=${j}`);
    for (const p of (data.partidos || [])) {
      if (p.cod_equipo_local) codes.set(p.cod_equipo_local, { nombre: limpiar(p.local), escudo: urlEscudo(p.escudo_local) });
      if (p.cod_equipo_visitante) codes.set(p.cod_equipo_visitante, { nombre: limpiar(p.visitante), escudo: urlEscudo(p.escudo_visitante) });
    }
    if (codes.size >= 4) break;
  }

  let n = 0;
  for (const [cod, datos] of codes) {
    const registro: Record<string, unknown> = {
      cod_ffcv: cod, nombre: datos.nombre, grupo_id: grupoId, temporada_id: temporadaId, ffcv_cod_temporada: g.cod_temporada,
    };
    // Solo se incluye si hay valor: así no se borra un escudo ya guardado
    // cuando una jornada concreta no trae la imagen del equipo.
    if (datos.escudo) registro.escudo_url = datos.escudo;
    await db("upsert equipo", admin.from("equipos").upsert(registro, { onConflict: "cod_ffcv" }));
    await db("encolar equipo",
      admin.from("ffcv_cola").upsert({ tipo: "equipo", referencia: cod, estado: "pendiente" }, { onConflict: "tipo,referencia" }));
    n++;
  }
  return { equipos: n };
}

// Las rutas de escudo que da la FFCV son relativas a su CMS (Novanet), no a ffcv.es.
const NOVANET = "https://appwebffcv.novanet.es";
function urlEscudo(ruta: string | null | undefined): string | null {
  return ruta ? `${NOVANET}${ruta}` : null;
}

// ------------------------------------------------------------
// Procesa un EQUIPO: descarga plantilla + ficha de cada jugador
// ------------------------------------------------------------
async function procesarEquipo(admin: any, codEquipo: string): Promise<{ nuevos: number; actualizados: number }> {
  const equipo = await db("leer equipo",
    admin.from("equipos").select("id, temporada_id, ffcv_cod_temporada").eq("cod_ffcv", codEquipo).single());

  const pl = await ffcvGet(`equipos/plantilla_home.php?cod_equipo=${codEquipo}`);
  const jugadores = pl.jugadores_equipo || [];
  let nuevos = 0, actualizados = 0;

  for (const jug of jugadores) {
    const codLic = String(jug.codjugador || "").trim();
    if (!codLic) continue;

    let fechaNac: string | null = null;
    let historial: any[] = [];
    try {
      const h = await ffcvGet(`jugadores/historial_deportivo.php?cod_licencia=${codLic}`);
      fechaNac = parseFecha(h.fecha_nacimiento);
      historial = (h.datos_historico || []).map((x: any) => ({
        temporada: limpiar(x.temporada), equipo: limpiar(x.equipo), categoria: limpiar(x.categoria),
      }));
    } catch { /* si falla la ficha, seguimos con lo básico de la plantilla */ }

    // Estadísticas de la temporada (partidos, goles, tarjetas, minutos)
    let stats: Record<string, unknown> = {};
    if (equipo.ffcv_cod_temporada) {
      try {
        const s = await ffcvGet(`jugadores/jugador_api.php?codigo=${codLic}&cod_temporada=${equipo.ffcv_cod_temporada}`);
        stats = extraerStatsJugador(s);
      } catch { /* si falla, seguimos sin estadísticas para este jugador */ }
    }

    const existente = await db("buscar jugador existente",
      admin.from("jugadores").select("id, foto_url").eq("cod_ffcv", codLic).maybeSingle());
    let fotoUrl = existente?.foto_url || null;
    if (!fotoUrl && jug.foto) {
      fotoUrl = await subirFotoR2(jug.foto, `ffcv/${codLic}.jpg`);
    }

    const registro = {
      cod_ffcv: codLic,
      nombre: limpiar(jug.nombre),
      equipo_id: equipo.id,
      temporada_id: equipo.temporada_id,
      posicion: limpiar(jug.posicion) || null,
      dorsal: limpiar(jug.dorsal) || null,
      fecha_nacimiento: fechaNac,
      foto_url: fotoUrl,
      historial,
      ffcv_actualizado: new Date().toISOString(),
      ...stats,
    };
    await db("upsert jugador", admin.from("jugadores").upsert(registro, { onConflict: "cod_ffcv" }));
    if (existente) actualizados++; else nuevos++;
  }
  return { nuevos, actualizados };
}

// Convierte la respuesta de jugador_api.php (arrays "partidos"/"tarjetas") en columnas planas
function extraerStatsJugador(j: any): Record<string, unknown> {
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const partidos: Record<string, string> = {};
  for (const p of (j.partidos || [])) partidos[p.nombre] = p.valor;
  const tarjetas: Record<string, string> = {};
  for (const t of (j.tarjetas || [])) tarjetas[t.nombre] = t.valor;
  return {
    minutos_jugados: num(j.minutos_totales_jugados),
    partidos_convocados: num(partidos["Convocados"]),
    partidos_titular: num(partidos["Titular"]),
    partidos_suplente: num(partidos["Suplente"]),
    partidos_jugados: num(partidos["Jugados"]),
    goles: num(partidos["Total Goles"]),
    tarjetas_amarillas: num(tarjetas["Amarillas"]),
    tarjetas_rojas: num(tarjetas["Rojas"]),
    tarjetas_doble_amarilla: num(tarjetas["Doble Amarilla"]),
    tarjetas_verde: num(tarjetas["Tarjeta verde"]),
    es_portero: j.es_portero === "1",
  };
}

// upsert por cod_ffcv devolviendo el id; extra = campos padre (categoria_id, etc.)
async function upsertNivel(admin: any, tabla: string, base: Record<string, unknown>, extra: Record<string, unknown>): Promise<string> {
  const data = await db(`upsert ${tabla}`,
    admin.from(tabla).upsert({ ...base, ...extra }, { onConflict: "cod_ffcv" }).select("id").single());
  return data.id;
}
