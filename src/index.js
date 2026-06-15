import fs from 'node:fs';
import { migrate, ensureRun, recordResult, refreshRun, closePool } from './db.js';
import { initLogger, log } from './logger.js';
import { processUrl } from './pipeline.js';
import { sleep } from './utils/http.js';
import { CONFIG } from './config.js';

/**
 * MODO LOCAL: procesa URLs secuencialmente contra la BD configurada en
 * DATABASE_URL, sin pasar por SQS. Útil para desarrollo y pruebas.
 *   node src/index.js --urls urls.txt
 *   node src/index.js https://dealer1.com https://dealer2.com
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const urls = [];
  let file = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--urls') file = args[++i];
    else if (args[i].startsWith('http')) urls.push(args[i]);
  }
  if (file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    urls.push(...lines);
  }
  return [...new Set(urls)];
}

async function main() {
  const urls = parseArgs();
  if (urls.length === 0) {
    console.error('Uso: node src/index.js --urls urls.txt   (o)   node src/index.js https://dealer1.com');
    process.exit(1);
  }

  await migrate();
  const runId = `local-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const logFile = initLogger(runId);
  await ensureRun(runId, urls.length);
  log.info(`Corrida ${runId} iniciada — ${urls.length} URL(s) — log: ${logFile}`);
  if (!CONFIG.ai.enabled) log.warn('ANTHROPIC_API_KEY no configurada: la estrategia IA quedará deshabilitada');

  for (const url of urls) {
    try {
      const result = await processUrl(url, runId, 'local');
      await recordResult(result);
    } catch (e) {
      await recordResult({
        run_id: runId, dealer_id: null, url, strategy_used: 'none',
        strategies_tried: JSON.stringify([{ strategy: 'fatal', reason: e.message }]),
        status: 'failed', vehicles_found: 0, vehicles_new: 0, vehicles_updated: 0,
        reason: `Error no controlado: ${e.message}`, duration_ms: 0, worker_id: 'local',
      });
      log.error(`Error no controlado en ${url}: ${e.stack || e.message}`);
    }
    await refreshRun(runId);
    await sleep(CONFIG.requestDelayMs);
  }

  log.info(`Corrida ${runId} finalizada. Ejecuta "npm run report" para ver el resumen.`);
  log.close();
  await closePool();
}

main().catch(async (e) => {
  console.error('Error fatal:', e);
  await closePool().catch(() => {});
  process.exit(1);
});
