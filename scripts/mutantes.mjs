// Prueba de mutación: revierte cada arreglo por separado y exige que la suite
// falle. Una mutación que deja la suite en verde significa que ese arreglo no
// está cubierto por ninguna prueba.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SALIDA = fs.mkdtempSync(path.join(os.tmpdir(), 'emma-mut-'));
const original = fs.readFileSync(path.join(RAIZ, 'app', 'presupuesto_emma.html'), 'utf8');

const MUTACIONES = [
  { id: 'M1', cubre: '(1)(19) Actualizar materiales salta filas sin desglose',
    de: `      if (!r.insumos || !r.insumos.length) {
        r.matIVA = null;
        sincronizarFilaConCatalogo(r);
        return;
      }
      let changed = false;`,
    a:  `      if (!r.insumos) { r.matIVA = null; return; }
      let changed = false;` },

  { id: 'M2', cubre: '(4)(9)(20) partesDeBasico pierde csManual',
    de: `    if (i.csManual) parte.csManual = true;
    if (i.custom)   parte.custom   = true;`, a: `` },

  { id: 'M3', cubre: '(5)(10) onBasicoPartPick no suelta csManual',
    de: `  delete p.csManual;
  const dict = I_DICT[insCod];`, a: `  const dict = I_DICT[insCod];` },

  { id: 'M4', cubre: '(6) Actualizar materiales pisa costos tecleados',
    de: `        if (ins.custom || ins.csManual) return;   // costo escrito o tecleado a mano
`, a: `` },

  { id: 'M5', cubre: '(11) FASAR no llega a los básicos',
    de: `  Object.keys(CREW_COMPOSITION).forEach(c => semillas.add(c));`, a: `` },

  { id: 'M6', cubre: '(3)(12) guarda de ciclos marca el básico igualmente',
    de: `  if (I_DICT[insCod] && creariaCiclo(cod, insCod)) {`,
    a:  `  const _forzar = asegurarBasicoEditable(cod);
  if (I_DICT[insCod] && creariaCiclo(cod, insCod)) {` },

  { id: 'M7', cubre: '(15) el precio de material no siembra la cascada',
    de: `  materiales.forEach(c => semillas.add(c));`, a: `` },

  { id: 'M8', cubre: '(16) el escalado vuelve a loadInsumosForRow',
    de: `  const ratio = (tienePUEditado(r) && origSum > 0 && r.p > 0) ? (r.p / origSum) : 1;
  r.insumos = original.map(i => {`,
    a:  `  const ratio = (origSum > 0 && r.p > 0) ? (r.p / origSum) : 1;
  r.insumos = original.map(i => {` },

  { id: 'M9', cubre: '(17) propagarBasicos sin la rama de filas nunca abiertas',
    de: `        if ((I_BREAKDOWN[r.cod] || []).some(p => afectados.has(p.cod))) {
          sincronizarFilaConCatalogo(r);
        }
`, a: `` },

  { id: 'M10', cubre: '(14) la cascada escribe fuera del registro',
    de: `      recordarOriginal(cod);   // reversible, igual que las ediciones directas
`, a: `` },

  { id: 'M11', cubre: 'deshacer: la cascada no se siembra con lo revertido',
    de: `  revertidos.forEach(c => semillas.add(c));`, a: `` },

  { id: 'M12', cubre: 'aislamiento: los precios de material salen del registro',
    de: `    recordarOriginal(cod);   // reversible: al abrir otra obra vuelve a fábrica`, a: `` },

  { id: 'M13', cubre: 'Restablecer borra el APU de un concepto libre',
    de: `  if (!r.libre) delete r.insumos;`, a: `  delete r.insumos;` },

  { id: 'M14', cubre: 'al abrir, las filas no se ponen al día',
    de: `  sincronizarFilasConCatalogo();   // el respaldo pudo guardarse con otro catálogo`, a: `` },
  { id: 'M15', cubre: '(18) recalcConceptFromInsumos no suelta pu_manual',
    de: `  delete r.pu_manual;`, a: '' },
];

let sobreviven = [];
let noAplican = [];

for (const m of MUTACIONES) {
  if (!original.includes(m.de)) { noAplican.push(m); console.log(`⚠ ${m.id} no encontró su patrón — la mutación no se aplicó`); continue; }
  const mutante = original.replace(m.de, m.a);
  const ruta = path.join(SALIDA, `mut-${m.id}.html`);
  fs.writeFileSync(ruta, mutante);
  let fallo = false;
  try {
    execFileSync('node', [path.join(RAIZ, 'scripts', 'test-catalogo.mjs')],
      { env: { ...process.env, EMMA_HTML: ruta }, stdio: 'pipe' });
  } catch (e) { fallo = true; }
  console.log(`${fallo ? '✓' : '✗'} ${m.id}  ${fallo ? 'la suite lo detecta' : 'LA SUITE SIGUE VERDE'}  — ${m.cubre}`);
  if (!fallo) sobreviven.push(m);
  fs.unlinkSync(ruta);
}

console.log('');
console.log(`${MUTACIONES.length - sobreviven.length - noAplican.length}/${MUTACIONES.length} mutaciones detectadas.`);
if (sobreviven.length) console.log('Sin cubrir: ' + sobreviven.map(m => `${m.id} (${m.cubre})`).join('; '));
if (noAplican.length) console.log('No aplicadas: ' + noAplican.map(m => m.id).join(', '));
