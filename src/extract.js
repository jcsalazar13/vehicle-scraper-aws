import { migrate, upsertDealer, upsertVehicles, ensureRun, recordResult, refreshRun, closePool } from './db.js';
import { initLogger, log } from './logger.js';
import { dwsExtract } from './strategies/platforms/dws.js';
import { dealerSyncExtract } from './strategies/platforms/dealersync.js';
import { dealrExtract } from './strategies/platforms/dealr.js';
import { overfuelExtract } from './strategies/platforms/overfuel.js';
import { dealerInspireExtract } from './strategies/platforms/dealerinspire.js';
import { dealerDotComExtract } from './strategies/platforms/dealerdotcom.js';
import { carsForSaleExtract } from './strategies/platforms/carsforsale.js';

/**
 * Runner genérico de extractores por plataforma.
 *   node src/extract.js <plataforma> <url-dealer>
 * Plataformas: dws (DealerCenter/DealerCarSearch), dealersync
 * Cronometra, normaliza, persiste y reporta cobertura por campo.
 */
const EXTRACTORS = { dws: dwsExtract, dealersync: dealerSyncExtract, dealr: dealrExtract, overfuel: overfuelExtract, dealerinspire: dealerInspireExtract, dealercom: dealerDotComExtract, carsforsale: carsForSaleExtract };

const platform = process.argv[2];
const url = process.argv[3];
const extractor = EXTRACTORS[platform];
if (!extractor || !url) {
  console.error(`Uso: node src/extract.js <${Object.keys(EXTRACTORS).join('|')}> <url-dealer>`);
  process.exit(1);
}

const runId = `${platform}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
initLogger(runId);

const t0 = Date.now();
await migrate();
await ensureRun(runId, 1);
const dealerId = await upsertDealer(url);

const res = await extractor(url, { log });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

let inserted = 0, updated = 0;
if (res.ok) ({ inserted, updated } = await upsertVehicles(dealerId, runId, res.vehicles, platform));

await recordResult({
  run_id: runId, dealer_id: dealerId, url, strategy_used: res.ok ? platform : 'none',
  strategies_tried: JSON.stringify([{ strategy: platform, ok: res.ok, reason: res.reason, attempts: res.attempts }]),
  status: res.ok ? 'ok' : 'failed', vehicles_found: res.vehicles.length,
  vehicles_new: inserted, vehicles_updated: updated, reason: res.reason,
  duration_ms: Date.now() - t0, worker_id: 'extract',
});
await refreshRun(runId);

console.log(`\n=== ${platform} (${elapsed}s) ===`);
console.log(`${res.ok ? 'OK' : 'FALLÓ'} | ${res.vehicles.length} vehículos | ${res.reason}`);

if (res.vehicles.length) {
  const total = res.vehicles.length;
  const pct = (f) => `${Math.round(100 * res.vehicles.filter((v) => v[f] != null).length / total)}%`;
  console.log('\n=== COBERTURA POR CAMPO ===');
  for (const f of ['vin', 'year', 'make', 'model', 'trim', 'mileage', 'price', 'stock_number', 'location', 'url', 'image_url']) {
    console.log(`  ${f.padEnd(14)} ${pct(f)}`);
  }
  console.log('\n=== MUESTRA (3) ===');
  for (const v of res.vehicles.slice(0, 3)) {
    console.log(`  ${v.year} ${v.make} ${v.model} ${v.trim ?? ''} | ${v.mileage ?? '?'} mi | ${v.price ? '$' + v.price : '?'} | VIN ${v.vin} | ${v.location ?? ''}`);
  }
}

log.close();
await closePool();
