import os from 'node:os';
import {
  SQSClient, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { CONFIG } from './config.js';
import { migrate, ensureRun, recordResult, refreshRun, closePool } from './db.js';
import { log } from './logger.js';
import { processUrl } from './pipeline.js';

/**
 * WORKER DISTRIBUIDO (ECS Fargate)
 * - Long-polling a SQS; procesa CONFIG.workerConcurrency dealers en paralelo.
 * - Cada dealer tiene un timeout duro (dealerTimeoutMs) menor que el visibility
 *   timeout de la cola, para que un sitio colgado no bloquee la tarea.
 * - Resultado de scraping (ok o failed con razones) => se registra en BD y se
 *   BORRA el mensaje: las razones de fallo de scraping son deterministas y no
 *   vale la pena reintentarlas.
 * - Error de infraestructura (BD caída, excepción no controlada, timeout) =>
 *   NO se borra el mensaje: SQS lo reentrega y tras maxReceiveCount va a la DLQ.
 * - La tabla scrape_run_results tiene UNIQUE(run_id, url), así que una
 *   reentrega del mismo mensaje nunca duplica resultados ni vehículos.
 * - Maneja SIGTERM (scale-in de ECS): termina los dealers en vuelo y sale.
 */

const sqs = new SQSClient({});
const workerId = `${os.hostname()}-${process.pid}`;
let shuttingDown = false;

process.on('SIGTERM', () => { log.warn('SIGTERM recibido: terminando trabajos en vuelo…'); shuttingDown = true; });
process.on('SIGINT', () => { shuttingDown = true; });

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Timeout de ${ms / 1000}s procesando ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function handleMessage(msg) {
  let payload;
  try {
    payload = JSON.parse(msg.Body);
  } catch {
    log.error(`Mensaje con body inválido, se descarta: ${msg.Body?.slice(0, 200)}`);
    await deleteMsg(msg);
    return;
  }

  const { runId, url, totalUrls, platform } = payload;
  if (!runId || !url) {
    log.error(`Mensaje sin runId/url, se descarta: ${msg.Body.slice(0, 200)}`);
    await deleteMsg(msg);
    return;
  }

  await ensureRun(runId, totalUrls ?? 0);

  // El resultado del pipeline (incluido "failed" con razones) es un resultado válido.
  // `platform` (opcional, viene del platform-map) enruta al extractor específico.
  const result = await withTimeout(processUrl(url, runId, workerId, platform), CONFIG.dealerTimeoutMs, url);
  await recordResult(result);
  await refreshRun(runId);
  await deleteMsg(msg);
}

async function deleteMsg(msg) {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: CONFIG.queueUrl, ReceiptHandle: msg.ReceiptHandle }));
}

async function main() {
  if (!CONFIG.queueUrl) {
    console.error('Falta la variable de entorno QUEUE_URL');
    process.exit(1);
  }

  await migrate();
  log.info(`Worker ${workerId} listo — concurrencia ${CONFIG.workerConcurrency} — cola ${CONFIG.queueUrl}`);
  if (!CONFIG.ai.enabled) log.warn('ANTHROPIC_API_KEY no configurada: la estrategia IA quedará deshabilitada');

  let emptyPolls = 0;

  while (!shuttingDown) {
    const res = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: CONFIG.queueUrl,
      MaxNumberOfMessages: Math.min(CONFIG.workerConcurrency, 10),
      WaitTimeSeconds: 20,
    }));

    const messages = res.Messages ?? [];
    if (messages.length === 0) {
      emptyPolls++;
      if (emptyPolls === CONFIG.emptyPollsBeforeIdle) {
        log.info('Cola vacía: en espera (el auto scaling apagará esta tarea si no llegan más mensajes)');
      }
      continue;
    }
    emptyPolls = 0;

    const outcomes = await Promise.allSettled(messages.map((m) => handleMessage(m)));
    for (let i = 0; i < outcomes.length; i++) {
      if (outcomes[i].status === 'rejected') {
        // Error de infraestructura o timeout: dejar que SQS reintente / DLQ.
        log.error(`Error de infraestructura procesando mensaje (se reintentará vía SQS): ${outcomes[i].reason?.message}`);
        // Acortar la visibilidad para que el reintento no espere el timeout completo.
        await sqs.send(new ChangeMessageVisibilityCommand({
          QueueUrl: CONFIG.queueUrl,
          ReceiptHandle: messages[i].ReceiptHandle,
          VisibilityTimeout: 60,
        })).catch(() => {});
      }
    }
  }

  log.info('Worker apagándose limpiamente');
  await closePool().catch(() => {});
  process.exit(0);
}

main().catch(async (e) => {
  console.error('Error fatal del worker:', e);
  await closePool().catch(() => {});
  process.exit(1);
});
