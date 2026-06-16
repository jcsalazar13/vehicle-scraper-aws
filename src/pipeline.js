import { upsertDealer, setDealerPlatform, upsertVehicles } from './db.js';
import { log } from './logger.js';
import { apiStrategy } from './strategies/api.js';
import { embeddedStrategy } from './strategies/embedded.js';
import { navigateStrategy } from './strategies/navigate.js';
import { unlockedStrategy } from './strategies/unlocked.js';
import { aiStrategy } from './strategies/ai.js';
import { extractorFor } from './strategies/platforms/registry.js';

/**
 * Procesa una URL de dealer y persiste el inventario.
 *   1) Si se conoce la plataforma (del mensaje SQS / platform-map), usa su extractor
 *      específico (rápido, alta fidelidad, con fetch escalonado anti-bot).
 *   2) Si no, o si el extractor falla, cae a la cascada genérica (API → embebido →
 *      navegación → IA).
 * Devuelve el objeto listo para insertar en scrape_run_results.
 */
export async function processUrl(url, runId, workerId = null, platform = null) {
  const start = Date.now();
  const tried = [];
  const ctx = { log };
  let dealerId = null;

  try {
    dealerId = await upsertDealer(url);
  } catch (e) {
    return {
      run_id: runId, dealer_id: null, url, strategy_used: 'none',
      strategies_tried: JSON.stringify([{ strategy: 'setup', reason: `URL inválida: ${e.message}` }]),
      status: 'failed', vehicles_found: 0, vehicles_new: 0, vehicles_updated: 0,
      reason: `URL inválida: ${e.message}`, duration_ms: Date.now() - start, worker_id: workerId,
    };
  }

  log.info(`Procesando dealer #${dealerId}: ${url}${platform ? ` [plataforma: ${platform}]` : ''}`);

  // 0) Extractor específico de plataforma (si la conocemos)
  const platformExtractor = extractorFor(platform);
  if (platformExtractor) {
    try {
      const r = await platformExtractor(url, ctx);
      tried.push({ strategy: `platform:${platform}`, ok: r.ok, reason: r.reason, attempts: r.attempts?.slice(0, 15) });
      await setDealerPlatform(dealerId, platform).catch(() => {});
      if (r.ok && r.vehicles.length) {
        const { inserted, updated } = await upsertVehicles(dealerId, runId, r.vehicles, platform);
        log.info(`✔ OK [${platform}] ${url} → ${r.vehicles.length} vehículos (${inserted} nuevos, ${updated} actualizados)`);
        return {
          run_id: runId, dealer_id: dealerId, url, strategy_used: platform,
          strategies_tried: JSON.stringify(tried), status: 'ok',
          vehicles_found: r.vehicles.length, vehicles_new: inserted, vehicles_updated: updated,
          reason: r.reason, duration_ms: Date.now() - start, worker_id: workerId,
        };
      }
      log.warn(`[${url}] Extractor ${platform} sin resultado: ${r.reason} → cascada genérica`);
    } catch (e) {
      tried.push({ strategy: `platform:${platform}`, ok: false, reason: `error: ${e.message}` });
      log.warn(`[${url}] Extractor ${platform} falló (${e.message}) → cascada genérica`);
    }
  }

  let winner = null;
  let htmlForNext = '';

  // 1) API
  const api = await apiStrategy(url, ctx);
  tried.push({ strategy: 'api', ok: api.ok, reason: api.reason, attempts: api.attempts?.slice(0, 15) });
  if (api.platform) await setDealerPlatform(dealerId, api.platform).catch(() => {});
  if (api.ok) winner = { name: 'api', ...api };
  else {
    htmlForNext = api.html || '';
    log.warn(`[${url}] API sin resultado: ${api.reason}`);
  }

  // 2) HTML embebido
  if (!winner) {
    const emb = await embeddedStrategy(url, ctx, htmlForNext);
    tried.push({ strategy: 'embedded', ok: emb.ok, reason: emb.reason, attempts: emb.attempts?.slice(0, 15) });
    if (emb.ok) winner = { name: 'embedded', ...emb };
    else log.warn(`[${url}] Embebido sin resultado: ${emb.reason}`);
  }

  // 3) Navegación con browser
  let renderedHtml = '';
  if (!winner) {
    const nav = await navigateStrategy(url, ctx);
    tried.push({ strategy: 'navigate', ok: nav.ok, reason: nav.reason, attempts: nav.attempts?.slice(0, 15) });
    renderedHtml = nav.renderedHtml || '';
    if (nav.ok) winner = { name: 'navigate', ...nav };
    else log.warn(`[${url}] Navegación sin resultado: ${nav.reason}`);
  }

  // 3.5) Desbloqueo anti-bot: genéricos server-rendered tras 403 (Web Unlocker + VIN-anclado).
  // Barato ($1.5/1000) y solo corre si todo lo anterior falló → costo acotado a los perdidos.
  if (!winner) {
    const unl = await unlockedStrategy(url, ctx);
    tried.push({ strategy: 'unlocked', ok: unl.ok, reason: unl.reason, attempts: unl.attempts?.slice(0, 15) });
    if (unl.ok) winner = { name: 'unlocked', ...unl };
    else log.warn(`[${url}] Unlocked sin resultado: ${unl.reason}`);
  }

  // 4) IA
  if (!winner) {
    const ai = await aiStrategy(url, ctx, renderedHtml);
    tried.push({ strategy: 'ai', ok: ai.ok, reason: ai.reason });
    if (ai.ok) winner = { name: 'ai', ...ai };
    else log.warn(`[${url}] IA sin resultado: ${ai.reason}`);
  }

  if (winner) {
    const { inserted, updated } = await upsertVehicles(dealerId, runId, winner.vehicles, winner.name);
    log.info(`✔ OK [${winner.name}] ${url} → ${winner.vehicles.length} vehículos (${inserted} nuevos, ${updated} actualizados)`);
    return {
      run_id: runId, dealer_id: dealerId, url, strategy_used: winner.name,
      strategies_tried: JSON.stringify(tried), status: 'ok',
      vehicles_found: winner.vehicles.length, vehicles_new: inserted, vehicles_updated: updated,
      reason: winner.reason, duration_ms: Date.now() - start, worker_id: workerId,
    };
  }

  const reasonSummary = tried.map((t) => `[${t.strategy}] ${t.reason}`).join(' || ');
  log.error(`✘ FALLÓ ${url} → ${reasonSummary}`);
  return {
    run_id: runId, dealer_id: dealerId, url, strategy_used: 'none',
    strategies_tried: JSON.stringify(tried), status: 'failed',
    vehicles_found: 0, vehicles_new: 0, vehicles_updated: 0,
    reason: reasonSummary, duration_ms: Date.now() - start, worker_id: workerId,
  };
}
