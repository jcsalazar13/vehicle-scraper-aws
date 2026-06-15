import fs from 'node:fs';
import dns from 'node:dns/promises';
import { request } from 'undici';

/**
 * Clasifica cada dealer de platform-map.csv en la CAPA de la cascada que lo resolvería:
 *   L0_extractor  plataforma con extractor listo (dws/dealersync/dealr/overfuel/dealerinspire)
 *   L0_pendiente  plataforma conocida sin extractor aún (dealer.com, goxee, motorlot, v12…)
 *   L1_api        endpoint JSON genérico devuelve vehículos
 *   L2_embebido   JSON-LD schema.org / __NEXT_DATA__ / JSON inline con vehículos
 *   L3_navegacion alcanzable pero sin API/embebido por HTTP → necesita navegador (puede acabar en IA)
 *   antibot       Cloudflare/DataDome (HTTP bloqueado) → necesita fetch gestionado
 *   descartado    DNS muerto / error de conexión / parqueado (sin web)
 *   recuperable   inalcanzable por timeout (lento) → reintentar
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const READY = new Set(['DealerCenter', 'DealerCarSearch', 'DealerSync', 'Dealr.cloud', 'OverFuel', 'DealerInspire']);
const KNOWN_PENDING = new Set(['Dealer.com', 'GoxeeDealer', 'MotorLot', 'V12Software', 'Frazer', 'DealerOn', 'DealerGo', 'ShopClubs', 'CarsForSale.com', 'AutoManager', 'AutoRevo', 'DealerFire', 'AutoCorner']);
const CHALLENGE = [/just a moment/i, /captcha-delivery/i, /datadome/i, /checking your browser/i, /attention required/i, /enable javascript and cookies/i, /access denied/i];

const rows = fs.readFileSync('platform-map.csv', 'utf8').split('\n').slice(1).filter(Boolean)
  .map((l) => { const [url, platform] = l.split(','); return { url, platform }; });

function hasEmbeddedVehicles(html) {
  // a) JSON-LD schema.org
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const o = JSON.parse(m[1].trim());
      const items = Array.isArray(o) ? o : [o, ...(o['@graph'] || [])];
      if (items.some((it) => /vehicle|car|product/i.test(String(it?.['@type'] || '')) && (it.vehicleIdentificationNumber || it.vin || it.model || it.brand))) return true;
    } catch { /* json-ld inválido */ }
  }
  // b) estado de framework con pinta de inventario
  if (/__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|__PRELOADED_STATE__/.test(html) && /"vin"|vehicleIdentificationNumber|"inventory"/i.test(html)) return true;
  // c) JSON inline con varios VIN
  if ((html.match(/"vin"\s*:/gi) || []).length >= 3) return true;
  return false;
}

async function tryApi(origin) {
  for (const path of ['/inventory.json', '/api/inventory', '/api/vehicles', '/feed/inventory.json']) {
    try {
      const res = await request(origin + path, { headers: { 'user-agent': UA, accept: 'application/json' }, headersTimeout: 7000, bodyTimeout: 7000, maxRedirections: 3 });
      if (res.statusCode >= 400) { await res.body.dump?.(); continue; }
      const t = (await res.body.text()).slice(0, 200000);
      if (/^\s*[[{]/.test(t) && (t.match(/"vin"\s*:/gi) || []).length >= 2) return true;
    } catch { /* siguiente */ }
  }
  return false;
}

async function probeCascade(url) {
  const host = new URL(url).hostname;
  try { await dns.lookup(host); } catch { return 'descartado'; }
  let html = '', status = 0;
  try {
    const res = await request(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, headersTimeout: 9000, bodyTimeout: 9000, maxRedirections: 5 });
    status = res.statusCode;
    html = (await res.body.text()).slice(0, 250000);
  } catch (e) { return /timeout/i.test(e.message || e.code || '') ? 'recuperable' : 'descartado'; }

  if (status === 403 || status === 429 || status === 503 || CHALLENGE.some((re) => re.test(html))) return 'antibot';
  if (/hugedomains|domain.*for sale|buy this domain|parked/i.test(html)) return 'descartado';
  if (hasEmbeddedVehicles(html)) return 'L2_embebido';
  if (await tryApi(new URL(url).origin)) return 'L1_api';
  return 'L3_navegacion';
}

async function classify(row) {
  if (READY.has(row.platform)) return 'L0_extractor';
  if (KNOWN_PENDING.has(row.platform)) return 'L0_pendiente';
  if (row.platform === 'PARQUEADO (en venta)') return 'descartado';
  if (row.platform === 'INALCANZABLE') {
    try { await dns.lookup(new URL(row.url).hostname); } catch { return 'descartado'; }
    try { const r = await request(row.url, { headers: { 'user-agent': UA }, headersTimeout: 9000, bodyTimeout: 9000, maxRedirections: 5 }); await r.body.dump?.(); return r.statusCode >= 400 ? 'antibot' : 'recuperable'; }
    catch (e) { return /timeout/i.test(e.message || e.code || '') ? 'recuperable' : 'descartado'; }
  }
  return probeCascade(row.url);
}

const out = [];
let i = 0;
await Promise.all(Array.from({ length: 14 }, async () => {
  while (i < rows.length) {
    const row = rows[i++];
    const layer = await classify(row);
    out.push({ ...row, layer });
  }
}));

const dist = {};
for (const r of out) dist[r.layer] = (dist[r.layer] || 0) + 1;
const order = ['L0_extractor', 'L0_pendiente', 'L1_api', 'L2_embebido', 'L3_navegacion', 'antibot', 'recuperable', 'descartado'];
console.log('=== DEALERS POR CAPA DE LA CASCADA (total ' + out.length + ') ===');
for (const k of order) if (dist[k]) console.log(String(dist[k]).padStart(4), k, `(${Math.round(100 * dist[k] / out.length)}%)`);
for (const k of Object.keys(dist)) if (!order.includes(k)) console.log(String(dist[k]).padStart(4), k);

fs.writeFileSync('cascade-map.csv', 'url,platform,layer\n' + out.map((r) => `${r.url},${r.platform},${r.layer}`).join('\n') + '\n');
console.log('\nDetalle por dealer → cascade-map.csv');
