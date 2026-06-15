import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

// En ECS los logs van a stdout (CloudWatch Logs). El archivo es opcional (modo local).
let stream = null;

export function initLogger(runId) {
  fs.mkdirSync(CONFIG.logsDir, { recursive: true });
  const file = path.join(CONFIG.logsDir, `run-${runId}.log`);
  stream = fs.createWriteStream(file, { flags: 'a' });
  return file;
}

function write(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}` +
    (extra ? ` | ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '');
  console.log(line);
  if (stream) stream.write(line + '\n');
}

export const log = {
  info: (msg, extra) => write('INFO', msg, extra),
  warn: (msg, extra) => write('WARN', msg, extra),
  error: (msg, extra) => write('ERROR', msg, extra),
  close: () => stream?.end(),
};
