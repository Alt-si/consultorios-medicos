// =====================================================================
//  Agenda de turnos · Servidor (Cloudflare Pages Functions + D1)
//  Necesita en Cloudflare:
//   · Enlace D1 con el nombre  DB
//   · Variable secreta  SETUP_CODE  (para crear la primera cuenta admin)
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

/* ---------------- reserva pública ---------------- */
async function reservar(db, cuenta, body){
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
  return json({id: r.meta.last_row_id, code});
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
        return reservar(db, cuenta, await leerJSON(req, 30000));
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
        const row = await db.prepare("SELECT * FROM turnos WHERE id = ?").bind(r.meta.last_row_id).first();
        return json(filaTurno(row));
      }
      if (b && M === "PATCH"){
        const id = Number(b), x = await leerJSON(req, 30000);
        const cur = await db.prepare("SELECT * FROM turnos WHERE id = ? AND cuenta_id = ?").bind(id, cta.id).first();
        if (!cur) return fallo(404, "no_existe");
        const n = {pro: x.pro ?? cur.pro, fecha: x.fecha ?? cur.fecha, inicio: x.inicio ?? cur.inicio, dur: x.dur ?? cur.dur, estado: x.estado ?? cur.estado,
          datos: x.datos !== undefined ? JSON.stringify(x.datos) : cur.datos};
        if (!esFecha(n.fecha) || !esHora(n.inicio) || !Number.isInteger(n.dur) || !ESTADOS.includes(n.estado)) return fallo(400, "datos_invalidos");
        await db.prepare("UPDATE turnos SET pro = ?, fecha = ?, inicio = ?, ini_min = ?, dur = ?, estado = ?, datos = ?, actualizado = ? WHERE id = ? AND cuenta_id = ?")
          .bind(String(n.pro), n.fecha, n.inicio, aMin(n.inicio), n.dur, n.estado, n.datos, ahoraISO(), id, cta.id).run();
        return json(filaTurno(await db.prepare("SELECT * FROM turnos WHERE id = ?").bind(id).first()));
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
