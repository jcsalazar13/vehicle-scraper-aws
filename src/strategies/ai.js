import { CONFIG } from '../config.js';
import { normalizeMany } from '../normalizer.js';

/**
 * ESTRATEGIA 4 — IA (último recurso)
 * Envía el texto/HTML limpio de la página a la API de Claude y le pide
 * extraer los vehículos como JSON estructurado.
 * Requiere ANTHROPIC_API_KEY en el entorno; si no existe, se omite con razón clara.
 */
export async function aiStrategy(baseUrl, ctx, renderedHtml = '') {
  if (!CONFIG.ai.enabled) {
    return {
      ok: false, vehicles: [],
      reason: 'Estrategia IA omitida: no hay ANTHROPIC_API_KEY configurada',
      attempts: [],
    };
  }
  if (!renderedHtml || renderedHtml.length < 500) {
    return {
      ok: false, vehicles: [],
      reason: 'Estrategia IA omitida: no hay HTML renderizado disponible para analizar',
      attempts: [],
    };
  }

  const cleaned = cleanHtml(renderedHtml).slice(0, CONFIG.ai.maxInputChars);

  const prompt = `Eres un extractor de datos. A continuación está el contenido de la página de inventario de un concesionario de vehículos (${baseUrl}).

Extrae TODOS los vehículos en venta que aparezcan. Responde ÚNICAMENTE con un array JSON válido, sin texto adicional ni markdown. Cada vehículo es un objeto con estas claves (usa null si no aparece):
vin, stock_number, make, model, trim, year, mileage, price, exterior_color, interior_color, transmission, drivetrain, fuel_type, engine, body_style, doors, condition, location, url, image_url

Si no hay ningún vehículo, responde [].

CONTENIDO:
${cleaned}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': CONFIG.ai.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONFIG.ai.model,
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      return { ok: false, vehicles: [], reason: `API de IA respondió HTTP ${res.status}: ${t.slice(0, 200)}`, attempts: [] };
    }

    const data = await res.json();
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const jsonText = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { ok: false, vehicles: [], reason: 'La IA no devolvió JSON parseable', attempts: [] };
    }
    if (!Array.isArray(parsed)) parsed = [parsed];

    const vehicles = normalizeMany(parsed, new URL(baseUrl).origin);
    if (vehicles.length === 0) {
      return { ok: false, vehicles: [], reason: 'La IA analizó la página pero no identificó vehículos válidos', attempts: [] };
    }
    return { ok: true, vehicles, reason: `IA extrajo ${vehicles.length} vehículos del HTML renderizado`, attempts: [] };
  } catch (e) {
    return { ok: false, vehicles: [], reason: `Error llamando a la API de IA: ${e.message}`, attempts: [] };
  }
}

/** Quita scripts/estilos y se queda con texto + enlaces relevantes para reducir tokens. */
function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?!a\s|\/a)[^>]+>/g, ' ')   // conserva <a href> para URLs de fichas
    .replace(/\s{2,}/g, ' ')
    .trim();
}
