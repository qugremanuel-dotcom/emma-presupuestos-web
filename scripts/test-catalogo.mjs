// Pruebas del catálogo por presupuesto.
//
// El catálogo (I_DICT / I_BREAKDOWN) es uno solo para toda la sesión, pero las
// ediciones de básicos, cuadrillas y precios de materiales son POR OBRA. Estas
// pruebas vigilan las dos propiedades que se rompieron una y otra vez:
//
//   1. Al abrir otra obra, el catálogo vuelve a fábrica salvo lo que esa obra
//      personalice. (Aislamiento.)
//   2. Deshacer una edición devuelve los conceptos al precio anterior, no solo
//      la tarjeta del básico. (Reversibilidad hasta la fila.)
//
// Cada caso reproduce un defecto confirmado en la revisión del commit 34facb4.

import { resetFabrica, diferenciasContraFabrica, FABRICA } from './lib/sandbox-catalogo.mjs';

let fallos = 0;
let grupo = '';

function seccion(nombre) { grupo = nombre; console.log('\n' + nombre); }

function ok(desc, cond, detalle) {
  if (cond) { console.log('  ✓ ' + desc); return; }
  fallos++;
  console.log('  ✗ ' + desc);
  if (detalle) console.log('      ' + detalle);
}

const cerca = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

/** Construye una fila de presupuesto como lo hace la app al agregar un concepto. */
function filaDeConcepto(api, cod) {
  const r = { cod, libre: false };
  const partesFabrica = FABRICA.breakdown[cod] || [];
  r.p = api.round2(partesFabrica.reduce((s, p) => s + Number(p.i || 0), 0));
  api.loadInsumosForRow(r);
  r.p = api.round2((r.insumos || []).reduce((s, i) => s + Number(i.i || 0), 0));
  api.STATE.rows.A = [r];
  return r;
}

/** Simula abrir otro presupuesto: STATE se reemplaza y el catálogo se refresca. */
function abrirOtraObra(api, { materiales = {}, basicos = {}, cuadrillas = {} } = {}) {
  api.STATE.customMaterialCosts = materiales;
  api.STATE.customBasicos = basicos;
  api.STATE.customCuadrillas = cuadrillas;
  api.STATE.rows.A = [];
  // restoreSnapshot() llama solo a esto: el refresco es el único punto de
  // entrada al catálogo y aplica materiales, básicos y cuadrillas en orden.
  api.refrescarCatalogoDelPresupuesto();
}

// ── 1. Aislamiento: precios de materiales ──────────────────────────────────
seccion('Aislamiento entre obras — precios de materiales');
{
  const api = resetFabrica();
  const MAT = '330-VAL-0000';
  const base = FABRICA.dict[MAT][2];

  abrirOtraObra(api, { materiales: { [MAT]: api.round2(base * 1.1) } });
  ok('la obra A sí ve su propio precio de material',
    cerca(api.I_DICT[MAT][2], base * 1.1),
    `esperado ${api.round2(base * 1.1)}, obtenido ${api.I_DICT[MAT][2]}`);

  abrirOtraObra(api, {});   // obra B, sin nada personalizado
  const d = diferenciasContraFabrica();
  ok('abrir una obra sin precios propios devuelve I_DICT a fábrica',
    d.dict.length === 0,
    `${d.dict.length} códigos siguen con el precio de la obra anterior` +
    (d.dict.length ? ` (p.ej. ${d.dict[0].cod}: fábrica ${d.dict[0].fabrica}, vivo ${d.dict[0].vivo})` : ''));
  ok('abrir una obra sin precios propios devuelve I_BREAKDOWN a fábrica',
    d.breakdown.length === 0,
    `${d.breakdown.length} composiciones siguen contaminadas` +
    (d.breakdown.length ? ` (p.ej. ${d.breakdown[0].cod}: ${d.breakdown[0].motivo})` : ''));
}

// ── 2. Un precio idéntico al de fábrica no debe mover nada ─────────────────
seccion('Aplicar un precio idéntico al de fábrica no cambia ningún básico');
{
  const api = resetFabrica();
  const MAT = '303-ARF-0201';
  abrirOtraObra(api, { materiales: { [MAT]: FABRICA.dict[MAT][2] } });

  const movidos = Object.keys(FABRICA.dict).filter(cod =>
    !cerca(FABRICA.dict[cod][2], (api.I_DICT[cod] || [])[2], 0.005));
  ok('ningún básico cambia de costo',
    movidos.length === 0,
    `${movidos.length} básicos se movieron` +
    (movidos.length ? ` (peor: ${movidos[0]} ${FABRICA.dict[movidos[0]][2]} → ${api.I_DICT[movidos[0]][2]})` : ''));
}

// ── 3. Los %MO se derivan de la mano de obra, nunca del diccionario ────────
seccion('Insumos por porcentaje de mano de obra');
{
  const api = resetFabrica();
  abrirOtraObra(api, { materiales: { '303-ARF-0201': api.round2(FABRICA.dict['303-ARF-0201'][2] * 1.5) } });

  const partes = api.I_BREAKDOWN['10603-061'] || [];
  const mo = partes.filter(p => p.t === 'O' && !api.isGlobalMoPercentInsumo(p))
    .reduce((s, p) => s + Number(p.i || 0), 0);
  const porcentuales = partes.filter(p => api.isGlobalMoPercentInsumo(p));
  ok('el básico de prueba tiene líneas %MO', porcentuales.length > 0);
  porcentuales.forEach(p => {
    ok(`${p.cod} conserva el costo derivado de la MO, no el de diccionario`,
      cerca(p.cs, api.round2(mo), 0.05),
      `cs=${p.cs}, MO del básico=${api.round2(mo)}, diccionario=${(api.I_DICT[p.cod] || [])[2]}`);
  });
}

// ── 4. Deshacer una edición de cuadrilla devuelve el concepto a su precio ──
seccion('Deshacer una cuadrilla revierte los conceptos');
{
  const api = resetFabrica();
  const r = filaDeConcepto(api, '10601-013');
  const pFabrica = r.p;

  const original = api.CREW_COMPOSITION['1A5P'].map(p => ({ ...p }));
  const editada = original.map((p, idx) => idx === original.length - 1 ? { ...p, q: Number(p.q) * 2 } : { ...p });
  api.STATE.customCuadrillas['1A5P'] = editada;
  api.propagarBasicos(['1A5P']);
  const pEditado = api.STATE.rows.A[0].p;
  ok('editar la cuadrilla mueve el P.U. del concepto',
    !cerca(pEditado, pFabrica),
    `fábrica ${pFabrica}, editado ${pEditado}`);

  delete api.STATE.customCuadrillas['1A5P'];
  api.propagarBasicos(['1A5P']);
  const pRestablecido = api.STATE.rows.A[0].p;
  ok('restablecer la cuadrilla devuelve el P.U. del concepto',
    cerca(pRestablecido, pFabrica),
    `esperado ${pFabrica}, obtenido ${pRestablecido}`);
}

// ── 5. Deshacer una edición de básico devuelve el concepto a su precio ─────
seccion('Deshacer un básico revierte los conceptos');
{
  const api = resetFabrica();
  const r = filaDeConcepto(api, '10301-001');
  const pFabrica = r.p;

  const BAS = '10401-291';
  const partes = FABRICA.breakdown[BAS].map(p => ({ ...p }));
  const iMat = partes.findIndex(p => p.t === 'M');
  partes[iMat] = { ...partes[iMat], q: Number(partes[iMat].q) * 10 };
  api.STATE.customBasicos[BAS] = partes;
  api.propagarBasicos([BAS]);
  const pEditado = api.STATE.rows.A[0].p;
  ok('editar el básico mueve el P.U. del concepto',
    !cerca(pEditado, pFabrica),
    `fábrica ${pFabrica}, editado ${pEditado}`);

  delete api.STATE.customBasicos[BAS];
  api.propagarBasicos([BAS]);
  const pRestablecido = api.STATE.rows.A[0].p;
  ok('restablecer el básico devuelve el P.U. del concepto',
    cerca(pRestablecido, pFabrica),
    `esperado ${pFabrica}, obtenido ${pRestablecido}`);
}

// ── 6. Aislamiento de básicos y cuadrillas (no-regresión) ──────────────────
seccion('Aislamiento entre obras — básicos y cuadrillas');
{
  const api = resetFabrica();
  const BAS = '10401-291';
  const partes = FABRICA.breakdown[BAS].map(p => ({ ...p }));
  partes[0] = { ...partes[0], q: Number(partes[0].q) * 3 };
  abrirOtraObra(api, { basicos: { [BAS]: partes } });
  ok('la obra A ve su básico editado',
    !cerca(api.I_DICT[BAS][2], FABRICA.dict[BAS][2]));

  abrirOtraObra(api, {});
  const d = diferenciasContraFabrica();
  ok('abrir una obra sin básicos propios devuelve el catálogo a fábrica',
    d.dict.length === 0 && d.breakdown.length === 0,
    `${d.dict.length} precios y ${d.breakdown.length} composiciones contaminadas`);
}

// ── 7. El P.U. de la fila siempre cuadra con su desglose ───────────────────
seccion('Invariante: P.U. = suma del desglose');
{
  const api = resetFabrica();
  const r = filaDeConcepto(api, '10601-013');
  api.STATE.customCuadrillas['1A5P'] = api.CREW_COMPOSITION['1A5P']
    .map((p, i) => i === 0 ? { ...p, q: Number(p.q) + 1 } : { ...p });
  api.propagarBasicos(['1A5P']);

  const fila = api.STATE.rows.A[0];
  const suma = api.round2((fila.insumos || []).reduce((s, i) => s + Number(i.i || 0), 0));
  ok('tras editar una cuadrilla, el P.U. sigue igual a la suma de importes',
    cerca(fila.p, suma),
    `P.U. ${fila.p}, desglose ${suma}`);

  // El básico que contiene la cuadrilla debe valer lo mismo en la fila que en
  // el catálogo: si difieren, la pestaña Básicos y el concepto se contradicen.
  const insBasico = (fila.insumos || []).find(i => i.t === 'B' && api.I_DICT[i.cod]);
  if (insBasico) {
    ok(`el básico ${insBasico.cod} vale lo mismo en la fila que en el catálogo`,
      cerca(insBasico.cs, api.I_DICT[insBasico.cod][2]),
      `fila ${insBasico.cs}, catálogo ${api.I_DICT[insBasico.cod][2]}`);
  }
}

console.log('');
if (fallos) {
  console.log(`${fallos} comprobación(es) fallaron.`);
  process.exit(1);
}
console.log('Catálogo en orden.');
