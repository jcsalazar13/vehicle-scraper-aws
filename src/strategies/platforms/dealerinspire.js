import { chromium } from 'playwright';
import { CONFIG } from '../../config.js';
import { normalizeMany } from '../../normalizer.js';

/**
 * EXTRACTOR DE PLATAFORMA — DealerInspire (Cars Commerce)
 *
 * El inventario se sirve por una API JSON muy rica:
 *   https://websites-search.api.carscommerce.inc/api/v1/listings/<ccid>/search
 * con vin, stock, year, make, model, trim, MILLAJE, pricing, vdp_url, etc.
 * La API exige auth de la sesión (fetch directo → 401), así que cargamos la
 * página de inventario con navegador, interceptamos sus respuestas mientras
 * recorremos la paginación (?page=N) y acumulamos los listados (dedupe por VIN).
 *
 * Contrato estándar { ok, vehicles, reason, attempts }.
 */
export async function dealerInspireExtract(baseUrl, ctx) {
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

    const byVin = new Map();
    let total = 0;
    page.on('response', async (r) => {
      if (!/carscommerce.*\/listings\/\d+\/search/i.test(r.url())) return;
      try {
        const j = JSON.parse(await r.text());
        total = j.data?.total_vehicle_count || total;
        for (const v of j.data?.listings || []) if (v.vin) byVin.set(v.vin, v);
      } catch { /* respuesta no-JSON */ }
    });

    // Cargar inventario (la API es un POST; paginamos con el botón "Next" que la re-dispara)
    await page.goto(origin + '/used-inventory/index.htm', { waitUntil: 'commit', timeout: CONFIG.navTimeoutMs }).catch(() => {});
    await page.waitForTimeout(4500);

    for (let pageNum = 1; pageNum <= CONFIG.maxPagesPerDealer; pageNum++) {
      const before = byVin.size;
      attempts.push(`page=${pageNum}: acumulado ${byVin.size}/${total}`);
      if (total && byVin.size >= total) break;                     // ya tenemos todo

      // Buscar y clicar "Next" (a.go-to-page con texto Next)
      const next = page.locator('a.go-to-page', { hasText: /next/i }).first();
      if (await next.count() === 0) break;
      await next.click().catch(() => {});
      await page.waitForTimeout(3500);
      for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 5000); await page.waitForTimeout(500); }
      if (byVin.size === before) break;                            // no entró nada nuevo
    }

    if (byVin.size === 0) {
      return { ok: false, vehicles: [], reason: 'DealerInspire: no se interceptaron listados de la API Cars Commerce', attempts };
    }

    // Aplanar los campos que necesitamos antes de normalizar (la API anida pricing/mechanical/body)
    const nz = (n) => (n && n > 0 ? n : null);
    const raw = [...byVin.values()].map((v) => ({
      vin: v.vin, stock_number: v.stock, year: v.year, make: v.make, model: v.model, trim: v.trim,
      mileage: v.mileage, condition: v.type,
      price: nz(v.pricing?.our_price) ?? nz(v.pricing?.price) ?? nz(v.pricing?.msrp) ?? null,
      msrp: nz(v.pricing?.msrp),
      body_style: v.body_details?.type ?? null,
      doors: v.body_details?.number_of_doors ?? null,
      drivetrain: v.mechanical?.drivetrain ?? null,
      transmission: v.mechanical?.transmission ?? null,
      fuel_type: v.mechanical?.fuel_type ?? null,
      engine: v.mechanical?.engine ?? null,
      url: v.vdp_url || null,
      image_url: v.media?.images?.[0] ?? null,
    }));

    const vehicles = normalizeMany(raw, origin);
    return { ok: vehicles.length > 0, vehicles, reason: `DealerInspire: ${vehicles.length} vehículos (API Cars Commerce, total ${total})`, attempts };
  } catch (e) {
    return { ok: false, vehicles: [], reason: `DealerInspire: error de extracción: ${e.message}`, attempts };
  } finally {
    await browser.close().catch(() => {});
  }
}
