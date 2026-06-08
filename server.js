"use strict";
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const https  = require("https");

// ─── Config ──────────────────────────────────────────────────────────────────
const root         = __dirname;
const port         = process.env.PORT || 8080;

// ─── Catálogo de conceptos e insumos ─────────────────────────────────────────
let DATA_CONCEPTOS = null;
let DATA_INSUMOS   = null;
(function loadData() {
  const cFile = path.join(root, "data", "conceptos.json");
  const iFile = path.join(root, "data", "insumos.json");
  try {
    if (fs.existsSync(cFile)) {
      DATA_CONCEPTOS = JSON.parse(fs.readFileSync(cFile, "utf8"));
      const nP = Object.keys(DATA_CONCEPTOS).length;
      const nC = Object.values(DATA_CONCEPTOS).reduce((s, a) => s + a.length, 0);
      console.log(`[Emma] Conceptos: ${nP} partidas · ${nC} conceptos`);
    } else { console.warn("[Emma] data/conceptos.json no encontrado — ejecuta scripts/extract-db.js"); }
  } catch (e) { console.error("[Emma] Error cargando conceptos:", e.message); }
  try {
    if (fs.existsSync(iFile)) {
      DATA_INSUMOS = JSON.parse(fs.readFileSync(iFile, "utf8"));
      const nD = Object.keys(DATA_INSUMOS.dict || {}).length;
      console.log(`[Emma] Insumos: ${nD} entradas en dict`);
    } else { console.warn("[Emma] data/insumos.json no encontrado — ejecuta scripts/extract-db.js"); }
  } catch (e) { console.error("[Emma] Error cargando insumos:", e.message); }
})();
const SESSION_TTL  = 7 * 24 * 60 * 60 * 1000; // 7 días en ms
const COOKIE_NAME  = "emma_session";
const DEVICE_COOKIE = "emma_device";
const MAX_DEVICES   = 2;
const ADMIN_SECRET  = process.env.ADMIN_SECRET || "4be2e609bb541c275702ddc107f24bd5fec80b6e157dc4aa";
const DEVICES_FILE  = "/tmp/emma_devices.json";

// ─── Base de usuarios (variable de entorno USERS_DB como JSON array) ─────────
// Formato: [{"email":"cliente@empresa.com","key":"EMMA-XXXX-YY-HHHHHH","name":"Nombre","active":true}]
let USERS = [];
try {
  if (process.env.USERS_DB) USERS = JSON.parse(process.env.USERS_DB);
} catch (e) {
  console.error("[Emma] USERS_DB parse error:", e.message);
}

// ─── Extra users (creados vía pago, persisten en /tmp) ───────────────────────
const EXTRA_USERS_FILE = "/tmp/emma_users_extra.json";
let extraUsers = [];
try {
  if (fs.existsSync(EXTRA_USERS_FILE))
    extraUsers = JSON.parse(fs.readFileSync(EXTRA_USERS_FILE, "utf8"));
} catch {}
for (const u of extraUsers) {
  if (!USERS.some(e => e.email.toLowerCase() === u.email.toLowerCase())) USERS.push(u);
}
function saveExtraUsers() {
  try { fs.writeFileSync(EXTRA_USERS_FILE, JSON.stringify(extraUsers), "utf8"); } catch {}
}
function addPaidUser(user) {
  const em = user.email.toLowerCase();
  const nu = { ...user, email: em };
  if (!USERS.some(u => u.email.toLowerCase() === em)) USERS.push(nu);
  if (!extraUsers.some(u => u.email.toLowerCase() === em)) { extraUsers.push(nu); saveExtraUsers(); }
}

// ─── FNV-1a 32-bit — idéntico al _h() del HTML ───────────────────────────────
const _LS = "emPrj-X7Q2-2024"; // mismo salt que en el HTML
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
function validateKey(key) {
  if (!key) return false;
  const p = key.toUpperCase().trim().split("-");
  if (p.length !== 4 || p[0] !== "EMMA") return false;
  if (!/^[0-9A-F]{4}$/.test(p[1])) return false;
  if (!/^\d{2}$/.test(p[2])) return false;
  if (!/^[0-9A-F]{6}$/.test(p[3])) return false;
  const yr = parseInt(p[2]);
  const cy = new Date().getFullYear() % 100;
  if (yr < cy) return false; // clave vencida
  const exp = fnv(p[1] + p[2] + _LS) & 0xFFFFFF;
  return exp === parseInt(p[3], 16);
}

// ─── Registro de dispositivos ─────────────────────────────────────────────────
// email → [deviceId, ...]  (máx. MAX_DEVICES por usuario)
// Persiste en /tmp entre requests; se limpia en cada redeploy.
let deviceRegistry = {};
try {
  if (fs.existsSync(DEVICES_FILE))
    deviceRegistry = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8"));
} catch {}

function saveDevices() {
  try { fs.writeFileSync(DEVICES_FILE, JSON.stringify(deviceRegistry), "utf8"); } catch {}
}
function getDevices(email)          { return deviceRegistry[email.toLowerCase()] || []; }
function deviceCount(email)         { return getDevices(email).length; }
function hasDevice(email, devId)    { return getDevices(email).includes(devId); }
function registerDevice(email, devId) {
  const em = email.toLowerCase();
  if (!deviceRegistry[em]) deviceRegistry[em] = [];
  if (!deviceRegistry[em].includes(devId)) {
    deviceRegistry[em].push(devId);
    saveDevices();
  }
}
function clearDevices(email) {
  delete deviceRegistry[email.toLowerCase()];
  saveDevices();
}

// ─── Sesiones en memoria ──────────────────────────────────────────────────────
// token (hex 64 chars) → { email, name, key, expiresAt }
const sessions = new Map();

function createSession(email, name, key) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { email, name, key, expiresAt: Date.now() + SESSION_TTL });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
}
function deleteSession(token) { sessions.delete(token); }

// Limpiar sesiones expiradas cada hora
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) { if (now > s.expiresAt) sessions.delete(t); }
}, 3_600_000).unref();

// ─── Cookies ──────────────────────────────────────────────────────────────────
function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || "").split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(v.join("="));
  });
  return cookies;
}
function makeCookie(token, maxAge) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`;
}
function makeDeviceCookie(devId) {
  return `${DEVICE_COOKIE}=${devId}; HttpOnly; SameSite=Strict; Max-Age=${365 * 24 * 3600}; Path=/`;
}

// ─── MIME types ───────────────────────────────────────────────────────────────
const MIME = {
  ".css":  "text/css; charset=utf-8",
  ".gif":  "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico":  "image/x-icon",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4":  "video/mp4",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".txt":  "text/plain; charset=utf-8",
  ".webp": "image/webp"
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 16_384) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendFile(res, filePath, extraHeaders = {}) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
      ...extraHeaders
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}

function sendJSON(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders
  });
  res.end(body);
}

// ─── HTTP helper para llamadas externas ──────────────────────────────────────
function httpsReq(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(body, "utf8") : null;
    const opts = {
      hostname, path, method,
      headers: bodyBuf
        ? { ...headers, "Content-Length": bodyBuf.length }
        : { ...headers }
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ─── Planes disponibles ───────────────────────────────────────────────────────
const PLANES = {
  mensual: { title: "Emma Presupuestos Pro — Plan Mensual", price: 399,  label: "Plan Mensual",    yearOffset: 0 },
  anual:   { title: "Emma Presupuestos Pro — Plan Anual Pro", price: 3499, label: "Plan Anual Pro", yearOffset: 1 }
};

// ─── Generador de licencia ────────────────────────────────────────────────────
function generarLicencia(planId) {
  const code4 = crypto.randomBytes(2).toString("hex").toUpperCase();
  const d = new Date();
  d.setFullYear(d.getFullYear() + ((PLANES[planId] || PLANES.mensual).yearOffset));
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const hash = (fnv(code4 + yy + _LS) & 0xFFFFFF).toString(16).toUpperCase().padStart(6, "0");
  return `EMMA-${code4}-${yy}-${hash}`;
}

// ─── Envío de email via Resend ────────────────────────────────────────────────
async function enviarEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn("[Emma] RESEND_API_KEY no configurada — email no enviado"); return; }
  const from = process.env.FROM_EMAIL || "Emma Presupuestos <licencias@emma-presupuestos.com>";
  try {
    const r = await httpsReq("POST", "api.resend.com", "/emails",
      { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      JSON.stringify({ from, to: [to], subject, html }));
    console.log(`[Emma] Email a ${to}: status ${r.status}`);
  } catch (e) { console.error("[Emma] Error email:", e.message); }
}

async function enviarCredenciales(email, name, key, planId) {
  const planLabel = (PLANES[planId] || PLANES.mensual).label;
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#17191f;">
<div style="background:#17191f;padding:32px;text-align:center;">
  <h1 style="color:#c79a43;margin:0;font-size:28px;">Emma Presupuestos Pro</h1>
  <p style="color:#9ca0a8;margin:8px 0 0;">Tu licencia está activada</p>
</div>
<div style="padding:32px;background:#fbfaf6;">
  <p>Hola <strong>${name}</strong>,</p>
  <p style="margin:12px 0;">¡Tu pago fue procesado correctamente! Ya puedes entrar con estas credenciales:</p>
  <div style="background:#fff;border:2px solid #c79a43;border-radius:8px;padding:24px;margin:24px 0;text-align:center;">
    <p style="margin:0 0 4px;color:#626978;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Correo</p>
    <p style="font-size:17px;font-weight:bold;margin:0 0 20px;">${email}</p>
    <p style="margin:0 0 4px;color:#626978;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Clave de licencia</p>
    <p style="font-size:22px;font-weight:bold;color:#c79a43;font-family:monospace;letter-spacing:3px;margin:0;">${key}</p>
  </div>
  <p style="text-align:center;">
    <a href="https://emma-presupuestos.com/login" style="background:#c79a43;color:#fff;text-decoration:none;padding:14px 32px;border-radius:999px;font-weight:bold;display:inline-block;">Entrar a Emma →</a>
  </p>
  <p style="margin-top:24px;"><strong>${planLabel}</strong> — Guarda esta clave, la necesitarás al iniciar sesión desde un dispositivo nuevo.</p>
  <hr style="border:none;border-top:1px solid #e8e4d9;margin:24px 0;">
  <p style="color:#626978;font-size:13px;">¿Tienes dudas? <a href="mailto:soporte@emma-presupuestos.com">soporte@emma-presupuestos.com</a> o WhatsApp <a href="https://wa.me/529841970948">+52 984 197 0948</a>.</p>
</div></body></html>`;
  await enviarEmail(email, "✅ Tu licencia Emma Presupuestos Pro — Credenciales de acceso", html);
}

// ─── Actualizar USERS_DB en Railway (best-effort) ─────────────────────────────
async function actualizarRailwayUsers() {
  const token = process.env.RAILWAY_TOKEN;
  const svcId = process.env.RAILWAY_SERVICE_ID;
  const envId = process.env.RAILWAY_ENVIRONMENT_ID;
  const prjId = process.env.RAILWAY_PROJECT_ID;
  if (!token || !svcId || !envId || !prjId) return;
  const val   = JSON.stringify(USERS);
  const query = `mutation{variableUpsert(input:{serviceId:${JSON.stringify(svcId)},environmentId:${JSON.stringify(envId)},projectId:${JSON.stringify(prjId)},name:"USERS_DB",value:${JSON.stringify(val)}})}`;
  try {
    const r = await httpsReq("POST", "backboard.railway.app", "/graphql/v2",
      { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify({ query }));
    console.log(`[Emma] Railway USERS_DB actualizado: ${r.status}`);
  } catch (e) { console.error("[Emma] Railway update error:", e.message); }
}

// ─── Servidor ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const method   = req.method.toUpperCase();
  let   pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "") || "/";
  } catch {
    res.writeHead(400); res.end("Bad request"); return;
  }

  const cookies = parseCookies(req);
  const session = getSession(cookies[COOKIE_NAME]);

  // ── Página principal (pública) ─────────────────────────────────────────────
  if (method === "GET" && pathname === "/") {
    return sendFile(res, path.join(root, "index.html"));
  }

  // ── Demo (pública) ─────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/demo") {
    return sendFile(res, path.join(root, "demo.html"));
  }

  // ── Panel de administración (la página es pública; los datos exigen ADMIN_SECRET) ──
  if (method === "GET" && pathname === "/emma-admin") {
    return sendFile(res, path.join(root, "emma-admin.html"));
  }

  // ── Página de login ────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/login") {
    if (session) return redirect(res, "/app");
    return sendFile(res, path.join(root, "login.html"));
  }

  // ── POST /api/login ────────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/login") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* body malformado → campos vacíos */ }

    const email = (body.email || "").toLowerCase().trim();
    const key   = (body.key   || "").trim().toUpperCase();

    if (!email || !key) {
      return sendJSON(res, 400, { error: "Email y clave de licencia requeridos." });
    }
    if (!validateKey(key)) {
      return sendJSON(res, 401, { error: "Clave de licencia inválida o vencida." });
    }

    const user = USERS.find(
      u => u.email.toLowerCase() === email
        && u.key.toUpperCase() === key
        && u.active !== false
    );
    if (!user) {
      return sendJSON(res, 401, { error: "Credenciales incorrectas o licencia inactiva." });
    }

    // ── Restricción de dispositivos (máx. MAX_DEVICES) ────────────────────
    // Los usuarios admin (user.admin === true) no tienen restricción de dispositivos
    if (!user.admin) {
      let devId       = cookies[DEVICE_COOKIE];
      const isNewDev  = !devId || !/^[0-9a-f-]{36}$/.test(devId);
      if (isNewDev) devId = crypto.randomUUID();

      if (!hasDevice(email, devId)) {
        // Dispositivo no registrado aún
        if (deviceCount(email) >= MAX_DEVICES) {
          return sendJSON(res, 403, {
            error: `Esta licencia ya está activada en ${MAX_DEVICES} dispositivos. ` +
                   `Contacta a soporte@emma-presupuestos.com para liberar un dispositivo.`
          });
        }
        registerDevice(email, devId);
      }

      if (isNewDev) {
        // Enviar cookie de dispositivo junto con la de sesión
        const token   = createSession(user.email, user.name || email, user.key);
        const sessCk  = makeCookie(token, Math.floor(SESSION_TTL / 1000));
        const devCk   = makeDeviceCookie(devId);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie"  : [sessCk, devCk],
        });
        return res.end(JSON.stringify({ ok: true, name: user.name || email }));
      }
    }

    const token  = createSession(user.email, user.name || email, user.key);
    const cookie = makeCookie(token, Math.floor(SESSION_TTL / 1000));
    return sendJSON(res, 200, { ok: true, name: user.name || email }, { "Set-Cookie": cookie });
  }

  // ── POST /api/logout ───────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/logout") {
    if (cookies[COOKIE_NAME]) deleteSession(cookies[COOKIE_NAME]);
    const clear = makeCookie("", 0);
    return sendJSON(res, 200, { ok: true }, { "Set-Cookie": clear });
  }

  // ── GET /api/me ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/me") {
    if (!session) return sendJSON(res, 401, { error: "No autenticado." });
    return sendJSON(res, 200, { email: session.email, name: session.name, key: session.key });
  }

  // ── /app — zona protegida ──────────────────────────────────────────────────
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    if (!session) return redirect(res, "/login");
    if (method !== "GET") { res.writeHead(405); res.end(); return; }

    // Sólo sirve el HTML principal en /app o /app/
    if (pathname === "/app" || pathname === "/app/") {
      return sendFile(res, path.join(root, "app", "presupuesto_emma.html"));
    }

    // Assets bajo /app/ (si los hubiera) — con protección de path traversal
    const rel      = pathname.slice(4); // quita "/app"
    const filePath = path.resolve(root, "app", rel.replace(/^\/+/, ""));
    if (!filePath.startsWith(path.join(root, "app"))) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    return sendFile(res, filePath);
  }

  // ── Assets públicos ────────────────────────────────────────────────────────
  const PUBLIC_PREFIXES = ["/assets/", "/ventas/", "/scripts/"];
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) {
    const filePath = path.resolve(root, pathname.replace(/^\/+/, ""));
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end("Forbidden"); return; }
    return sendFile(res, filePath);
  }

  // ── POST /api/admin/reset-devices ─────────────────────────────────────────
  // Requiere: Authorization: Bearer <ADMIN_SECRET>
  // Body: { "email": "usuario@empresa.com" }
  if (method === "POST" && pathname === "/api/admin/reset-devices") {
    const auth = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
    if (auth !== ADMIN_SECRET) {
      return sendJSON(res, 401, { error: "No autorizado." });
    }
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const target = (body.email || "").toLowerCase().trim();
    if (!target) return sendJSON(res, 400, { error: "email requerido." });
    clearDevices(target);
    console.log(`[Emma] Dispositivos reseteados para: ${target}`);
    return sendJSON(res, 200, { ok: true, message: `Dispositivos liberados para ${target}.` });
  }

  // ── GET /api/admin/devices ─────────────────────────────────────────────────
  // Devuelve cuántos dispositivos tiene cada usuario (sin IDs)
  if (method === "GET" && pathname === "/api/admin/devices") {
    const auth = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
    if (auth !== ADMIN_SECRET) return sendJSON(res, 401, { error: "No autorizado." });
    const summary = {};
    for (const [em, devs] of Object.entries(deviceRegistry)) {
      summary[em] = devs.length;
    }
    return sendJSON(res, 200, summary);
  }

  // ── GET /api/admin/users — lista completa de usuarios ──────────────────────
  if (method === "GET" && pathname === "/api/admin/users") {
    const auth = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
    if (auth !== ADMIN_SECRET) return sendJSON(res, 401, { error: "No autorizado." });
    const list = USERS.map(u => ({
      email:   u.email,
      name:    u.name || "",
      key:     u.key,
      plan:    u.plan || "",
      active:  u.active !== false,
      admin:   u.admin === true,
      devices: deviceCount(u.email),
      createdAt: u.createdAt || "",
    }));
    return sendJSON(res, 200, { ok: true, users: list, maxDevices: MAX_DEVICES });
  }

  // ── POST /api/admin/create-user — genera licencia y da de alta al usuario ──
  // Body: { email, name, plan: "mensual"|"anual", admin?: bool, sendEmail?: bool }
  if (method === "POST" && pathname === "/api/admin/create-user") {
    const auth = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
    if (auth !== ADMIN_SECRET) return sendJSON(res, 401, { error: "No autorizado." });
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const email = (body.email || "").toLowerCase().trim();
    const name  = (body.name  || "").trim();
    const plan  = body.plan || "anual";
    if (!email || !name) return sendJSON(res, 400, { error: "email y name requeridos." });
    if (!PLANES[plan]) return sendJSON(res, 400, { error: "Plan inválido (mensual o anual)." });
    if (USERS.some(u => u.email.toLowerCase() === email))
      return sendJSON(res, 409, { error: "Ya existe un usuario con ese correo." });

    const key = generarLicencia(plan);
    const nuevo = { email, name, key, plan, active: true, createdAt: new Date().toISOString() };
    if (body.admin === true) nuevo.admin = true;
    addPaidUser(nuevo);
    actualizarRailwayUsers();
    if (body.sendEmail) { try { await enviarCredenciales(email, name, key, plan); } catch (e) { console.error("[Emma] email alta admin:", e.message); } }
    console.log(`[Emma] Licencia creada (admin): ${email} · ${key}`);
    return sendJSON(res, 200, { ok: true, key, email, name, plan });
  }

  // ── POST /api/admin/set-active — revoca o reactiva una licencia ────────────
  // Body: { email, active: bool }
  if (method === "POST" && pathname === "/api/admin/set-active") {
    const auth = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
    if (auth !== ADMIN_SECRET) return sendJSON(res, 401, { error: "No autorizado." });
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const email  = (body.email || "").toLowerCase().trim();
    const active = body.active === true;
    if (!email) return sendJSON(res, 400, { error: "email requerido." });
    let found = false;
    USERS.forEach(u => { if (u.email.toLowerCase() === email) { u.active = active; found = true; } });
    extraUsers.forEach(u => { if (u.email.toLowerCase() === email) { u.active = active; } });
    if (!found) return sendJSON(res, 404, { error: "Usuario no encontrado." });
    saveExtraUsers();
    actualizarRailwayUsers();
    if (!active) clearDevices(email); // al revocar, libera sus dispositivos
    console.log(`[Emma] Licencia ${active ? "reactivada" : "revocada"}: ${email}`);
    return sendJSON(res, 200, { ok: true, email, active });
  }

  // ── GET /api/ping ─────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/ping") {
    if (!session) return sendJSON(res, 401, { error: "No autenticado." });
    return sendJSON(res, 200, { ok: true, client: session.name });
  }

  // ── GET /api/conceptos ────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/conceptos") {
    if (!session) return sendJSON(res, 401, { error: "No autenticado." });
    if (!DATA_CONCEPTOS) return sendJSON(res, 503, { error: "Catálogo no disponible." });
    return sendJSON(res, 200, { ok: true, data: DATA_CONCEPTOS });
  }

  // ── GET /api/insumos ──────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/insumos") {
    if (!session) return sendJSON(res, 401, { error: "No autenticado." });
    if (!DATA_INSUMOS) return sendJSON(res, 503, { error: "Insumos no disponibles." });
    return sendJSON(res, 200, { ok: true, data: DATA_INSUMOS });
  }

  // ── GET /pagar ─────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/pagar") {
    return sendFile(res, path.join(root, "checkout.html"));
  }

  // ── GET /pago-exitoso ──────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/pago-exitoso") {
    return sendFile(res, path.join(root, "pago_exitoso.html"));
  }

  // ── GET /pago-fallido | /pago-pendiente ────────────────────────────────────
  if (method === "GET" && (pathname === "/pago-fallido" || pathname === "/pago-pendiente")) {
    return sendFile(res, path.join(root, "pago_fallido.html"));
  }

  // ── POST /api/checkout — crea preferencia en MercadoPago ──────────────────
  if (method === "POST" && pathname === "/api/checkout") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const { email, name, plan } = body;
    if (!email || !name || !plan) return sendJSON(res, 400, { error: "email, name y plan requeridos." });
    if (!PLANES[plan]) return sendJSON(res, 400, { error: "Plan inválido." });

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) {
      return sendJSON(res, 503, { error: "Pagos no configurados. Contáctanos por WhatsApp al +52 984 197 0948." });
    }

    const siteUrl = (process.env.SITE_URL || "https://emma-presupuestos.com").replace(/\/$/, "");
    const planData = PLANES[plan];
    const extRef = `${Date.now()}|${plan}|${email}|${encodeURIComponent(name)}`;

    const pref = {
      items: [{ title: planData.title, quantity: 1, unit_price: planData.price, currency_id: "MXN" }],
      payer: { email, name },
      external_reference: extRef,
      back_urls: {
        success: `${siteUrl}/pago-exitoso`,
        failure: `${siteUrl}/pago-fallido`,
        pending: `${siteUrl}/pago-pendiente`
      },
      auto_return: "approved",
      notification_url: `${siteUrl}/api/mp-webhook`
    };

    try {
      const r = await httpsReq("POST", "api.mercadopago.com", "/checkout/preferences",
        { "Authorization": `Bearer ${mpToken}`, "Content-Type": "application/json" },
        JSON.stringify(pref));
      if (r.status === 201 && r.body?.init_point) {
        return sendJSON(res, 200, { init_point: r.body.init_point });
      }
      console.error("[Emma] MP preference error:", r.status, JSON.stringify(r.body));
      return sendJSON(res, 502, { error: "Error al crear el pago. Intenta de nuevo." });
    } catch (e) {
      console.error("[Emma] MP exception:", e.message);
      return sendJSON(res, 502, { error: "Error de conexión con el proveedor de pago." });
    }
  }

  // ── POST /api/mp-webhook — notificación de pago de MercadoPago ─────────────
  if (method === "POST" && pathname === "/api/mp-webhook") {
    // Siempre responder 200 rápido a MP para que no reintente
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}

    const paymentId = body?.data?.id;
    if (!paymentId || body?.type !== "payment") return;

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) return;

    (async () => {
      try {
        const r = await httpsReq("GET", "api.mercadopago.com", `/v1/payments/${paymentId}`,
          { "Authorization": `Bearer ${mpToken}` }, null);

        if (r.status !== 200 || r.body?.status !== "approved") {
          console.log(`[Emma] Pago ${paymentId}: ${r.body?.status || "error"}`);
          return;
        }

        const extRef = r.body?.external_reference || "";
        const parts = extRef.split("|");
        if (parts.length < 4) { console.error("[Emma] extRef inválido:", extRef); return; }
        const [, planId, rawEmail, rawName] = parts;
        const email = rawEmail.toLowerCase().trim();
        const name  = decodeURIComponent(rawName).trim();

        if (!PLANES[planId]) { console.error("[Emma] Plan desconocido:", planId); return; }

        // Si ya tiene licencia, solo reenviar credenciales
        const existe = USERS.find(u => u.email.toLowerCase() === email && u.active !== false);
        if (existe) {
          console.log(`[Emma] Usuario ${email} ya existe — reenviando credenciales`);
          await enviarCredenciales(email, name || existe.name, existe.key, planId);
          return;
        }

        const key = generarLicencia(planId);
        const newUser = { email, key, name, active: true };
        addPaidUser(newUser);

        // Actualizar Railway (async, no bloquea)
        actualizarRailwayUsers().catch(() => {});

        // Email al usuario
        await enviarCredenciales(email, name, key, planId);

        // Notificar al admin
        const adminMail = process.env.ADMIN_EMAIL || "admin@emma-presupuestos.com";
        await enviarEmail(adminMail,
          `[Emma] Nuevo cliente: ${name} — ${(PLANES[planId]).label}`,
          `<p><b>Nuevo pago confirmado en MercadoPago</b></p>
           <ul>
             <li><b>Nombre:</b> ${name}</li>
             <li><b>Email:</b> ${email}</li>
             <li><b>Plan:</b> ${PLANES[planId].label}</li>
             <li><b>Clave generada:</b> <code>${key}</code></li>
             <li><b>Pago MP ID:</b> ${paymentId}</li>
           </ul>
           <p>El usuario ya puede acceder. Agrega la entrada a emma_licencias.json para persistencia.</p>`
        );

        console.log(`[Emma] ✅ Nuevo usuario activado: ${email} plan=${planId} key=${key}`);
      } catch (e) {
        console.error("[Emma] Error procesando webhook MP:", e.message);
      }
    })();
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`[Emma] Servidor en puerto ${port}`);
  console.log(`[Emma] Usuarios cargados: ${USERS.length}`);
});
