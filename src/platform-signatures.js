/**
 * Firmas de detección de plataforma, compartidas por:
 *  - src/detect-platform.js  (detección masiva: DNS/CNAME + HTTP + fallback navegador local)
 *  - src/reprobe-blocked.js   (re-probe de los bloqueados vía Scraping Browser remoto)
 */

// Firmas por hostname/CNAME (señal más fuerte: no depende del HTML)
export const HOST_SIGNATURES = [
  [/dealercenterwebsite\.net|dealercenter\.net/i, 'DealerCenter'],
  [/mycarsonline\.com/i, 'DealerCarSearch'],
  [/v12soft\.com/i, 'V12Software'],
  [/godealergo\.com/i, 'DealerGo'],
  [/theshopclubs\.com/i, 'ShopClubs'],
  [/dealeron\.com/i, 'DealerOn'],
  [/dealerinspire\.com/i, 'DealerInspire'],
  [/dealer\.com|edgepilot|ddc\.com/i, 'Dealer.com'],
  [/wixsite\.com|wix\.com/i, 'Wix'],
  [/facebook\.com/i, 'Facebook (sin inventario)'],
];

// Firmas por contenido HTML
export const HTML_SIGNATURES = [
  [/dws-vehicle|dealercenter/i, 'DealerCenter'],
  [/ws-inv-data|data-widget-name|ddc\.com|"dealer\.com"/i, 'Dealer.com'],
  [/dealerinspire|di-cta|cms-content-di/i, 'DealerInspire'],
  [/dealeron|do-app|dealeroncdn/i, 'DealerOn'],
  [/mycarsonline|dealercarsearch/i, 'DealerCarSearch'],
  [/v12soft|v12software/i, 'V12Software'],
  [/motorlot/i, 'MotorLot'],
  [/dealersync/i, 'DealerSync'],
  [/overfuel/i, 'OverFuel'],
  [/dealrcloud|dealrimages|dealr\.cloud/i, 'Dealr.cloud'],
  [/carsforsale\.com/i, 'CarsForSale.com'],
  [/goxee/i, 'GoxeeDealer'],
  [/frazer/i, 'Frazer'],
  [/cdn-website\.com|dudaone|duda\.co/i, 'Duda (constructor)'],
  [/captcha-delivery\.com|datadome/i, 'DataDome (anti-bot)'],
  [/wsimg\.com|secureserver|starfield|godaddysites/i, 'GoDaddy (constructor)'],
  [/automanager\.com|deskmanager/i, 'AutoManager'],
  [/autorevo/i, 'AutoRevo'],
  [/dealerfire/i, 'DealerFire'],
  [/autocorner\.com/i, 'AutoCorner'],
  [/hugedomains|godaddy.*parked|domain.*for sale|expireddomains/i, 'PARQUEADO (en venta)'],
  [/wp-content|wp-json|wordpress/i, 'WordPress (genérico)'],
  [/wix\.com|_wixCssImports/i, 'Wix'],
  [/squarespace/i, 'Squarespace'],
  [/shopify/i, 'Shopify'],
];

export const matchHtml = (html) => { for (const [re, name] of HTML_SIGNATURES) if (re.test(html)) return name; return null; };
export const matchHost = (hostBlob) => { for (const [re, name] of HOST_SIGNATURES) if (re.test(hostBlob)) return name; return null; };
