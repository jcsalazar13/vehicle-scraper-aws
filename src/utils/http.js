import { request } from 'undici';
import { CONFIG } from '../config.js';

export async function httpGet(url, { headers = {}, asJson = false } = {}) {
  const res = await request(url, {
    method: 'GET',
    headers: {
      'user-agent': CONFIG.userAgent,
      accept: asJson ? 'application/json' : 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9,es;q=0.8',
      ...headers,
    },
    maxRedirections: 5,
    headersTimeout: CONFIG.httpTimeoutMs,
    bodyTimeout: CONFIG.httpTimeoutMs,
  });

  const status = res.statusCode;
  const contentType = res.headers['content-type'] || '';
  const body = await res.body.text();
  return { status, contentType, body };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Intenta parsear JSON sin lanzar excepción. */
export function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Busca recursivamente arrays de objetos que parezcan vehículos dentro de un JSON. */
export function findVehicleArrays(obj, depth = 0, found = []) {
  if (depth > 8 || obj == null) return found;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj.every((x) => x && typeof x === 'object')) {
      const sample = obj[0];
      const keys = Object.keys(sample).map((k) => k.toLowerCase());
      const score = ['vin', 'make', 'model', 'year', 'mileage', 'odometer', 'stocknumber', 'stock_number', 'price', 'trim']
        .filter((k) => keys.some((kk) => kk.includes(k))).length;
      if (score >= 3) found.push(obj);
    }
    for (const item of obj) findVehicleArrays(item, depth + 1, found);
  } else if (typeof obj === 'object') {
    for (const v of Object.values(obj)) findVehicleArrays(v, depth + 1, found);
  }
  return found;
}
