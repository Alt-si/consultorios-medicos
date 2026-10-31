// =====================================================================
//  Agenda de turnos · Servidor (Cloudflare Pages Functions + D1)
//  Necesita en Cloudflare:
//   · Enlace D1 con el nombre  DB
//   · Variable secreta  SETUP_CODE  (para crear la primera cuenta admin)
//   · Variable secreta  CRON_KEY    (para los recordatorios automáticos de WhatsApp)
//  Las tablas se crean solas la primera vez.
// =====================================================================

const ESTADOS = ["pendiente", "confirmado", "asistio", "ausente", "bloqueo", "cancelado"];
const TIPOS_ORDEN = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_ORDEN = 1900000;          // bytes por foto o PDF de orden
const MAX_CONFIG = 600000;          // tamaño de la configuración (incluye el logo)
const DIAS_SESION = 30;
const ZONA_HORAS = -3;              // Argentina (sin horario de verano)

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cuentas (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, slug TEXT UNIQUE,
     rol TEXT NOT NULL DEFAULT 'consultorio', hash TEXT NOT NULL, salt TEXT NOT NULL, activa INTEGER NOT NULL DEFAULT 1, creada TEXT NOT NULL, ultimo_ingreso TEXT)`,
  `CREATE TABLE IF NOT EXISTS sesiones (token TEXT PRIMARY KEY, cuenta_id INTEGER NOT NULL, expira INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS config (cuenta_id INTEGER PRIMARY KEY, data TEXT NOT NULL, actualizado TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS turnos (id INTEGER PRIMARY KEY AUTOINCREMENT, cuenta_id INTEGER NOT NULL, pro TEXT NOT NULL, fecha TEXT NOT NULL,
     inicio TEXT NOT NULL, ini_min INTEGER NOT NULL, dur INTEGER NOT NULL, estado TEXT NOT NULL, origen TEXT NOT NULL, datos TEXT NOT NULL,
     creado TEXT NOT NULL, actualizado TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS turnos_cf ON turnos (cuenta_id, fecha)`,
  `CREATE INDEX IF NOT EXISTS turnos_ca ON turnos (cuenta_id, actualizado)`,
  `CREATE TABLE IF NOT EXISTS ordenes (id TEXT PRIMARY KEY, cuenta_id INTEGER NOT NULL, tipo TEXT NOT NULL, data BLOB NOT NULL, creado TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS limites (clave TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS whatsapp (cuenta_id INTEGER PRIMARY KEY, phone_id TEXT, token TEXT, app_secret TEXT, verify_token TEXT NOT NULL,
     plantilla_conf TEXT NOT NULL DEFAULT 'turno_confirmacion', plantilla_rec TEXT NOT NULL DEFAULT 'turno_recordatorio', idioma TEXT NOT NULL DEFAULT 'es_AR',
     hora_rec INTEGER NOT NULL DEFAULT 10, al_reservar INTEGER NOT NULL DEFAULT 1, recordatorio INTEGER NOT NULL DEFAULT 1, activo INTEGER NOT NULL DEFAULT 0,
     ultimo_error TEXT, actualizado TEXT)`,
  `CREATE TABLE IF NOT EXISTS wa_envios (turno_id INTEGER NOT NULL, tipo TEXT NOT NULL, cuenta_id INTEGER NOT NULL, estado TEXT NOT NULL, msg_id TEXT, error TEXT, creado TEXT NOT NULL, PRIMARY KEY (turno_id, tipo))`,
  `CREATE TABLE IF NOT EXISTS wa_mensajes (id INTEGER PRIMARY KEY AUTOINCREMENT, cuenta_id INTEGER NOT NULL, telefono TEXT NOT NULL, nombre TEXT, texto TEXT NOT NULL,
     sentido TEXT NOT NULL, turno_id INTEGER, creado TEXT NOT NULL, leido INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS wa_mensajes_c ON wa_mensajes (cuenta_id, creado)`,
  `CREATE INDEX IF NOT EXISTS limites_c ON limites (clave, ts)`
];
let schemaListo = false;

/* ---------------- utilidades ---------------- */
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers}
});
const fallo = (status, error, message) => json({error, message: message || error}, status);
const ahoraISO = () => new Date().toISOString();
const hoy = () => new Date(Date.now() + ZONA_HORAS * 3600e3).toISOString().slice(0, 10);
const sumarDias = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diaSemana = s => new Date(s + "T12:00:00Z").getUTCDay();
const aMin = t => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(new Date(s + "T12:00:00Z"));
const esHora = s => /^[0-2]\d:[0-5]\d$/.test(s || "") && aMin(s) < 24 * 60;
const esMail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || "") && s.length <= 120;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const azar = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function hashClave(clave, salt){
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000}, key, 256);
  return hex(bits);
}
function claveNueva(){
  const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(10));
  return [...r].map(x => a[x % a.length]).join("");
}
function slugDe(t){
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "consultorio";
}
function leerCookie(req, nombre){
  const c = req.headers.get("cookie") || "";
  const m = c.split(/;\s*/).find(x => x.startsWith(nombre + "="));
  return m ? decodeURIComponent(m.slice(nombre.length + 1)) : null;
}
const cookieSesion = (token, maxAge) => `sesion=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const ip = req => req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "local";
async function leerJSON(req, max = 200000){
  const t = await req.text();
  if (t.length > max) throw Object.assign(new Error("muy_grande"), {status: 413});
  try { return t ? JSON.parse(t) : {}; } catch(_){ throw Object.assign(new Error("json_invalido"), {status: 400}); }
}
// Límite de pedidos: true si se puede seguir
async function limite(db, clave, max, segundos){
  const t = Math.floor(Date.now() / 1000);
  const r = await db.prepare("SELECT COUNT(*) AS n FROM limites WHERE clave = ? AND ts > ?").bind(clave, t - segundos).first();
  if ((r && r.n) >= max) return false;
  await db.prepare("INSERT INTO limites (clave, ts) VALUES (?, ?)").bind(clave, t).run();
  if (Math.random() < 0.02) await db.prepare("DELETE FROM limites WHERE ts < ?").bind(t - 86400).run();
  return true;
}
const filaTurno = r => ({id: r.id, pro: r.pro, fecha: r.fecha, inicio: r.inicio, dur: r.dur, estado: r.estado, origen: r.origen,
  datos: (() => { try { return JSON.parse(r.datos); } catch(_){ return {}; } })(), actualizado: r.actualizado});
const yo = c => ({id: c.id, email: c.email, nombre: c.nombre, slug: c.slug, rol: c.rol});

async function sesionActual(db, req){
  const token = leerCookie(req, "sesion");
  if (!token) return null;
  const h = await sha256(token);
  const c = await db.prepare(`SELECT c.* FROM sesiones s JOIN cuentas c ON c.id = s.cuenta_id
    WHERE s.token = ? AND s.expira > ? AND c.activa = 1`).bind(h, Date.now()).first();
  return c || null;
}
async function crearSesion(db, cuentaId){
  const token = azar(32);
  await db.prepare("INSERT INTO sesiones (token, cuenta_id, expira) VALUES (?, ?, ?)").bind(await sha256(token), cuentaId, Date.now() + DIAS_SESION * 864e5).run();
  await db.prepare("UPDATE cuentas SET ultimo_ingreso = ? WHERE id = ?").bind(ahoraISO(), cuentaId).run();
  return cookieSesion(token, DIAS_SESION * 86400);
}
async function cuentaPorSlug(db, slug){
  return db.prepare("SELECT * FROM cuentas WHERE slug = ? AND rol = 'consultorio' AND activa = 1").bind(String(slug || "")).first();
}
async function configDe(db, cuentaId){
  const r = await db.prepare("SELECT data FROM config WHERE cuenta_id = ?").bind(cuentaId).first();
  if (!r) return null;
  try { return JSON.parse(r.data); } catch(_){ return null; }
}

/* ---------------- WhatsApp automático (API oficial de Meta) ---------------- */
const SERVER_KEYS = ["waConf", "waConfErr", "waRec", "waRecErr", "patientConfirmed", "wantsChange", "patientReplyAt"];
const graph = env => (env.WA_API_BASE || "https://graph.facebook.com") + "/" + (env.WA_GRAPH_VERSION || "v25.0");
function normTel(n){
  let d = String(n || "").replace(/\D/g, ""); if (!d) return "";
  if (d.startsWith("54")) return d;
  d = d.replace(/^0/, "");
  if (d.length === 12 && d.slice(2, 4) === "15") d = d.slice(0, 2) + d.slice(4);
  return "549" + d;
}
const limpio = (t, max = 700) => String(t || "").replace(/[\r\n\t]+/g, " · ").replace(/\s{2,}/g, " ").trim().slice(0, max) || "-";
const plata = n => "$ " + Number(n || 0).toLocaleString("es-AR");
function fechaLarga(f){
  const t = new Date(f + "T12:00:00Z").toLocaleDateString("es-AR", {weekday: "long", day: "numeric", month: "long", timeZone: "UTC"});
  return t.charAt(0).toUpperCase() + t.slice(1);
}
// Arma los 7 datos que van en las plantillas de WhatsApp
function datosMensaje(cfg, cuentaNombre, t){
  const d = t.datos || {}, cl = cfg.clinic || {};
  const items = Array.isArray(d.items) ? d.items : [];
  const svcs = items.map(i => (cfg.services || []).find(s => s.id === i.id) || {name: i.n, price: 0});
  const pro = (cfg.pros || []).find(p => p.id === t.pro);
  const nombre = (String(d.name || "").trim().split(/\s+/)[0] || "").slice(0, 40) || "paciente";
  const que = (svcs.map(s => s.name).join(" + ") || "Turno") + (pro ? " con " + pro.name : "");
  const os = d.os || "Particular", total = svcs.reduce((a, s) => a + (Number(s.price) || 0), 0);
  let pago;
  if (os === "Particular") pago = "Monto a abonar: " + plata(total);
  else {
    let cubre = 0, falta = false;
    svcs.forEach(s => { const v = s.cov && s.cov[os]; if (v === undefined || v === null || v === "") falta = true; else cubre += Math.min(Number(v), Number(s.price) || 0); });
    pago = falta ? "Cobertura: " + os + " (te confirmamos si hay diferencia)" : (total - cubre > 0 ? "Monto a abonar: " + plata(total - cubre) + " (" + os + ")" : "Sin monto a abonar (" + os + ")");
  }
  const met = (cfg.payments && cfg.payments.methods) || [];
  if (pago.startsWith("Monto a abonar") && met.length) pago += ". Aceptamos " + met.join(", ").toLowerCase();
  const ind = [];
  svcs.forEach(s => { if (s.prep) ind.push(s.prep); if (s.needs) ind.push("Necesitás: " + s.needs); });
  const orden = svcs.some(s => s.order), auth = ((cfg.coverage || []).find(c => c.n === os) || {}).auth;
  ind.push("Traé DNI" + (os !== "Particular" ? ", credencial de " + os : "") + (orden ? " y la orden médica" + (auth ? " autorizada" : "") : ""));
  const inc = cfg.waIncl || {}, no = k => inc[k] === false;
  const que2 = no("profesional") ? (svcs.map(s => s.name).join(" + ") || "Turno") : que;
  return [nombre, cl.name || cuentaNombre, fechaLarga(t.fecha) + ", " + t.inicio + " h", que2, no("direccion") ? "—" : (cl.address || "-"),
    no("monto") ? "—" : pago, no("indicaciones") ? "—" : ind.join(" · ")].map(x => limpio(x));
}
async function waEnviar(env, wa, cuerpo){
  if (!wa || !wa.phone_id || !wa.token) return {ok: false, error: "WhatsApp sin configurar"};
  try {
    const r = await fetch(graph(env) + "/" + encodeURIComponent(wa.phone_id) + "/messages", {method: "POST",
      headers: {"authorization": "Bearer " + wa.token, "content-type": "application/json"}, body: JSON.stringify(Object.assign({messaging_product: "whatsapp"}, cuerpo))});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return {ok: false, error: limpio((j.error && (j.error.error_user_msg || j.error.message)) || ("Error " + r.status), 300)};
    return {ok: true, id: j.messages && j.messages[0] && j.messages[0].id};
  } catch(e){ return {ok: false, error: "No se pudo conectar con WhatsApp"}; }
}
function cuerpoPlantilla(wa, tipo, to, params, turnoId){
  const comps = [{type: "body", parameters: params.map(text => ({type: "text", text}))}];
  if (tipo === "recordatorio") [["CONFIRMO", 0], ["CAMBIO", 1]].forEach(([k, i]) =>
    comps.push({type: "button", sub_type: "quick_reply", index: String(i), parameters: [{type: "payload", payload: k + ":" + turnoId}]}));
  return {to, type: "template", template: {name: tipo === "recordatorio" ? wa.plantilla_rec : wa.plantilla_conf, language: {code: wa.idioma || "es_AR"}, components: comps}};
}
// Envía la confirmación o el recordatorio de un turno (una sola vez por tipo)
async function waTurno(env, db, cuentaId, turnoId, tipo){
  const wa = await db.prepare("SELECT * FROM whatsapp WHERE cuenta_id = ? AND activo = 1").bind(cuentaId).first();
  if (!wa || (tipo === "confirmacion" && !wa.al_reservar) || (tipo === "recordatorio" && !wa.recordatorio)) return null;
  const row = await db.prepare("SELECT * FROM turnos WHERE id = ? AND cuenta_id = ?").bind(turnoId, cuentaId).first();
  if (!row || row.estado === "bloqueo" || row.estado === "cancelado") return null;
  const t = filaTurno(row), to = normTel(t.datos.phone);
  if (to.length < 10) return null;
  const ins = await db.prepare("INSERT OR IGNORE INTO wa_envios (turno_id, tipo, cuenta_id, estado, creado) VALUES (?, ?, ?, 'enviando', ?)").bind(turnoId, tipo, cuentaId, ahoraISO()).run();
  if (!ins.meta.changes) return null;                       // ya se mandó
  const cfg = (await configDe(db, cuentaId)) || {};
  const cta = await db.prepare("SELECT nombre FROM cuentas WHERE id = ?").bind(cuentaId).first();
  const r = await waEnviar(env, wa, cuerpoPlantilla(wa, tipo, to, datosMensaje(cfg, cta && cta.nombre, t), turnoId));
  await db.prepare("UPDATE wa_envios SET estado = ?, msg_id = ?, error = ? WHERE turno_id = ? AND tipo = ?").bind(r.ok ? "enviado" : "error", r.id || null, r.error || null, turnoId, tipo).run();
  const k = tipo === "recordatorio" ? "waRec" : "waConf";
  const datos = Object.assign({}, t.datos, {[k]: r.ok ? ahoraISO() : null, [k + "Err"]: r.ok ? null : r.error});
  if (tipo === "recordatorio" && r.ok) datos.reminded = true;
  await db.prepare("UPDATE turnos SET datos = ?, actualizado = ? WHERE id = ?").bind(JSON.stringify(datos), ahoraISO(), turnoId).run();
  if (!r.ok) await db.prepare("UPDATE whatsapp SET ultimo_error = ? WHERE cuenta_id = ?").bind(r.error, cuentaId).run();
  return r;
}
// Recordatorios del día siguiente para todos los consultorios (lo llama el cron)
async function waRecordatorios(env, db){
  const ahora = new Date(Date.now() + ZONA_HORAS * 3600e3), hora = ahora.getUTCHours(), manana = sumarDias(hoy(), 1);
  const was = (await db.prepare("SELECT w.cuenta_id, w.hora_rec FROM whatsapp w JOIN cuentas c ON c.id = w.cuenta_id WHERE w.activo = 1 AND w.recordatorio = 1 AND c.activa = 1").all()).results || [];
  let enviados = 0, errores = 0;
  for (const w of was){
    if (hora < w.hora_rec) continue;
    const ts = (await db.prepare(`SELECT id FROM turnos t WHERE cuenta_id = ? AND fecha = ? AND estado IN ('pendiente','confirmado')
      AND NOT EXISTS (SELECT 1 FROM wa_envios e WHERE e.turno_id = t.id AND e.tipo = 'recordatorio') ORDER BY ini_min LIMIT ?`).bind(w.cuenta_id, manana, Math.max(0, 40 - enviados - errores)).all()).results || [];
    for (const t of ts){ const r = await waTurno(env, db, w.cuenta_id, t.id, "recordatorio"); if (r) r.ok ? enviados++ : errores++; }
    if (enviados + errores >= 40) break;                       // el resto sale en la próxima vuelta
  }
  return {enviados, errores, fecha: manana};
}
async function firmaValida(req, cuerpo, secreto){
  const h = req.headers.get("x-hub-signature-256") || "";
  if (!secreto || !h.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, cuerpo));
  const a = h.slice(7);
  if (a.length !== sig.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ sig.charCodeAt(i);
  return x === 0;
}
// Respuestas de los pacientes (botones y mensajes)
async function waWebhook(env, db, cuenta, req){
  const wa = await db.prepare("SELECT * FROM whatsapp WHERE cuenta_id = ?").bind(cuenta.id).first();
  const buf = await req.arrayBuffer();
  if (!wa || !(await firmaValida(req, buf, wa.app_secret))) return fallo(401, "firma_invalida");
  let body; try { body = JSON.parse(new TextDecoder().decode(buf)); } catch(_){ return json({ok: true}); }
  for (const en of body.entry || []) for (const ch of en.changes || []){
    const v = ch.value || {}, contactos = v.contacts || [];
    for (const m of v.messages || []){
      const tel = String(m.from || ""), nombre = ((contactos.find(c => c.wa_id === tel) || {}).profile || {}).name || "";
      let payload = "", texto = "";
      if (m.type === "button"){ payload = (m.button && m.button.payload) || ""; texto = (m.button && m.button.text) || payload; }
      else if (m.type === "interactive"){ const br = m.interactive && m.interactive.button_reply; payload = (br && br.id) || ""; texto = (br && br.title) || ""; }
      else if (m.type === "text") texto = (m.text && m.text.body) || "";
      else texto = "[" + (m.type || "mensaje") + "]";
      let turnoId = null;
      const pm = /^(CONFIRMO|CAMBIO):(\d+)$/.exec(payload);
      if (pm){
        turnoId = Number(pm[2]);
        const row = await db.prepare("SELECT * FROM turnos WHERE id = ? AND cuenta_id = ?").bind(turnoId, cuenta.id).first();
        if (row){
          const t = filaTurno(row), datos = Object.assign({}, t.datos, {patientReplyAt: ahoraISO()});
          let estado = row.estado;
          if (pm[1] === "CONFIRMO"){ datos.patientConfirmed = true; datos.wantsChange = false; if (estado === "pendiente") estado = "confirmado"; }
          else { datos.wantsChange = true; datos.patientConfirmed = false; }
          await db.prepare("UPDATE turnos SET estado = ?, datos = ?, actualizado = ? WHERE id = ?").bind(estado, JSON.stringify(datos), ahoraISO(), turnoId).run();
          const resp = pm[1] === "CONFIRMO" ? "¡Gracias! Tu turno quedó confirmado. Te esperamos." : "Recibimos tu pedido. En breve te escribimos para reprogramar el turno.";
          await waEnviar(env, wa, {to: tel, type: "text", text: {body: resp}});
        }
      }
      await db.prepare("INSERT INTO wa_mensajes (cuenta_id, telefono, nombre, texto, sentido, turno_id, creado) VALUES (?, ?, ?, ?, 'entrada', ?, ?)")
        .bind(cuenta.id, tel, limpio(nombre, 80), String(texto).slice(0, 2000), turnoId, ahoraISO()).run();
    }
  }
  return json({ok: true});
}
const waPublico = w => w ? {phone_id: w.phone_id || "", tieneToken: !!w.token, tieneSecreto: !!w.app_secret, verify_token: w.verify_token,
  plantilla_conf: w.plantilla_conf, plantilla_rec: w.plantilla_rec, idioma: w.idioma, hora_rec: w.hora_rec, al_reservar: !!w.al_reservar,
  recordatorio: !!w.recordatorio, activo: !!w.activo, ultimo_error: w.ultimo_error || ""} : null;

/* ---------------- reserva pública ---------------- */
async function reservar(db, cuenta, body, env, ctx){
  const pro = String(body.pro || ""), fecha = body.fecha, inicio = body.inicio, dur = Number(body.dur);
  let datos = body.datos && typeof body.datos === "object" ? body.datos : {};
  if (!pro || !esFecha(fecha) || !esHora(inicio) || !Number.isInteger(dur) || dur < 5 || dur > 240) return fallo(400, "datos_invalidos");
  const h = hoy();
  if (fecha < h || fecha > sumarDias(h, 400)) return fallo(400, "fecha_invalida");
  if (!String(datos.name || "").trim()) return fallo(400, "falta_nombre");
  const cfg = await configDe(db, cuenta.id);
  const p = cfg && Array.isArray(cfg.pros) && cfg.pros.find(x => x.id === pro);
  if (!p) return fallo(400, "profesional_inexistente");
  if ((cfg.daysOff || []).some(o => o.d === fecha && (!o.pro || o.pro === pro))) return fallo(409, "dia_anulado");
  const franjas = (p.hours && p.hours[String(diaSemana(fecha))]) || [];
  const ini = aMin(inicio);
  if (!franjas.some(([a, b]) => ini >= aMin(a) && ini + dur <= aMin(b))) return fallo(409, "fuera_de_horario");
  if (fecha === h){
    const ahora = new Date(Date.now() + ZONA_HORAS * 3600e3), min = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
    if (ini < min) return fallo(409, "fuera_de_horario");
  }
  const code = claveNueva().slice(0, 5).toUpperCase();
  delete datos.status; delete datos.id; delete datos.orderThumb;
  datos = Object.assign(datos, {code, isNew: true, source: "web"});
  const txt = JSON.stringify(datos);
  if (txt.length > 20000) return fallo(413, "datos_muy_grandes");
  const t = ahoraISO();
  // Inserta solo si nadie tomó ese horario (una sola operación, sin carreras)
  const r = await db.prepare(`INSERT INTO turnos (cuenta_id, pro, fecha, inicio, ini_min, dur, estado, origen, datos, creado, actualizado)
    SELECT ?, ?, ?, ?, ?, ?, 'pendiente', 'web', ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM turnos WHERE cuenta_id = ? AND pro = ? AND fecha = ? AND estado <> 'cancelado'
                      AND ini_min < ? AND ? < ini_min + dur)`)
    .bind(cuenta.id, pro, fecha, inicio, ini, dur, txt, t, t, cuenta.id, pro, fecha, ini + dur, ini).run();
  if (!r.meta || !r.meta.changes) return fallo(409, "horario_ocupado");
  const nuevo = r.meta.last_row_id;
  if (ctx && ctx.waitUntil) ctx.waitUntil(waTurno(env, db, cuenta.id, nuevo, "confirmacion").catch(() => null));
  return json({id: nuevo, code});
}

/* ---------------- router ---------------- */
export async function onRequest(ctx){
  const {request: req, env} = ctx;
  const db = env.DB;
  if (!db) return fallo(500, "falta_base", "Falta conectar la base de datos D1 con el nombre DB.");
  try {
    if (!schemaListo){ await db.batch(SCHEMA.map(s => db.prepare(s))); schemaListo = true; }
    const url = new URL(req.url);
    const parts = (Array.isArray(ctx.params.path) ? ctx.params.path : [ctx.params.path || ""]).filter(Boolean);
    const [a, b, c] = parts, M = req.method;
    // Pedidos que cambian datos: deben venir de la propia app
    // Webhook de WhatsApp (lo llama Meta)
    if (a === "wa" && c === "webhook"){
      const cuenta = await cuentaPorSlug(db, b);
      if (!cuenta) return fallo(404, "no_existe");
      if (M === "GET"){
        const wa = await db.prepare("SELECT verify_token FROM whatsapp WHERE cuenta_id = ?").bind(cuenta.id).first();
        if (wa && url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === wa.verify_token)
          return new Response(url.searchParams.get("hub.challenge") || "", {status: 200});
        return fallo(403, "token_invalido");
      }
      if (M === "POST") return waWebhook(env, db, cuenta, req);
    }
    // Recordatorios automáticos (lo llama el cron de GitHub)
    if (a === "cron" && b === "recordatorios"){
      if (!env.CRON_KEY || req.headers.get("x-cron-key") !== env.CRON_KEY) return fallo(403, "clave_cron_invalida");
      return json(await waRecordatorios(env, db));
    }
    if (M !== "GET" && M !== "HEAD" && req.headers.get("x-turnos") !== "1") return fallo(403, "origen_invalido");

    if (a === "salud") return json({ok: true});

    /* ---- primera configuración ---- */
    if (a === "setup"){
      const hayAdmin = await db.prepare("SELECT 1 FROM cuentas WHERE rol = 'admin' LIMIT 1").first();
      if (M === "GET") return json({necesario: !hayAdmin});
      if (M === "POST"){
        if (hayAdmin) return fallo(409, "ya_configurado");
        if (!env.SETUP_CODE) return fallo(500, "falta_setup_code", "Falta la variable SETUP_CODE en Cloudflare.");
        if (!(await limite(db, "setup:" + ip(req), 10, 900))) return fallo(429, "demasiados_intentos");
        const body = await leerJSON(req);
        if (String(body.codigo || "") !== String(env.SETUP_CODE)) return fallo(403, "codigo_incorrecto");
        const email = String(body.email || "").trim().toLowerCase(), nombre = String(body.nombre || "").trim() || "Administrador", clave = String(body.clave || "");
        if (!esMail(email)) return fallo(400, "mail_invalido");
        if (clave.length < 8) return fallo(400, "clave_corta");
        const salt = azar(16);
        const r = await db.prepare("INSERT INTO cuentas (email, nombre, slug, rol, hash, salt, creada) VALUES (?, ?, NULL, 'admin', ?, ?, ?)")
          .bind(email, nombre, await hashClave(clave, salt), salt, ahoraISO()).run();
        const cookie = await crearSesion(db, r.meta.last_row_id);
        return json({ok: true, yo: {id: r.meta.last_row_id, email, nombre, slug: null, rol: "admin"}}, 200, {"set-cookie": cookie});
      }
    }

    /* ---- ingreso ---- */
    if (a === "login" && M === "POST"){
      const body = await leerJSON(req);
      const email = String(body.email || "").trim().toLowerCase(), clave = String(body.clave || "");
      const cl = "login:" + ip(req);
      const fallos = await db.prepare("SELECT COUNT(*) AS n FROM limites WHERE clave = ? AND ts > ?").bind(cl, Math.floor(Date.now() / 1000) - 900).first();
      if (fallos && fallos.n >= 10) return fallo(429, "demasiados_intentos", "Demasiados intentos. Probá de nuevo en 15 minutos.");
      const cta = await db.prepare("SELECT * FROM cuentas WHERE email = ?").bind(email).first();
      if (!cta || (await hashClave(clave, cta.salt)) !== cta.hash){
        await db.prepare("INSERT INTO limites (clave, ts) VALUES (?, ?)").bind(cl, Math.floor(Date.now() / 1000)).run();
        return fallo(401, "credenciales", "Mail o contraseña incorrectos.");
      }
      if (!cta.activa) return fallo(403, "cuenta_desactivada", "Esta cuenta está desactivada.");
      return json({yo: yo(cta)}, 200, {"set-cookie": await crearSesion(db, cta.id)});
    }
    if (a === "logout" && M === "POST"){
      const token = leerCookie(req, "sesion");
      if (token) await db.prepare("DELETE FROM sesiones WHERE token = ?").bind(await sha256(token)).run();
      return json({ok: true}, 200, {"set-cookie": cookieSesion("", 0)});
    }

    /* ---- público: página de reservas de un consultorio ---- */
    if (a === "c"){
      const cuenta = await cuentaPorSlug(db, b);
      if (!cuenta) return fallo(404, "consultorio_inexistente", "No encontramos ese consultorio.");
      if (c === "config" && M === "GET") return json({nombre: cuenta.nombre, slug: cuenta.slug, data: await configDe(db, cuenta.id)});
      if (c === "ocupados" && M === "GET"){
        const desde = url.searchParams.get("desde"), hasta = url.searchParams.get("hasta");
        if (!esFecha(desde) || !esFecha(hasta)) return fallo(400, "fechas_invalidas");
        const lim = hasta > sumarDias(desde, 400) ? sumarDias(desde, 400) : hasta;
        const r = await db.prepare("SELECT pro, fecha, inicio, dur FROM turnos WHERE cuenta_id = ? AND estado <> 'cancelado' AND fecha BETWEEN ? AND ?")
          .bind(cuenta.id, desde, lim).all();
        return json(r.results || []);
      }
      if (c === "reservar" && M === "POST"){
        if (!(await limite(db, "reserva:" + ip(req), 30, 3600))) return fallo(429, "demasiados_intentos", "Demasiadas reservas seguidas. Probá más tarde.");
        return reservar(db, cuenta, await leerJSON(req, 30000), env, ctx);
      }
      if (c === "orden" && M === "POST"){
        const tipo = (req.headers.get("content-type") || "").split(";")[0].trim();
        if (!TIPOS_ORDEN.includes(tipo)) return fallo(415, "tipo_no_permitido");
        if (!(await limite(db, "orden:" + ip(req), 20, 3600))) return fallo(429, "demasiados_intentos");
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > MAX_ORDEN) return fallo(413, "archivo_muy_grande", "La foto es muy pesada.");
        const id = azar(12);
        await db.prepare("INSERT INTO ordenes (id, cuenta_id, tipo, data, creado) VALUES (?, ?, ?, ?, ?)").bind(id, cuenta.id, tipo, buf, ahoraISO()).run();
        return json({id});
      }
      return fallo(404, "no_existe");
    }

    /* ---- de acá en adelante hay que estar adentro ---- */
    const cta = await sesionActual(db, req);
    if (!cta) return fallo(401, "sin_sesion", "Tenés que ingresar.");

    if (a === "yo" && M === "GET") return json({yo: yo(cta)});
    if (a === "clave" && M === "POST"){
      const body = await leerJSON(req);
      if ((await hashClave(String(body.actual || ""), cta.salt)) !== cta.hash) return fallo(400, "clave_actual_incorrecta", "La contraseña actual no es correcta.");
      const nueva = String(body.nueva || "");
      if (nueva.length < 8) return fallo(400, "clave_corta", "La contraseña nueva tiene que tener al menos 8 caracteres.");
      const salt = azar(16);
      await db.prepare("UPDATE cuentas SET hash = ?, salt = ? WHERE id = ?").bind(await hashClave(nueva, salt), salt, cta.id).run();
      return json({ok: true});
    }

    /* ---- administrador: cuentas de los consultorios ---- */
    if (a === "admin"){
      if (cta.rol !== "admin") return fallo(403, "solo_admin");
      if (b === "cuentas" && !c && M === "GET"){
        const r = await db.prepare(`SELECT c.id, c.email, c.nombre, c.slug, c.activa, c.creada, c.ultimo_ingreso,
            (SELECT COUNT(*) FROM turnos t WHERE t.cuenta_id = c.id AND t.estado <> 'cancelado' AND t.estado <> 'bloqueo') AS turnos
          FROM cuentas c WHERE c.rol = 'consultorio' ORDER BY c.creada DESC`).all();
        return json(r.results || []);
      }
      if (b === "cuentas" && !c && M === "POST"){
        const body = await leerJSON(req);
        const email = String(body.email || "").trim().toLowerCase(), nombre = String(body.nombre || "").trim();
        if (!nombre) return fallo(400, "falta_nombre", "Escribí el nombre del consultorio.");
        if (!esMail(email)) return fallo(400, "mail_invalido", "El mail no es válido.");
        if (await db.prepare("SELECT 1 FROM cuentas WHERE email = ?").bind(email).first()) return fallo(409, "mail_repetido", "Ya hay una cuenta con ese mail.");
        let base = slugDe(body.slug || nombre), slug = base, i = 2;
        while (await db.prepare("SELECT 1 FROM cuentas WHERE slug = ?").bind(slug).first()) slug = base + "-" + i++;
        const clave = claveNueva(), salt = azar(16);
        const r = await db.prepare("INSERT INTO cuentas (email, nombre, slug, rol, hash, salt, creada) VALUES (?, ?, ?, 'consultorio', ?, ?, ?)")
          .bind(email, nombre, slug, await hashClave(clave, salt), salt, ahoraISO()).run();
        return json({cuenta: {id: r.meta.last_row_id, email, nombre, slug, activa: 1}, clave});
      }
      if (b === "cuentas" && c && M === "PATCH"){
        const id = Number(c), body = await leerJSON(req);
        const t = await db.prepare("SELECT * FROM cuentas WHERE id = ? AND rol = 'consultorio'").bind(id).first();
        if (!t) return fallo(404, "no_existe");
        const out = {ok: true};
        if (typeof body.nombre === "string" && body.nombre.trim()) await db.prepare("UPDATE cuentas SET nombre = ? WHERE id = ?").bind(body.nombre.trim(), id).run();
        if (typeof body.email === "string" && body.email.trim().toLowerCase() !== t.email){
          const email = body.email.trim().toLowerCase();
          if (!esMail(email)) return fallo(400, "mail_invalido", "El mail no es válido.");
          if (await db.prepare("SELECT 1 FROM cuentas WHERE email = ? AND id <> ?").bind(email, id).first()) return fallo(409, "mail_repetido", "Ya hay otra cuenta con ese mail.");
          await db.prepare("UPDATE cuentas SET email = ? WHERE id = ?").bind(email, id).run();
        }
        if (typeof body.slug === "string" && body.slug.trim()){
          const slug = slugDe(body.slug);
          if (slug !== t.slug){
            if (await db.prepare("SELECT 1 FROM cuentas WHERE slug = ? AND id <> ?").bind(slug, id).first()) return fallo(409, "link_repetido", "Ese link ya lo usa otro consultorio.");
            await db.prepare("UPDATE cuentas SET slug = ? WHERE id = ?").bind(slug, id).run();
          }
        }
        if (typeof body.activa === "boolean"){
          await db.prepare("UPDATE cuentas SET activa = ? WHERE id = ?").bind(body.activa ? 1 : 0, id).run();
          if (!body.activa) await db.prepare("DELETE FROM sesiones WHERE cuenta_id = ?").bind(id).run();
        }
        if (body.reiniciarClave){
          const clave = claveNueva(), salt = azar(16);
          await db.prepare("UPDATE cuentas SET hash = ?, salt = ? WHERE id = ?").bind(await hashClave(clave, salt), salt, id).run();
          await db.prepare("DELETE FROM sesiones WHERE cuenta_id = ?").bind(id).run();
          out.clave = clave;
        }
        out.cuenta = await db.prepare("SELECT id, email, nombre, slug, activa, creada, ultimo_ingreso FROM cuentas WHERE id = ?").bind(id).first();
        return json(out);
      }
      return fallo(404, "no_existe");
    }

    /* ---- consultorio: su configuración, sus turnos y sus órdenes ---- */
    if (cta.rol !== "consultorio") return fallo(403, "solo_consultorio");
    if (a === "config"){
      if (M === "GET") return json({data: await configDe(db, cta.id), nombre: cta.nombre, slug: cta.slug});
      if (M === "PUT"){
        const body = await leerJSON(req, MAX_CONFIG + 1000);
        if (!body.data || typeof body.data !== "object" || !Array.isArray(body.data.pros)) return fallo(400, "config_invalida");
        const txt = JSON.stringify(body.data);
        if (txt.length > MAX_CONFIG) return fallo(413, "config_muy_grande", "La configuración es muy grande (probá con un logo más liviano).");
        await db.prepare(`INSERT INTO config (cuenta_id, data, actualizado) VALUES (?, ?, ?)
          ON CONFLICT(cuenta_id) DO UPDATE SET data = excluded.data, actualizado = excluded.actualizado`).bind(cta.id, txt, ahoraISO()).run();
        return json({ok: true});
      }
    }
    if (a === "turnos"){
      if (!b && M === "GET"){
        const cambios = url.searchParams.get("cambios");
        if (cambios){
          const r = await db.prepare("SELECT * FROM turnos WHERE cuenta_id = ? AND actualizado > ? ORDER BY actualizado").bind(cta.id, cambios).all();
          return json((r.results || []).map(filaTurno));
        }
        const desde = url.searchParams.get("desde"), hasta = url.searchParams.get("hasta");
        if (!esFecha(desde) || !esFecha(hasta)) return fallo(400, "fechas_invalidas");
        const r = await db.prepare("SELECT * FROM turnos WHERE cuenta_id = ? AND fecha BETWEEN ? AND ? ORDER BY fecha, ini_min").bind(cta.id, desde, hasta).all();
        return json((r.results || []).map(filaTurno));
      }
      if (!b && M === "POST"){
        const x = await leerJSON(req, 30000);
        if (!x.pro || !esFecha(x.fecha) || !esHora(x.inicio) || !Number.isInteger(x.dur) || x.dur < 5 || x.dur > 480 || !ESTADOS.includes(x.estado)) return fallo(400, "datos_invalidos");
        const t = ahoraISO();
        const r = await db.prepare(`INSERT INTO turnos (cuenta_id, pro, fecha, inicio, ini_min, dur, estado, origen, datos, creado, actualizado)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(cta.id, String(x.pro), x.fecha, x.inicio, aMin(x.inicio), x.dur, x.estado,
          String(x.origen || "manual"), JSON.stringify(x.datos || {}), t, t).run();
        const nid = r.meta.last_row_id;
        if (x.estado !== "bloqueo" && x.avisar !== false && ctx.waitUntil) ctx.waitUntil(waTurno(env, db, cta.id, nid, "confirmacion").catch(() => null));
        const row = await db.prepare("SELECT * FROM turnos WHERE id = ?").bind(nid).first();
        return json(filaTurno(row));
      }
      if (b && M === "PATCH"){
        const id = Number(b), x = await leerJSON(req, 30000);
        const cur = await db.prepare("SELECT * FROM turnos WHERE id = ? AND cuenta_id = ?").bind(id, cta.id).first();
        if (!cur) return fallo(404, "no_existe");
        const n = {pro: x.pro ?? cur.pro, fecha: x.fecha ?? cur.fecha, inicio: x.inicio ?? cur.inicio, dur: x.dur ?? cur.dur, estado: x.estado ?? cur.estado,
          datos: cur.datos};
        if (x.datos !== undefined){
          const viejo = (() => { try { return JSON.parse(cur.datos); } catch(_){ return {}; } })(), nuevo = Object.assign({}, x.datos);
          SERVER_KEYS.forEach(k => { if (k in viejo) nuevo[k] = viejo[k]; });   // lo que escribe WhatsApp no se pisa
          n.datos = JSON.stringify(nuevo);
        }
        if (!esFecha(n.fecha) || !esHora(n.inicio) || !Number.isInteger(n.dur) || !ESTADOS.includes(n.estado)) return fallo(400, "datos_invalidos");
        await db.prepare("UPDATE turnos SET pro = ?, fecha = ?, inicio = ?, ini_min = ?, dur = ?, estado = ?, datos = ?, actualizado = ? WHERE id = ? AND cuenta_id = ?")
          .bind(String(n.pro), n.fecha, n.inicio, aMin(n.inicio), n.dur, n.estado, n.datos, ahoraISO(), id, cta.id).run();
        return json(filaTurno(await db.prepare("SELECT * FROM turnos WHERE id = ?").bind(id).first()));
      }
    }
    if (a === "whatsapp"){
      let wa = await db.prepare("SELECT * FROM whatsapp WHERE cuenta_id = ?").bind(cta.id).first();
      if (!wa){
        await db.prepare("INSERT INTO whatsapp (cuenta_id, verify_token, actualizado) VALUES (?, ?, ?)").bind(cta.id, azar(12), ahoraISO()).run();
        wa = await db.prepare("SELECT * FROM whatsapp WHERE cuenta_id = ?").bind(cta.id).first();
      }
      if (!b && M === "GET") return json(waPublico(wa));
      if (!b && M === "PUT"){
        const x = await leerJSON(req);
        const v = {
          phone_id: typeof x.phone_id === "string" ? x.phone_id.replace(/\D/g, "") : wa.phone_id,
          token: typeof x.token === "string" && x.token.trim() ? x.token.trim() : wa.token,
          app_secret: typeof x.app_secret === "string" && x.app_secret.trim() ? x.app_secret.trim() : wa.app_secret,
          plantilla_conf: /^[a-z0-9_]{1,60}$/.test(x.plantilla_conf || "") ? x.plantilla_conf : wa.plantilla_conf,
          plantilla_rec: /^[a-z0-9_]{1,60}$/.test(x.plantilla_rec || "") ? x.plantilla_rec : wa.plantilla_rec,
          idioma: /^[a-z]{2}(_[A-Z]{2})?$/.test(x.idioma || "") ? x.idioma : wa.idioma,
          hora_rec: Number.isInteger(x.hora_rec) && x.hora_rec >= 6 && x.hora_rec <= 21 ? x.hora_rec : wa.hora_rec,
          al_reservar: typeof x.al_reservar === "boolean" ? (x.al_reservar ? 1 : 0) : wa.al_reservar,
          recordatorio: typeof x.recordatorio === "boolean" ? (x.recordatorio ? 1 : 0) : wa.recordatorio,
          activo: typeof x.activo === "boolean" ? (x.activo ? 1 : 0) : wa.activo
        };
        if (v.activo && (!v.phone_id || !v.token)) return fallo(400, "faltan_datos", "Para activarlo cargá el identificador del número y el token.");
        await db.prepare(`UPDATE whatsapp SET phone_id = ?, token = ?, app_secret = ?, plantilla_conf = ?, plantilla_rec = ?, idioma = ?, hora_rec = ?,
          al_reservar = ?, recordatorio = ?, activo = ?, ultimo_error = NULL, actualizado = ? WHERE cuenta_id = ?`)
          .bind(v.phone_id, v.token, v.app_secret, v.plantilla_conf, v.plantilla_rec, v.idioma, v.hora_rec, v.al_reservar, v.recordatorio, v.activo, ahoraISO(), cta.id).run();
        return json(waPublico(await db.prepare("SELECT * FROM whatsapp WHERE cuenta_id = ?").bind(cta.id).first()));
      }
      if (b === "prueba" && M === "POST"){
        const x = await leerJSON(req), to = normTel(x.telefono);
        if (to.length < 10) return fallo(400, "telefono_invalido", "Escribí un celular válido, con código de área.");
        const cfg = (await configDe(db, cta.id)) || {};
        const svc = (cfg.services || [])[0], pro = (cfg.pros || []).find(p => svc && p.services && p.services.includes(svc.id)) || (cfg.pros || [])[0];
        const t = {pro: pro ? pro.id : "", fecha: sumarDias(hoy(), 1), inicio: "10:00", datos: {name: "Prueba", os: "Particular", items: svc ? [{id: svc.id, n: svc.name}] : []}};
        const tipo = x.tipo === "recordatorio" ? "recordatorio" : "confirmacion";
        const r = await waEnviar(env, wa, cuerpoPlantilla(wa, tipo, to, datosMensaje(cfg, cta.nombre, t), 0));
        if (!r.ok) return fallo(400, "envio_fallido", "WhatsApp respondió: " + r.error);
        return json({ok: true});
      }
      if (b === "mensajes" && M === "GET"){
        const r = await db.prepare("SELECT * FROM wa_mensajes WHERE cuenta_id = ? ORDER BY id DESC LIMIT 60").bind(cta.id).all();
        return json(r.results || []);
      }
      if (b === "leidos" && M === "POST"){
        await db.prepare("UPDATE wa_mensajes SET leido = 1 WHERE cuenta_id = ?").bind(cta.id).run();
        return json({ok: true});
      }
      if (b === "responder" && M === "POST"){
        const x = await leerJSON(req), to = normTel(x.telefono), texto = String(x.texto || "").trim().slice(0, 1500);
        if (!to || !texto) return fallo(400, "datos_invalidos");
        const r = await waEnviar(env, wa, {to, type: "text", text: {body: texto}});
        if (!r.ok) return fallo(400, "envio_fallido", "No se pudo enviar: " + r.error + ". Solo se puede responder dentro de las 24 h del último mensaje del paciente.");
        await db.prepare("INSERT INTO wa_mensajes (cuenta_id, telefono, nombre, texto, sentido, creado, leido) VALUES (?, ?, '', ?, 'salida', ?, 1)").bind(cta.id, to, texto, ahoraISO()).run();
        return json({ok: true});
      }
    }
    if (a === "orden" && b && M === "GET"){
      const r = await db.prepare("SELECT tipo, data FROM ordenes WHERE id = ? AND cuenta_id = ?").bind(String(b), cta.id).first();
      if (!r) return fallo(404, "no_existe");
      return new Response(new Uint8Array(r.data), {headers: {"content-type": r.tipo, "cache-control": "private, max-age=3600"}});
    }
    return fallo(404, "no_existe");
  } catch(e){
    return fallo(e.status || 500, e.status ? e.message : "error_interno", e.status ? e.message : "Ocurrió un error. Probá de nuevo.");
  }
}
