import { chromium } from 'playwright';
import { CONFIG } from '../config.js';
import { normalizeMany } from '../normalizer.js';
import { fetchViaApi, launchBrowser, newScrapePage } from '../fetch/managed-fetch.js';
import { findVehicleArrays } from '../utils/http.js';

/**
 * ESTRATEGIA "UNLOCKED" — último recurso para genéricos bloqueados por anti-bot.
 * Dos tiers, de barato a caro, con guard de costo:
 *
 *   TIER A (Web Unlocker, $1.5/1000): trae el HTML server-rendered y extrae con DOM-cards
 *     + VIN-anclado. Resuelve los sitios cuyo inventario está en el HTML.
 *
 *   TIER B (Scraping Browser, $8/GB): SOLO si el HTML del Tier A parece SPA (templates
 *     `{{}}`, módulos JS, muchos links de detalle pero sin tarjetas) → carga la página en
 *     un navegador remoto real que EJECUTA EL JS, descubre el link de inventario, pagina,
 *     intercepta el API JSON si lo hay, y extrae el DOM ya renderizado. Recupera los SPA
 *     que el Web Unlocker no puede. El guard evita gastar Scraping Browser en sitios muertos.
 *
 * Corre en la cascada tras `navigate` y antes de IA. Contrato { ok, vehicles, reason, attempts }.
 */

const VIN_G = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const INV_RE = /inventory|used-vehicles|used-cars|pre-owned|vehicles-for-sale|cars-for-sale|\/srp|\/vehicles/i;

const vkey = (v) => {
  const vin = v.vin && /\d/.test(v.vin) && /[A-HJ-NPR-Z]/i.test(v.vin) ? v.vin : null;
  return vin || (v.year && v.make ? `${v.year}|${v.make}|${v.model}|${v.url}` : null);
};

export async function unlockedStrategy(url, ctx) {
  const log = ctx?.log;
  const attempts = [];
  if (!CONFIG.managedFetch.enabled && !CONFIG.scrapingBrowser.enabled) {
    return { ok: false, vehicles: [], reason: 'unlocked: sin Web Unlocker ni Scraping Browser → omitido', attempts };
  }
  const origin = new URL(url).origin;

  // TIER A — Web Unlocker (barato)
  let spaLikely = false;
  if (CONFIG.managedFetch.enabled) {
    const a = await tierWebUnlocker(url, origin, attempts, log);
    if (a.raw.length) {
      const vehicles = normalizeMany(a.raw, origin);
      if (vehicles.length) return { ok: true, vehicles, reason: `unlocked/web-unlocker: ${vehicles.length} vehículos`, attempts };
    }
    spaLikely = a.spaLikely;
  }

  // TIER B — Scraping Browser (caro) solo si parece SPA real
  if (!spaLikely || !CONFIG.scrapingBrowser.enabled) {
    const why = spaLikely ? 'SPA pero sin Scraping Browser' : 'sin inventario en HTML (no parece SPA)';
    return { ok: false, vehicles: [], reason: `unlocked: ${why}`, attempts };
  }
  const b = await tierRemoteRender(url, origin, attempts, log);
  const vehicles = normalizeMany(b.raw, origin);
  return {
    ok: vehicles.length > 0,
    vehicles,
    reason: vehicles.length ? `unlocked/render: ${vehicles.length} vehículos (Scraping Browser)` : 'unlocked: SPA renderizado sin tarjetas parseables',
    attempts,
  };
}

/** TIER A: Web Unlocker sobre varias rutas, fusiona. Detecta si el sitio parece SPA. */
async function tierWebUnlocker(url, origin, attempts, log) {
  const paths = ['/inventory', '/used-inventory', '/used-cars'];
  const candidates = [...new Set([url, ...paths.map((p) => origin + p)])].slice(0, 4);
  const fetched = await Promise.all(candidates.map((u) =>
    fetchViaApi(u, { log, timeoutMs: 35_000 }).then((h) => ({ u, h })).catch(() => ({ u, h: '' }))));

  const byKey = new Map();
  let spaLikely = false;
  let browser;
  try {
    for (const { u, h: html } of fetched) {
      if (!html || html.length < 2000) { attempts.push(`A ${u} → ${html?.length || 0}b (vacío)`); continue; }
      // ¿señales de SPA? templates, módulos JS, o muchos links de detalle sin tarjetas
      if (/\{\{|ng-repeat|v-for|__NUXT__|__NEXT_DATA__|vehicleDetailUrl|\/_content\/|data-react/i.test(html)
        || (html.match(/\/(details|vehicle|inventory|vdp)\//gi) || []).length >= 6) spaLikely = true;
      if (!browser) browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'commit' }).catch(() => {});
      const raw = await page.evaluate(extractInPage).catch(() => []);
      await page.close().catch(() => {});
      let nuevos = 0;
      for (const v of raw) { const k = vkey(v); if (k && !byKey.has(k)) { byKey.set(k, v); nuevos++; } }
      attempts.push(`A ${u} → ${html.length}b, ${raw.length} tarjetas (${nuevos} nuevas)`);
    }
  } finally { await browser?.close().catch(() => {}); }
  return { raw: [...byKey.values()], spaLikely };
}

/** TIER B: navegador remoto que ejecuta JS. Descubre inventario, pagina, intercepta API + DOM. */
async function tierRemoteRender(url, origin, attempts, log) {
  const byKey = new Map();
  const addRaw = (v) => { const k = vkey(v); if (k && !byKey.has(k)) byKey.set(k, v); };
  let browser;
  try {
    browser = await launchBrowser(true);
    const page = await newScrapePage(browser, true);
    // Interceptar respuestas JSON con arrays de vehículos (algunos SPA sí usan API)
    page.on('response', async (r) => {
      if (!/json/i.test(r.headers()['content-type'] || '')) return;
      try { const j = JSON.parse(await r.text()); for (const arr of findVehicleArrays(j)) for (const v of arr) addRaw(v); } catch { /* no-json */ }
    });

    // Home → descubrir el mejor link de inventario
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs }).catch((e) => log?.warn?.(`[render] home: ${e.message}`));
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const invUrl = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      let best = null, bs = 0;
      for (const a of document.querySelectorAll('a[href]')) {
        const h = a.href || ''; const t = (a.textContent || '').toLowerCase(); let s = 0;
        if (re.test(h)) s += 2;
        if (/invent|used|pre-owned|vehicle|cars/.test(t)) s += 1;
        if (s > bs && h.startsWith('http')) { bs = s; best = h; }
      }
      return best;
    }, INV_RE.source).catch(() => null);

    const bases = [...new Set([invUrl, `${origin}/inventory`, `${origin}/used-vehicles`, `${origin}/used-inventory`].filter(Boolean))];
    for (const base of bases) {
      let aporto = false;
      for (let pg = 1; pg <= Math.min(CONFIG.maxPagesPerDealer, 8); pg++) {
        const u = pg === 1 ? base : `${base}${base.includes('?') ? '&' : '?'}page=${pg}`;
        const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs }).catch(() => null);
        if ((resp?.status() ?? 404) >= 400) break;
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 4000); await page.waitForTimeout(600); }
        const before = byKey.size;
        for (const v of await page.evaluate(extractInPage).catch(() => [])) addRaw(v);
        attempts.push(`B ${u} → ${byKey.size - before} nuevos (acum ${byKey.size})`);
        if (byKey.size > before) aporto = true;
        if (byKey.size === before && pg > 1) break; // página sin nuevos → fin de paginación
      }
      if (aporto) break; // este listado sirvió, no probar más rutas
    }
    return { raw: [...byKey.values()] };
  } catch (e) {
    attempts.push(`B error: ${e.message}`);
    return { raw: [...byKey.values()] };
  } finally { await browser?.close().catch(() => {}); }
}

/** Dentro del navegador: DOM-cards + VIN-anclado, fusionados por VIN. */
function extractInPage() {
  const vinRe = /\b[A-HJ-NPR-Z0-9]{17}\b/;
  const yearMakeRe = /\b(19[5-9]\d|20[0-4]\d)\s+([A-Z][A-Za-z-]+)\s+([A-Za-z0-9-]+)/;
  const priceRe = /\$\s?([\d,]{4,})/;
  const milesRe = /([\d,]{1,7})\s*(?:miles|mi\.?|km|kil[oó]metros)/i;
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
    condition: 'used',
  });

  for (const el of document.querySelectorAll(
    '[class*="vehicle" i], [class*="inventory" i], [class*="srp" i], [class*="listing" i], ' +
    '[class*="card" i], [class*="result" i], [class*="item" i], [data-vin], [data-vehicle], article, li, tr')) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 20 || text.length > 3000) continue;
    const vin = el.getAttribute('data-vin') || (text.match(vinRe) || [])[0] || null;
    if (!vin && !yearMakeRe.test(text)) continue;
    const f = fields(text, vin);
    f.url = el.querySelector('a[href]')?.href || null;
    f.image_url = el.querySelector('img')?.src || el.querySelector('img')?.getAttribute('data-src') || null;
    add(f);
  }

  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const m = (node.nodeValue || '').match(vinRe);
    if (!m || !isVin(m[0]) || byKey.has(m[0])) continue;
    let card = node.parentElement;
    for (let i = 0; i < 6 && card?.parentElement; i++) { if (yearMakeRe.test(card.textContent || '')) break; card = card.parentElement; }
    const f = fields((card?.textContent || '').replace(/\s+/g, ' '), m[0]);
    f.url = card?.querySelector('a[href]')?.href || null;
    f.image_url = card?.querySelector('img')?.src || null;
    add(f);
  }

  return [...byKey.values()].slice(0, 1000);
}
