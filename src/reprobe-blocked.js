import fs from 'node:fs';
import { matchHtml } from './platform-signatures.js';

/**
 * RE-PROBE DE BLOQUEADOS (vía Bright Data Web Unlocker)
 *
 * El detector local (detect-platform.js) no pasa DataDome/Cloudflare-duro, así que esos
 * dealers quedan como "DataDome (anti-bot)"/"INALCANZABLE" sin plataforma real. Aquí los
 * re-pedimos con el Web Unlocker (HTTP que resuelve el anti-bot server-side y devuelve el
 * HTML renderizado), aplicamos las mismas firmas y recuperamos su plataforma (sobre todo
 * CarsForSale.com).
 *
 * Por qué Web Unlocker y no el Scraping Browser: es una request HTTP con timeout DURO — no
 * puede quedarse colgada como una sesión CDP (que fue lo que pasó antes). Y es más barato.
 *
 * Reescribe platform-map.csv INCREMENTALMENTE (cada pocos dealers) para no perder progreso.
 *   node src/reprobe-blocked.js [platform-map.csv]
 */

const BLOCKED = new Set([
  'DataDome (anti-bot)',
  'INALCANZABLE',
  'BLOQUEADA/CAÍDA (revisar c/navegador)',
]);
const INCONCLUSO = new Set(['DataDome (anti-bot)', 'INALCANZABLE']);
const CONCURRENCY = Number.parseInt(process.env.CONC || '6', 10);
const ATTEMPTS = Number.parseInt(process.env.ATTEMPTS || '2', 10);

// cargar .env ANTES de importar config (CONFIG se arma al import desde process.env)
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { fetchViaApi } = await import('./fetch/managed-fetch.js');
const { CONFIG } = await import('./config.js');
if (!CONFIG.managedFetch.enabled) { console.error('Falta SCRAPER_API_KEY (Web Unlocker) en .env'); process.exit(1); }

const mapFile = process.argv[2] || 'platform-map.csv';
const allRows = fs.readFileSync(mapFile, 'utf8').split('\n').filter(Boolean);
const header = allRows.shift();
const records = allRows.map((r) => { const [url, platform, via, cname] = r.split(','); return { url, platform, via, cname }; });

const targets = records.filter((r) => BLOCKED.has(r.platform));
console.log(`Re-probando ${targets.length} bloqueados vía Web Unlocker (conc ${CONCURRENCY}, ${ATTEMPTS} intentos)...\n`);

const silentLog = { warn() {}, info() {} };
async function probe(url) {
  for (let i = 0; i < ATTEMPTS; i++) {
    const html = await fetchViaApi(url, { log: silentLog }); // HTTP con timeout duro
    if (html && html.length > 1500) {
      const hit = matchHtml(html);
      if (hit && !INCONCLUSO.has(hit)) return hit;          // plataforma real
      if (i === ATTEMPTS - 1) return hit || 'DESCONOCIDA (custom)';
    }
  }
  return 'INALCANZABLE';
}

function writeMap() {
  const out = [header, ...records.map((r) => `${r.url},${r.platform},${r.via || ''},${r.cname || ''}`)].join('\n') + '\n';
  fs.writeFileSync(mapFile, out);
}

let done = 0, recovered = 0;
async function runPool(items, concurrency) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const rec = items[i++];
      const before = rec.platform;
      rec.platform = await probe(rec.url);
      rec.via = 'web-unlocker';
      done++;
      if (!INCONCLUSO.has(rec.platform)) recovered++;
      console.log(`  [${done}/${targets.length}] ${rec.url}  ${before} → ${rec.platform}`);
      if (done % 5 === 0) writeMap(); // progreso persistido
    }
  }));
}
await runPool(targets, CONCURRENCY);
writeMap();

const dist = {};
for (const t of targets) dist[t.platform] = (dist[t.platform] || 0) + 1;
console.log(`\n=== RESULTADO DEL RE-PROBE (${recovered}/${targets.length} recuperados) ===`);
for (const [p, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${p}`);
console.log(`\nplatform-map.csv actualizado`);
