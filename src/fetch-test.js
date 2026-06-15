import { chromium } from 'playwright';
import { CONFIG } from './config.js';
import { gotoTiered, isBlocked } from './fetch/managed-fetch.js';
import { log } from './logger.js';

/**
 * Prueba de la capa de fetch escalonada.
 *   node src/fetch-test.js https://sitio1 https://sitio2 ...
 * Reporta, por URL: qué tier resolvió, si quedó bloqueado, y cuántos VIN se ven en el HTML.
 */
const urls = process.argv.slice(2);
if (urls.length === 0) { console.error('Uso: node src/fetch-test.js <url> [url...]'); process.exit(1); }

console.log(`Proveedor gestionado: ${CONFIG.managedFetch.provider} | key configurada: ${CONFIG.managedFetch.enabled ? 'SÍ' : 'NO (Tier 2 se omite)'}\n`);

const browser = await chromium.launch({ headless: true });
for (const url of urls) {
  const page = await (await browser.newContext({ userAgent: CONFIG.userAgent, viewport: { width: 1366, height: 900 } })).newPage();
  const t0 = Date.now();
  const { tier, blocked } = await gotoTiered(page, url, { log });
  const html = await page.content().catch(() => '');
  const vins = new Set((html.match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) || []).filter((v) => /[0-9]/.test(v) && /[A-Z]/.test(v)));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const estado = blocked ? '🔴 BLOQUEADO' : tier === 2 ? '🟡 resuelto vía servicio gestionado (Tier 2)' : '🟢 OK con navegador (Tier 1)';
  console.log(`${estado}  ${url}`);
  console.log(`   tier=${tier} bloqueado=${blocked} · ${html.length} bytes · ${vins.size} VINs visibles · ${secs}s\n`);
  await page.close();
}
await browser.close();
