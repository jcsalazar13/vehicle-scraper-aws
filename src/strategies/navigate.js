import { chromium } from 'playwright';
import { CONFIG } from '../config.js';
import { tryJson, findVehicleArrays } from '../utils/http.js';
import { normalizeMany } from '../normalizer.js';
import { extractFromHtml } from './embedded.js';

/**
 * ESTRATEGIA 3 — NAVEGACIÓN (browser real)
 * 1) Abre la página con Chromium headless e intercepta TODAS las respuestas XHR/fetch:
 *    si alguna devuelve JSON con vehículos, se queda con eso (es la fuente más limpia).
 * 2) Localiza el enlace de "inventario" y navega hacia él; hace scroll para forzar lazy-load.
 * 3) Si no hubo XHR útil, extrae tarjetas del DOM con heurísticas + reintenta extracción embebida
 *    sobre el HTML ya renderizado.
 * 4) Pagina (botón "next" / rel=next) hasta CONFIG.maxPagesPerDealer.
 *
 * Devuelve también el HTML renderizado para que la estrategia IA lo aproveche.
 */
export async function navigateStrategy(baseUrl, ctx) {
  const attempts = [];
  const origin = new URL(baseUrl).origin;
  const xhrRaws = [];
  let renderedHtml = '';
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    return {
      ok: false, vehicles: [], renderedHtml: '',
      reason: `No se pudo iniciar el navegador (¿falta "npx playwright install chromium"?): ${e.message}`,
      attempts,
    };
  }

  try {
    const context = await browser.newContext({ userAgent: CONFIG.userAgent, viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();

    // Interceptar respuestas JSON: muchas SPAs cargan el inventario por XHR
    page.on('response', async (res) => {
      try {
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const url = res.url();
        if (/\.(png|jpe?g|svg|woff)/.test(url)) return;
        const text = await res.text();
        if (text.length < 100 || text.length > 5_000_000) return;
        const json = tryJson(text);
        if (!json) return;
        const arrays = findVehicleArrays(json);
        if (arrays.length) {
          xhrRaws.push(...arrays.flat());
          ctx.log.info(`XHR con vehículos interceptado: ${url.slice(0, 120)}`);
        }
      } catch { /* respuestas que ya se cerraron */ }
    });

    await page.goto(baseUrl, { timeout: CONFIG.navTimeoutMs, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    attempts.push(`Página base cargada: ${baseUrl}`);

    // Buscar enlace al inventario si no estamos ya en él
    const invLink = await findInventoryLink(page, origin);
    if (invLink && invLink !== page.url()) {
      try {
        await page.goto(invLink, { timeout: CONFIG.navTimeoutMs, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        attempts.push(`Navegado a inventario: ${invLink}`);
      } catch (e) {
        attempts.push(`Fallo navegando a ${invLink}: ${e.message}`);
      }
    } else if (!invLink) {
      attempts.push('No se encontró enlace explícito a inventario; se usa la página actual');
    }

    let pageCount = 0;
    const domRaws = [];

    while (pageCount < CONFIG.maxPagesPerDealer) {
      pageCount++;
      await autoScroll(page);
      await page.waitForTimeout(1200);

      renderedHtml = await page.content();

      // Si los XHR ya trajeron suficiente, no hace falta seguir paginando
      if (xhrRaws.length >= CONFIG.maxVehiclesPerDealer) break;

      // Extraer tarjetas del DOM como respaldo
      const cards = await extractDomCards(page);
      if (cards.length) {
        domRaws.push(...cards);
        attempts.push(`Página ${pageCount}: ${cards.length} tarjetas en el DOM`);
      }

      const advanced = await goNextPage(page);
      if (!advanced) break;
      await page.waitForTimeout(1800);
    }

    // Prioridad: XHR > embebido en HTML renderizado > tarjetas del DOM
    let vehicles = normalizeMany(xhrRaws, origin);
    let source = 'XHR interceptado';

    if (vehicles.length === 0 && renderedHtml) {
      const emb = extractFromHtml(renderedHtml, origin);
      if (emb.vehicles.length) { vehicles = emb.vehicles; source = `HTML renderizado (${emb.source})`; }
    }
    if (vehicles.length === 0 && domRaws.length) {
      vehicles = normalizeMany(domRaws, origin);
      source = 'tarjetas del DOM';
    }

    if (vehicles.length > 0) {
      return {
        ok: true,
        vehicles: vehicles.slice(0, CONFIG.maxVehiclesPerDealer),
        renderedHtml,
        reason: `Navegación exitosa vía ${source} (${vehicles.length} vehículos en ${pageCount} página(s))`,
        attempts,
      };
    }

    return {
      ok: false, vehicles: [], renderedHtml,
      reason: 'La navegación cargó la página pero no se identificaron vehículos (ni XHR, ni embebido, ni tarjetas DOM)',
      attempts,
    };
  } catch (e) {
    return { ok: false, vehicles: [], renderedHtml, reason: `Error de navegación: ${e.message}`, attempts };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function findInventoryLink(page, origin) {
  const words = ['inventory', 'inventario', 'used', 'usados', 'vehicles', 'vehiculos', 'vehículos', 'cars for sale', 'autos'];
  const links = await page.$$eval('a[href]', (as) =>
    as.map((a) => ({ href: a.href, text: (a.textContent || '').trim().toLowerCase() }))
  );
  let best = null;
  let bestScore = 0;
  for (const l of links) {
    if (!l.href.startsWith(origin)) continue;
    let score = 0;
    for (const w of words) {
      if (l.text.includes(w)) score += 2;
      if (l.href.toLowerCase().includes(w.replace(/\s/g, '-'))) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = l.href; }
  }
  return bestScore >= 2 ? best : null;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 600;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight || total > 25_000) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  }).catch(() => {});
}

async function goNextPage(page) {
  const selectors = [
    'a[rel="next"]', 'link[rel="next"]',
    'a[aria-label*="next" i]', 'button[aria-label*="next" i]',
    'a.next, button.next, .pagination-next a, li.next a',
    'a:has-text("Next")', 'a:has-text("Siguiente")', 'button:has-text("Next")',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() && await el.isVisible()) {
        const disabled = await el.getAttribute('disabled').catch(() => null);
        const cls = (await el.getAttribute('class').catch(() => '')) || '';
        if (disabled !== null || cls.includes('disabled')) continue;
        await el.click({ timeout: 5000 });
        return true;
      }
    } catch { /* probar el siguiente selector */ }
  }
  return false;
}

/** Heurística: detecta tarjetas de vehículo en el DOM renderizado. */
async function extractDomCards(page) {
  return page.evaluate(() => {
    const out = [];
    const candidates = document.querySelectorAll(
      '[class*="vehicle" i], [class*="inventory" i], [class*="srp-" i], [class*="listing" i], ' +
      '[data-vin], [data-vehicle], article, li[class*="result" i]'
    );
    const vinRe = /\b[A-HJ-NPR-Z0-9]{17}\b/;
    const yearMakeRe = /\b(19[5-9]\d|20[0-4]\d)\s+([A-Z][A-Za-z-]+)\s+([A-Za-z0-9-]+)/;
    const priceRe = /\$\s?([\d,]{4,})/;
    const milesRe = /([\d,]{1,7})\s*(?:miles|mi\.?|km|kil[oó]metros)/i;
    const seen = new Set();

    for (const el of candidates) {
      if (el.querySelector('[class*="vehicle" i] [class*="vehicle" i]')) continue; // evitar contenedores padre
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 20 || text.length > 3000) continue;

      const vin = el.getAttribute('data-vin') || (text.match(vinRe) || [])[0] || null;
      const ym = text.match(yearMakeRe);
      if (!vin && !ym) continue;

      const link = el.querySelector('a[href]');
      const img = el.querySelector('img');
      const item = {
        vin,
        year: ym ? ym[1] : null,
        make: ym ? ym[2] : null,
        model: ym ? ym[3] : null,
        price: (text.match(priceRe) || [])[1] || null,
        mileage: (text.match(milesRe) || [])[1] || null,
        url: link ? link.href : null,
        image: img ? (img.src || img.getAttribute('data-src')) : null,
      };
      const key = item.vin || `${item.year}|${item.make}|${item.model}|${item.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= 500) break;
    }
    return out;
  }).catch(() => []);
}
