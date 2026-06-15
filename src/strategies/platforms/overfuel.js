import { chromium } from 'playwright';
import { CONFIG } from '../../config.js';
import { normalizeMany } from '../../normalizer.js';

/**
 * EXTRACTOR DE PLATAFORMA — OverFuel (overfuel.com)
 *
 * SPA con inventario en /inventory. Cada vehículo es <div class="srp-cardcontainer"
 * data-vin="..." ...> y la clase incluye make_<x> body_<x>. El link de ficha es
 *   /inventory/<year>-<make>-<model>-<trim>-<VIN>
 * El texto trae "Stock # X", "<n> miles" y un precio ("No-haggle price $X").
 * Pagina con ?page=N (25 por página). Contrato { ok, vehicles, reason, attempts }.
 */
export async function overfuelExtract(baseUrl, ctx) {
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

    await page.goto(`${origin}/inventory`, { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs }).catch(() => {});
    await page.waitForTimeout(4000);
    if (!await page.$('[data-vin]')) {
      return { ok: false, vehicles: [], reason: 'OverFuel: no se encontró /inventory con tarjetas data-vin', attempts };
    }
    const invUrl = page.url();

    const byVin = new Map();
    for (let pageNum = 1; pageNum <= CONFIG.maxPagesPerDealer; pageNum++) {
      if (pageNum > 1) {
        const sep = invUrl.includes('?') ? '&' : '?';
        await page.goto(`${invUrl}${sep}page=${pageNum}`, { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs }).catch(() => {});
        await page.waitForTimeout(2500);
      }
      for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 5000); await page.waitForTimeout(500); }

      const pageCards = await page.evaluate(extractCardsInPage);
      let nuevos = 0;
      for (const c of pageCards) {
        const key = c.vin || c.url;
        if (key && !byVin.has(key)) { byVin.set(key, c); nuevos++; }
      }
      attempts.push(`page=${pageNum}: ${pageCards.length} tarjetas, ${nuevos} nuevos`);
      if (nuevos === 0 || pageCards.length < 25) break;
    }

    if (byVin.size === 0) {
      return { ok: false, vehicles: [], reason: 'OverFuel: no se extrajeron tarjetas', attempts };
    }
    const vehicles = normalizeMany([...byVin.values()], origin);
    return { ok: vehicles.length > 0, vehicles, reason: `OverFuel: ${vehicles.length} vehículos del listado`, attempts };
  } catch (e) {
    return { ok: false, vehicles: [], reason: `OverFuel: error de extracción: ${e.message}`, attempts };
  } finally {
    await browser.close().catch(() => {});
  }
}

function extractCardsInPage() {
  const cards = [];
  for (const el of document.querySelectorAll('[data-vin]')) {
    const vin = el.getAttribute('data-vin');
    const a = el.querySelector('a[href*="/inventory/"]');
    const href = a?.getAttribute('href') || '';
    // slug: /inventory/<year>-<make>-<model>-<trim>-<VIN>
    const slug = href.split('/').pop() || '';
    const parts = slug.split('-');
    if (parts.length && /^[A-HJ-NPR-Z0-9]{17}$/i.test(parts[parts.length - 1])) parts.pop(); // quitar VIN final
    const year = /^(19|20)\d{2}$/.test(parts[0]) ? parts[0] : null;
    const make = parts[1] || ((el.className.match(/make_([a-z0-9]+)/i) || [])[1]) || null;
    const model = parts[2] || null;
    const trim = parts.slice(3).join(' ') || null;

    const text = (el.innerText || '').replace(/\s+/g, ' ');
    const priceMatch = text.match(/(?:No-haggle price|Sale Price|Our Price|Internet Price|Price)\s*\$\s?([\d,]{3,})/i)
      || text.match(/\$\s?([\d,]{4,})/);

    cards.push({
      vin,
      stock_number: (text.match(/Stock\s*#?\s*([A-Za-z0-9-]+)/i) || [])[1] || null,
      make, model, trim, year,
      mileage: (text.match(/([\d,]+)\s*miles/i) || [])[1] || null,
      price: priceMatch ? priceMatch[1] : null,
      condition: 'used',
      url: href || null,
      image_url: el.querySelector('img')?.getAttribute('src') || null,
    });
  }
  return cards;
}
