import { dwsExtract } from './dws.js';
import { dealerSyncExtract } from './dealersync.js';
import { dealrExtract } from './dealr.js';
import { overfuelExtract } from './overfuel.js';
import { dealerInspireExtract } from './dealerinspire.js';
import { dealerDotComExtract } from './dealerdotcom.js';
import { carsForSaleExtract } from './carsforsale.js';

/**
 * Registro plataforma → extractor. Las claves coinciden con las etiquetas que
 * produce el detector de plataforma (detect-platform.js / platform-map.csv).
 * El worker enruta por aquí; si la plataforma no está, cae a la cascada genérica.
 */
export const PLATFORM_EXTRACTORS = {
  DealerCenter: dwsExtract,
  DealerCarSearch: dwsExtract,
  dws: dwsExtract,
  DealerSync: dealerSyncExtract,
  dealersync: dealerSyncExtract,
  'Dealr.cloud': dealrExtract,
  dealr: dealrExtract,
  OverFuel: overfuelExtract,
  overfuel: overfuelExtract,
  DealerInspire: dealerInspireExtract,
  dealerinspire: dealerInspireExtract,
  'Dealer.com': dealerDotComExtract,
  dealercom: dealerDotComExtract,
  'CarsForSale.com': carsForSaleExtract,
  carsforsale: carsForSaleExtract,
};

/** Devuelve el extractor para una plataforma, o null si no hay uno específico. */
export function extractorFor(platform) {
  if (!platform) return null;
  return PLATFORM_EXTRACTORS[platform] || PLATFORM_EXTRACTORS[String(platform).toLowerCase()] || null;
}
