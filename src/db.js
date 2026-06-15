import pg from 'pg';
import { CONFIG } from './config.js';

const ssl = process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false };

export const pool = new pg.Pool({
  connectionString: CONFIG.databaseUrl,
  max: CONFIG.dbPoolMax,
  ssl,
  idleTimeoutMillis: 30_000,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dealers (
  id          SERIAL PRIMARY KEY,
  name        TEXT,
  base_url    TEXT NOT NULL UNIQUE,
  domain      TEXT,
  platform    TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id              TEXT PRIMARY KEY,          -- generado por el dispatcher (p.ej. run-2026-06-12T15-00-00)
  started_at      TIMESTAMPTZ DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  total_urls      INT DEFAULT 0,
  urls_ok         INT DEFAULT 0,
  urls_failed     INT DEFAULT 0,
  total_vehicles  INT DEFAULT 0,
  status          TEXT DEFAULT 'running'     -- running | finished
);

CREATE TABLE IF NOT EXISTS scrape_run_results (
  id               BIGSERIAL PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES scrape_runs(id),
  dealer_id        INT REFERENCES dealers(id),
  url              TEXT NOT NULL,
  strategy_used    TEXT,
  strategies_tried JSONB,
  status           TEXT NOT NULL,            -- ok | failed
  vehicles_found   INT DEFAULT 0,
  vehicles_new     INT DEFAULT 0,
  vehicles_updated INT DEFAULT 0,
  reason           TEXT,
  duration_ms      INT,
  worker_id        TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE (run_id, url)                       -- idempotencia: si SQS reentrega el mensaje no se duplica
);

CREATE TABLE IF NOT EXISTS vehicles (
  id              BIGSERIAL PRIMARY KEY,
  dealer_id       INT NOT NULL REFERENCES dealers(id),
  vin             TEXT,
  stock_number    TEXT,
  make            TEXT,
  model           TEXT,
  trim            TEXT,
  year            INT,
  mileage         INT,
  price           NUMERIC,
  msrp            NUMERIC,
  exterior_color  TEXT,
  interior_color  TEXT,
  transmission    TEXT,
  drivetrain      TEXT,
  fuel_type       TEXT,
  engine          TEXT,
  body_style      TEXT,
  doors           INT,
  condition       TEXT,
  location        TEXT,
  url             TEXT,
  image_url       TEXT,
  description     TEXT,
  raw_json        TEXT,
  source_strategy TEXT,
  first_seen_run  TEXT REFERENCES scrape_runs(id),
  last_seen_run   TEXT REFERENCES scrape_runs(id),
  first_seen_at   TIMESTAMPTZ DEFAULT now(),
  last_seen_at    TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_dealer_vin ON vehicles(dealer_id, vin) WHERE vin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vehicles_dealer ON vehicles(dealer_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_last_seen ON vehicles(last_seen_run);
CREATE INDEX IF NOT EXISTS idx_results_run ON scrape_run_results(run_id);
`;

export async function migrate() {
  await pool.query(SCHEMA);
}

// ---------- Dealers ----------
export async function upsertDealer(baseUrl, { name = null, platform = null } = {}) {
  const domain = new URL(baseUrl).hostname.replace(/^www\./, '');
  const { rows } = await pool.query(
    `INSERT INTO dealers (name, base_url, domain, platform)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (base_url) DO UPDATE SET
       platform   = COALESCE(EXCLUDED.platform, dealers.platform),
       updated_at = now()
     RETURNING id`,
    [name ?? domain, baseUrl, domain, platform]
  );
  return rows[0].id;
}

export async function setDealerPlatform(dealerId, platform) {
  await pool.query('UPDATE dealers SET platform = $1, updated_at = now() WHERE id = $2', [platform, dealerId]);
}

// ---------- Corridas ----------
/** Crea la corrida si no existe (idempotente: cualquier worker puede llamarlo). */
export async function ensureRun(runId, totalUrls) {
  await pool.query(
    `INSERT INTO scrape_runs (id, total_urls) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET total_urls = GREATEST(scrape_runs.total_urls, EXCLUDED.total_urls)`,
    [runId, totalUrls]
  );
}

export async function recordResult(r) {
  await pool.query(
    `INSERT INTO scrape_run_results
       (run_id, dealer_id, url, strategy_used, strategies_tried, status,
        vehicles_found, vehicles_new, vehicles_updated, reason, duration_ms, worker_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (run_id, url) DO NOTHING`,
    [r.run_id, r.dealer_id, r.url, r.strategy_used, r.strategies_tried, r.status,
     r.vehicles_found, r.vehicles_new, r.vehicles_updated, r.reason, r.duration_ms, r.worker_id ?? null]
  );
}

/**
 * Recalcula los agregados de la corrida y la marca como terminada cuando
 * el número de resultados alcanza total_urls. Seguro ante concurrencia:
 * lo puede ejecutar cualquier worker después de cada resultado.
 */
export async function refreshRun(runId) {
  await pool.query(
    `UPDATE scrape_runs r SET
        urls_ok        = s.ok,
        urls_failed    = s.failed,
        total_vehicles = s.veh,
        finished_at    = CASE WHEN s.cnt >= r.total_urls AND r.total_urls > 0 THEN now() ELSE r.finished_at END,
        status         = CASE WHEN s.cnt >= r.total_urls AND r.total_urls > 0 THEN 'finished' ELSE r.status END
     FROM (
       SELECT COUNT(*)::int AS cnt,
              COUNT(*) FILTER (WHERE status = 'ok')::int AS ok,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              COALESCE(SUM(vehicles_found), 0)::int AS veh
       FROM scrape_run_results WHERE run_id = $1
     ) s
     WHERE r.id = $1`,
    [runId]
  );
}

// ---------- Vehículos ----------
const VEHICLE_COLS = [
  'vin', 'stock_number', 'make', 'model', 'trim', 'year', 'mileage', 'price', 'msrp',
  'exterior_color', 'interior_color', 'transmission', 'drivetrain', 'fuel_type', 'engine',
  'body_style', 'doors', 'condition', 'location', 'url', 'image_url', 'description', 'raw_json',
];

/**
 * Inserta o actualiza vehículos. Con VIN usa ON CONFLICT sobre el índice único
 * parcial (dealer_id, vin); sin VIN deduplica por stock_number o por
 * (make, model, year, url). Devuelve { inserted, updated }.
 */
export async function upsertVehicles(dealerId, runId, vehicles, strategy) {
  let inserted = 0;
  let updated = 0;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const v of vehicles) {
      const vals = VEHICLE_COLS.map((c) => v[c] ?? null);

      if (v.vin) {
        const setClauses = VEHICLE_COLS
          .filter((c) => c !== 'vin')
          .map((c) => `"${c}" = COALESCE(EXCLUDED."${c}", vehicles."${c}")`)
          .join(', ');
        const placeholders = VEHICLE_COLS.map((_, i) => `$${i + 2}`).join(', ');
        const { rows } = await client.query(
          `INSERT INTO vehicles (dealer_id, ${VEHICLE_COLS.map((c) => `"${c}"`).join(', ')},
             source_strategy, first_seen_run, last_seen_run)
           VALUES ($1, ${placeholders}, $${VEHICLE_COLS.length + 2}, $${VEHICLE_COLS.length + 3}, $${VEHICLE_COLS.length + 3})
           ON CONFLICT (dealer_id, vin) WHERE vin IS NOT NULL DO UPDATE SET
             ${setClauses},
             source_strategy = EXCLUDED.source_strategy,
             last_seen_run   = EXCLUDED.last_seen_run,
             last_seen_at    = now()
           RETURNING (xmax = 0) AS is_insert`,
          [dealerId, ...vals, strategy, runId]
        );
        rows[0].is_insert ? inserted++ : updated++;
        continue;
      }

      // Sin VIN: buscar duplicado manualmente
      let existing = null;
      if (v.stock_number) {
        const r = await client.query(
          'SELECT id FROM vehicles WHERE dealer_id = $1 AND stock_number = $2 AND vin IS NULL LIMIT 1',
          [dealerId, v.stock_number]
        );
        existing = r.rows[0];
      }
      if (!existing && v.make && v.model && v.year) {
        const r = await client.query(
          `SELECT id FROM vehicles WHERE dealer_id = $1 AND vin IS NULL
             AND make = $2 AND model = $3 AND year = $4 AND COALESCE(url, '') = COALESCE($5, '') LIMIT 1`,
          [dealerId, v.make, v.model, v.year, v.url ?? null]
        );
        existing = r.rows[0];
      }

      if (existing) {
        const setClauses = VEHICLE_COLS
          .map((c, i) => `"${c}" = COALESCE($${i + 2}, "${c}")`)
          .join(', ');
        await client.query(
          `UPDATE vehicles SET ${setClauses},
             source_strategy = $${VEHICLE_COLS.length + 2},
             last_seen_run   = $${VEHICLE_COLS.length + 3},
             last_seen_at    = now()
           WHERE id = $1`,
          [existing.id, ...vals, strategy, runId]
        );
        updated++;
      } else {
        const placeholders = VEHICLE_COLS.map((_, i) => `$${i + 2}`).join(', ');
        await client.query(
          `INSERT INTO vehicles (dealer_id, ${VEHICLE_COLS.map((c) => `"${c}"`).join(', ')},
             source_strategy, first_seen_run, last_seen_run)
           VALUES ($1, ${placeholders}, $${VEHICLE_COLS.length + 2}, $${VEHICLE_COLS.length + 3}, $${VEHICLE_COLS.length + 3})`,
          [dealerId, ...vals, strategy, runId]
        );
        inserted++;
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { inserted, updated };
}

export async function closePool() {
  await pool.end();
}
