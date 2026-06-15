import { chromium } from 'playwright';
import { CONFIG } from '../../config.js';
import { normalizeMany } from '../../normalizer.js';

/**
 * EXTRACTOR DE PLATAFORMA — Dealr.cloud (dealrcloud.com / dealrimages.com)
 *
 * Inventario en /main-inventory (o el link "Inventory"). Cada vehículo es un
 * <div class="dealr-inventory-vehicle"> con campos etiquetados en el texto:
 *   Mileage, Stock, Drivetrain, Exterior, Interior, Engine + precio ($).
 * El año/marca/modelo/trim vienen limpios en el slug del link de ficha
 *   inventory/<year>-<make>-<model>-<trim>/<id>
 * El VIN suele estar en el badge de CarGurus (data-cg-vin) de cada tarjeta.
 *
 * Contrato estándar { ok, vehicles, reason, attempts }.
 */
export async function dealrExtract(baseUrl, ctx) {
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

    // Llegar al inventario
    let invUrl = null;
    for (const path of ['/main-inventory', '/inventory', '/used-cars']) {
      try {
        const resp = await page.goto(origin + path, { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs });
        await page.waitForTimeout(3000);
        if ((resp?.status() ?? 500) < 400 && await page.$('.dealr-inventory-vehicle')) { invUrl = origin + path; break; }
      } catch { /* siguiente */ }
    }
    if (!invUrl) {
      await page.goto(baseUrl, { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs }).catch(() => {});
      await page.waitForTimeout(3000);
      const link = await page.evaluate(() => [...document.querySelectorAll('a[href]')]
        .find((a) => /^(inventory|view inventory|pre-?owned|used)/i.test((a.innerText || '').trim()))?.href || null);
      if (link) { await page.goto(link, { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs }).catch(() => {}); await page.waitForTimeout(3000); }
      invUrl = link || baseUrl;
    }
    invUrl = page.url(); // URL canónica (post-redirect) para que ?page=N no se pierda
    attempts.push(`inventario: ${invUrl}`);

    // Paginación ?page=N (50 por página); deduplicar por VIN/stock
    const byKey = new Map();
    for (let pageNum = 1; pageNum <= CONFIG.maxPagesPerDealer; pageNum++) {
      if (pageNum > 1) {
        const sep = invUrl.includes('?') ? '&' : '?';
        await page.goto(`${invUrl}${sep}page=${pageNum}`, { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs }).catch(() => {});
        await page.waitForTimeout(2500);
      }
      for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 6000); await page.waitForTimeout(500); }

      const pageCards = await page.evaluate(extractCardsInPage);
      let nuevos = 0;
      for (const c of pageCards) {
        const key = c.vin || c.stock_number || c.url;
        if (key && !byKey.has(key)) { byKey.set(key, c); nuevos++; }
      }
      attempts.push(`page=${pageNum}: ${pageCards.length} tarjetas, ${nuevos} nuevos`);
      if (nuevos === 0 || pageCards.length < 50) break;
    }

    if (byKey.size === 0) {
      return { ok: false, vehicles: [], reason: 'Dealr.cloud: no se encontraron tarjetas .dealr-inventory-vehicle', attempts };
    }

    const vehicles = normalizeMany([...byKey.values()], origin);
    return { ok: vehicles.length > 0, vehicles, reason: `Dealr.cloud: ${vehicles.length} vehículos del listado`, attempts };
  } catch (e) {
    return { ok: false, vehicles: [], reason: `Dealr.cloud: error de extracción: ${e.message}`, attempts };
  } finally {
    await browser.close().catch(() => {});
  }
}

function extractCardsInPage() {
  const cards = [];
  const field = (text, label, end) => {
    const re = new RegExp(`${label}\\s+(.+?)\\s+(?=${end})`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  for (const el of document.querySelectorAll('.dealr-inventory-vehicle')) {
    const text = (el.innerText || '').replace(/\s+/g, ' ');
    const a = el.querySelector('a[href*="inventory/"], a[href*="/vehicle"]');
    const href = a?.getAttribute('href') || '';
    // slug: inventory/<year>-<make>-<model>-<trim>/<id>
    const slug = (href.split('/').filter(Boolean).find((s) => /^(19|20)\d{2}-/.test(s)) || '').split('-');
    const year = slug[0] && /^(19|20)\d{2}$/.test(slug[0]) ? slug[0] : (text.match(/\b(19|20)\d{2}\b/) || [])[0] || null;
    const make = slug[1] || null;
    const model = slug[2] || null;
    const trim = slug.slice(3).join(' ') || null;

    const vin = el.querySelector('[data-cg-vin]')?.getAttribute('data-cg-vin') || null;
    const priceMatch = text.match(/\$\s?([\d,]{3,})/);

    cards.push({
      vin,
      stock_number: (text.match(/Stock\s+([A-Za-z0-9-]+)/i) || [])[1] || null,
      make, model, trim, year,
      mileage: (text.match(/Mileage\s+([\d,]+)/i) || [])[1] || null,
      drivetrain: (text.match(/Drivetrain\s+([A-Za-z0-9]+)/i) || [])[1] || null,
      exterior_color: field(text, 'Exterior', 'Interior|Engine|Mileage|Stock|MPG|\\$'),
      interior_color: field(text, 'Interior', 'Engine|Exterior|Mileage|Stock|MPG|\\$'),
      engine: field(text, 'Engine', 'MPG|Mileage|Stock|Exterior|Interior|\\$'),
      price: priceMatch ? priceMatch[1] : null,
      condition: 'used',
      url: href || null,
      image_url: el.querySelector('img')?.getAttribute('src') || null,
    });
  }
  return cards;
}
