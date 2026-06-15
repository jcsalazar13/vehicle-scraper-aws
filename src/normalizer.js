/**
 * Normaliza un objeto "crudo" de vehículo (de API, JSON-LD, scraping o IA)
 * al esquema unificado de la tabla `vehicles`.
 */

const KEY_MAP = {
  vin: ['vin', 'vehicleidentificationnumber', 'vin_number'],
  stock_number: ['stocknumber', 'stock_number', 'stock', 'stockno', 'sku'],
  make: ['make', 'brand', 'manufacturer', 'marca'],
  model: ['model', 'modelo'],
  trim: ['trim', 'version', 'vehicletrim', 'serie'],
  year: ['year', 'modelyear', 'vehicleyear', 'anio', 'año', 'ano'],
  mileage: ['mileage', 'miles', 'odometer', 'odometro', 'kilometraje', 'km', 'mileagevalue'],
  price: ['price', 'sellingprice', 'saleprice', 'internetprice', 'listprice', 'precio', 'askingprice', 'finalprice'],
  msrp: ['msrp', 'retailprice', 'originalprice'],
  exterior_color: ['exteriorcolor', 'extcolor', 'color', 'colorexterior', 'exterior_color', 'exteriorcolour'],
  interior_color: ['interiorcolor', 'intcolor', 'colorinterior', 'interior_color'],
  transmission: ['transmission', 'transmision', 'gearbox', 'transmissiontype'],
  drivetrain: ['drivetrain', 'drivetype', 'traccion', 'driveline'],
  fuel_type: ['fueltype', 'fuel', 'combustible', 'fuel_type'],
  engine: ['engine', 'enginedescription', 'motor', 'enginesize'],
  body_style: ['bodystyle', 'body', 'bodytype', 'carroceria', 'vehicletype', 'body_style'],
  doors: ['doors', 'numberofdoors', 'puertas', 'doorcount'],
  condition: ['condition', 'type', 'newused', 'inventorytype', 'estado', 'itemcondition'],
  location: ['location', 'dealership', 'city', 'localidad', 'lot', 'dealername', 'address', 'sucursal'],
  url: ['url', 'link', 'vdpurl', 'detailurl', 'vehicleurl', 'href', 'permalink'],
  image_url: ['imageurl', 'image', 'photo', 'thumbnail', 'mainphoto', 'primaryimage', 'images', 'photourl'],
  description: ['description', 'comments', 'descripcion', 'sellersnotes'],
};

function flatten(obj, prefix = '', out = {}, depth = 0) {
  if (depth > 4 || obj == null) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, key + '_', out, depth + 1);
    } else if (out[key] === undefined) {
      out[key] = v;
      if (prefix && out[prefix + key] === undefined) out[prefix + key] = v;
    }
  }
  return out;
}

function pick(flat, aliases) {
  for (const a of aliases) {
    if (flat[a] !== undefined && flat[a] !== null && flat[a] !== '') return flat[a];
    // también buscar claves que contengan el alias (p.ej. "vehicle_vin")
    const hit = Object.keys(flat).find((k) => k.endsWith('_' + a) || k === a);
    if (hit && flat[hit] !== '' && flat[hit] != null) return flat[hit];
  }
  return null;
}

const toInt = (v) => {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

const toFloat = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const toStr = (v) => {
  if (v == null) return null;
  if (Array.isArray(v)) v = v[0];
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  return s.length ? s.slice(0, 500) : null;
};

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

export function normalizeVehicle(raw, baseUrl) {
  const flat = flatten(raw);

  let vin = toStr(pick(flat, KEY_MAP.vin));
  if (vin && !VIN_RE.test(vin)) vin = vin.length >= 11 ? vin.toUpperCase() : null;
  else if (vin) vin = vin.toUpperCase();

  let year = toInt(pick(flat, KEY_MAP.year));
  if (year && (year < 1950 || year > new Date().getFullYear() + 2)) year = null;

  let url = toStr(pick(flat, KEY_MAP.url));
  let image = toStr(pick(flat, KEY_MAP.image_url));
  try {
    if (url && baseUrl) url = new URL(url, baseUrl).href;
    if (image && baseUrl) image = new URL(image, baseUrl).href;
  } catch { /* URL inválida: se conserva como vino */ }

  let condition = toStr(pick(flat, KEY_MAP.condition));
  if (condition) {
    const c = condition.toLowerCase();
    if (c.includes('cert')) condition = 'certified';
    else if (c.includes('new') || c.includes('nuevo')) condition = 'new';
    else if (c.includes('used') || c.includes('usado') || c.includes('pre')) condition = 'used';
  }

  const vehicle = {
    vin,
    stock_number: toStr(pick(flat, KEY_MAP.stock_number)),
    make: toStr(pick(flat, KEY_MAP.make)),
    model: toStr(pick(flat, KEY_MAP.model)),
    trim: toStr(pick(flat, KEY_MAP.trim)),
    year,
    mileage: toInt(pick(flat, KEY_MAP.mileage)),
    price: toFloat(pick(flat, KEY_MAP.price)),
    msrp: toFloat(pick(flat, KEY_MAP.msrp)),
    exterior_color: toStr(pick(flat, KEY_MAP.exterior_color)),
    interior_color: toStr(pick(flat, KEY_MAP.interior_color)),
    transmission: toStr(pick(flat, KEY_MAP.transmission)),
    drivetrain: toStr(pick(flat, KEY_MAP.drivetrain)),
    fuel_type: toStr(pick(flat, KEY_MAP.fuel_type)),
    engine: toStr(pick(flat, KEY_MAP.engine)),
    body_style: toStr(pick(flat, KEY_MAP.body_style)),
    doors: toInt(pick(flat, KEY_MAP.doors)),
    condition,
    location: toStr(pick(flat, KEY_MAP.location)),
    url,
    image_url: image,
    description: toStr(pick(flat, KEY_MAP.description)),
    raw_json: JSON.stringify(raw).slice(0, 20_000),
  };

  return vehicle;
}

/** Un vehículo es válido si tiene al menos VIN, o (marca + modelo), o (marca + año). */
export function isValidVehicle(v) {
  if (v.vin) return true;
  if (v.make && v.model) return true;
  if (v.make && v.year) return true;
  return false;
}

export function normalizeMany(rawList, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const raw of rawList) {
    const v = normalizeVehicle(raw, baseUrl);
    if (!isValidVehicle(v)) continue;
    const key = v.vin || `${v.make}|${v.model}|${v.year}|${v.stock_number}|${v.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
