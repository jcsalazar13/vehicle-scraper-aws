// Lambda dispatcher — runtime nodejs20.x (los SDK v3 ya vienen incluidos, no requiere bundling)
//
// Lee la lista de URLs (del payload del evento o de un archivo en S3), genera un
// runId y publica un mensaje por dealer en SQS. Los workers en Fargate hacen el resto.
//
// Formas de invocarlo:
//   1) Con archivo en S3 (por defecto):   payload {}            -> lee s3://$URLS_BUCKET/$URLS_KEY
//   2) Con URLs en el payload:            payload {"urls": ["https://dealer1.com", ...]}
//   3) runId propio (opcional):           payload {"runId": "corrida-junio"}

import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const sqs = new SQSClient({});
const s3 = new S3Client({});

export const handler = async (event = {}) => {
  const queueUrl = process.env.QUEUE_URL;
  if (!queueUrl) throw new Error('Falta la variable de entorno QUEUE_URL');

  // 1) Obtener la lista de dealers. Cada entrada puede ser:
  //    - string "https://dealer.com"
  //    - string CSV "https://dealer.com,DealerSync"  (url,platform)
  //    - objeto { url, platform }
  let raw = Array.isArray(event.urls) ? event.urls : null;
  if (!raw) {
    const bucket = process.env.URLS_BUCKET;
    const key = process.env.URLS_KEY || 'urls.txt';
    if (!bucket) throw new Error('No se recibieron urls en el evento y no hay URLS_BUCKET configurado');
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await obj.Body.transformToString();
    raw = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }

  // 2) Normalizar a { url, platform }, validar y deduplicar por url
  const seen = new Set();
  const valid = [];
  for (const item of raw) {
    let url, platform = null;
    if (typeof item === 'object' && item) { url = item.url; platform = item.platform || null; }
    else { [url, platform] = String(item).split(','); url = (url || '').trim(); platform = (platform || '').trim() || null; }
    try { const p = new URL(url); if (p.protocol !== 'http:' && p.protocol !== 'https:') continue; } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    valid.push({ url, platform });
  }
  if (valid.length === 0) throw new Error('La lista de URLs quedó vacía tras validar');

  // 3) Generar runId y encolar en lotes de 10 (límite de SendMessageBatch)
  const runId = event.runId || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let enqueued = 0;

  for (let i = 0; i < valid.length; i += 10) {
    const batch = valid.slice(i, i + 10);
    const res = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: batch.map((d, j) => ({
        Id: String(i + j),
        MessageBody: JSON.stringify({ runId, url: d.url, platform: d.platform, totalUrls: valid.length }),
      })),
    }));
    enqueued += (res.Successful ?? []).length;
    if (res.Failed?.length) {
      console.error('Mensajes fallidos:', JSON.stringify(res.Failed));
    }
  }

  console.log(`Corrida ${runId}: ${enqueued}/${valid.length} dealers encolados`);
  return { runId, totalUrls: valid.length, enqueued };
};
