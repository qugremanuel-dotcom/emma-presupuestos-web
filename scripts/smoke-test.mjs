// ============================================================
// smoke-test.mjs — Prueba de humo del servidor
//
//   node scripts/smoke-test.mjs
//
// Levanta el servidor en un puerto libre con un volumen temporal y recorre
// los flujos que un cliente de pago ejecuta a diario: entrar, pedir el
// catálogo, guardar y reabrir un presupuesto, y que sus datos sobrevivan a
// un reinicio. Sale con código 1 si algo falla.
// ============================================================
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9400 + Math.floor(process.pid % 200);
const BASE = `http://localhost:${PORT}`;
const VOL = mkdtempSync(join(tmpdir(), 'emma-smoke-'));

// Licencia de prueba con el mismo algoritmo del servidor
const SALT = 'emPrj-X7Q2-2024';
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
const cc = '0A3F', yy = String((new Date().getFullYear() + 1) % 100).padStart(2, '0');
const KEY = `EMMA-${cc}-${yy}-${(fnv(cc + yy + SALT) & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0')}`;
const EMAIL = 'smoke@emma.mx';
const USERS = JSON.stringify([{ email: EMAIL, key: KEY, name: 'Prueba', active: true, admin: true }]);

let fallos = 0;
const ok = (n, c) => { if (!c) fallos++; console.log(`  ${c ? '✓' : '✗ FALLA'} ${n}`); };

function arranca() {
  const p = spawn(process.execPath, [join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), EMMA_DATA_DIR: VOL, USERS_DB: USERS },
  });
  let log = '';
  p.stdout.on('data', d => log += d);
  p.stderr.on('data', d => log += d);
  return { p, getLog: () => log };
}
const espera = async () => {
  for (let i = 0; i < 80; i++) {
    try { await fetch(BASE + '/'); return true; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  return false;
};
async function entra() {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, key: KEY }),
  });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}
const api = (ck, p, o = {}) => fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', Cookie: ck, ...(o.headers || {}) } });

try {
  // ── Catálogo en disco ─────────────────────────────────────────────────────
  console.log('Catálogo');
  const C = JSON.parse(readFileSync(join(ROOT, 'data', 'conceptos.json'), 'utf8'));
  const I = JSON.parse(readFileSync(join(ROOT, 'data', 'insumos.json'), 'utf8'));
  const partidas = Object.keys(C).filter(k => !k.startsWith('__'));
  const cods = new Set();
  let desfases = 0, rotas = 0;
  for (const p of partidas) for (const c of C[p]) {
    cods.add(c.cod);
    const b = I.breakdown[c.cod];
    if (!b) continue;
    const s = Math.round(b.reduce((x, i) => x + i.i, 0) * 100) / 100;
    if (Math.abs(s - c.p) > 0.02) desfases++;
  }
  for (const k of Object.keys(I.breakdown)) for (const i of I.breakdown[k]) if (!I.dict[i.cod]) rotas++;
  ok(`${cods.size} conceptos en ${partidas.length} partidas`, cods.size > 6000);
  ok('ningún P.U. contradice su desglose', desfases === 0);
  ok('ninguna referencia rota a insumos', rotas === 0);

  // ── Arranque y sesión ─────────────────────────────────────────────────────
  console.log('\nSesión y catálogo por API');
  let s = arranca();
  ok('el servidor arranca', await espera());
  const ck = await entra();
  ok('se puede entrar con una licencia válida', !!ck);
  ok('sin sesión, el catálogo está protegido', (await fetch(BASE + '/api/conceptos')).status === 401);
  const cat = await (await api(ck, '/api/conceptos')).json();
  ok('el catálogo se sirve por API', Object.keys(cat.data || {}).length > 0);
  const ins = await (await api(ck, '/api/insumos')).json();
  ok('los insumos se sirven por API', Object.keys(ins.data?.dict || {}).length > 5000);

  // ── Presupuestos ──────────────────────────────────────────────────────────
  console.log('\nPresupuestos del cliente');
  const acentos = 'Cimentación f\'c=250 kg/cm² ñ áéíóú';
  const p1 = await (await api(ck, '/api/proyectos', {
    method: 'POST',
    body: JSON.stringify({ name: acentos, data: { rows: { A: [{ cod: 'X', c: acentos, qty: 3 }] }, meta: { obra: acentos } } }),
  })).json();
  ok('guarda un presupuesto', !!p1.id);
  const leido = await (await api(ck, '/api/proyectos/' + p1.id)).json();
  ok('los acentos sobreviven íntegros', leido.name === acentos && leido.data.rows.A[0].c === acentos);
  ok('sobrescribir sin versión conocida pide confirmación',
    (await api(ck, '/api/proyectos', { method: 'POST', body: JSON.stringify({ id: p1.id, name: acentos, data: { v: 2 } }) })).status === 409);
  const conVer = await api(ck, '/api/proyectos', { method: 'POST', body: JSON.stringify({ id: p1.id, name: acentos, data: { v: 2 }, expect: p1.updated_at }) });
  ok('sobrescribir con la versión correcta funciona', conVer.status === 200);
  ok('un cuerpo de más de 5 MB se rechaza con mensaje',
    (await api(ck, '/api/proyectos', { method: 'POST', body: JSON.stringify({ name: 'G', data: { z: 'z'.repeat(6 * 1024 * 1024) } }) })).status === 413);

  // ── Persistencia entre reinicios ──────────────────────────────────────────
  console.log('\nPersistencia');
  s.p.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 700));
  s = arranca();
  ok('el servidor vuelve a arrancar', await espera());
  const ck2 = await entra();
  const lista = (await (await api(ck2, '/api/proyectos')).json()).proyectos;
  ok('el presupuesto sigue ahí tras el reinicio', lista.length === 1 && lista[0].name === acentos);

  // ── Aislamiento ───────────────────────────────────────────────────────────
  console.log('\nAislamiento entre cuentas');
  ok('sin sesión no se listan presupuestos', (await fetch(BASE + '/api/proyectos')).status === 401);
  ok('sin sesión no se lee uno por id', (await fetch(BASE + '/api/proyectos/' + p1.id)).status === 401);

  s.p.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 400));
} finally {
  rmSync(VOL, { recursive: true, force: true });
}

console.log(fallos === 0 ? '\nTodo en orden.' : `\n${fallos} comprobaciones fallaron.`);
process.exit(fallos === 0 ? 0 : 1);
