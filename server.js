"use strict";
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// ─── Config ──────────────────────────────────────────────────────────────────
const root         = __dirname;
const port         = process.env.PORT || 8080;
const SESSION_TTL  = 7 * 24 * 60 * 60 * 1000; // 7 días en ms
const COOKIE_NAME  = "emma_session";

// ─── Base de usuarios (variable de entorno USERS_DB como JSON array) ─────────
// Formato: [{"email":"cliente@empresa.com","key":"EMMA-XXXX-YY-HHHHHH","name":"Nombre","active":true}]
let USERS = [];
try {
  if (process.env.USERS_DB) USERS = JSON.parse(process.env.USERS_DB);
} catch (e) {
  console.error("[Emma] USERS_DB parse error:", e.message);
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

  // ── 404 ───────────────────────────────────────────────────────────────────
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`[Emma] Servidor en puerto ${port}`);
  console.log(`[Emma] Usuarios cargados: ${USERS.length}`);
});
