import fs from 'node:fs';
import dns from 'node:dns/promises';
import { request } from 'undici';
import { chromium } from 'playwright';
import { HOST_SIGNATURES, matchHtml } from './platform-signatures.js';

/**
 * DETECTOR DE PLATAFORMA (sin navegador, barato)
 * Para cada URL de dealer:
 *  - Resuelve DNS/CNAME (revela plataformas white-label aunque Cloudflare bloquee el HTML).
 *  - Descarga el home por HTTP y busca marcadores conocidos.
 * Clasifica cada sitio en una plataforma y agrega la distribución.
 *
 *   node src/detect-platform.js urls.txt
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = parseInt(process.env.TIMEOUT_MS || '8000', 10);
const CONCURRENCY = parseInt(process.env.CONC || '6', 10);

function cleanUrl(raw) {
  if (!raw) return null;
  let u = raw.trim().replace(/^https?:\/\//i, '').replace(/^https?:\/\//i, ''); // doble http://
  u = u.replace(/\s+/g, '');
  if (!u || u.includes('@') || /facebook\.com/i.test(u)) return null; // emails / facebook fuera
  if (!/\./.test(u)) return null;
  return 'https://' + u.replace(/\/+$/, '');
}

async function fingerprint(url, browser) {
  const host = new URL(url).hostname;

  // 1) DNS/CNAME (gratis, sortea Cloudflare)
  let cname = [];
  try { cname = await dns.resolveCname(host); } catch { /* sin cname */ }
  const hostBlob = host + ' ' + cname.join(' ');
  for (const [re, name] of HOST_SIGNATURES) if (re.test(hostBlob)) return { platform: name, via: 'host/cname', cname: cname[0] || null };

  // 2) HTTP + marcadores HTML
  let needsBrowser = false;
  try {
    const res = await request(url, {
      method: 'GET', headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      maxRedirections: 5, headersTimeout: TIMEOUT, bodyTimeout: TIMEOUT,
    });
    const status = res.statusCode;
    const cf = res.headers['cf-ray'] || /cloudflare/i.test(res.headers['server'] || '');
    const html = (await res.body.text()).slice(0, 200_000);
    const hit = matchHtml(html);
    if (hit) return { platform: hit, via: 'html', status };
    if ((status === 403 && cf) || status === 429 || status >= 400) needsBrowser = true;
  } catch { needsBrowser = true; }

  if (needsBrowser && !browser) return { platform: 'BLOQUEADA/CAÍDA (revisar c/navegador)', via: 'http' };

  // 3) Fallback navegador (pasa Cloudflare): solo para los que HTTP no pudo
  if (needsBrowser && browser) {
    let ctx;
    try {
      ctx = await browser.newContext({ userAgent: UA });
      const page = await ctx.newPage();
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(1500);
      const html = await page.content();
      const hit = matchHtml(html);
      if (hit) return { platform: hit, via: 'browser', status: resp?.status() };
      return { platform: 'DESCONOCIDA (custom)', via: 'browser', status: resp?.status() };
    } catch (e) {
      return { platform: 'INALCANZABLE', via: 'browser-error', error: e.message?.slice(0, 40) };
    } finally {
      await ctx?.close().catch(() => {});
    }
  }

  return { platform: 'DESCONOCIDA (custom)', via: 'http' };
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }));
  return results;
}

const file = process.argv[2];
if (!file) { console.error('Uso: node src/detect-platform.js <archivo-urls>'); process.exit(1); }

const rawLines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const urls = [...new Set(rawLines.map(cleanUrl).filter(Boolean))];
const descartadas = rawLines.length - urls.length;

console.log(`Entradas: ${rawLines.length} | URLs válidas únicas: ${urls.length} | descartadas (email/fb/malas): ${descartadas}\n`);

const useBrowser = !process.env.SKIP_BROWSER;
const browser = useBrowser ? await chromium.launch({ headless: true }) : null;
const results = await runPool(urls, async (url) => {
  const r = await fingerprint(url, browser);
  return { url, ...r };
}, CONCURRENCY);
if (browser) await browser.close();

const dist = {};
for (const r of results) dist[r.platform] = (dist[r.platform] || 0) + 1;

// Guardar el mapa por dealer (CSV) para análisis posterior
const csv = ['url,platform,via,cname', ...results.map((r) =>
  `${r.url},${r.platform},${r.via || ''},${r.cname || ''}`)].join('\n');
fs.writeFileSync('platform-map.csv', csv + '\n');

console.log('\n=== DISTRIBUCIÓN DE PLATAFORMAS ===');
for (const [p, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${Math.round(100 * n / results.length)}%  ${p}`);
}
console.log('\nMapa por dealer guardado en platform-map.csv');
