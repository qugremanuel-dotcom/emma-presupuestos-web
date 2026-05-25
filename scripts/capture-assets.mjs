import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire('C:/Users/QUGR_/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js');
const { chromium } = require('playwright');

const root = resolve('.');
const outDir = resolve(root, 'assets', 'screenshots');
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });

async function shot(path, file, options = {}) {
  await page.goto(`file:///${resolve(root, path).replaceAll('\\', '/')}`);
  await page.waitForLoadState('load');
  await page.screenshot({ path: resolve(outDir, file), fullPage: options.fullPage ?? false });
}

await shot('index.html', '01-landing-emma.png', { fullPage: false });
await shot('demo.html', '02-demo-presupuesto.png', { fullPage: false });

await page.goto(`file:///${resolve(root, 'demo.html').replaceAll('\\', '/')}`);
await page.waitForLoadState('load');
await page.locator('button', { hasText: 'Agregar concepto demo' }).click();
await page.locator('button', { hasText: 'Calcular presupuesto' }).click();
await page.screenshot({ path: resolve(outDir, '03-demo-concepto-agregado.png'), fullPage: false });

await page.goto(`file:///${resolve(root, 'app', 'presupuesto_emma.html').replaceAll('\\', '/')}`);
await page.waitForLoadState('load');
await page.screenshot({ path: resolve(outDir, '04-app-completa-acceso.png'), fullPage: false });

await browser.close();
console.log(outDir);
