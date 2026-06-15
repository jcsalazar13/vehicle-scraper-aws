import { pool, closePool } from './db.js';

const runs = (await pool.query('SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT 10')).rows;
console.log('\n=== ÚLTIMAS CORRIDAS ===');
console.table(runs);

if (runs[0]) {
  const results = (await pool.query(`
    SELECT url, strategy_used, status, vehicles_found, vehicles_new,
           vehicles_updated, duration_ms, left(reason, 90) AS reason
    FROM scrape_run_results WHERE run_id = $1 ORDER BY id`, [runs[0].id])).rows;
  console.log(`\n=== RESULTADOS DE LA CORRIDA ${runs[0].id} ===`);
  console.table(results);
}

const dealers = (await pool.query(`
  SELECT d.id, d.name, d.domain, d.platform, COUNT(v.id)::int AS vehiculos
  FROM dealers d LEFT JOIN vehicles v ON v.dealer_id = d.id
  GROUP BY d.id ORDER BY vehiculos DESC LIMIT 25`)).rows;
console.log('\n=== DEALERS E INVENTARIO (top 25) ===');
console.table(dealers);

const sample = (await pool.query(`
  SELECT v.id, d.domain, v.year, v.make, v.model, v.vin, v.mileage, v.price, v.exterior_color, v.location
  FROM vehicles v JOIN dealers d ON d.id = v.dealer_id
  ORDER BY v.last_seen_at DESC LIMIT 15`)).rows;
console.log('\n=== ÚLTIMOS VEHÍCULOS ===');
console.table(sample);

await closePool();
