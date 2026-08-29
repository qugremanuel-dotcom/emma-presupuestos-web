#!/usr/bin/env node
// ============================================================
// extract-db.js
// Lee app/presupuesto_emma.html y extrae las variables
// window.CONCEPT_DATABASE, window.INSUMOS_DICT y
// window.INSUMOS_BREAKDOWN a archivos JSON en data/
// ============================================================
"use strict";
const fs   = require("fs");
const path = require("path");

const HTML_FILE = path.join(__dirname, "..", "app", "presupuesto_emma.html");
const DATA_DIR  = path.join(__dirname, "..", "data");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

console.log("Leyendo HTML…");
const lines = fs.readFileSync(HTML_FILE, "utf8").split("\n");
console.log(`  ${lines.length} líneas leídas.`);

function extractVar(varName) {
  const prefix = `window.${varName} = `;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      const json = trimmed.slice(prefix.length).replace(/;$/, "").trim();
      return JSON.parse(json);
    }
  }
  return null;
}

// ── Conceptos ────────────────────────────────────────────────
console.log("\nExtrayendo CONCEPT_DATABASE…");
const conceptos = extractVar("CONCEPT_DATABASE");
if (!conceptos) { console.error("ERROR: No se encontró window.CONCEPT_DATABASE"); process.exit(1); }
const nPartidas = Object.keys(conceptos).length;
const nConcepts = Object.values(conceptos).reduce((s, a) => s + a.length, 0);
console.log(`  ${nPartidas} partidas, ${nConcepts} conceptos`);
fs.writeFileSync(path.join(DATA_DIR, "conceptos.json"), JSON.stringify(conceptos), "utf8");
console.log("  ✓ data/conceptos.json");

// ── Insumos ──────────────────────────────────────────────────
console.log("\nExtrayendo INSUMOS_DICT…");
const dict = extractVar("INSUMOS_DICT");
if (!dict) console.warn("  ADVERTENCIA: No se encontró window.INSUMOS_DICT");
else console.log(`  ${Object.keys(dict).length} entradas`);

console.log("Extrayendo INSUMOS_BREAKDOWN…");
const breakdown = extractVar("INSUMOS_BREAKDOWN");
if (!breakdown) console.warn("  ADVERTENCIA: No se encontró window.INSUMOS_BREAKDOWN");
else console.log(`  ${Object.keys(breakdown).length} conceptos con insumos`);

const insumos = { dict: dict || {}, breakdown: breakdown || {} };
fs.writeFileSync(path.join(DATA_DIR, "insumos.json"), JSON.stringify(insumos), "utf8");
console.log("  ✓ data/insumos.json");

console.log("\n✅  Extracción completa.");
