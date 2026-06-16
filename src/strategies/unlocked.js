import { chromium } from 'playwright';
import { CONFIG } from '../config.js';
import { normalizeMany } from '../normalizer.js';
import { fetchViaApi } from '../fetch/managed-fetch.js';

/**
 * ESTRATEGIA "UNLOCKED" — último recurso para genéricos bloqueados por anti-bot.
 *
 * Muchos dealers sin plataforma conocida devuelven HTTP 403 al request plano pero su
 * inventario está SERVER-RENDERED en el HTML (con VINs). El Web Unlocker de Bright Data
 * pasa el anti-bot y devuelve ese HTML (barato: $1.5/1000 req). Aquí lo traemos, lo
 * cargamos en un navegador local con setContent y extraemos con DOS heurísticas que se
 * complementan y se fusionan por VIN:
 *   1) Tarjetas del DOM (contenedores con clase vehicle/inventory/listing).
 *   2) VIN-anclado: cada VIN suelto en el texto → sube al contenedor por año/make/precio.
 *      (recupera sitios cuyo markup no tiene estructura de "tarjeta" reconocible).
 *
 * Se ejecuta solo cuando api/embebido/navegación ya fallaron, así que el costo de Web
 * Unlocker recae únicamente en los dealers que de otro modo se perderían.
 *
 * Contrato estándar { ok, vehicles, reason, attempts }.
 */
export async function unlockedStrategy(url, ctx) {
  const log = ctx?.log;
  const attempts = [];
  if (!CONFIG.managedFetch.enabled) {
    return { ok: false, vehicles: [], reason: 'unlocked: sin Web Unlocker (SCRAPER_API_KEY) → omitido', attempts };
  }

  const origin = new URL(url).origin;
  // Home primero (muchos dealers chicos listan ahí) + rutas de inventario. Extraemos de
  // CADA candidato y FUSIONAMOS por VIN/clave: la página que tenga tarjetas parseables
  // aporta, sin que una elección equivocada de "mejor página" pierda el inventario.
  const paths = ['/inventory', '/used-inventory', '/used-cars'];
  const candidates = [];
  const seenU = new Set();
  for (const u of [url, ...paths.map((p) => origin + p)]) { if (!seenU.has(u)) { seenU.add(u); candidates.push(u); } }

  let browser;
  try {
    // Traer los candidatos EN PARALELO (Bright Data admite concurrencia) → ~35s en vez de
    // hasta 140s secuencial. Luego extraer de cada HTML y fusionar.
    const fetched = await Promise.all(candidates.slice(0, 4).map((u) =>
      fetchViaApi(u, { log, timeoutMs: 35_000 }).then((h) => ({ u, h })).catch(() => ({ u, h: '' }))));

    const byKey = new Map();
    for (const { u, h: html } of fetched) {
      if (!html || html.length < 2000) { attempts.push(`${u} → ${html?.length || 0}b (vacío/bloqueado)`); continue; }
      if (!browser) browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'commit' }).catch(() => {});
      const raw = await page.evaluate(extractInPage).catch(() => []);
      await page.close().catch(() => {});
      let nuevos = 0;
      for (const v of raw) {
        const key = v.vin || (v.year && v.make ? `${v.year}|${v.make}|${v.model}|${v.url}` : null);
        if (key && !byKey.has(key)) { byKey.set(key, v); nuevos++; }
      }
      attempts.push(`${u} → ${html.length}b, ${raw.length} tarjetas (${nuevos} nuevas)`);
    }

    if (byKey.size === 0) {
      return { ok: false, vehicles: [], reason: 'unlocked: Web Unlocker pasó el bloqueo pero no se hallaron tarjetas parseables', attempts };
    }
    const vehicles = normalizeMany([...byKey.values()], origin);
    return {
      ok: vehicles.length > 0,
      vehicles,
      reason: `unlocked: ${vehicles.length} vehículos vía Web Unlocker (${candidates.length} rutas)`,
      attempts,
    };
  } catch (e) {
    return { ok: false, vehicles: [], reason: `unlocked: error de extracción: ${e.message}`, attempts };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Dentro del navegador: DOM-cards + VIN-anclado, fusionados por VIN. */
function extractInPage() {
  const vinRe = /\b[A-HJ-NPR-Z0-9]{17}\b/;
  const yearMakeRe = /\b(19[5-9]\d|20[0-4]\d)\s+([A-Z][A-Za-z-]+)\s+([A-Za-z0-9-]+)/;
  const priceRe = /\$\s?([\d,]{4,})/;
  const milesRe = /([\d,]{1,7})\s*(?:miles|mi\.?|km|kil[oó]metros)/i;
  // VIN real: tiene dígitos y letras (sin I/O/Q), no es 7+ chars repetidos (hashes/ids)
  const isVin = (v) => /\d/.test(v) && /[A-HJ-NPR-Z]/.test(v) && !/(.)\1{6}/.test(v);

  const byKey = new Map();
  const add = (it) => {
    if (it.vin && !isVin(it.vin)) it.vin = null;
    const key = it.vin || (it.year && it.make ? `${it.year}|${it.make}|${it.model}|${it.url}` : null);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, it);
    else { const p = byKey.get(key); for (const f in it) if (p[f] == null && it[f] != null) p[f] = it[f]; }
  };
  const fields = (text, vin) => ({
    vin,
    year: (text.match(yearMakeRe) || [])[1] || null,
    make: (text.match(yearMakeRe) || [])[2] || null,
    model: (text.match(yearMakeRe) || [])[3] || null,
    price: (text.match(priceRe) || [])[1] || null,
    mileage: (text.match(milesRe) || [])[1] || null,
  });

  // 1) Tarjetas del DOM
  const cands = document.querySelectorAll(
    '[class*="vehicle" i], [class*="inventory" i], [class*="srp" i], [class*="listing" i], ' +
    '[class*="card" i], [class*="result" i], [class*="item" i], ' +
    '[data-vin], [data-vehicle], article, li, tr'
  );
  for (const el of cands) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 20 || text.length > 3000) continue;
    const vin = el.getAttribute('data-vin') || (text.match(vinRe) || [])[0] || null;
    if (!vin && !yearMakeRe.test(text)) continue;
    const f = fields(text, vin);
    f.url = el.querySelector('a[href]')?.href || null;
    f.image_url = el.querySelector('img')?.src || el.querySelector('img')?.getAttribute('data-src') || null;
    f.condition = 'used';
    add(f);
  }

  // 2) VIN-anclado: cada VIN suelto en el texto → contenedor con año
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const m = (node.nodeValue || '').match(vinRe);
    if (!m || !isVin(m[0])) continue;
    const vin = m[0];
    if (byKey.has(vin)) continue;
    let card = node.parentElement;
    for (let i = 0; i < 6 && card?.parentElement; i++) { if (yearMakeRe.test(card.textContent || '')) break; card = card.parentElement; }
    const text = (card?.textContent || '').replace(/\s+/g, ' ');
    const f = fields(text, vin);
    f.url = card?.querySelector('a[href]')?.href || null;
    f.image_url = card?.querySelector('img')?.src || null;
    f.condition = 'used';
    add(f);
  }

  return [...byKey.values()].slice(0, 1000);
}
