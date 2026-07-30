// ============================================================
// import-db.mjs — Alimenta la base de datos desde Excel
//
//   node scripts/import-db.mjs <archivo.xlsx>            (fusiona)
//   node scripts/import-db.mjs <archivo.xlsx> --replace  (reemplaza todo)
//   node scripts/import-db.mjs <archivo.xlsx> --dry-run  (solo valida)
//
// El archivo usa el mismo formato que Base_de_Datos_ProyectoEmma_DEPURADA.xlsx:
//
//   Hoja "Precios por concepto"  — Código concepto, Descripción concepto,
//        Unidad concepto, Partida, Nombre Partida, Materiales, MO + Equipo, P.U.
//   Hoja "Insumos por concepto"  — Código concepto, Tipo insumo, Código insumo,
//        Descripción insumo, Unidad insumo, Costo Insumo, Operador,
//        Cantidad insumo, Importe insumo
//   Hoja "Basicos" (opcional)    — Código básico, Descripción básico,
//        Unidad básico, Código, Insumo, Tipo, Unidad, Costo, Op, Cantidad, Importe
//
// Las columnas se localizan por nombre de encabezado, no por posición, así que
// el orden puede variar. Nada se escribe si alguna validación falla.
// ============================================================
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let XLSX;
try {
  XLSX = (await import('xlsx')).default;
} catch {
  console.error('Falta la librería xlsx. Instálala con:\n\n  npm i -D xlsx\n');
  process.exit(1);
}

const root    = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA    = join(root, 'data');
const F_CONC  = join(DATA, 'conceptos.json');
const F_INS   = join(DATA, 'insumos.json');

const args    = process.argv.slice(2);
const file    = args.find(a => !a.startsWith('--'));
const replace = args.includes('--replace');
const dryRun  = args.includes('--dry-run');

if (!file) {
  console.error('Uso: node scripts/import-db.mjs <archivo.xlsx> [--replace] [--dry-run]');
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`No existe el archivo: ${file}`);
  process.exit(1);
}

// ── Utilidades ──────────────────────────────────────────────────────────────
const TIPOS = {
  'MATERIALES': 'M',
  'MATERIAL': 'M',
  'BASICOS': 'B',
  'BÁSICOS': 'B',
  'BASICO': 'B',
  'BÁSICO': 'B',
  'MANO DE OBRA': 'O',
  'MO': 'O',
  'EQUIPO Y HERRAMIENTA': 'E',
  'EQUIPO': 'E',
  'HERRAMIENTA': 'E',
};
const norm  = s => String(s ?? '').trim();
const upper = s => norm(s).toUpperCase();
const num   = v => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const round2 = n => Math.round(n * 100) / 100;

// Localiza columnas por nombre de encabezado, tolerando acentos y mayúsculas
const deacc = s => upper(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
function columnMap(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => { if (h) map[deacc(h)] = i; });
  return map;
}
function pick(map, ...nombres) {
  for (const n of nombres) {
    const i = map[deacc(n)];
    if (i !== undefined) return i;
  }
  return -1;
}

const errores = [];
const avisos  = [];
const err = (hoja, fila, msg) => errores.push(`  ${hoja} fila ${fila}: ${msg}`);

// ── Leer el libro ───────────────────────────────────────────────────────────
console.log(`Leyendo ${file}…`);
const wb = XLSX.readFile(file, { cellDates: false });
const hoja = nombre => {
  const real = wb.SheetNames.find(n => deacc(n) === deacc(nombre));
  return real ? XLSX.utils.sheet_to_json(wb.Sheets[real], { header: 1, defval: null, raw: true }) : null;
};

const sConc = hoja('Precios por concepto');
const sIns  = hoja('Insumos por concepto');
const sBas  = hoja('Basicos');

if (!sConc) { console.error('Falta la hoja "Precios por concepto".'); process.exit(1); }
if (!sIns)  { console.error('Falta la hoja "Insumos por concepto".'); process.exit(1); }

// ── Hoja de conceptos ───────────────────────────────────────────────────────
const cMap = columnMap(sConc[0] || []);
const cCod = pick(cMap, 'Código concepto', 'Codigo concepto', 'Código', 'Codigo');
const cDes = pick(cMap, 'Descripción concepto', 'Descripcion concepto', 'Descripción', 'Descripcion');
const cUni = pick(cMap, 'Unidad concepto', 'Unidad');
const cPar = pick(cMap, 'Nombre Partida', 'Partida nombre');
const cLet = pick(cMap, 'Partida', 'Letra');
const cMat = pick(cMap, 'Materiales', 'Material');
const cMo  = pick(cMap, 'MO + Equipo', 'MO+Equipo', 'Mano de obra', 'MO');
const cPu  = pick(cMap, 'P.U.', 'PU', 'Precio unitario');

for (const [nom, idx] of [['Código concepto', cCod], ['Descripción concepto', cDes], ['Unidad concepto', cUni]]) {
  if (idx < 0) { console.error(`La hoja "Precios por concepto" no tiene la columna "${nom}".`); process.exit(1); }
}

const conceptosNuevos = new Map(); // cod → { cod, c, u, mat, mo, p, partida }
sConc.slice(1).forEach((r, i) => {
  const fila = i + 2;
  if (!r || r.every(v => v === null || v === '')) return;
  const cod = norm(r[cCod]);
  if (!cod) return;
  const c = norm(r[cDes]);
  const u = upper(r[cUni]);
  if (!c) return err('Precios por concepto', fila, `el concepto ${cod} no tiene descripción`);
  if (!u) return err('Precios por concepto', fila, `el concepto ${cod} no tiene unidad`);
  if (conceptosNuevos.has(cod)) return err('Precios por concepto', fila, `el código ${cod} está repetido dentro del archivo`);
  const partida = cPar >= 0 ? upper(r[cPar]) : '';
  if (!partida) return err('Precios por concepto', fila, `el concepto ${cod} no tiene partida`);
  conceptosNuevos.set(cod, {
    cod, c, u,
    mat: round2(num(r[cMat])),
    mo:  round2(num(r[cMo])),
    p:   round2(num(r[cPu])),
    partida,
    letra: cLet >= 0 ? upper(r[cLet]) : '',
  });
});

// ── Hoja de insumos ─────────────────────────────────────────────────────────
const iMap  = columnMap(sIns[0] || []);
const iCon  = pick(iMap, 'Código concepto', 'Codigo concepto');
const iTipo = pick(iMap, 'Tipo insumo', 'Tipo');
const iCod  = pick(iMap, 'Código insumo', 'Codigo insumo');
const iDes  = pick(iMap, 'Descripción insumo', 'Descripcion insumo');
const iUni  = pick(iMap, 'Unidad insumo');
const iCos  = pick(iMap, 'Costo Insumo', 'Costo insumo', 'Costo');
const iOp   = pick(iMap, 'Operador', 'Op');
const iCant = pick(iMap, 'Cantidad insumo', 'Cantidad');
const iImp  = pick(iMap, 'Importe insumo', 'Importe');

for (const [nom, idx] of [['Código concepto', iCon], ['Código insumo', iCod], ['Tipo insumo', iTipo]]) {
  if (idx < 0) { console.error(`La hoja "Insumos por concepto" no tiene la columna "${nom}".`); process.exit(1); }
}

const dictNuevo      = new Map(); // cod → [desc, unidad, costo]
const breakdownNuevo = new Map(); // cod concepto → [{t, cod, op, q, i}]

function agregarInsumo(hojaNom, fila, conceptoCod, tipoRaw, cod, desc, uni, costo, op, cant, imp) {
  const t = TIPOS[deacc(tipoRaw)];
  if (!t) return err(hojaNom, fila, `tipo de insumo desconocido: "${tipoRaw}"`);
  if (!cod) return err(hojaNom, fila, 'falta el código del insumo');
  const operador = norm(op) === '/' ? '/' : '*';
  const q = num(cant);
  const c = num(costo);
  // Se respeta el importe capturado; solo se calcula cuando falta. Si el
  // capturado se aleja del cálculo, se avisa: suele ser un error de captura.
  const calc = round2(operador === '/' ? (q === 0 ? 0 : c / q) : c * q);
  const tieneImporte = imp !== null && imp !== undefined && imp !== '';
  const importe = tieneImporte ? round2(num(imp)) : calc;
  if (tieneImporte && Math.abs(importe - calc) > Math.max(0.02, Math.abs(calc) * 0.02)) {
    avisos.push(`  ${hojaNom} fila ${fila}: importe capturado ${importe} vs costo×cantidad ${calc}`);
  }
  if (!dictNuevo.has(cod)) dictNuevo.set(cod, [norm(desc) || cod, upper(uni), c]);
  if (!breakdownNuevo.has(conceptoCod)) breakdownNuevo.set(conceptoCod, []);
  breakdownNuevo.get(conceptoCod).push({ t, cod, op: operador, q, i: importe });
}

sIns.slice(1).forEach((r, i) => {
  const fila = i + 2;
  if (!r || r.every(v => v === null || v === '')) return;
  const conceptoCod = norm(r[iCon]);
  if (!conceptoCod) return;
  agregarInsumo('Insumos por concepto', fila, conceptoCod,
    r[iTipo], norm(r[iCod]), r[iDes], r[iUni], r[iCos], r[iOp], r[iCant], r[iImp]);
});

// ── Hoja de básicos (opcional) ──────────────────────────────────────────────
let basicosCount = 0;
if (sBas) {
  const bMap  = columnMap(sBas[0] || []);
  const bCod  = pick(bMap, 'Código básico', 'Codigo basico');
  const bICod = pick(bMap, 'Código', 'Codigo');
  const bIns  = pick(bMap, 'Insumo', 'Descripción insumo');
  const bTipo = pick(bMap, 'Tipo');
  const bUni  = pick(bMap, 'Unidad');
  const bCos  = pick(bMap, 'Costo');
  const bOp   = pick(bMap, 'Op', 'Operador');
  const bCant = pick(bMap, 'Cantidad');
  const bImp  = pick(bMap, 'Importe');
  if (bCod >= 0 && bICod >= 0) {
    const antes = breakdownNuevo.size;
    sBas.slice(1).forEach((r, i) => {
      const fila = i + 2;
      if (!r || r.every(v => v === null || v === '')) return;
      const basico = norm(r[bCod]);
      if (!basico) return;
      agregarInsumo('Basicos', fila, basico,
        r[bTipo], norm(r[bICod]), r[bIns], r[bUni], r[bCos], r[bOp], r[bCant], r[bImp]);
    });
    basicosCount = breakdownNuevo.size - antes;
  } else {
    avisos.push('  La hoja "Basicos" no tiene las columnas esperadas; se omitió.');
  }
}

// ── Cargar lo existente y fusionar ──────────────────────────────────────────
const conceptosBase = (!replace && existsSync(F_CONC)) ? JSON.parse(readFileSync(F_CONC, 'utf8')) : {};
const insumosBase   = (!replace && existsSync(F_INS))  ? JSON.parse(readFileSync(F_INS, 'utf8'))  : { dict: {}, breakdown: {} };

// Índice de lo existente: cod → partida
const partidaDe = new Map();
for (const [par, arr] of Object.entries(conceptosBase)) for (const c of arr) partidaDe.set(c.cod, par);

const resultConc = {};
for (const [par, arr] of Object.entries(conceptosBase)) resultConc[par] = arr.map(c => ({ ...c }));
const resultDict = { ...(insumosBase.dict || {}) };
const resultBreak = { ...(insumosBase.breakdown || {}) };

let nuevos = 0, actualizados = 0, partidasNuevas = 0;
for (const c of conceptosNuevos.values()) {
  const registro = { cod: c.cod, c: c.c, u: c.u, mat: c.mat, mo: c.mo, p: c.p };
  const anterior = partidaDe.get(c.cod);
  if (anterior !== undefined) {
    // Ya existía: se actualiza en su partida (o se mueve si cambió)
    resultConc[anterior] = resultConc[anterior].filter(x => x.cod !== c.cod);
    actualizados++;
  } else {
    nuevos++;
  }
  if (!resultConc[c.partida]) { resultConc[c.partida] = []; partidasNuevas++; }
  resultConc[c.partida].push(registro);
}

for (const [cod, entrada] of dictNuevo) resultDict[cod] = entrada;
for (const [cod, lista] of breakdownNuevo) resultBreak[cod] = lista;

// ── Recalcular precios desde el desglose ────────────────────────────────────
// Esto mantiene la invariante: P.U. = suma de importes = mat + mo
const GRUPO = { M: 'mat', B: 'mat', O: 'mo', E: 'mo' };
let recalculados = 0;
for (const arr of Object.values(resultConc)) {
  for (const c of arr) {
    const b = resultBreak[c.cod];
    if (!b || !b.length) continue;
    let mat = 0, mo = 0;
    for (const ins of b) (GRUPO[ins.t] === 'mat' ? (mat += ins.i) : (mo += ins.i));
    mat = round2(mat); mo = round2(mo);
    const p = round2(mat + mo);
    if (c.mat !== mat || c.mo !== mo || c.p !== p) recalculados++;
    c.mat = mat; c.mo = mo; c.p = p;
  }
}

// ── Validaciones finales ────────────────────────────────────────────────────
const codigosFinales = new Set();
for (const [par, arr] of Object.entries(resultConc)) {
  for (const c of arr) {
    if (codigosFinales.has(c.cod)) errores.push(`  El código ${c.cod} quedó duplicado en más de una partida.`);
    codigosFinales.add(c.cod);
  }
  if (!arr.length) delete resultConc[par];
}
let refsRotas = 0;
for (const [cod, lista] of Object.entries(resultBreak)) {
  for (const ins of lista) if (!resultDict[ins.cod]) refsRotas++;
}
if (refsRotas) errores.push(`  Hay ${refsRotas} referencias a insumos que no existen en el diccionario.`);

const sinDesglose = [...codigosFinales].filter(c => !resultBreak[c] || !resultBreak[c].length);
if (sinDesglose.length) {
  avisos.push(`  ${sinDesglose.length} conceptos quedaron sin desglose de insumos (ej.: ${sinDesglose.slice(0, 3).join(', ')}).`);
}

// ── Reporte ─────────────────────────────────────────────────────────────────
const totalConc = [...codigosFinales].length;
console.log('\n── Resumen ──────────────────────────────────');
console.log(`  Modo:                 ${replace ? 'REEMPLAZO TOTAL' : 'fusión con lo existente'}`);
console.log(`  Conceptos en archivo: ${conceptosNuevos.size}`);
console.log(`    nuevos:             ${nuevos}`);
console.log(`    actualizados:       ${actualizados}`);
console.log(`  Partidas nuevas:      ${partidasNuevas}`);
console.log(`  Básicos con desglose: ${basicosCount}`);
console.log(`  Precios recalculados: ${recalculados}`);
console.log('  ─────────────────────────────────────────');
console.log(`  Total conceptos:      ${totalConc}`);
console.log(`  Total partidas:       ${Object.keys(resultConc).length}`);
console.log(`  Diccionario insumos:  ${Object.keys(resultDict).length}`);
console.log(`  Desgloses:            ${Object.keys(resultBreak).length}`);

if (avisos.length) {
  console.log(`\n── Avisos (${avisos.length}) ─────────────────────────`);
  console.log(avisos.slice(0, 15).join('\n'));
  if (avisos.length > 15) console.log(`  … y ${avisos.length - 15} más.`);
}

if (errores.length) {
  console.error(`\n── ERRORES (${errores.length}) — no se escribió nada ──`);
  console.error(errores.slice(0, 25).join('\n'));
  if (errores.length > 25) console.error(`  … y ${errores.length - 25} más.`);
  process.exit(1);
}

if (dryRun) {
  console.log('\n--dry-run: validación correcta, no se escribió nada.');
  process.exit(0);
}

// ── Escribir con respaldo ───────────────────────────────────────────────────
const stamp = new Date().toISOString().slice(0, 10);
for (const f of [F_CONC, F_INS]) {
  if (existsSync(f)) {
    const bak = f.replace(/\.json$/, `.${stamp}.bak.json`);
    copyFileSync(f, bak);
  }
}
writeFileSync(F_CONC, JSON.stringify(resultConc), 'utf8');
writeFileSync(F_INS, JSON.stringify({ dict: resultDict, breakdown: resultBreak }), 'utf8');

console.log(`\nEscrito. Respaldo previo guardado como *.${stamp}.bak.json`);
console.log('Reinicia el servidor para que cargue la base nueva.');
