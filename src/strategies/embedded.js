import * as cheerio from 'cheerio';
import { CONFIG } from '../config.js';
import { httpGet, tryJson, findVehicleArrays, sleep } from '../utils/http.js';
import { normalizeMany } from '../normalizer.js';

/**
 * ESTRATEGIA 2 — HTML EMBEBIDO
 * Busca inventario incrustado directamente en el HTML de la página base
 * y de las rutas típicas de inventario:
 *   a) JSON-LD (schema.org Vehicle / Car / Product)
 *   b) Estados iniciales de frameworks: __NEXT_DATA__, __NUXT__, __INITIAL_STATE__, etc.
 *   c) Cualquier <script> con JSON que contenga arrays con pinta de vehículos
 */
export async function embeddedStrategy(baseUrl, ctx, htmlFromBefore = '') {
  const origin = new URL(baseUrl).origin;
  const attempts = [];
  const pagesToTry = [baseUrl, ...CONFIG.inventoryPathGuesses.map((p) => origin + p)];
  const triedPages = new Set();

  // Reaprovecha el HTML descargado por la estrategia API para no repetir la petición
  let pending = htmlFromBefore ? [{ url: baseUrl, html: htmlFromBefore }] : [];

  for (const pageUrl of pagesToTry) {
    if (triedPages.has(pageUrl)) continue;
    triedPages.add(pageUrl);

    let html;
    const cached = pending.find((p) => p.url === pageUrl);
    if (cached) {
      html = cached.html;
    } else {
      try {
        await sleep(CONFIG.requestDelayMs / 2);
        const res = await httpGet(pageUrl);
        if (res.status >= 400) { attempts.push(`${pageUrl} -> HTTP ${res.status}`); continue; }
        html = res.body;
      } catch (e) {
        attempts.push(`${pageUrl} -> error: ${e.message}`);
        continue;
      }
    }

    const result = extractFromHtml(html, origin);
    attempts.push(`${pageUrl} -> ${result.note}`);

    if (result.vehicles.length > 0) {
      // Si la página enlaza más inventario embebido en subpáginas, igual ya tenemos datos
      return {
        ok: true,
        vehicles: result.vehicles.slice(0, CONFIG.maxVehiclesPerDealer),
        reason: `Inventario embebido en ${pageUrl} vía ${result.source} (${result.vehicles.length} vehículos)`,
        attempts,
      };
    }
  }

  return {
    ok: false,
    vehicles: [],
    reason: 'No se encontró inventario embebido (JSON-LD, estado inicial ni JSON inline) en las páginas probadas',
    attempts,
  };
}

export function extractFromHtml(html, origin) {
  const $ = cheerio.load(html);
  const raws = [];
  let source = null;

  // a) JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    const json = tryJson($(el).text());
    if (!json) return;
    const items = Array.isArray(json) ? json : [json];
    for (const item of items) {
      collectLdVehicles(item, raws);
    }
  });
  if (raws.length > 0) source = 'JSON-LD';

  // b) Estados iniciales de frameworks
  if (raws.length === 0) {
    const stateScripts = [];
    const next = $('#__NEXT_DATA__').text();
    if (next) stateScripts.push(next);

    $('script:not([src])').each((_, el) => {
      const t = $(el).text();
      if (/__INITIAL_STATE__|__NUXT__|__PRELOADED_STATE__|window\.inventory|var\s+inventory/i.test(t)) {
        stateScripts.push(t);
      }
    });

    for (const script of stateScripts) {
      const jsons = extractJsonBlobs(script);
      for (const j of jsons) {
        const arrays = findVehicleArrays(j);
        if (arrays.length) { raws.push(...arrays.flat()); source = 'estado inicial del framework'; }
      }
      if (raws.length) break;
    }
  }

  // c) Cualquier script inline con arrays de vehículos
  if (raws.length === 0) {
    $('script:not([src])').each((_, el) => {
      if (raws.length > 0) return;
      const jsons = extractJsonBlobs($(el).text());
      for (const j of jsons) {
        const arrays = findVehicleArrays(j);
        if (arrays.length) { raws.push(...arrays.flat()); source = 'JSON inline'; }
      }
    });
  }

  const vehicles = normalizeMany(raws, origin);
  return {
    vehicles,
    source,
    note: vehicles.length ? `${vehicles.length} vehículos (${source})` : 'sin inventario embebido',
  };
}

function collectLdVehicles(item, out) {
  if (!item || typeof item !== 'object') return;
  // @type puede ser string O array (p.ej. ["Product","Car"] en muchas fichas VDP)
  const types = (Array.isArray(item['@type']) ? item['@type'] : [item['@type']]).map((t) => String(t || '').toLowerCase());
  const vin = item.vehicleIdentificationNumber || item.vin || item.mpn;
  if (types.some((t) => ['vehicle', 'car', 'motorcycle', 'motorizedbicycle'].includes(t))) {
    out.push(ldToRaw(item));
  } else if (types.includes('product') && vin) {
    out.push(ldToRaw(item));
  } else if (types.includes('itemlist') && Array.isArray(item.itemListElement)) {
    for (const el of item.itemListElement) collectLdVehicles(el.item || el, out);
  } else if (Array.isArray(item['@graph'])) {
    for (const g of item['@graph']) collectLdVehicles(g, out);
  }
}

function ldToRaw(ld) {
  const offers = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers || {};
  return {
    vin: ld.vehicleIdentificationNumber || ld.vin || ld.mpn,
    stock_number: ld.sku,
    make: ld.brand?.name || ld.manufacturer?.name || ld.brand,
    model: ld.model?.name || ld.model,
    trim: ld.vehicleConfiguration,
    year: ld.vehicleModelDate || ld.productionDate || ld.modelDate,
    mileage: ld.mileageFromOdometer?.value || ld.mileageFromOdometer,
    price: offers.price,
    exteriorColor: ld.color,
    interiorColor: ld.vehicleInteriorColor,
    transmission: ld.vehicleTransmission,
    fuelType: ld.fuelType,
    engine: ld.vehicleEngine?.name,
    bodyStyle: ld.bodyType,
    doors: ld.numberOfDoors,
    condition: ld.itemCondition || offers.itemCondition,
    url: ld.url || offers.url,
    image: Array.isArray(ld.image) ? ld.image[0] : ld.image,
    description: ld.description,
    location: offers.availableAtOrFrom?.name || offers.seller?.name,
  };
}

/** Extrae bloques {...} o [...] grandes de un script JS y trata de parsearlos. */
function extractJsonBlobs(scriptText, max = 5) {
  const blobs = [];
  if (!scriptText || scriptText.length > 3_000_000) return blobs;

  // El script entero puede ser JSON (caso __NEXT_DATA__)
  const whole = tryJson(scriptText.trim());
  if (whole) return [whole];

  // Buscar asignaciones tipo `= { ... };` o `= [ ... ];`
  const re = /=\s*(\{|\[)/g;
  let m;
  while ((m = re.exec(scriptText)) !== null && blobs.length < max) {
    const start = m.index + m[0].length - 1;
    const blob = sliceBalanced(scriptText, start);
    if (blob && blob.length > 200) {
      const j = tryJson(blob);
      if (j) blobs.push(j);
    }
  }
  return blobs;
}

function sliceBalanced(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length && i - start < 2_000_000; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
