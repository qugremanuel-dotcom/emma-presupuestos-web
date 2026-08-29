// ============================================================
// capture-assets.mjs — Regenera los screenshots de assets/
//
// Requiere Playwright:  npm i -D playwright
// Uso:                  node scripts/capture-assets.mjs
//
// Landing y demo se capturan como archivos locales.
// La app requiere servidor + sesión, así que el script levanta
// server.js en un puerto libre con una licencia de prueba,
// inicia sesión y luego captura.
// ============================================================
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Falta Playwright. Instálalo con:\n\n  npm i -D playwright\n');
  process.exit(1);
}

const root   = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'assets', 'screenshots');
await mkdir(outDir, { recursive: true });

// ── Licencia de prueba (mismo algoritmo que server.js y el HTML) ────────────
const SALT = 'emPrj-X7Q2-2024';
const fnv = s => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
};
const cc = '0A3F';
const yy = String((new Date().getFullYear() + 1) % 100).padStart(2, '0');
const KEY = `EMMA-${cc}-${yy}-${(fnv(cc + yy + SALT) & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0')}`;
const EMAIL = 'demo@emma-presupuestos.com';
const PORT  = 8199;

// ── Levantar el servidor ────────────────────────────────────────────────────
const server = spawn(process.execPath, [resolve(root, 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    USERS_DB: JSON.stringify([{ email: EMAIL, key: KEY, name: 'Despacho Demo', active: true, admin: true }]),
  },
  stdio: 'ignore',
});
const stopServer = () => { try { server.kill(); } catch {} };
process.on('exit', stopServer);

// Esperar a que responda
await (async () => {
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://localhost:${PORT}/`); return; }
    catch { await new Promise(r => setTimeout(r, 250)); }
  }
  console.error(`El servidor no respondió en el puerto ${PORT}.`);
  stopServer();
  process.exit(1);
})();

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });

const fileUrl = p => `file:///${resolve(root, p).replaceAll('\\', '/')}`;

async function shot(url, file, fullPage = false) {
  await page.goto(url, { waitUntil: 'load' });
  await page.screenshot({ path: resolve(outDir, file), fullPage });
  console.log('  ✓', file);
}

console.log('Capturando…');

// 1 · Landing
await shot(fileUrl('index.html'), '01-landing-emma.png');

// 2 · Demo pública
await shot(fileUrl('demo.html'), '02-demo-presupuesto.png');

// 3 · Demo con el presupuesto calculado
await page.goto(fileUrl('demo.html'), { waitUntil: 'load' });
await page.getByRole('button', { name: 'Calcular presupuesto' }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: resolve(outDir, '03-demo-concepto-agregado.png') });
console.log('  ✓ 03-demo-concepto-agregado.png');

// 4 · App completa (requiere sesión)
await page.goto(`http://localhost:${PORT}/login`, { waitUntil: 'load' });
await page.evaluate(async ({ email, key }) => {
  await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, key }),
  });
}, { email: EMAIL, key: KEY });
await page.goto(`http://localhost:${PORT}/app`, { waitUntil: 'load' });
await page.waitForFunction(
  () => document.getElementById('emma-loading')?.style.display === 'none',
  null, { timeout: 30000 }
);
await page.screenshot({ path: resolve(outDir, '04-app-completa-acceso.png') });
console.log('  ✓ 04-app-completa-acceso.png');

await browser.close();
stopServer();
console.log('\nListo →', outDir);
