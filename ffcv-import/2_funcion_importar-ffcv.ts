// ============================================================
// CaptaNET · Edge Function "importar-ffcv"
// Importa jugadores desde la web pública de la FFCV, por lotes,
// de forma reanudable (pensado para ejecutarse en bucle vía cron).
//
// Acciones (body JSON { accion: "..." }):
//   "descubrir" -> recorre la temporada actual, cataloga todos los
//                  grupos y llena la cola de trabajo. Empieza una pasada.
//   "procesar"  -> procesa un lote de la cola (equipos/grupos pendientes)
//                  dentro de un presupuesto de tiempo. Se llama en bucle.
//   "estado"    -> devuelve el progreso actual.
//
// Autorización: admin global (JWT) O cabecera X-Cron-Secret == FFCV_CRON_SECRET.
// No se guardan DNI ni email (decisión de privacidad).
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
    const meta = dataUri.slice(5, coma);                 // p.ej. image/jpeg;base64
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
  // FFCV da "05-07-2008" (dd-mm-aaaa) -> ISO "2008-07-05"
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

    const { accion, lote } = await req.json().catch(() => ({ accion: "estado" }));

    // ========================================================
    // ESTADO
    // ========================================================
    if (accion === "estado") {
      const [{ count: pend }, { count: total }, { data: ejec }] = await Promise.all([
        admin.from("ffcv_cola").select("*", { count: "exact", head: true }).eq("estado", "pendiente"),
        admin.from("ffcv_cola").select("*", { count: "exact", head: true }),
        admin.from("ffcv_ejecuciones").select("*").order("iniciado", { ascending: false }).limit(1),
      ]);
      return json({ pendientes: pend ?? 0, total_cola: total ?? 0, ultima_ejecucion: ejec?.[0] ?? null });
    }

    // ========================================================
    // DESCUBRIR — cataloga grupos de la temporada actual y llena la cola
    // ========================================================
    if (accion === "descubrir") {
      // temporada actual = la de mayor cod_temporada con competiciones activas
      const temps = (await ffcvGet("filtros/temporadas_fetch.php")).temporadas || [];
      temps.sort((a: any, b: any) => Number(b.cod_temporada) - Number(a.cod_temporada));

      let elegida: any = null;
      let competiciones: any[] = [];
      for (const t of temps.slice(0, 3)) {           // mira las 3 más recientes
        const comps = (await ffcvGet(`filtros/competiciones_fetch.php?temporada=${t.cod_temporada}`)).competiciones || [];
        const activas = comps.filter((c: any) => c.Activa === "1");
        if (activas.length) { elegida = t; competiciones = activas; break; }
        if (!elegida && comps.length) { elegida = t; competiciones = comps; }  // reserva: la más reciente aunque no haya activas
      }
      if (!elegida) return json({ error: "No se encontró temporada con competiciones" }, 500);

      // recoger todos los grupos en memoria (una llamada por competición)
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
            cod_temporada: elegida.cod_temporada,
            nombre_temporada: limpiar(elegida.nombre),
            modalidad,
            activo: comp.Activa === "1",
            ultima_jornada: Number(g.total_jornadas) || null,
          });
          filasCola.push({ tipo: "grupo", referencia: g.codigo, estado: "pendiente" });
        }
      }

      // escribir en bloque (pocas llamadas -> evita agotar el tiempo)
      await admin.from("ffcv_cola").delete().neq("id", 0);
      for (let i = 0; i < filasGrupos.length; i += 500)
        await admin.from("ffcv_grupos").upsert(filasGrupos.slice(i, i + 500), { onConflict: "cod_grupo" });
      for (let i = 0; i < filasCola.length; i += 500)
        await admin.from("ffcv_cola").upsert(filasCola.slice(i, i + 500), { onConflict: "tipo,referencia" });

      await admin.from("ffcv_ejecuciones").insert({ grupos_total: filasGrupos.length, estado: "en_curso" });
      return json({ ok: true, temporada: elegida.nombre, grupos_encolados: filasGrupos.length });
    }

    // ========================================================
    // PROCESAR — trabaja la cola dentro del presupuesto de tiempo
    // ========================================================
    if (accion === "procesar") {
      const t0 = Date.now();
      const maxItems = Number(lote) || 40;
      let hechos = 0, nuevos = 0, actualizados = 0, equipos = 0;

      while (Date.now() - t0 < PRESUPUESTO_MS && hechos < maxItems) {
        // coger un pendiente
        const { data: fila } = await admin.from("ffcv_cola")
          .select("*").eq("estado", "pendiente").order("id").limit(1).maybeSingle();
        if (!fila) break;
        await admin.from("ffcv_cola").update({ estado: "procesando" }).eq("id", fila.id);

        try {
          if (fila.tipo === "grupo") {
            const r = await procesarGrupo(admin, fila.referencia);
            equipos += r.equipos;
          } else if (fila.tipo === "equipo") {
            const r = await procesarEquipo(admin, fila.referencia);
            nuevos += r.nuevos; actualizados += r.actualizados;
          }
          await admin.from("ffcv_cola").update({ estado: "hecho", procesado: new Date().toISOString() }).eq("id", fila.id);
          hechos++;
        } catch (e) {
          await admin.from("ffcv_cola").update({
            estado: (fila.intentos ?? 0) >= 2 ? "error" : "pendiente",
            intentos: (fila.intentos ?? 0) + 1,
            error_msg: String(e).slice(0, 300),
          }).eq("id", fila.id);
        }
      }

      // acumular en la ejecución en curso
      const { data: ej } = await admin.from("ffcv_ejecuciones").select("*").eq("estado", "en_curso").order("iniciado", { ascending: false }).limit(1).maybeSingle();
      if (ej) {
        await admin.from("ffcv_ejecuciones").update({
          equipos_total: (ej.equipos_total ?? 0) + equipos,
          jugadores_nuevos: (ej.jugadores_nuevos ?? 0) + nuevos,
          jugadores_actualizados: (ej.jugadores_actualizados ?? 0) + actualizados,
        }).eq("id", ej.id);
      }

      const { count: pend } = await admin.from("ffcv_cola").select("*", { count: "exact", head: true }).eq("estado", "pendiente");
      // si ya no queda nada pendiente, cerrar la ejecución
      if ((pend ?? 0) === 0 && ej) {
        await admin.from("ffcv_ejecuciones").update({ estado: "completado", finalizado: new Date().toISOString() }).eq("id", ej.id);
      }
      return json({ ok: true, procesados: hechos, equipos_nuevos: equipos, jugadores_nuevos: nuevos, jugadores_actualizados: actualizados, pendientes: pend ?? 0 });
    }

    return json({ error: "Acción no reconocida" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ------------------------------------------------------------
// Procesa un GRUPO: encaja la jerarquía y encola sus equipos
// ------------------------------------------------------------
async function procesarGrupo(admin: any, codGrupo: string): Promise<{ equipos: number }> {
  const { data: g } = await admin.from("ffcv_grupos").select("*").eq("cod_grupo", codGrupo).single();
  if (!g) throw new Error("grupo no catalogado");

  // 1) jerarquía: categoria (modalidad) -> liga (competición) -> grupo
  const catId = await upsertNivel(admin, "categorias", { cod_ffcv: `mod_${g.modalidad}`, nombre: g.modalidad }, {});
  const ligaId = await upsertNivel(admin, "ligas", { cod_ffcv: g.cod_competicion, nombre: g.nombre_competicion }, { categoria_id: catId });
  const grupoId = await upsertNivel(admin, "grupos", { cod_ffcv: g.cod_grupo, nombre: g.nombre_grupo }, { liga_id: ligaId });

  // 2) listar equipos del grupo a partir de los partidos de una jornada
  const total = g.ultima_jornada || 34;
  const codes = new Map<string, string>();  // cod_equipo -> nombre
  // escaneamos jornadas del centro hacia fuera hasta reunir >= total_equipos o agotar
  const orden: number[] = [];
  const medio = Math.max(1, Math.floor(total / 2));
  for (let d = 0; d < total; d++) {
    const a = medio + d, b = medio - d;
    if (a <= total) orden.push(a);
    if (b >= 1 && b !== a) orden.push(b);
    if (orden.length >= 6) break;   // con 6 jornadas basta de sobra para ver todos los equipos
  }
  for (const j of orden) {
    const data = await ffcvGet(`partidos/resultados_por_grupo_jornada_data.php?cod_temporada=${g.cod_temporada}&cod_competicion=${g.cod_competicion}&cod_grupo=${codGrupo}&cod_jornada=${j}`);
    for (const p of (data.partidos || [])) {
      if (p.cod_equipo_local) codes.set(p.cod_equipo_local, limpiar(p.local));
      if (p.cod_equipo_visitante) codes.set(p.cod_equipo_visitante, limpiar(p.visitante));
    }
    if (codes.size >= 4) break;   // ya tenemos equipos; no hace falta seguir escaneando
  }

  // 3) upsert de cada equipo (colgado del grupo) y encolarlo para su plantilla
  let n = 0;
  for (const [cod, nombre] of codes) {
    await admin.from("equipos").upsert({ cod_ffcv: cod, nombre, grupo_id: grupoId }, { onConflict: "cod_ffcv" });
    await admin.from("ffcv_cola").upsert({ tipo: "equipo", referencia: cod, estado: "pendiente" }, { onConflict: "tipo,referencia" });
    n++;
  }
  return { equipos: n };
}

// ------------------------------------------------------------
// Procesa un EQUIPO: descarga plantilla + ficha de cada jugador
// ------------------------------------------------------------
async function procesarEquipo(admin: any, codEquipo: string): Promise<{ nuevos: number; actualizados: number }> {
  const { data: equipo } = await admin.from("equipos").select("id").eq("cod_ffcv", codEquipo).maybeSingle();
  if (!equipo) throw new Error("equipo no encontrado");

  const pl = await ffcvGet(`equipos/plantilla_home.php?cod_equipo=${codEquipo}`);
  const jugadores = pl.jugadores_equipo || [];
  let nuevos = 0, actualizados = 0;

  for (const jug of jugadores) {
    const codLic = String(jug.codjugador || "").trim();
    if (!codLic) continue;

    // ficha con fecha de nacimiento e historial (endpoint distinto)
    let fechaNac: string | null = null;
    let historial: any[] = [];
    try {
      const h = await ffcvGet(`jugadores/historial_deportivo.php?cod_licencia=${codLic}`);
      fechaNac = parseFecha(h.fecha_nacimiento);
      historial = (h.datos_historico || []).map((x: any) => ({
        temporada: limpiar(x.temporada), equipo: limpiar(x.equipo), categoria: limpiar(x.categoria),
      }));
    } catch { /* si falla la ficha, seguimos con lo básico */ }

    // foto -> R2 (solo si el jugador aún no tiene una guardada)
    const { data: existente } = await admin.from("jugadores").select("id, foto_url").eq("cod_ffcv", codLic).maybeSingle();
    let fotoUrl = existente?.foto_url || null;
    if (!fotoUrl && jug.foto) {
      fotoUrl = await subirFotoR2(jug.foto, `ffcv/${codLic}.jpg`);
    }

    const registro = {
      cod_ffcv: codLic,
      nombre: limpiar(jug.nombre),
      equipo_id: equipo.id,
      posicion: limpiar(jug.posicion) || null,
      dorsal: limpiar(jug.dorsal) || null,
      fecha_nacimiento: fechaNac,
      foto_url: fotoUrl,
      historial,
      ffcv_actualizado: new Date().toISOString(),
    };
    await admin.from("jugadores").upsert(registro, { onConflict: "cod_ffcv" });
    if (existente) actualizados++; else nuevos++;
  }
  return { nuevos, actualizados };
}

// upsert por cod_ffcv devolviendo el id; extra = campos padre (categoria_id, etc.)
async function upsertNivel(admin: any, tabla: string, base: { cod_ffcv: string; nombre: string }, extra: Record<string, unknown>): Promise<string> {
  const { data } = await admin.from(tabla).upsert({ ...base, ...extra }, { onConflict: "cod_ffcv" }).select("id").single();
  return data.id;
}
