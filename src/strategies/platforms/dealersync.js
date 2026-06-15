import { chromium } from 'playwright';
import { CONFIG } from '../../config.js';
import { normalizeMany } from '../../normalizer.js';

/**
 * EXTRACTOR DE PLATAFORMA — DealerSync (images.dealersync.com)
 *
 * El inventario vive en una página tipo /pre-owned-cars (o el link "Inventory").
 * Cada vehículo es un <div class="ds-vehicle-list-item"> con los datos en atributos:
 *   data-vin, data-stock-no, data-vehicle-title ("2024 Cadillac Escalade AWD V-Series"),
 *   data-city, data-id
 * Precio y millaje van en el texto de la tarjeta. La paginación suele ser scroll
 * infinito (cargan más al bajar); recorremos hasta que el conteo se estabiliza.
 *
 * Devuelve el contrato estándar { ok, vehicles, reason, attempts }.
 */
export async function dealerSyncExtract(baseUrl, ctx) {
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

    // 1) Llegar a la página de inventario
    const inventoryUrl = await findInventoryUrl(page, baseUrl, origin);
    attempts.push(`inventario: ${inventoryUrl}`);

    // 2) Scroll hasta que deje de crecer el número de tarjetas (lazy-load)
    let prev = -1, stable = 0;
    for (let i = 0; i < CONFIG.maxPagesPerDealer * 2 && stable < 3; i++) {
      await page.mouse.wheel(0, 6000);
      await page.waitForTimeout(900);
      const count = await page.evaluate(() => document.querySelectorAll('[data-vin]').length);
      if (count === prev) stable++; else { stable = 0; prev = count; }
    }

    // 3) Extraer las tarjetas
    const rawCards = await page.evaluate(extractCardsInPage);
    attempts.push(`${rawCards.length} tarjetas extraídas`);

    if (rawCards.length === 0) {
      return { ok: false, vehicles: [], reason: 'DealerSync: no se encontraron tarjetas .ds-vehicle-list-item', attempts };
    }

    const vehicles = normalizeMany(rawCards, origin);
    return {
      ok: vehicles.length > 0,
      vehicles,
      reason: `DealerSync: ${vehicles.length} vehículos del listado`,
      attempts,
    };
  } catch (e) {
    return { ok: false, vehicles: [], reason: `DealerSync: error de extracción: ${e.message}`, attempts };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function findInventoryUrl(page, baseUrl, origin) {
  // Rutas típicas de DealerSync primero
  for (const path of ['/pre-owned-cars', '/inventory', '/used-cars']) {
    try {
      const resp = await page.goto(origin + path, { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs });
      await page.waitForTimeout(3000);
      if ((resp?.status() ?? 500) < 400 && await page.$('[data-vin]')) return origin + path;
    } catch { /* probar siguiente */ }
  }
  // Si no, seguir el link "Inventory" del home
  try {
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs });
    await page.waitForTimeout(3000);
    const link = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a[href]')].find((a) =>
        /^(inventory|view inventory|pre-?owned|used|vehicles)/i.test((a.innerText || '').trim()));
      return a?.href || null;
    });
    if (link) { await page.goto(link, { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs }); await page.waitForTimeout(3000); }
    return link || baseUrl;
  } catch { return baseUrl; }
}

/** Se ejecuta dentro del navegador. */
function extractCardsInPage() {
  const cards = [];
  for (const el of document.querySelectorAll('[data-vin]')) {
    const title = el.getAttribute('data-vehicle-title') || '';           // "2024 Cadillac Escalade AWD V-Series"
    const yearMatch = title.match(/\b(19|20)\d{2}\b/);
    const rest = title.replace(/\b(19|20)\d{2}\b/, '').trim().split(/\s+/);
    const make = rest[0] || null;
    const model = rest[1] || null;
    const trim = rest.slice(2).join(' ') || null;

    const text = (el.innerText || '').replace(/\s+/g, ' ');
    const priceMatch = text.match(/\$\s?([\d,]{3,})/);
    // millaje: el número (con coma) que precede a "<n> MPG"; si no, "<n> mi/miles"
    const milesMpg = text.match(/([\d,]{2,})\s+\d{1,2}\s*MPG/i);
    const milesLbl = text.match(/([\d,]{3,})\s*(?:mi\b|miles)/i);
    const mileage = (milesMpg || milesLbl)?.[1] || null;

    const a = el.querySelector('a[href*="detail"], a[href*="/inventory/"]');

    cards.push({
      vin: el.getAttribute('data-vin'),
      stock_number: el.getAttribute('data-stock-no'),
      make, model, trim,
      year: yearMatch ? yearMatch[0] : null,
      price: priceMatch ? priceMatch[1] : null,
      mileage,
      location: el.getAttribute('data-city') || null,
      condition: 'used',
      url: a?.getAttribute('href') || null,
      image_url: el.querySelector('img')?.getAttribute('src') || null,
    });
  }
  return cards;
}
