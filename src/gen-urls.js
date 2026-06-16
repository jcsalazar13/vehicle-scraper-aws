import fs from 'node:fs';

/**
 * GENERADOR urls.txt  ←  platform-map.csv
 *
 * Convierte el mapa de detección (url,platform,via,cname) en el archivo que consume el
 * dispatcher: `url[,platform]`. Solo se etiquetan las plataformas que tienen extractor
 * específico (más rápido); el resto va sin tag y cae a la cascada genérica.
 *
 *   node src/gen-urls.js [platform-map.csv] [urls.txt]
 */

// Etiquetas que el worker enruta a un extractor (deben coincidir con registry.js).
// Mapea la etiqueta del detector → la etiqueta de routing.
const EXTRACTOR_TAG = {
  'DealerCenter': 'DealerCenter',
  'DealerCarSearch': 'DealerCarSearch',
  'DealerSync': 'DealerSync',
  'Dealr.cloud': 'Dealr.cloud',
  'OverFuel': 'OverFuel',
  'DealerInspire': 'DealerInspire',
  'Dealer.com': 'Dealer.com',
  'CarsForSale.com': 'CarsForSale.com',
};

const mapFile = process.argv[2] || 'platform-map.csv';
const outFile = process.argv[3] || 'urls.txt';

const rows = fs.readFileSync(mapFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const header = rows.shift(); // descarta encabezado url,platform,via,cname
if (!/^url,platform/i.test(header)) rows.unshift(header); // no había encabezado: reincorpora

const seen = new Set();
const lines = [];
const dist = {};
let tagged = 0;

for (const row of rows) {
  const [url, platform] = row.split(',');
  if (!url || seen.has(url)) continue;
  seen.add(url);
  const tag = EXTRACTOR_TAG[platform] || null;
  lines.push(tag ? `${url},${tag}` : url);
  if (tag) tagged++;
  const k = tag || 'genérico';
  dist[k] = (dist[k] || 0) + 1;
}

const out = ['# url[,platform] — generado por src/gen-urls.js desde ' + mapFile, ...lines].join('\n') + '\n';
fs.writeFileSync(outFile, out);

console.log(`${outFile}: ${lines.length} dealers (${tagged} con extractor, ${lines.length - tagged} genéricos)\n`);
console.log('=== DISTRIBUCIÓN ===');
for (const [p, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${p}`);
}
