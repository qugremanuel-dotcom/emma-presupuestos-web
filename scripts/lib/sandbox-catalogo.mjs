// Arnés para probar la lógica del catálogo sin navegador.
//
// Extrae las funciones REALES de app/presupuesto_emma.html y las ejecuta en un
// contexto aislado con los datos reales de data/insumos.json. Así una prueba
// falla cuando falla el código que se envía, no una copia que se desincroniza.
//
// Existe porque las tres primeras rondas de revisión encontraron defectos que
// `npm test` no veía: verificaba que el P.U. cuadrara con su desglose sobre la
// base, pero nada comprobaba que abrir otra obra devolviera el catálogo a
// fábrica. Esa es la propiedad que este arnés vigila.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// EMMA_HTML permite apuntar a otra copia del archivo — sirve para comprobar si
// un comportamiento ya existía en un commit anterior en vez de suponerlo.
const HTML = process.env.EMMA_HTML || path.join(RAIZ, 'app', 'presupuesto_emma.html');

// Funciones que necesitan las pruebas del catálogo. Si alguna se renombra, la
// extracción falla ruidosamente en vez de probar un objeto vacío.
const FUNCIONES = [
  'isGlobalMoPercentInsumo',
  'recalcInsumoAmounts',
  'normalizarPartes',
  'costoDeComposicion',
  'recordarOriginal',
  'restaurarCatalogo',
  'applyCustomBasicos',
  'recalcBasicosQueUsan',
  'crewPartsFor',
  'recalcCrewDictionaryPrices',
  'refrescarCatalogoDelPresupuesto',
  'propagarBasicos',
  'applyCustomMaterialPrices',
  'getCrewParts',
  'crewConceptMultiplier',
  'computeBasicoMatMonto',
  'loadInsumosForRow',
  'getComparableInsumos',
  'tienePUEditado',
  'desgloseDeCatalogo',
  'sincronizarFilaConCatalogo',
  'basicosDelPresupuesto',
];

// Recorta `function nombre(...) { ... }` balanceando llaves. No intenta ser un
// parser: el archivo usa un estilo uniforme y cualquier desajuste revienta al
// evaluar, que es justo lo que queremos que pase.
function extraerFuncion(src, nombre) {
  const re = new RegExp(`\\bfunction\\s+${nombre}\\s*\\(`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`No se encontró la función ${nombre}() en presupuesto_emma.html`);
  const abre = src.indexOf('{', re.lastIndex - 1);
  let prof = 0, i = abre, enCadena = null, enComentario = null;
  for (; i < src.length; i++) {
    const c = src[i], sig = src[i + 1], ant = src[i - 1];
    if (enComentario === 'linea') { if (c === '\n') enComentario = null; continue; }
    if (enComentario === 'bloque') { if (c === '*' && sig === '/') { enComentario = null; i++; } continue; }
    if (enCadena) {
      if (c === '\\') { i++; continue; }
      if (c === enCadena) enCadena = null;
      continue;
    }
    if (c === '/' && sig === '/') { enComentario = 'linea'; i++; continue; }
    if (c === '/' && sig === '*') { enComentario = 'bloque'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { enCadena = c; continue; }
    if (c === '{') prof++;
    else if (c === '}') { prof--; if (prof === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error(`Llaves desbalanceadas al extraer ${nombre}()`);
}

// El objeto de cuadrillas es una const literal; se recorta igual pero por llaves
// de objeto y hasta el `};` de cierre.
function extraerConstObjeto(src, nombre) {
  const re = new RegExp(`\\bconst\\s+${nombre}\\s*=\\s*\\{`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`No se encontró const ${nombre} en presupuesto_emma.html`);
  const abre = src.indexOf('{', m.index);
  let prof = 0;
  for (let i = abre; i < src.length; i++) {
    if (src[i] === '{') prof++;
    else if (src[i] === '}') { prof--; if (prof === 0) return src.slice(m.index, i + 1) + ';'; }
  }
  throw new Error(`Llaves desbalanceadas al extraer ${nombre}`);
}

const html = fs.readFileSync(HTML, 'utf8');
const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'data', 'insumos.json'), 'utf8'));

const clonar = o => JSON.parse(JSON.stringify(o));

const PREAMBULO = `
const round2 = n => Math.round((+n) * 100) / 100;
const PARTIDAS = [['A', 'PRUEBAS']];
const NAME_BY_LETTER = { A: 'PRUEBAS' };
let I_DICT = {};
let I_BREAKDOWN = {};
let _basicosOriginales = {};
let _cuadrillasOriginales = {};
let _catalogoTocado = new Map();
const STATE = {
  rows: { A: [] },
  customBasicos: {},
  customCuadrillas: {},
  customMaterialCosts: {},
};
// Efectos de UI y persistencia que las pruebas no necesitan.
function save() {}
function calcularPresupuesto() {}
function toast() {}
function isFasarWorkerCode() { return false; }
function displayWorkerCode(c) { return c; }
function getWorkerDictEntry(cod) { return I_DICT[cod]; }
`;

const CIERRE = `
globalThis.__api = {
  get I_DICT() { return I_DICT; },
  get I_BREAKDOWN() { return I_BREAKDOWN; },
  set I_DICT(v) { I_DICT = v; },
  set I_BREAKDOWN(v) { I_BREAKDOWN = v; },
  get _catalogoTocado() { return _catalogoTocado; },
  set _catalogoTocado(v) { _catalogoTocado = v; },
  set _basicosOriginales(v) { _basicosOriginales = v; },
  set _cuadrillasOriginales(v) { _cuadrillasOriginales = v; },
  STATE,
  CREW_COMPOSITION,
  round2,
  ${FUNCIONES.join(',\n  ')}
};
`;

// Con EMMA_HTML apuntando a un commit anterior, las funciones nuevas no
// existen todavía: se omiten en vez de reventar, para poder comparar
// comportamientos entre versiones.
const comparandoVersiones = !!process.env.EMMA_HTML;
const disponibles = [];
const cuerpos = [];
for (const n of FUNCIONES) {
  try {
    cuerpos.push(extraerFuncion(html, n));
    disponibles.push(n);
  } catch (e) {
    if (!comparandoVersiones) throw e;
    console.log(`  (esta versión no tiene ${n}())`);
  }
}

const fuente = [
  PREAMBULO,
  extraerConstObjeto(html, 'CREW_COMPOSITION'),
  ...cuerpos,
  CIERRE.replace(FUNCIONES.join(',\n  '), disponibles.join(',\n  ')),
].join('\n\n');

const contexto = vm.createContext({ console, JSON, Math, Object, Array, Number, String, Set, Map });
vm.runInContext(fuente, contexto, { filename: 'catalogo-extraido.js' });
const api = contexto.__api;

/** Devuelve el catálogo y el presupuesto al estado de fábrica. */
export function resetFabrica() {
  api.I_DICT = clonar(datos.dict);
  api.I_BREAKDOWN = clonar(datos.breakdown);
  api._catalogoTocado = new Map();
  api._basicosOriginales = {};
  api._cuadrillasOriginales = {};
  api.STATE.rows.A = [];
  api.STATE.customBasicos = {};
  api.STATE.customCuadrillas = {};
  api.STATE.customMaterialCosts = {};
  return api;
}

/** Instantánea de fábrica, para comparar contra ella. */
export const FABRICA = Object.freeze({
  dict: Object.freeze(clonar(datos.dict)),
  breakdown: Object.freeze(clonar(datos.breakdown)),
});

/**
 * Compara el catálogo vivo contra fábrica. Es la propiedad central: al abrir
 * otra obra, todo lo que esa obra no personalice debe valer lo de fábrica.
 *
 * La comparación es numérica, no byte a byte, por una razón concreta:
 * `normalizarPartes` rellena `cs` en las líneas que no lo traían (el catálogo
 * solo lo guarda cuando difiere del precio genérico). Eso cambia la forma del
 * objeto sin cambir ningún número. Para que relajarlo no tape una fuga, se
 * compara el costo EFECTIVO de cada línea — el `cs` si lo hay, y si no el
 * precio de diccionario — además del importe y del costo del básico.
 */
function costoEfectivo(parte, dict) {
  if (parte.cs !== undefined && parte.cs !== null && parte.cs !== '') return Number(parte.cs);
  const d = dict[parte.cod];
  return d ? Number(d[2] || 0) : 0;
}

export function diferenciasContraFabrica() {
  const dict = [];
  const breakdown = [];
  Object.keys(FABRICA.dict).forEach(cod => {
    const a = Number(FABRICA.dict[cod][2] || 0);
    const b = Number((api.I_DICT[cod] || [])[2] || 0);
    if (Math.abs(a - b) > 0.005) dict.push({ cod, fabrica: a, vivo: b });
  });
  Object.keys(FABRICA.breakdown).forEach(cod => {
    const a = FABRICA.breakdown[cod];
    const b = api.I_BREAKDOWN[cod];
    if (!b || a.length !== b.length) { breakdown.push({ cod, motivo: 'faltan o sobran líneas' }); return; }
    for (let k = 0; k < a.length; k++) {
      if (a[k].cod !== b[k].cod || String(a[k].op) !== String(b[k].op)) {
        breakdown.push({ cod, motivo: `línea ${k} cambió de insumo` }); return;
      }
      if (Math.abs(Number(a[k].q || 0) - Number(b[k].q || 0)) > 0.0005) {
        breakdown.push({ cod, motivo: `línea ${k} cambió de cantidad` }); return;
      }
      if (Math.abs(Number(a[k].i || 0) - Number(b[k].i || 0)) > 0.005) {
        breakdown.push({ cod, motivo: `línea ${k} cambió de importe` }); return;
      }
      const ca = costoEfectivo(a[k], FABRICA.dict);
      const cb = costoEfectivo(b[k], api.I_DICT);
      if (Math.abs(ca - cb) > 0.005) {
        breakdown.push({ cod, motivo: `línea ${k} (${a[k].cod}) costo ${ca} → ${cb}` }); return;
      }
    }
  });
  return { dict, breakdown };
}

/** Suma de importes del desglose de un básico, tal como lo ve el catálogo. */
export function sumaDesglose(cod) {
  const partes = api.I_BREAKDOWN[cod] || [];
  return api.round2(partes.reduce((s, p) => s + Number(p.i || 0), 0));
}

export { api };
