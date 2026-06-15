import { chromium } from 'playwright';
import { CONFIG } from '../../config.js';
import { findVehicleArrays } from '../../utils/http.js';
import { normalizeMany } from '../../normalizer.js';

/**
 * EXTRACTOR DE PLATAFORMA — Dealer.com (DDC, "ws-inv-data") — ⚠️ EXPERIMENTAL
 *
 * NOTA: Dealer.com es muy variable entre sitios (inventario server-side en unos,
 * XHR con rutas de widget distintas en otros, Cloudflare en varios). Este extractor
 * funciona solo en sitios que disparan ws-inv-data/getInventory por XHR al cargar
 * /used-inventory/. Para fidelidad completa (con millaje) en toda la familia Dealer.com
 * hace falta manejo por-config del endpoint o enriquecimiento por VDP — pendiente.
 * El pipeline genérico (api/navigate) ya cubre parcialmente Dealer.com mientras tanto.
 *
 * Dealer.com carga el inventario por XHR a widgets `/api/widget/ws-inv-data/...`.
 * Hay dos endpoints según la config del sitio:
 *   - getInventoryAndFacets → resumen (a veces SIN millaje)
 *   - getInventory          → registro completo (CON millaje)
 * Interceptamos cualquiera de los dos, extraemos los arrays de vehículos con la
 * heurística findVehicleArrays y paginamos con ?start=N (24 por página).
 *
 * Contrato estándar { ok, vehicles, reason, attempts }.
 */
export async function dealerDotComExtract(baseUrl, ctx) {
  const origin = new URL(baseUrl).origin;
  const attempts = [];
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    return { ok: false, vehicles: [], reason: `No se pudo iniciar el navegador: ${e.message}`, attempts };
  }

  try {
    const page = await (await browser.newContext({
      userAgent: CONFIG.userAgent, viewport: { width: 1366, height: 900 },
    })).newPage();

    const byKey = new Map();
    page.on('response', async (r) => {
      if (!/getInventory|inventory-data|ws-inv-data/i.test(r.url())) return;
      const ct = r.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const json = JSON.parse(await r.text());
        for (const arr of findVehicleArrays(json)) {
          for (const v of arr) {
            const key = v.vin || v.uuid || JSON.stringify(v).slice(0, 80);
            if (!byKey.has(key)) byKey.set(key, v);
          }
        }
      } catch { /* respuesta no-JSON */ }
    });

    const invPath = '/used-inventory/index.htm';
    for (let pageNum = 0; pageNum < CONFIG.maxPagesPerDealer; pageNum++) {
      const url = pageNum === 0 ? origin + invPath : `${origin}${invPath}?start=${pageNum * 24}`;
      await page.goto(url, { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs }).catch(() => {});
      await page.waitForTimeout(4000);
      for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 5000); await page.waitForTimeout(700); }
      const before = byKey.size;
      attempts.push(`start=${pageNum * 24}: acumulado ${byKey.size}`);
      if (pageNum > 0 && byKey.size === before) break;
    }

    if (byKey.size === 0) {
      return { ok: false, vehicles: [], reason: 'Dealer.com: no se interceptó inventario ws-inv-data', attempts };
    }
    const vehicles = normalizeMany([...byKey.values()], origin);
    return { ok: vehicles.length > 0, vehicles, reason: `Dealer.com: ${vehicles.length} vehículos (ws-inv-data)`, attempts };
  } catch (e) {
    return { ok: false, vehicles: [], reason: `Dealer.com: error de extracción: ${e.message}`, attempts };
  } finally {
    await browser.close().catch(() => {});
  }
}
