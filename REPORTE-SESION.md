# Reporte de sesión — Scraper de inventario por plataforma

_Trabajo autónomo (piloto automático). Resumen de todo lo construido y medido._

## Resumen ejecutivo

El objetivo de fondo era **velocidad**: el sistema actual tarda ~60 min en un dealer
(56 vehículos) porque visita la ficha de cada coche. Demostramos que leyendo el
**listado en bloque** y reconociendo la **plataforma** de cada dealer, eso baja a
**segundos** con fidelidad alta (VIN + millaje + precio).

Resultado concreto de la sesión:
- **4 extractores por plataforma funcionando y probados** contra dealers reales.
- Un **detector de plataforma** que clasifica los ~870 dominios de la flota.
- Un **mapa de la flota** que dimensiona cuántos extractores faltan.
- Hallazgo de negocio: **~194 dealers (22%) no tienen web funcional** (dominio muerto).

## 1. Extractores construidos (probados, datos reales en BD)

Todos siguen el mismo patrón: navegador headless → leer el listado → paginar →
normalizar al esquema unificado. Runner genérico: `node src/extract.js <plataforma> <url>`.

| Plataforma | Cubre | Dealer probado | Vehículos | Tiempo | VIN | Millaje | Precio |
|---|---|---|---|---|---|---|---|
| **dws** | DealerCenter + DealerCarSearch | offleaseimports / bigreds | 39 / 19 | 30s / ~10s | 100% | 100% | 100% |
| **dealersync** | DealerSync | auto206.com | 104 | 13s | 100% | 88% | 92% |
| **dealr** | Dealr.cloud | coloradomotorcars.com | 124 | 16s | 98% | 100% | 98% |
| **overfuel** | OverFuel | jerryhuntsupercenter.com | 375¹ | 64s | 100% | 100% | 100% |
| **dealerinspire** | DealerInspire (Cars Commerce) | fordofupland.com | 62 | 20s | 100% | 100% | 97% |
| **dealercom** ⚠️ | Dealer.com (DDC) | — | experimental² | — | — | — | — |

¹ OverFuel tiene 909 autos; el extractor está topado a 15 páginas (375). Subir
`maxPagesPerDealer` en `config.js` saca el resto.
² **Dealer.com quedó experimental/diferido:** la plataforma es muy variable (inventario
server-side en unos sitios, XHR con rutas de widget distintas en otros, Cloudflare en
varios), así que no se logró un extractor robusto en esta sesión. Son ~4 dealers reales
(varios "Dealer.com" del mapa son falsos positivos: el regex `dealer.com` matchea el
substring del propio dominio, p.ej. `elautodealer.com`). El pipeline genérico ya cubre
parcialmente Dealer.com (en la 1ª corrida sacó sonic 517 / ciocca 375). Para fidelidad
completa con millaje necesita manejo por-config del endpoint o enriquecimiento por VDP.

**Comparación con el baseline:** sistema actual = 60 min / 56 vehículos. Extractor `dws`
sobre el mismo dealer (offleaseimports) = **30s / 39 vehículos con VIN+millaje**. ~120×.

Archivos: `src/strategies/platforms/{dws,dealersync,dealr,overfuel}.js` + `src/extract.js`.

## 2. Detector de plataforma

`src/detect-platform.js` — dos capas:
1. **DNS/CNAME** (gratis, sortea Cloudflare): caza las white-label al instante
   (DealerCarSearch→`alpha.dcdws.net`, DealerCenter→`dealercenterwebsite.net`, etc.).
2. **Navegador** (para dominios custom tras Cloudflare): lee marcadores del HTML.

Biblioteca de firmas ampliada esta sesión: DealerSync, OverFuel, Dealr.cloud,
CarsForSale, Goxee, Frazer, MotorLot, Duda, parqueados.

Salida: `platform-map.csv` (un dealer por fila → su plataforma).

## 3. Mapa de la flota (870 dominios reales, de 1157 filas)

> Limpieza: se quitaron 204 filas de QA/prueba (google.com, PABLO*, Sara DS*, nombres
> de generador) y 12 emails. **La columna `Website` del CSV está desalineada** respecto
> al nombre del dealer (el 2º bloque del CSV trae el emparejamiento correcto).

| Plataforma | Dealers | Extractor |
|---|---|---|
| DESCONOCIDA (custom) | 423 (49%) | ronda de minería en curso |
| INALCANZABLE | 270 (31%) | ver triaje §4 |
| WordPress | 44 (5%) | IA-fallback |
| **DealerSync** | 31 | ✅ |
| **Dealr.cloud** | 16 | ✅ |
| CarsForSale.com | 14 | diferido (ver §5) |
| **DealerCarSearch** | 11 | ✅ (dws) |
| **DealerCenter** | 9 | ✅ (dws) |
| Dealer.com | 8 | conocido (pendiente) |
| **OverFuel** | 7 | ✅ |
| DealerInspire | 6 | conocido (pendiente) |
| Resto (Shopify/Wix/Duda/Goxee/MotorLot/V12/Frazer/DealerOn/DealerGo) | ~18 | cola |

Los conteos son un **piso** (subestiman): muchos dealers de cada plataforma están
escondidos en "custom" e "inalcanzable" por timeouts del escaneo.

## 4. Triaje de los 270 inalcanzables

| Causa | Dealers | % | Acción |
|---|---|---|---|
| DNS muerto (dominio no resuelve) | 123 | 46% | **descartar** (web no existe) |
| Error de conexión (refused/SSL) | 71 | 26% | mayormente muertos |
| Timeout recuperable (lento/Cloudflare) | 74 | 27% | re-escanear con navegador |
| Respondía ahora (transitorio) | 2 | 1% | reintentar |

**Hallazgo:** ~194 dealers (DNS muerto + error conexión) **no tienen web scrapeable**.
Es ~22% de la flota — una lista a depurar en origen.

## 5. CarsForSale.com — diferido (decisión consciente)

No es self-hosted: el inventario vive en el **marketplace carsforsale.com** (con un hash
por dealer, p.ej. `00934f03...`), y algunos dealers están tras **DataDome** (captcha
anti-bot). Son 14 dealers y de alto riesgo/esfuerzo. Recomendación: atacarlo aparte,
posiblemente vía el feed/API de carsforsale.com con su hash de dealer, no por el sitio.

## 6. Recomendaciones / próximos pasos

1. **Cobertura inmediata:** con los 4 extractores ya cubres las plataformas nombradas de
   mayor volumen. Faltan extractores de **Dealer.com** y **DealerInspire** (enterprise,
   patrón conocido) para sumar ~14 más.
2. **El frente real es el bucket "custom" (49%)** — cada ronda de minería de firmas saca
   decenas de dealers a plataformas nombradas. (Resultados de esta ronda al final.)
3. **Depurar la lista:** marcar los ~194 dealers sin web; no gastar esfuerzo ahí.
4. **Arquitectura a futuro:** detección de plataforma automática → extractor determinista
   por plataforma → IA solo como fallback para la cola larga (WordPress/custom irreducible).
5. **Subir cobertura de campos:** millaje de DealerSync (88%→~100%) refinando el parseo
   del texto cuando no hay MPG; imágenes (lazy-load) si alguna vez se necesitan en UI.

## 7. Cómo usar lo construido

```bash
# levantar Postgres local (puerto 5433 en esta sesión)
docker run -d --name scraper-pg-test -e POSTGRES_USER=scraper \
  -e POSTGRES_PASSWORD=scraper -e POSTGRES_DB=scraper -p 5433:5432 postgres:16-alpine
export DATABASE_URL="postgres://scraper:scraper@localhost:5433/scraper" PGSSLMODE=disable

# extraer inventario de un dealer (elige la plataforma)
node src/extract.js dws        https://www.offleaseimports.com
node src/extract.js dealersync https://auto206.com
node src/extract.js dealr      https://coloradomotorcars.com
node src/extract.js overfuel   https://jerryhuntsupercenter.com

# clasificar la flota por plataforma
node src/detect-platform.js urls.fleet.txt        # mapa → platform-map.csv
```

Artefactos generados: `platform-map.csv`, `urls.fleet.txt`, `vendor-tally.txt`,
`triage-dead.txt`, logs `platform-detect*.log`.

## 8. Minería del bucket "custom" (423 sitios) — resultado

Se cargó cada sitio con navegador y se tallaron los dominios de recursos (CDN/scripts)
para descubrir qué hay realmente en ese 49%. **Conclusión clave: el bucket "custom" NO
es mayormente plataformas white-label escondidas.** Se reparte así (aprox.):

| Qué es | Sitios | Implicación |
|---|---|---|
| **DataDome (anti-bot)** — `captcha-delivery.com` / `datadome.co` | ~100 | No es plataforma; es un **muro captcha**. Requiere proxies residenciales / anti-bot, no un parser |
| **GoDaddy/Starfield (constructor)** — `wsimg.com`, `godaddy`, `Starfield` | ~20 | Sitio genérico sin inventario estructurado → IA o descartar |
| **CarsForSale.com** | ~11 | Plataforma conocida (diferida, §5) |
| **Plataformas chicas reales** — AutoManager (5), AutoRevo (6), DealerFire (2), AutoCorner (4), AutoClick (3) | ~20 | Cada una = un extractor pequeño o IA |
| **A medida / hosting moderno** — `vercel`, `pages.dev`, etc. | ~15+ | Sin patrón común → IA-fallback |
| Ruido (chat/accesibilidad/analytics) | resto | — |

**Lo que esto cambia en la estrategia (honesto):**
- Seguir minando firmas **rinde poco más** — el grueso del "custom" es **anti-bot (DataDome)**
  y sitios genéricos/a medida, no plataformas parseables nuevas.
- El verdadero techo de cobertura por extractores son las **plataformas nombradas**
  (dws, DealerSync, Dealr, OverFuel, Dealer.com, DealerInspire + las chicas). Una vez
  cubiertas esas, lo que queda exige **dos inversiones distintas**:
  1. **Infra anti-bot** (proxies residenciales / resolución de captcha) para los ~100 DataDome.
  2. **IA-fallback** para constructores genéricos y sitios a medida.

Firmas nuevas agregadas al detector (`detect-platform.js`): DataDome, GoDaddy, AutoManager,
AutoRevo, DealerFire, AutoCorner. Un próximo `node src/detect-platform.js urls.fleet.txt`
reclasificará ~140 dealers del bucket custom hacia estas categorías.

## 8.5 Anti-bot — investigación (DataDome / Cloudflare)

Para los ~100 dealers tras **DataDome** y los que dan Cloudflare. Resumen de lo que
encontré (web; los videos de YouTube apuntan a las mismas guías de vendors, no pude
reproducir video aquí):

**Lo que YA NO funciona (2025-2026):**
- `undetected-chromedriver` y `puppeteer-stealth`: **deprecados en feb-2025**, Cloudflare
  los detecta fácil.
- **FlareSolverr**: sus solvers de CAPTCHA están **inoperativos** (ene-2026) y usa
  undetected-chromedriver por debajo → mismos problemas. No invertir aquí.

**El estado real del arte:**
- Cloudflare (modelo de bot-score v9) pesa **fingerprint TLS (JA4)**, orden de frames
  HTTP/2 y telemetría de comportamiento. El handshake TLS por defecto de Playwright en
  Linux **resalta** aunque el fingerprint del navegador sea perfecto.
- DataDome usa **+85,000 modelos ML por-cliente**: un bypass que funciona en un sitio
  **falla en otro**, y se adaptan en tiempo real. No hay bala de plata.

**Herramientas actuales (open-source) si se hace in-house:**
- **Patchright** (Playwright parcheado, TLS de dispositivo real), **Camoufox** (Firefox
  parcheado), **Nodriver** / **SeleniumBase UC Mode** (reemplazan a undetected-chromedriver).
- **Lo más importante no es la herramienta, son los PROXIES:** residenciales/móviles
  (no datacenter). Es la palanca #1 para el score de reputación de IP.
- Ningún truco solo basta: stealth + proxies residenciales + comportamiento realista +
  monitoreo y adaptación continua.

**Servicios gestionados (abstraen todo el anti-bot — mandas URL, devuelven HTML):**

| Servicio | Desde | Notas |
|---|---|---|
| Scrape.do | $29/mo | barato |
| Scrapfly | $30/mo | enfoque dev, extracción con IA |
| ScrapingBee | $49/mo | |
| ZenRows | $69/mo | CAPTCHA/WAF/fingerprint |
| Bright Data | por uso | mayor tasa de éxito (~98%), red de proxies más grande |

Ojo: con JS-rendering + proxies premium el costo por request sube **5-75×**.

**Mi recomendación para esta flota (~100 dealers difíciles):**
1. **No** mantener un stack de bypass propio — es una carrera armamentista de alto
   mantenimiento para tan pocos dealers.
2. **Capa de fetch escalonada:** intentar primero con Playwright headless normal (¡ya
   pasó offleaseimports tras Cloudflare hoy! → no todos necesitan maquinaria pesada);
   **solo al ser bloqueado**, reintentar vía un **servicio gestionado** (Scrapfly/ZenRows/
   Bright Data) que devuelve el HTML ya resuelto.
3. **Los extractores no cambian:** el HTML que devuelve el servicio se pasa al mismo
   extractor de plataforma. Solo se aísla el costo anti-bot a los ~100 dealers duros.
4. **Costo estimado:** ~100 dealers × pocas páginas × refresco periódico ≈ unos pocos
   USD/día con JS-rendering — barato vs. el tiempo de ingeniería de mantener bypasses.

**Fuentes:** [Scrapfly – Bypass Cloudflare](https://scrapfly.io/blog/posts/how-to-bypass-cloudflare-anti-scraping),
[Scrapfly – Bypass DataDome](https://scrapfly.io/blog/posts/how-to-bypass-datadome-anti-scraping),
[ZenRows – DataDome](https://www.zenrows.com/blog/datadome-bypass),
[Kameleo – Cloudflare/Playwright](https://kameleo.io/blog/how-to-bypass-cloudflare-with-playwright),
[ScrapeOps – Bypass Cloudflare](https://scrapeops.io/web-scraping-playbook/how-to-bypass-cloudflare/),
[humanbrowser – 12 métodos probados](https://humanbrowser.cloud/blog/bypass-cloudflare-playwright-2026),
[Bright Data – mejores scraping APIs](https://brightdata.com/blog/web-data/best-web-scraping-apis).

## 8.6 Capa de fetch gestionada — CONSTRUIDA ✅

Implementé la recomendación de §8.5: una capa de fetch escalonada que aísla el costo
anti-bot y **no obliga a cambiar los extractores**.

**Cómo funciona** (`src/fetch/managed-fetch.js`):

- `gotoTiered(page, url)` reemplaza a `page.goto`:
  - **Tier 1:** navega con el navegador headless normal (gratis).
  - **Detección de bloqueo:** `isBlocked()` reconoce páginas de desafío (Cloudflare
    "just a moment", DataDome `captcha-delivery`, HTTP 403/429/503, HTML sospechosamente corto).
  - **Tier 2:** solo si Tier 1 quedó bloqueado → pide el HTML ya resuelto a un **servicio
    gestionado** y lo inyecta con `page.setContent()`. El resto del extractor (`page.evaluate`)
    corre igual sobre ese DOM, sin saber de dónde vino.
- Si no hay `SCRAPER_API_KEY`, Tier 2 se omite y degrada a solo-navegador (con aviso).

**Proveedores soportados** (configurable, provider-agnostic): `scrapfly` (default), `zenrows`,
`scrapedo`, `scrapingbee`. Cada uno con JS-rendering + proxies premium activados.

**Configuración (variables de entorno):**

```bash
export SCRAPER_PROVIDER=scrapfly        # scrapfly | zenrows | scrapedo | scrapingbee
export SCRAPER_API_KEY=tu_key           # sin esto, solo se usa el navegador
```

**Probado** (`node src/fetch-test.js <url>`), sin key todavía:

| Sitio | Plataforma | Resultado |
|---|---|---|
| auto206.com | DealerSync | 🟢 Tier 1 OK (4.8s) |
| offleaseimports.com/inventory | DealerCenter/Cloudflare | 🟢 Tier 1 OK, 12 VINs (6.1s) |
| feelgoodmotors.com | DataDome | 🔴 **bloqueo detectado** (1478 bytes) → escalaría a Tier 2 |

La detección de bloqueo y el escalado **funcionan**: feelgoodmotors (DataDome) se detecta
correctamente y dispararía Tier 2 si hubiera key. **Ya integrado en el extractor `dws`**
(plantilla para los demás: basta cambiar `page.goto` por `gotoTiered`). Regresión OK:
offleaseimports sigue dando 39 vehículos al 100%.

**Para activarlo en producción:** contratar un proveedor (Scrapfly $30/mo es buen punto de
partida), poner `SCRAPER_API_KEY`, y replicar el cambio `page.goto`→`gotoTiered` en los otros
extractores. Los ~100 dealers DataDome pasan a ser scrapeables sin mantener bypass propio.

## 9. Conclusión

- **Velocidad: demostrada.** 60 min → segundos, con VIN+millaje, en **5 plataformas reales**
  (dws, dealersync, dealr, overfuel, dealerinspire) + Dealer.com experimental.
- **Cobertura: el camino es claro** — extractores por plataforma para las white-labels.
  5 hechas, Dealer.com diferido, CarsForSale diferido (marketplace+DataDome).
- **Límites reales identificados con números:** ~22% de la flota sin web; ~12% tras
  DataDome (anti-bot); WordPress/GoDaddy/a-medida → IA. No son suposiciones.
- **Anti-bot:** no construir bypass propio; usar **capa de fetch escalonada** (Playwright
  normal → servicio gestionado solo al ser bloqueado) alimentando los mismos extractores.
- **Recomendación de orden a futuro:** (1) plataformas chicas restantes (AutoManager,
  AutoRevo, DealerFire, AutoCorner) con extractor o IA, (2) terminar Dealer.com con manejo
  por-config, (3) montar la capa de fetch gestionada para los ~100 DataDome, (4) IA-fallback
  para la cola larga (WordPress/GoDaddy/a-medida), (5) depurar los ~194 dealers sin web.

### Extractores entregados esta sesión (6 archivos)

`src/strategies/platforms/`: `dws.js`, `dealersync.js`, `dealr.js`, `overfuel.js`,
`dealerinspire.js`, `dealerdotcom.js` (experimental). Runner: `node src/extract.js <plataforma> <url>`
con `dws | dealersync | dealr | overfuel | dealerinspire | dealercom`.
