import { CONFIG } from '../config.js';
import { httpGet, tryJson, findVehicleArrays, sleep } from '../utils/http.js';
import { normalizeMany } from '../normalizer.js';

/**
 * ESTRATEGIA 1 — API
 * 1) Descarga el HTML inicial para detectar la plataforma del dealer.
 * 2) Prueba endpoints de API conocidos según la plataforma + lista genérica.
 * 3) Si algún endpoint devuelve JSON con arrays que parecen vehículos, los normaliza.
 */
export async function apiStrategy(baseUrl, ctx) {
  const origin = new URL(baseUrl).origin;
  const attempts = [];
  let platform = null;
  let html = '';

  try {
    const res = await httpGet(baseUrl);
    if (res.status >= 400) {
      return fail(`La página base respondió HTTP ${res.status}`, attempts, platform);
    }
    html = res.body;
    platform = detectPlatform(html);
    if (platform) ctx.log.info(`Plataforma detectada: ${platform}`, baseUrl);
  } catch (e) {
    return fail(`No se pudo descargar la página base: ${e.message}`, attempts, platform);
  }

  const endpoints = buildEndpoints(origin, platform, html);

  for (const ep of endpoints) {
    try {
      await sleep(CONFIG.requestDelayMs / 2);
      const res = await httpGet(ep, { asJson: true });
      attempts.push(`${ep} -> HTTP ${res.status}`);
      if (res.status >= 400) continue;

      const json = tryJson(res.body);
      if (!json) continue;

      const arrays = findVehicleArrays(json);
      if (arrays.length === 0) continue;

      const rawVehicles = arrays.flat();
      const vehicles = normalizeMany(rawVehicles, origin);
      if (vehicles.length > 0) {
        return {
          ok: true,
          vehicles: vehicles.slice(0, CONFIG.maxVehiclesPerDealer),
          platform,
          reason: `API encontrada en ${ep} (${vehicles.length} vehículos)`,
          attempts,
        };
      }
    } catch (e) {
      attempts.push(`${ep} -> error: ${e.message}`);
    }
  }

  return fail(
    `Se probaron ${endpoints.length} endpoints de API sin obtener inventario`,
    attempts,
    platform,
    html
  );
}

function fail(reason, attempts, platform, html = '') {
  return { ok: false, vehicles: [], platform, reason, attempts, html };
}

function detectPlatform(html) {
  const h = html.toLowerCase();
  if (h.includes('dealer.com') || h.includes('ddc-')) return 'dealer.com';
  if (h.includes('dealeron')) return 'dealeron';
  if (h.includes('dealerinspire') || h.includes('dealer inspire')) return 'dealerinspire';
  if (h.includes('dealersocket')) return 'dealersocket';
  if (h.includes('carsforsale.com')) return 'carsforsale';
  if (h.includes('wp-content') || h.includes('wp-json')) return 'wordpress';
  if (h.includes('__next_data__')) return 'nextjs';
  if (h.includes('window.__nuxt__')) return 'nuxt';
  if (h.includes('shopify')) return 'shopify';
  return null;
}

function buildEndpoints(origin, platform, html) {
  const eps = [];

  // Endpoints específicos por plataforma primero (mayor probabilidad de éxito)
  if (platform === 'dealer.com') {
    eps.push(`${origin}/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory?start=0&pageSize=100`);
  }
  if (platform === 'wordpress') {
    eps.push(`${origin}/wp-json/wp/v2/inventory?per_page=100`);
    eps.push(`${origin}/wp-json/wp/v2/vehicles?per_page=100`);
  }
  if (platform === 'dealerinspire') {
    eps.push(`${origin}/api/inventory/search?per_page=100`);
  }

  // Endpoints que aparezcan referenciados dentro del propio HTML (fetch/ajax)
  const re = /["'](\/[a-z0-9_\-/.]*(?:inventory|vehicles|inventario|vehiculos)[a-z0-9_\-/.?=&]*)["']/gi;
  const seen = new Set();
  let m;
  while ((m = re.exec(html)) !== null && seen.size < 10) {
    const path = m[1];
    if (path.match(/\.(css|js|png|jpe?g|svg|webp|gif)(\?|$)/)) continue;
    if (!seen.has(path)) {
      seen.add(path);
      eps.push(origin + path);
    }
  }

  // Endpoints genéricos
  for (const p of CONFIG.apiEndpointGuesses) eps.push(origin + p);

  return [...new Set(eps)];
}
