import { chromium } from 'playwright';
import { CONFIG } from '../../config.js';
import { normalizeMany } from '../../normalizer.js';
import { gotoTiered, launchBrowser, newScrapePage } from '../../fetch/managed-fetch.js';

/**
 * EXTRACTOR DE LA FAMILIA "DWS" (Dealer Web Services) — cubre DealerCenter
 * (dealercenterwebsite.net) Y DealerCarSearch (alpha.dcdws.net / mycarsonline.com),
 * que comparten exactamente el mismo markup `dws-vehicle-*`.
 *
 * Estos sitios:
 *  - Suelen estar tras Cloudflare (HTTP plano = 403) → requieren navegador real.
 *  - NO exponen un API JSON de inventario → el scraper genérico cae a "tarjetas
 *    del DOM" y saca datos sucios/incompletos.
 *
 * Pero TODO el dato vive en el listado (`/inventory/`), en markup propio con
 * clases estables `dws-vehicle-listing-item-*` y `dws-vehicle-field-*`:
 *   VIN, millaje, tracción, transmisión, motor, puertas, stock, precio.
 * El make/model/stock también vienen limpios en el href de la ficha
 *   /inventory/<make>/<model>/<stock>/.
 *
 * Por eso NO hace falta visitar las fichas (VDP): una sola sesión de navegador,
 * paginando el listado, saca el inventario completo con fidelidad alta.
 *
 * Devuelve el contrato estándar { ok, vehicles, reason, attempts }.
 */
export async function dwsExtract(baseUrl, ctx) {
  const origin = new URL(baseUrl).origin;
  const inventoryUrl = `${origin}/inventory/`;
  const attempts = [];
  let browser;

  try {
    browser = await launchBrowser(true);
  } catch (e) {
    return { ok: false, vehicles: [], reason: `No se pudo iniciar el navegador: ${e.message}`, attempts };
  }

  try {
    const page = await newScrapePage(browser, true);

    // El listado renderiza cada vehículo en DOS layouts (lista + grid): solo la
    // vista lista trae VIN/tracción/etc. Fusionamos por stock_number (presente en
    // ambos, 100%) para combinar campos y no duplicar. La paginación es ?page_no=N.
    const byStock = new Map();
    let pageNum = 1;

    while (pageNum <= CONFIG.maxPagesPerDealer) {
      const url = pageNum === 1 ? inventoryUrl : `${inventoryUrl}?page_no=${pageNum}`;
      // Fetch escalonado: navegador → si Cloudflare/DataDome bloquea, servicio gestionado.
      const { tier, blocked } = await gotoTiered(page, url, { timeout: CONFIG.navTimeoutMs, log: ctx.log, remote: true });
      if (blocked) { attempts.push(`${url} -> bloqueado anti-bot (sin escalado disponible)`); break; }
      if (tier === 2) attempts.push(`${url} -> resuelto vía servicio gestionado (Tier 2)`);

      // Esperar a que rendericen las tarjetas; si vienen 0 (sesión remota lenta),
      // reintentar la navegación una vez antes de dar la página por vacía.
      let pageCards = [];
      for (let intento = 0; intento < 2; intento++) {
        await page.waitForSelector('.dws-vehicle-listing-item-title', { timeout: 15_000 }).catch(() => {});
        for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 4000); await page.waitForTimeout(500); }
        pageCards = await page.evaluate(extractCardsInPage);
        if (pageCards.length > 0) break;
        if (intento === 0) await gotoTiered(page, url, { timeout: CONFIG.navTimeoutMs, log: ctx.log, remote: true });
      }

      let nuevos = 0;
      for (const c of pageCards) {
        const key = c.stock_number || c.vin || c.url;
        if (!key) continue;
        if (byStock.has(key)) {
          // fusionar: rellenar campos nulos con los del otro layout
          const prev = byStock.get(key);
          for (const [k, v] of Object.entries(c)) if (prev[k] == null && v != null) prev[k] = v;
        } else {
          byStock.set(key, { ...c });
          nuevos++;
        }
      }
      attempts.push(`${url} -> ${pageCards.length} tarjetas, ${nuevos} vehículos nuevos (tier ${tier})`);

      // Página sin vehículos nuevos => llegamos al final (o ?page_no se reinició)
      if (nuevos === 0) break;
      pageNum++;
    }

    if (byStock.size === 0) {
      return { ok: false, vehicles: [], reason: 'DealerCenter: no se encontraron tarjetas en el listado', attempts };
    }

    const vehicles = normalizeMany([...byStock.values()], origin);
    return {
      ok: vehicles.length > 0,
      vehicles,
      reason: `DealerCenter: ${vehicles.length} vehículos del listado en ${pageNum} página(s)`,
      attempts,
    };
  } catch (e) {
    return { ok: false, vehicles: [], reason: `DealerCenter: error de extracción: ${e.message}`, attempts };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Se ejecuta DENTRO del navegador (page.evaluate): no tiene acceso a imports.
 * Recorre cada tarjeta del listado y devuelve objetos crudos para el normalizer.
 */
function extractCardsInPage() {
  const stripLabel = (t) => (t || '').replace(/^[A-Za-z /]+?\s/, '').trim(); // "Mileage 62,942" -> "62,942"
  const titles = document.querySelectorAll('.dws-vehicle-listing-item-title');
  const cards = [];

  for (const title of titles) {
    const card = title.closest('.row') || title.parentElement?.parentElement;
    if (!card) continue;

    const a = title.querySelector('a');
    const href = a?.getAttribute('href') || '';
    // href: /inventory/<make>/<model>/<stock>/  -> make/model/stock limpios
    const seg = href.split('/').filter(Boolean); // [inventory, make, model, stock]
    const makeFromUrl = seg[1] ? seg[1].replace(/-/g, ' ') : null;
    const modelFromUrl = seg[2] ? seg[2].replace(/-/g, ' ') : null;
    const stockFromUrl = seg[3] || null;

    const titleText = (title.textContent || '').replace(/\s+/g, ' ').trim();
    const yearMatch = titleText.match(/\b(19|20)\d{2}\b/);

    const field = (cls) => {
      const el = card.querySelector(`.dws-vehicle-field-${cls}`);
      return el ? stripLabel((el.textContent || '').replace(/\s+/g, ' ').trim()) : null;
    };

    const priceMatch = (card.textContent || '').match(/\$[\d,]{3,}/);
    const img = card.querySelector('img');

    cards.push({
      vin: field('vin'),
      stock_number: field('stock-number') || stockFromUrl,
      make: makeFromUrl,
      model: modelFromUrl,
      year: yearMatch ? yearMatch[0] : null,
      mileage: field('mileage'),
      drivetrain: field('drivetrain'),
      transmission: field('transmission'),
      engine: field('engine'),
      doors: field('door'),
      price: priceMatch ? priceMatch[0] : null,
      condition: 'used',
      url: href,
      image_url: img ? (img.getAttribute('src') || img.getAttribute('data-src')) : null,
    });
  }
  return cards;
}
