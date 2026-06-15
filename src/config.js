// Configuración central del scraper (todo sobreescribible por variables de entorno)
export const CONFIG = {
  // --- PostgreSQL ---
  databaseUrl: process.env.DATABASE_URL || 'postgres://scraper:scraper@localhost:5432/scraper',
  dbPoolMax: parseInt(process.env.DB_POOL_MAX || '5', 10),

  // --- SQS / worker distribuido ---
  queueUrl: process.env.QUEUE_URL || '',
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '2', 10), // dealers en paralelo por tarea
  dealerTimeoutMs: parseInt(process.env.DEALER_TIMEOUT_MS || String(12 * 60_000), 10), // tope duro por dealer
  emptyPollsBeforeIdle: 3, // polls vacíos consecutivos antes de loguear estado idle

  logsDir: process.env.LOGS_DIR || './logs',

  // --- Timeouts y límites de scraping ---
  httpTimeoutMs: 20_000,
  navTimeoutMs: 45_000,
  maxPagesPerDealer: 15,        // máximo de páginas de paginación a recorrer
  // CarsForSale: visitar la ficha (VDP) de cada coche para sacar el VIN. Off por defecto
  // porque las VDP suelen estar más protegidas (DataDome) y multiplican el costo/llamadas.
  carsforsaleEnrichVdp: process.env.CARSFORSALE_ENRICH_VDP === 'true',
  maxVehiclesPerDealer: 2000,   // tope de seguridad
  requestDelayMs: 800,          // pausa entre requests para no saturar al sitio

  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  // --- Estrategia IA (opcional). Requiere ANTHROPIC_API_KEY ---
  ai: {
    // trim() porque Secrets Manager no admite secretos vacíos y se usa " " como "sin key"
    enabled: !!(process.env.ANTHROPIC_API_KEY || '').trim(),
    apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
    model: process.env.AI_MODEL || 'claude-sonnet-4-5',
    maxInputChars: 120_000,
  },

  // --- Capa de fetch gestionada (anti-bot). Opcional: si no hay key, solo se usa el navegador ---
  // Para los dealers tras Cloudflare/DataDome que el navegador headless no logra pasar.
  managedFetch: {
    // proveedor: brightdata | scrapfly | zenrows | scrapedo | scrapingbee
    provider: (process.env.SCRAPER_PROVIDER || 'brightdata').trim().toLowerCase(),
    apiKey: (process.env.SCRAPER_API_KEY || '').trim(),       // brightdata: API token
    zone: (process.env.SCRAPER_ZONE || 'web_unlocker').trim(), // brightdata: nombre de la zona
    enabled: !!(process.env.SCRAPER_API_KEY || '').trim(),
    timeoutMs: parseInt(process.env.SCRAPER_TIMEOUT_MS || '90000', 10),
  },

  // --- Navegador remoto anti-bot (Bright Data Scraping Browser / "Browser API") ---
  // Endpoint CDP wss://...@brd.superproxy.io:9222 — cuando está, los extractores se
  // conectan a ese Chrome remoto (pasa Cloudflare/DataDome) en vez del Chromium local.
  scrapingBrowser: {
    wss: (process.env.SCRAPER_BROWSER_WSS || '').trim(),
    enabled: !!(process.env.SCRAPER_BROWSER_WSS || '').trim(),
  },

  // Rutas típicas donde los dealers publican su inventario
  inventoryPathGuesses: [
    '/inventory', '/used-inventory', '/new-inventory', '/all-inventory',
    '/used-vehicles', '/used-cars', '/cars-for-sale', '/vehicles',
    '/inventario', '/vehiculos', '/usados', '/autos', '/searchused.aspx',
    '/used-vehicles-for-sale', '/VehicleSearchResults',
  ],

  // Endpoints de API comunes en plataformas de dealers
  apiEndpointGuesses: [
    '/api/inventory', '/api/vehicles', '/api/inventory/search',
    '/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory',
    '/inventory.json', '/feed/inventory.json', '/api/v1/inventory',
    '/wp-json/wp/v2/inventory?per_page=100',
    '/api/search/inventory',
  ],
};
