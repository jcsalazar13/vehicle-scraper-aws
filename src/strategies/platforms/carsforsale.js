import { chromium } from 'playwright';
import { CONFIG } from '../../config.js';
import { normalizeMany } from '../../normalizer.js';
import { gotoTiered, launchBrowser, newScrapePage } from '../../fetch/managed-fetch.js';

/**
 * EXTRACTOR DE PLATAFORMA — CarsForSale.com ("powered by CarsForSale" dealer sites)
 *
 * Estos dealers casi siempre están tras DataDome → requieren la capa de fetch
 * gestionada (Bright Data). El inventario se renderiza en el dominio del dealer,
 * en /inventory (o /cars-for-sale), con tarjetas `vehicle-snapshot` y un bloque
 * JSON-LD schema.org por vehículo. El link de ficha es:
 *   /details/<cond>-<year>-<make>-<model>/<listingId>
 *
 * El LISTADO da: year, make, model, trim, price, mileage, transmisión, tracción,
 * color, imagen, link VDP. El VIN y el stock viven SOLO en la ficha (VDP), cuyo
 * acceso es inconsistente incluso vía Bright Data → enriquecimiento best-effort.
 *
 * Contrato estándar { ok, vehicles, reason, attempts }.
 */
export async function carsForSaleExtract(baseUrl, ctx) {
  const origin = new URL(baseUrl).origin;
  const attempts = [];
  const log = ctx?.log;
  let browser;

  try {
    browser = await launchBrowser();
  } catch (e) {
    return { ok: false, vehicles: [], reason: `No se pudo iniciar el navegador: ${e.message}`, attempts };
  }

  try {
    const page = await newScrapePage(browser);

    // Localizar el listado (rutas típicas del template CarsForSale)
    let invUrl = null;
    for (const path of ['/inventory', '/cars-for-sale', '/used-cars-for-sale']) {
      const { blocked } = await gotoTiered(page, origin + path, { timeout: CONFIG.navTimeoutMs, log, forceManaged: true });
      if (!blocked && await page.$('[class*="vehicle-snapshot"], a[href*="/details/"]')) { invUrl = origin + path; break; }
    }
    if (!invUrl) return { ok: false, vehicles: [], reason: 'CarsForSale: no se encontró el listado (¿DataDome sin Bright Data?)', attempts };

    // Paginar ?page=N acumulando tarjetas (dedupe por listingId)
    const byId = new Map();
    for (let pageNum = 1; pageNum <= CONFIG.maxPagesPerDealer; pageNum++) {
      if (pageNum > 1) {
        const sep = invUrl.includes('?') ? '&' : '?';
        const { blocked } = await gotoTiered(page, `${invUrl}${sep}page=${pageNum}`, { timeout: CONFIG.navTimeoutMs, log, forceManaged: true });
        if (blocked) break;
      }
      await page.waitForTimeout(1200);
      const cards = await page.evaluate(extractCardsInPage);
      let nuevos = 0;
      for (const c of cards) { if (c.listingId && !byId.has(c.listingId)) { byId.set(c.listingId, c); nuevos++; } }
      attempts.push(`page=${pageNum}: ${cards.length} tarjetas, ${nuevos} nuevos`);
      if (nuevos === 0 || cards.length < 24) break;
    }

    if (byId.size === 0) return { ok: false, vehicles: [], reason: 'CarsForSale: listado sin tarjetas parseables', attempts };

    // Enriquecer VIN/stock desde la ficha (best-effort). Sonda la PRIMERA ficha: si las
    // VDP no devuelven contenido (DataDome más duro en fichas), se aborta para no
    // malgastar una llamada por vehículo. Solo si la enableVdp está activa.
    let vinOk = 0, vdpProbed = 0;
    if (CONFIG.managedFetch.enabled && CONFIG.carsforsaleEnrichVdp) {
      for (const v of byId.values()) {
        if (!v.url) continue;
        vdpProbed++;
        try {
          const { blocked } = await gotoTiered(page, v.url.startsWith('http') ? v.url : origin + v.url, { timeout: 30000, log, forceManaged: true });
          if (!blocked) {
            const det = await page.evaluate(extractVdpDetails);
            if (det.vin) { v.vin = det.vin; vinOk++; }
            if (det.stock_number) v.stock_number = det.stock_number;
            if (det.mileage && !v.mileage) v.mileage = det.mileage;
          }
        } catch { /* VDP inaccesible */ }
        // Aborta si la sonda inicial (primeras 2 fichas) no dio ningún VIN
        if (vdpProbed >= 2 && vinOk === 0) { attempts.push('VDP sin VIN en sonda inicial → enriquecimiento abortado'); break; }
      }
    }
    attempts.push(`VIN enriquecido en ${vinOk}/${byId.size} (VDP sondeadas: ${vdpProbed})`);

    const vehicles = normalizeMany([...byId.values()], origin);
    return {
      ok: vehicles.length > 0,
      vehicles,
      reason: `CarsForSale: ${vehicles.length} vehículos del listado (VIN en ${vinOk})`,
      attempts,
    };
  } catch (e) {
    return { ok: false, vehicles: [], reason: `CarsForSale: error de extracción: ${e.message}`, attempts };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Dentro del navegador: parsea las tarjetas del listado CarsForSale. */
function extractCardsInPage() {
  // Precio por vehículo desde JSON-LD (offers.price) — más fiable que el texto.
  const ldPrices = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const o = JSON.parse(s.textContent.trim());
      for (const it of (Array.isArray(o) ? o : [o, ...(o['@graph'] || [])])) {
        if (/vehicle|car/i.test(String(it['@type'] || '')) && it.offers?.price) ldPrices.push(String(it.offers.price));
      }
    } catch { /* json-ld inválido */ }
  }

  const cards = [];
  const anchors = [...document.querySelectorAll('a[href*="/details/"]')];
  const seen = new Set();
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/details\/(?:[a-z]+-)?(\d{4})-([a-z0-9]+)-([a-z0-9-]+?)\/(\d+)/i);
    if (!m) continue;
    const listingId = m[4];
    if (seen.has(listingId)) continue;

    const card = a.closest('[class*="vehicle"], [class*="listing"], [class*="card"], li, article') || a.parentElement;
    const text = (card?.textContent || '').replace(/\s+/g, ' ');
    const title = (card?.querySelector('h1,h2,h3,h4,[class*="title"]')?.textContent || '').replace(/\s+/g, ' ').trim();
    const idx = seen.size;
    seen.add(listingId);
    const trim = title.replace(new RegExp(`^\\s*${m[1]}\\s+${m[2]}\\s+`, 'i'), '').replace(new RegExp(m[3].replace(/-/g, '[ -]'), 'i'), '').trim() || null;

    const priceM = text.match(/\$\s?([\d,]{3,})/);
    const mileM = text.match(/([\d,]{3,})\s*(?:mi\b|miles)/i);

    cards.push({
      listingId,
      year: m[1],
      make: m[2].replace(/-/g, ' '),
      model: m[3].replace(/-/g, ' '),
      trim,
      price: (priceM ? priceM[1] : null) || ldPrices[idx] || null,
      mileage: mileM ? mileM[1] : null,
      transmission: (text.match(/Transmission\s+([A-Za-z0-9 -]+?)(?=\s+(?:Drivetrain|Engine|Exterior|Fuel|VIN|$))/i) || [])[1] || null,
      drivetrain: (text.match(/Drivetrain\s+([A-Za-z0-9]+)/i) || [])[1] || null,
      condition: 'used',
      url: href,
      image_url: card?.querySelector('img')?.getAttribute('src') || null,
    });
  }
  return cards;
}

/** Dentro del navegador: extrae VIN/stock/millaje de la ficha (VDP). */
function extractVdpDetails() {
  const text = document.body.innerText.replace(/\s+/g, ' ');
  const vinM = text.match(/VIN[:\s]{1,4}([A-HJ-NPR-Z0-9]{17})/i)
    || document.body.innerHTML.match(/vehicleIdentificationNumber["\s:]+([A-HJ-NPR-Z0-9]{17})/i);
  return {
    vin: vinM ? vinM[1].toUpperCase() : null,
    stock_number: (text.match(/Stock\s*#?[:\s]{1,4}([A-Za-z0-9-]{2,})/i) || [])[1] || null,
    mileage: (text.match(/([\d,]{3,})\s*(?:mi\b|miles)/i) || [])[1] || null,
  };
}
