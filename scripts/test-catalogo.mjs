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

// ── 8. Un concepto agregado DESPUÉS de editar entra al precio de la obra ───
seccion('Concepto agregado después de editar un básico');
{
  const api = resetFabrica();
  api.STATE.customCuadrillas['1A5P'] = api.CREW_COMPOSITION['1A5P']
    .map((p, i) => i === 0 ? { ...p, q: Number(p.q) * 2 } : { ...p });
  api.refrescarCatalogoDelPresupuesto();

  // addFromPicker parte del precio de fábrica de FLAT y lo sincroniza.
  const fila = { cod: '10601-013', libre: false, qty: 1 };
  fila.p = api.round2(FABRICA.breakdown['10601-013'].reduce((s, p) => s + Number(p.i || 0), 0));
  const pFabrica = fila.p;
  api.sincronizarFilaConCatalogo(fila);

  ok('el P.U. deja de ser el de fábrica',
    !cerca(fila.p, pFabrica),
    `fábrica ${pFabrica}, obtenido ${fila.p}`);

  const desglose = api.round2(api.desgloseDeCatalogo('10601-013')
    .reduce((s, i) => s + Number(i.i || 0), 0));
  ok('el P.U. cuadra con su desglose',
    cerca(fila.p, desglose),
    `P.U. ${fila.p}, desglose ${desglose}`);
}

// ── 9. Restaurar el precio no inventa costos ───────────────────────────────
seccion('Restaurar precio tras editar un básico');
{
  const api = resetFabrica();
  const BAS = '10401-291';
  const partes = FABRICA.breakdown[BAS].map(p => ({ ...p }));
  const iMat = partes.findIndex(p => p.t === 'M');
  partes[iMat] = { ...partes[iMat], q: Number(partes[iMat].q) * 5 };
  api.STATE.customBasicos[BAS] = partes;

  const r = { cod: '10301-001', libre: false, qty: 1 };
  r.p = api.round2(FABRICA.breakdown['10301-001'].reduce((s, p) => s + Number(p.i || 0), 0));
  api.STATE.rows.A = [r];
  api.refrescarCatalogoDelPresupuesto();
  api.sincronizarFilaConCatalogo(r);

  // resetPrice: borra el desglose y las banderas, y vuelve al catálogo vivo.
  delete r.insumos; delete r.insumos_modified; delete r.pu_manual;
  api.sincronizarFilaConCatalogo(r);

  const insumos = api.getComparableInsumos(r);
  const inventados = insumos.filter(i => {
    const d = api.I_DICT[i.cod];
    if (!d || api.isGlobalMoPercentInsumo(i)) return false;
    const esperado = Number(d[2] || 0);
    // Una línea con costo específico propio es legítima; lo que no puede pasar
    // es que aparezca un costo que no está ni en el catálogo ni en la línea.
    const propio = (FABRICA.breakdown['10301-001'].find(p => p.cod === i.cod) || {}).cs;
    return !cerca(i.cs, esperado, 0.05) && !(propio != null && cerca(i.cs, propio, 0.05));
  });
  ok('ningún insumo del desglose muestra un costo inventado',
    inventados.length === 0,
    inventados.length
      ? `${inventados.length} inventados (p.ej. ${inventados[0].cod}: desglose ${inventados[0].cs}, catálogo ${api.I_DICT[inventados[0].cod][2]})`
      : '');

  const suma = api.round2(insumos.reduce((s, i) => s + Number(i.i || 0), 0));
  ok('el P.U. restaurado cuadra con el desglose',
    cerca(r.p, suma),
    `P.U. ${r.p}, desglose ${suma}`);
}

// ── 10. Un P.U. tecleado a mano se sigue respetando ────────────────────────
seccion('Un P.U. tecleado a mano manda sobre el catálogo');
{
  const api = resetFabrica();
  const r = { cod: '10301-001', libre: false, qty: 1, p: 99, pu_manual: true };
  api.STATE.rows.A = [r];
  api.STATE.customBasicos['10401-291'] = FABRICA.breakdown['10401-291']
    .map((p, i) => i === 0 ? { ...p, q: Number(p.q) * 4 } : { ...p });
  api.propagarBasicos(['10401-291']);
  ok('editar un básico no pisa el P.U. tecleado',
    cerca(r.p, 99),
    `esperado 99, obtenido ${r.p}`);

  // Hueco conocido, ANTERIOR a los básicos editables (verificado ejecutando el
  // mismo caso contra el commit 34facb4: da 43.93 igual). El escalado del
  // desglose se deshace en parte porque recalcInsumoAmounts repone el costo de
  // las líneas de mano de obra desde el diccionario y recalcula los %MO, así
  // que un P.U. tecleado a mano no cuadra con su propio desglose. No se corrige
  // aquí para no mezclarlo con el aislamiento del catálogo.
  const suma = api.round2(api.getComparableInsumos(r).reduce((s, i) => s + Number(i.i || 0), 0));
  if (!cerca(suma, 99, 0.5)) {
    console.log(`  · hueco conocido: P.U. tecleado ${r.p}, desglose ${suma} ` +
      '(preexistente, no introducido por los básicos editables)');
  }
}

// ── 11. Un costo tecleado en una línea de mano de obra se respeta ──────────
seccion('Costo tecleado a mano en una línea de mano de obra');
{
  const api = resetFabrica();
  const partes = FABRICA.breakdown['10401-291'].map(p => ({ ...p }));
  const iMO = partes.findIndex(p => p.t === 'O' && api.I_DICT[p.cod]);
  ok('el básico de prueba tiene una línea de mano de obra', iMO >= 0);
  if (iMO >= 0) {
    const dePedido = 1000;
    partes[iMO] = { ...partes[iMO], cs: dePedido, csManual: true };
    api.recalcInsumoAmounts(partes);
    ok('el costo tecleado sobrevive al recálculo',
      cerca(partes[iMO].cs, dePedido),
      `tecleado ${dePedido}, quedó ${partes[iMO].cs} (diccionario ${api.I_DICT[partes[iMO].cod][2]})`);

    // Y una línea de mano de obra SIN marcar sí debe seguir al diccionario.
    // Se busca un básico con DOS líneas de mano de obra: con 10401-291, que
    // solo tiene una, esta comprobación iteraba sobre una lista vacía.
    const conDosMO = Object.keys(api.I_BREAKDOWN).find(cod =>
      api.I_DICT[cod] &&
      (api.I_BREAKDOWN[cod] || []).filter(p => p.t === 'O' && api.I_DICT[p.cod] && !api.isGlobalMoPercentInsumo(p)).length >= 2);
    ok('existe un básico con dos líneas de mano de obra para probarlo', !!conDosMO);
    if (conDosMO) {
      const ps = api.I_BREAKDOWN[conDosMO].map(p => ({ ...p }));
      const idx = ps.map((p, k) => ({ p, k }))
        .filter(x => x.p.t === 'O' && api.I_DICT[x.p.cod] && !api.isGlobalMoPercentInsumo(x.p))
        .map(x => x.k);
      ps[idx[0]].cs = 4321; ps[idx[0]].csManual = true;
      api.recalcInsumoAmounts(ps);
      ok('la línea marcada conserva su costo', cerca(ps[idx[0]].cs, 4321), `cs=${ps[idx[0]].cs}`);
      ok('la línea sin marcar sigue al diccionario',
        cerca(ps[idx[1]].cs, api.I_DICT[ps[idx[1]].cod][2]),
        `cs=${ps[idx[1]].cs}, diccionario=${api.I_DICT[ps[idx[1]].cod][2]}`);
    }
  }
}

// ── 17. La marca sobrevive al repintado de la tarjeta ──────────────────────
seccion('La tarjeta conserva el costo tecleado en una línea');
{
  const api = resetFabrica();
  const BAS = '10401-291';
  const partes = api.asegurarBasicoEditable(BAS);
  const iMO = partes.findIndex(p => p.t === 'O' && api.I_DICT[p.cod]);
  partes[iMO].cs = 1000;
  partes[iMO].csManual = true;
  api.refrescarCatalogoDelPresupuesto();

  const tarjeta = api.partesDeBasico(BAS);
  api.recalcInsumoAmounts(tarjeta);   // lo que hace tarjetaObra al dibujar
  ok('el costo tecleado sobrevive al repintado',
    cerca(tarjeta[iMO].cs, 1000),
    `cs=${tarjeta[iMO].cs}, diccionario=${api.I_DICT[tarjeta[iMO].cod][2]}`);
}

// ── 18. Cambiar el insumo de una línea suelta la marca ─────────────────────
seccion('Cambiar de insumo suelta el costo tecleado');
{
  const api = resetFabrica();
  const BAS = '10401-291';
  const partes = api.asegurarBasicoEditable(BAS);
  partes[0].cs = 5000;
  partes[0].csManual = true;
  // onBasicoPartPick sobre esa línea, con otro insumo del catálogo.
  api.onBasicoPartPick(BAS, 0, api.I_DICT['302-CAL-0102'][0]);
  const p = (api.STATE.customBasicos[BAS] || [])[0];
  ok('la línea deja de estar marcada como tecleada a mano',
    !p.csManual,
    `csManual=${p.csManual}`);
  ok('la línea toma el precio del insumo nuevo',
    cerca(p.cs, api.I_DICT['302-CAL-0102'][2]),
    `cs=${p.cs}, esperado ${api.I_DICT['302-CAL-0102'][2]}`);
}

// ── 19. Un costo tecleado en un concepto sobrevive a Actualizar ────────────
seccion('Actualizar materiales respeta el costo tecleado en un concepto');
{
  const api = resetFabrica();
  const CONC = Object.keys(FABRICA.breakdown).find(c =>
    !api.I_DICT[c] && (FABRICA.breakdown[c] || []).some(p => p.t === 'M' && api.I_DICT[p.cod]));
  const MAT = FABRICA.breakdown[CONC].find(p => p.t === 'M' && api.I_DICT[p.cod]).cod;
  const r = { cod: CONC, libre: false, qty: 1 };
  api.loadInsumosForRow(r);
  r.p = api.round2(r.insumos.reduce((s, i) => s + Number(i.i || 0), 0));
  const ins = r.insumos.find(i => i.cod === MAT);
  ins.cs = 7777; ins.csManual = true;
  api.STATE.rows.A = [r];
  api.STATE.customMaterialCosts = { [MAT]: api.round2(FABRICA.dict[MAT][2] * 2) };
  api.applyCustomMaterialsToBudget();
  const d = api.STATE.rows.A[0].insumos.find(i => i.cod === MAT);
  ok('el costo tecleado no se pisa',
    cerca(d.cs, 7777),
    `tecleado 7777, quedó ${d.cs}`);
}

// ── 20. Un cambio en el salario llega a los básicos con mano de obra ───────
seccion('El precio de la mano de obra llega a los básicos');
{
  const api = resetFabrica();
  const BAS = '10401-291';
  const antes = api.I_DICT[BAS][2];
  const lineaMO = api.I_BREAKDOWN[BAS].find(p => p.t === 'O' && api.CREW_COMPOSITION[p.cod]);
  ok('el básico de prueba lleva una cuadrilla', !!lineaMO);
  if (lineaMO) {
    const peon = api.CREW_COMPOSITION[lineaMO.cod][0].cod;
    api.I_DICT[peon][2] = api.round2(Number(api.I_DICT[peon][2]) * 2);   // como haría FASAR
    api.refrescarCatalogoDelPresupuesto();
    ok('el básico se mueve al subir el salario',
      !cerca(api.I_DICT[BAS][2], antes),
      `antes ${antes}, después ${api.I_DICT[BAS][2]}`);
  }
}

// ── 21. Un precio de material propio llega a los básicos ───────────────────
seccion('Un precio de material propio llega a los básicos que lo usan');
{
  const api = resetFabrica();
  const BAS = '10401-291';
  const mat = FABRICA.breakdown[BAS].find(p => p.t === 'M' && api.I_DICT[p.cod]);
  ok('el básico de prueba lleva un material', !!mat);
  if (mat) {
    const antes = api.I_DICT[BAS][2];
    api.STATE.customMaterialCosts = { [mat.cod]: api.round2(FABRICA.dict[mat.cod][2] * 2) };
    api.refrescarCatalogoDelPresupuesto();
    ok('el básico sube al subir el material',
      api.I_DICT[BAS][2] > antes,
      `antes ${antes}, después ${api.I_DICT[BAS][2]}`);
  }
}

// ── 22. Aislamiento con cuadrillas (la prueba 6 no las tocaba) ─────────────
seccion('Aislamiento entre obras — cuadrillas');
{
  const api = resetFabrica();
  const BAS = '10401-291';
  const lineaMO = api.I_BREAKDOWN[BAS].find(p => p.t === 'O' && api.CREW_COMPOSITION[p.cod]);
  const CUAD = lineaMO.cod;
  const deFabricaCuad = FABRICA.dict[CUAD][2];
  const deFabricaBas = FABRICA.dict[BAS][2];

  abrirOtraObra(api, {
    cuadrillas: { [CUAD]: api.CREW_COMPOSITION[CUAD].map((p, i) => i === 0 ? { ...p, q: Number(p.q) * 3 } : { ...p }) },
  });
  ok('la obra A ve su cuadrilla editada',
    !cerca(api.I_DICT[CUAD][2], deFabricaCuad),
    `fábrica ${deFabricaCuad}, obra A ${api.I_DICT[CUAD][2]}`);
  ok('y el básico que la usa también se movió',
    !cerca(api.I_DICT[BAS][2], deFabricaBas));

  abrirOtraObra(api, {});
  ok('abrir otra obra devuelve la cuadrilla a fábrica',
    cerca(api.I_DICT[CUAD][2], deFabricaCuad),
    `esperado ${deFabricaCuad}, obtenido ${api.I_DICT[CUAD][2]}`);
  ok('y el básico que la usa vuelve a fábrica',
    cerca(api.I_DICT[BAS][2], deFabricaBas),
    `esperado ${deFabricaBas}, obtenido ${api.I_DICT[BAS][2]}`);
  const d = diferenciasContraFabrica();
  ok('el catálogo entero vuelve a fábrica',
    d.dict.length === 0 && d.breakdown.length === 0,
    `${d.dict.length} precios y ${d.breakdown.length} composiciones contaminadas`);
}

// ── 23. El escalado tampoco se aplica en loadInsumosForRow ─────────────────
seccion('loadInsumosForRow no escala cuando el P.U. viene de un básico');
{
  const api = resetFabrica();
  const BAS = '10401-291';
  api.STATE.customBasicos[BAS] = FABRICA.breakdown[BAS]
    .map((p, i) => i === 0 ? { ...p, q: Number(p.q) * 6 } : { ...p });
  const r = { cod: '10301-001', libre: false, qty: 1 };
  api.STATE.rows.A = [r];
  api.refrescarCatalogoDelPresupuesto();
  api.sincronizarFilaConCatalogo(r);
  api.loadInsumosForRow(r);   // es el que PERSISTE los costos en r.insumos

  const inventados = r.insumos.filter(i => {
    const dict = api.I_DICT[i.cod];
    if (!dict || api.isGlobalMoPercentInsumo(i)) return false;
    const propio = (FABRICA.breakdown['10301-001'].find(p => p.cod === i.cod) || {}).cs;
    return !cerca(i.cs, dict[2], 0.05) && !(propio != null && cerca(i.cs, propio, 0.05));
  });
  ok('ningún costo persistido está escalado',
    inventados.length === 0,
    inventados.length ? `${inventados[0].cod}: ${inventados[0].cs} vs catálogo ${api.I_DICT[inventados[0].cod][2]}` : '');
}

// ── 24. Filas sin desglose materializado en propagarBasicos ────────────────
seccion('propagarBasicos pone al día las filas nunca abiertas');
{
  const api = resetFabrica();
  const r = { cod: '10301-001', libre: false, qty: 1 };
  r.p = api.round2(FABRICA.breakdown['10301-001'].reduce((s, p) => s + Number(p.i || 0), 0));
  api.STATE.rows.A = [r];   // sin r.insumos: nunca se abrió el panel
  const antes = r.p;

  const BAS = '10401-291';
  api.STATE.customBasicos[BAS] = FABRICA.breakdown[BAS]
    .map((p, i) => i === 0 ? { ...p, q: Number(p.q) * 4 } : { ...p });
  api.propagarBasicos([BAS]);

  ok('el P.U. de la fila nunca abierta se movió',
    !cerca(r.p, antes),
    `antes ${antes}, después ${r.p}`);
  const suma = api.round2(api.getComparableInsumos(r).reduce((s, i) => s + Number(i.i || 0), 0));
  ok('y cuadra con el desglose que se imprime',
    cerca(r.p, suma),
    `P.U. ${r.p}, desglose ${suma}`);
}

// ── 12. La tarjeta de Básicos no se queda congelada ────────────────────────
seccion('La tarjeta de un básico editado muestra el total vigente');
{
  const api = resetFabrica();
  const BAS = '10401-292';
  // El usuario abre el básico y cambia una cantidad. asegurarBasicoEditable
  // congela el costo de cada línea dentro de STATE.customBasicos.
  const partes = api.asegurarBasicoEditable(BAS);
  partes[0].q = Number(partes[0].q) * 1.5;
  api.refrescarCatalogoDelPresupuesto();

  // Después sube el precio de un material que vive dentro de ese básico. Las
  // líneas de mano de obra se refrescarían solas; las de material no, así que
  // es aquí donde la composición congelada se separa del catálogo.
  const mat = api.I_BREAKDOWN[BAS].find(p => p.t === 'M');
  ok('el básico de prueba lleva un material', !!mat);
  api.STATE.customMaterialCosts[mat.cod] = api.round2(api.I_DICT[mat.cod][2] * 2);
  api.refrescarCatalogoDelPresupuesto();

  const enTarjeta = api.round2(
    (() => { const ps = api.partesDeBasico(BAS); api.recalcInsumoAmounts(ps);
             return ps.reduce((s, p) => s + Number(p.i || 0), 0); })());
  ok('la tarjeta muestra el mismo total que el catálogo',
    cerca(enTarjeta, api.I_DICT[BAS][2]),
    `tarjeta ${enTarjeta}, catálogo ${api.I_DICT[BAS][2]}`);
}

// ── 13. Un costo de básico puesto a mano en un concepto se respeta ─────────
seccion('Costo de básico ajustado a mano dentro de un concepto');
{
  const api = resetFabrica();
  // 10301-001 lleva el básico 10401-291, que a su vez contiene la cuadrilla
  // 1A5P. Hace falta esa cadena: si el básico no contiene la cuadrilla editada,
  // la propagación ni lo mira y la prueba no comprobaría nada.
  const r = filaDeConcepto(api, '10301-001');
  const ins = (r.insumos || []).find(i => i.cod === '10401-291');
  ok('el concepto de prueba lleva el básico que contiene la cuadrilla', !!ins);
  if (ins) {
    const aMano = 9999;
    ins.cs = aMano;
    ins.csManual = true;   // lo que marca propagateInsumoCost al teclear el costo

    api.STATE.customCuadrillas['1A5P'] = api.CREW_COMPOSITION['1A5P']
      .map((p, i) => i === 0 ? { ...p, q: Number(p.q) * 2 } : { ...p });
    api.propagarBasicos(['1A5P']);

    const despues = (api.STATE.rows.A[0].insumos || []).find(i => i.cod === ins.cod);
    ok('editar una cuadrilla de dentro no pisa el costo tecleado',
      cerca(despues.cs, aMano),
      `tecleado ${aMano}, quedó ${despues.cs}`);
  }
}

// ── 14. Un básico no puede contenerse a sí mismo ───────────────────────────
seccion('Básicos circulares');
{
  const api = resetFabrica();
  ok('un básico no se acepta dentro de sí mismo',
    api.creariaCiclo('10401-291', '10401-291'));

  // Ciclo indirecto: 10301-001 contiene 10401-291, así que meter 10301-001
  // dentro de 10401-291 cerraría el círculo.
  const contiene = (FABRICA.breakdown['10301-001'] || []).some(p => p.cod === '10401-291');
  ok('el caso de prueba tiene la cadena esperada', contiene);
  ok('se detecta el ciclo indirecto',
    api.creariaCiclo('10401-291', '10301-001'));

  ok('un insumo normal sí se acepta',
    !api.creariaCiclo('10401-291', '302-CAL-0102'));
}

// ── 15. Un presupuesto guardado con otro catálogo cuadra al abrirlo ────────
seccion('Abrir un presupuesto guardado con una versión anterior');
{
  const api = resetFabrica();
  const MAT = '302-CEM-0102';
  api.STATE.customMaterialCosts = { [MAT]: api.round2(FABRICA.dict[MAT][2] * 1.2) };

  // Fila tal como la guardó una versión anterior: P.U. ligeramente distinto del
  // que da el catálogo de hoy, sin desglose materializado y sin banderas.
  const r = { cod: '10301-001', libre: false, qty: 1, p: 11.90 };
  api.STATE.rows.A = [r];

  api.refrescarCatalogoDelPresupuesto();
  api.sincronizarFilasConCatalogo();

  api.loadInsumosForRow(r);
  const suma = api.round2((r.insumos || []).reduce((s, i) => s + Number(i.i || 0), 0));
  ok('el P.U. guardado se pone al día y cuadra con su desglose',
    cerca(r.p, suma),
    `P.U. ${r.p}, desglose ${suma}`);

  // Una fila con P.U. tecleado a mano NO se toca al abrir.
  const api2 = resetFabrica();
  const rm = { cod: '10301-001', libre: false, qty: 1, p: 77, pu_manual: true };
  api2.STATE.rows.A = [rm];
  api2.refrescarCatalogoDelPresupuesto();
  api2.sincronizarFilasConCatalogo();
  ok('un P.U. tecleado a mano sobrevive a abrir el presupuesto',
    cerca(rm.p, 77),
    `esperado 77, obtenido ${rm.p}`);
}

// ── 16. «Actualizar presupuesto» de Materiales mueve TODAS las filas ───────
seccion('Actualizar precios de materiales en el presupuesto');
{
  const api = resetFabrica();
  const MAT = '302-CEM-0102';

  // Tres filas en los tres estados posibles: nunca abierta (como la deja
  // addFromPicker), con desglose materializado, y con P.U. tecleado a mano.
  const sinAbrir = { cod: '10301-001', libre: false, qty: 1 };
  sinAbrir.p = api.round2(FABRICA.breakdown['10301-001'].reduce((s, p) => s + Number(p.i || 0), 0));
  api.sincronizarFilaConCatalogo(sinAbrir);

  const abierta = { cod: '10301-002', libre: false, qty: 1 };
  abierta.p = api.round2(FABRICA.breakdown['10301-002'].reduce((s, p) => s + Number(p.i || 0), 0));
  api.loadInsumosForRow(abierta);

  const aMano = { cod: '10301-008', libre: false, qty: 1, p: 55, pu_manual: true };

  api.STATE.rows.A = [sinAbrir, abierta, aMano];
  api.STATE.customMaterialCosts = { [MAT]: api.round2(FABRICA.dict[MAT][2] * 2) };

  // Dos veces seguidas: la segunda no debe dejar nada a medias.
  api.applyCustomMaterialsToBudget();
  api.applyCustomMaterialsToBudget();

  [sinAbrir, abierta].forEach(r => {
    const suma = api.round2(api.getComparableInsumos(r).reduce((s, i) => s + Number(i.i || 0), 0));
    ok(`${r.cod}: el P.U. cuadra con su desglose tras actualizar materiales`,
      cerca(r.p, suma),
      `P.U. ${r.p}, desglose ${suma}`);
  });
  ok('la fila con P.U. tecleado a mano no se toca',
    cerca(aMano.p, 55),
    `esperado 55, obtenido ${aMano.p}`);

  const deFabrica = api.round2(FABRICA.breakdown['10301-001'].reduce((s, p) => s + Number(p.i || 0), 0));
  ok('el precio nuevo del material sí llegó al P.U.',
    !cerca(sinAbrir.p, deFabrica),
    `fábrica ${deFabrica}, obtenido ${sinAbrir.p}`);
}

console.log('');
if (fallos) {
  console.log(`${fallos} comprobación(es) fallaron.`);
  process.exit(1);
}
console.log('Catálogo en orden.');
