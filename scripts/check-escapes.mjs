// ============================================================
// check-escapes.mjs — Guarda de regresión del escapado de HTML
//
//   node scripts/check-escapes.mjs
//
// Los documentos de impresión se arman con plantillas de texto. Varias
// funciones declaran su PROPIO 'esc' local y el único escapador global es
// 'escHtml', así que copiar una línea de una función a otra puede dejar una
// llamada fuera de alcance: la plantilla lanza ReferenceError y el botón
// queda muerto en silencio. Este script verifica que eso no ocurra y que
// ningún logo se interpole sin escapar. Sale con código 1 si algo falla.
// ============================================================
import fs from 'node:fs';
const L = fs.readFileSync(new URL('../app/presupuesto_emma.html', import.meta.url), 'utf8').split('\n');

// Rangos de funciones de nivel superior (declaradas en columna 0)
const fns = [];
for (let i = 0; i < L.length; i++) {
  const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(L[i]);
  if (m) fns.push({ nombre: m[1], ini: i, fin: L.length });
}
for (let k = 0; k < fns.length - 1; k++) fns[k].fin = fns[k + 1].ini;
const fnDe = n => fns.find(f => n >= f.ini && n < f.fin);

// Funciones que declaran su propio esc
const declaran = new Set();
L.forEach((l, i) => { if (/^\s*const\s+esc\s*=/.test(l)) { const f = fnDe(i); if (f) declaran.add(f.nombre); } });

const global = L.some(l => /^const\s+esc\s*=/.test(l));
console.log('¿existe un esc global?', global ? 'sí' : 'NO');
console.log('funciones que declaran esc:', [...declaran].join(', '));

const rotos = [];
L.forEach((l, i) => {
  // usos de esc( que no sean escHtml( ni parte de otra palabra
  const usos = l.match(/(?<![\w$.])esc\s*\(/g);
  if (!usos) return;
  if (/^\s*const\s+esc\s*=/.test(l)) return;
  const f = fnDe(i);
  if (!f) { rotos.push({ linea: i + 1, fn: '(nivel superior)', txt: l.trim().slice(0, 70) }); return; }
  if (!declaran.has(f.nombre) && !global) rotos.push({ linea: i + 1, fn: f.nombre, txt: l.trim().slice(0, 70) });
});

console.log('\nusos de esc( fuera de alcance:', rotos.length);
for (const r of rotos) console.log(`  línea ${r.linea} en ${r.fn}(): ${r.txt}`);

// Y que ninguna interpolación de logo quede cruda
const html = L.join('\n');
const crudas = (html.match(/src="\$\{(?:STATE\.)?meta\.logo\}"/g) || []).length;
console.log('\ninterpolaciones de logo sin escapar:', crudas);
process.exit(rotos.length === 0 && crudas === 0 ? 0 : 1);
