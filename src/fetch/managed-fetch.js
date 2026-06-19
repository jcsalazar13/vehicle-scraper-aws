import { request } from 'undici';
import { chromium } from 'playwright';
import { CONFIG } from '../config.js';

/**
 * Lanza el navegador: si hay Scraping Browser configurado (SCRAPER_BROWSER_WSS), se
 * CONECTA al Chrome remoto de Bright Data (que pasa Cloudflare/DataDome); si no, lanza
 * Chromium local. Los extractores usan esto en vez de chromium.launch().
 */
// Semáforo: limita las sesiones concurrentes del Scraping Browser POR PROCESO. Cada sesión
// consume balance ($8/GB); con WORKER_CONCURRENCY dealers por tarea, esto evita que todas
// abran navegador remoto a la vez y quemen balance / topen la concurrencia de Bright Data.
const SB_MAX = Math.max(1, parseInt(process.env.SCRAPER_BROWSER_MAX || '1', 10));
let sbActive = 0;
const sbWaiters = [];
const sbAcquire = () => (sbActive < SB_MAX ? (sbActive++, Promise.resolve()) : new Promise((r) => sbWaiters.push(r)));
const sbRelease = () => { sbActive--; const next = sbWaiters.shift(); if (next) { sbActive++; next(); } };

export async function launchBrowser(remote = false) {
  // remote=true (plataformas bloqueadas) + Scraping Browser configurado → navegador remoto.
  // Si no, Chromium local (gratis) — las plataformas abiertas no necesitan anti-bot.
  if (!remote || !CONFIG.scrapingBrowser.enabled) return chromium.launch({ headless: true });
  await sbAcquire(); // cap de concurrencia (se mantiene hasta browser.close())
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const browser = await chromium.connectOverCDP(CONFIG.scrapingBrowser.wss, { timeout: 60_000 });
      // Mantener el semáforo durante TODA la sesión: liberar al cerrar el navegador.
      const origClose = browser.close.bind(browser);
      let released = false;
      browser.close = async () => { try { await origClose(); } finally { if (!released) { released = true; sbRelease(); } } };
      return browser;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  sbRelease(); // el connect falló tras los reintentos → liberar el cupo
  throw lastErr;
}

/**
 * Crea una página para scrapear. Local: contexto nuevo con UA/viewport. Remoto
 * (Scraping Browser): página en el contexto por defecto (Bright Data gestiona UA/proxy).
 */
export async function newScrapePage(browser, remote = false) {
  const page = (remote && CONFIG.scrapingBrowser.enabled)
    ? await browser.newPage()
    : await (await browser.newContext({ userAgent: CONFIG.userAgent, viewport: { width: 1366, height: 900 } })).newPage();

  // Bloqueo de recursos para recortar ancho de banda (clave por el costo $8/GB del Scraping
  // Browser). NUNCA bloquea document/script-principal/xhr/fetch (ahí viven las tarjetas y la
  // API de inventario). SÍ bloquea: imagen/font/media, CSS, y dominios de analytics/ads/widgets.
  if (CONFIG.blockMedia) {
    await page.route('**/*', (route) => {
      const req = route.request();
      const t = req.resourceType();
      // 1) media/css: nunca se usan para extraer
      if (t === 'image' || t === 'font' || t === 'media' || t === 'stylesheet') return route.abort();
      // 2) analytics/tracking/ads/chat-widgets: puro overhead, seguro de bloquear
      if ((t === 'script' || t === 'xhr' || t === 'fetch' || t === 'ping' || t === 'beacon') && BLOCK_HOSTS.test(req.url())) {
        return route.abort();
      }
      return route.continue();
    }).catch(() => { /* el navegador no soporta route: seguir sin bloqueo */ });
  }
  return page;
}

// Dominios de analytics/tracking/ads/widgets que no aportan al inventario y solo gastan banda.
const BLOCK_HOSTS = /google-analytics|googletagmanager|gtag\/js|doubleclick\.net|googlesyndication|google-adservices|facebook\.net|connect\.facebook|fbcdn|hotjar|clarity\.ms|segment\.(io|com)|mixpanel|amplitude|fullstory|optimizely|bat\.bing|snap\.licdn|tiktok\.com\/i18n|analytics\.tiktok|pinterest|criteo|taboola|outbrain|intercom|drift\.com|tawk\.to|zendesk|livechat|cookiebot|onetrust|trustarc|hs-scripts|hubspot|cdn\.cookielaw|newrelic|sentry\.io|cloudflareinsights|adroll|quantserve|scorecardresearch|addthis|sharethis/i;

/**
 * CAPA DE FETCH GESTIONADA (anti-bot)
 *
 * Estrategia escalonada para los dealers tras Cloudflare/DataDome:
 *   Tier 1: navegador headless normal (gratis, ya pasa muchos Cloudflare).
 *   Tier 2: solo si Tier 1 queda BLOQUEADO → servicio gestionado (Scrapfly/ZenRows/…)
 *           que resuelve proxies + fingerprint + CAPTCHA y devuelve el HTML renderizado.
 *
 * Los extractores no cambian: usan `gotoTiered(page, url)` en vez de `page.goto`; si el
 * navegador queda bloqueado, se inyecta el HTML del servicio con page.setContent y el
 * resto del extractor (page.evaluate) corre igual sobre ese DOM.
 *
 * Si no hay SCRAPER_API_KEY, Tier 2 se omite (degrada a solo navegador) con aviso.
 */

const CHALLENGE_MARKERS = [
  /just a moment/i, /checking your browser/i, /cf-browser-verification/i, /cf-challenge/i,
  /captcha-delivery\.com/i, /datadome/i, /geo\.captcha-delivery/i,
  /enable javascript and cookies to continue/i, /attention required.*cloudflare/i,
  /access denied/i, /are you a human/i,
];

/** ¿La respuesta es una página de desafío anti-bot (no el contenido real)? */
export function isBlocked(html, status) {
  if (status === 403 || status === 429 || status === 503) return true;
  if (!html || html.length < 1500) return true;           // páginas de challenge suelen ser cortas
  return CHALLENGE_MARKERS.some((re) => re.test(html));
}

/** Construye la petición al proveedor configurado. Devuelve { url, method, headers, body, parse }. */
function providerRequest(targetUrl) {
  const { provider, apiKey, zone } = CONFIG.managedFetch;
  const u = encodeURIComponent(targetUrl);
  switch (provider) {
    case 'brightdata':
      // Web Unlocker: POST a la API con Bearer token + zona; format:raw devuelve el HTML.
      return {
        url: 'https://api.brightdata.com/request',
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ zone, url: targetUrl, format: 'raw', country: 'us' }),
        parse: (b) => b,
      };
    case 'zenrows':
      return { url: `https://api.zenrows.com/v1/?apikey=${apiKey}&url=${u}&js_render=true&premium_proxy=true`, parse: (b) => b };
    case 'scrapedo':
      return { url: `https://api.scrape.do/?token=${apiKey}&url=${u}&render=true&super=true`, parse: (b) => b };
    case 'scrapingbee':
      return { url: `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${u}&render_js=true&premium_proxy=true`, parse: (b) => b };
    case 'scrapfly':
    default:
      // Scrapfly devuelve JSON; el HTML va en result.content. asp=anti-scraping-protection.
      return {
        url: `https://api.scrapfly.io/scrape?key=${apiKey}&url=${u}&render_js=true&asp=true&country=us`,
        parse: (b) => { try { return JSON.parse(b)?.result?.content || ''; } catch { return ''; } },
      };
  }
}

/** Tier 2: pide el HTML renderizado al servicio gestionado. Devuelve '' si falla/no hay key. */
export async function fetchViaApi(targetUrl, { log, timeoutMs } = {}) {
  if (!CONFIG.managedFetch.enabled) {
    log?.warn?.(`[managed-fetch] bloqueado y sin SCRAPER_API_KEY → no se puede escalar: ${targetUrl}`);
    return '';
  }
  const t = timeoutMs || CONFIG.managedFetch.timeoutMs;
  const { url, method = 'GET', headers, body: reqBody, parse } = providerRequest(targetUrl);
  try {
    const res = await request(url, { method, headers, body: reqBody, headersTimeout: t, bodyTimeout: t });
    const body = await res.body.text();
    if (res.statusCode >= 400) { log?.warn?.(`[managed-fetch] ${CONFIG.managedFetch.provider} HTTP ${res.statusCode}: ${body.slice(0, 150)}`); return ''; }
    const html = parse(body);
    log?.info?.(`[managed-fetch] ${CONFIG.managedFetch.provider} resolvió ${targetUrl} (${html.length} bytes)`);
    return html;
  } catch (e) {
    log?.warn?.(`[managed-fetch] error llamando a ${CONFIG.managedFetch.provider}: ${e.message}`);
    return '';
  }
}

/**
 * Navegación escalonada: intenta con el navegador; si queda bloqueado, trae el HTML del
 * servicio gestionado y lo inyecta en la página. Devuelve { tier, blocked }.
 */
export async function gotoTiered(page, url, { timeout = 45000, settleMs = 3000, log, forceManaged = false, remote = false } = {}) {
  // Si la página viene de un navegador remoto (Scraping Browser), él ya pasa el anti-bot:
  // navegamos en vivo y el extractor corre tal cual (scroll, waitForSelector, etc.).
  if (remote && CONFIG.scrapingBrowser.enabled) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch((e) => log?.warn?.(`[scraping-browser] goto: ${e.message}`));
    // Esperar a que terminen los XHR que cargan las tarjetas (reduce la variabilidad de sesión)
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(settleMs);
    return { tier: 'remote', blocked: false };
  }

  // forceManaged: plataformas que sabemos tras DataDome (CarsForSale) — el navegador
  // local recibe el captcha y isBlocked() no siempre lo detecta; vamos directo a Tier 2.
  if (forceManaged && CONFIG.managedFetch.enabled) {
    const apiHtml = await fetchViaApi(url, { log });
    if (apiHtml && apiHtml.length > 1500) {
      await page.setContent(apiHtml, { waitUntil: 'commit' }).catch(() => {});
      await page.waitForTimeout(500);
      return { tier: 2, blocked: false };
    }
    return { tier: 2, blocked: true };
  }

  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: 'commit', timeout });
    status = resp?.status() ?? 0;
  } catch (e) {
    log?.warn?.(`[managed-fetch] goto falló (${e.message}); se intentará Tier 2`);
  }
  await page.waitForTimeout(settleMs);

  let html = '';
  try { html = await page.content(); } catch { /* página rota */ }

  if (!isBlocked(html, status)) return { tier: 1, blocked: false };

  // Tier 2: escalar al servicio gestionado
  log?.info?.(`[managed-fetch] Tier 1 bloqueado (HTTP ${status}) → escalando a ${CONFIG.managedFetch.provider}: ${url}`);
  const apiHtml = await fetchViaApi(url, { log });
  if (apiHtml && apiHtml.length > 1500) {
    await page.setContent(apiHtml, { waitUntil: 'commit' }).catch(() => {});
    await page.waitForTimeout(500);
    return { tier: 2, blocked: false };
  }
  return { tier: 1, blocked: true };
}
