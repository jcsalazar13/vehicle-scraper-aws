# Flujo completo del scraper por plataforma

Diagrama end-to-end: desde la lista de dealers hasta los vehículos en la BD, con
**todos los casos/patrones** y la **capa de fetch gestionada** (anti-bot).

---

## Vista general

```
 LISTA DE DEALERS (CSV)
        │
        ▼
 ┌───────────────────────┐
 │ 1. LIMPIEZA            │  quitar QA/test/emails · dedup por dominio · corregir
 │    (extract urls)      │  desalineación nombre↔web
 └──────────┬────────────┘
            │  870 dominios reales (de 1157 filas)
            ▼
 ┌───────────────────────┐
 │ 2. DETECCIÓN DE         │  detect-platform.js  →  platform-map.csv
 │    PLATAFORMA           │  (un dealer → su plataforma)
 └──────────┬────────────┘
            ▼
 ┌───────────────────────┐
 │ 3. ROUTING             │  según plataforma detectada, elegir extractor / camino
 └──────────┬────────────┘
            ▼
 ┌───────────────────────┐
 │ 4. FETCH (escalonado)  │  Tier 1 navegador → Tier 2 servicio gestionado si bloqueo
 └──────────┬────────────┘
            ▼
 ┌───────────────────────┐
 │ 5. EXTRACCIÓN          │  parser específico de la plataforma (listado en bloque)
 └──────────┬────────────┘
            ▼
 ┌───────────────────────┐
 │ 6. NORMALIZACIÓN       │  esquema unificado · dedup por VIN/stock
 └──────────┬────────────┘
            ▼
 ┌───────────────────────┐
 │ 7. PERSISTENCIA        │  vehicles + scrape_run_results (idempotente)
 └───────────────────────┘
```

---

## 2. Detección de plataforma — 3 capas

```
 URL del dealer
     │
     ▼
 ┌──────────────────────────────┐
 │ Tier A: DNS / CNAME (gratis)  │  ¿el host apunta a un vendor conocido?
 │                              │  alpha.dcdws.net→DealerCarSearch · dealercenterwebsite.net→DealerCenter
 │                              │  v12soft · godealergo · mycarsonline · motorlot…
 └───────┬──────────────────────┘
         │ no resuelto
         ▼
 ┌──────────────────────────────┐
 │ Tier B: HTTP + marcadores HTML│  fetch del home → buscar firmas en el HTML
 │                              │  dealersync · overfuel · dealrcloud · carsforsale · ws-inv-data…
 └───────┬──────────────────────┘
         │ 403/429 (Cloudflare) o sin match
         ▼
 ┌──────────────────────────────┐
 │ Tier C: navegador headless    │  renderiza y vuelve a buscar firmas
 └───────┬──────────────────────┘
         ▼
   CLASIFICACIÓN (uno de):
     • Plataforma white-label conocida   → §3 ROUTING (extractor)
     • Anti-bot (DataDome/Cloudflare)     → §4 FETCH escalonado
     • Sin web (DNS muerto / parqueado)   → DESCARTAR (marcar en lista)
     • Genérico (WordPress/GoDaddy/Duda)  → IA-fallback
     • Custom / desconocido               → IA-fallback (o minar firma nueva)
```

---

## 3. Routing — todos los patrones

| Plataforma detectada | Camino | Estado | Fidelidad |
|---|---|---|---|
| **DealerCenter** | extractor `dws` | ✅ | VIN+millaje+precio 100% |
| **DealerCarSearch** | extractor `dws` (mismo markup) | ✅ | 100% |
| **DealerSync** | extractor `dealersync` | ✅ | VIN 100%, millaje 88% |
| **Dealr.cloud** | extractor `dealr` | ✅ | VIN 98%, millaje 100% |
| **OverFuel** | extractor `overfuel` | ✅ | 100% |
| **DealerInspire** | extractor `dealerinspire` (API Cars Commerce) | ✅ | VIN+millaje 100% |
| **Dealer.com** | extractor `dealercom` | ⚠️ experimental | variable |
| **CarsForSale** | (marketplace + DataDome) | ⏸ diferido | — |
| AutoManager / AutoRevo / DealerFire / AutoCorner | extractor nuevo, o §3.5 cascada genérica | ⏳ pendiente | — |
| **WordPress / GoDaddy / Duda / Wix / Shopify** | §3.5 cascada genérica → IA | ✅ existe | parcial |
| **DataDome / Cloudflare duro** | §4 fetch gestionado → extractor o §3.5 | infra | depende |
| **Custom / desconocido** | **§3.5 cascada genérica** (API → JSON embebido → navegación → IA) | ✅ existe | parcial |
| **DNS muerto / parqueado** | DESCARTAR | — | — |

> **Dos caminos complementarios:** si la plataforma es conocida → extractor específico
> (rápido, alta fidelidad). Si es custom/desconocida → **§3.5 cascada genérica**, que
> NO salta directo a IA: primero intenta API y JSON embebido (gratis y preciso), y deja
> la IA como último recurso.

---

## 3.5 Cascada genérica (custom / desconocido) — API + JSON embebido + navegación + IA

Es el **pipeline original** (`src/strategies/`, intacto), para dealers sin plataforma
reconocida. Va de lo más barato/preciso a lo más caro, y **la IA es el último recurso**,
no el primero:

```text
 url (custom / desconocido)
        │
        ▼
 ┌─ 1) API (api.js) ──────────────────────────────────────────────┐
 │   descarga el home → detectPlatform(html) → prueba endpoints     │
 │   conocidos + genéricos (/api/inventory, /inventory.json,        │
 │   /wp-json/.../inventory, widgets…)                              │
 │   ¿algún endpoint devuelve JSON con array de vehículos?          │
 └───────┬──────────────────────────────── sí → vehículos ✔ ───────┘
         │ no
         ▼
 ┌─ 2) HTML EMBEBIDO (embedded.js) ───────────────────────────────┐
 │   sobre el HTML ya descargado + rutas de inventario, busca:      │
 │     a) JSON-LD schema.org  (Vehicle / Car / Product)  ← estándar │
 │        cross-dealer, el más fiable sin saber la plataforma       │
 │     b) estado de framework: __NEXT_DATA__, __NUXT__,             │
 │        __INITIAL_STATE__, __PRELOADED_STATE__, window.inventory  │
 │     c) cualquier <script> con array JSON que parezca vehículos   │
 └───────┬──────────────────────────────── encontrado → vehículos ✔┘
         │ no
         ▼
 ┌─ 3) NAVEGACIÓN (navigate.js, browser vía fetch §4) ────────────┐
 │   intercepta XHR/fetch JSON · sigue el link de inventario ·     │
 │   scroll lazy-load · extrae tarjetas del DOM · pagina           │
 └───────┬──────────────────────────────── encontrado → vehículos ✔┘
         │ no
         ▼
 ┌─ 4) IA (ai.js) — último recurso ──────────────────────────────┐
 │   HTML renderizado limpio → Claude extrae JSON estructurado    │
 │   (requiere ANTHROPIC_API_KEY; si no hay, se omite con razón)  │
 └───────┬───────────────────────────────────────────────────────┘
         ▼
   normalizeMany → BD   (igual que el camino por plataforma)
```

Notas:
- Pasos **1 y 2 son HTTP plano** → en sitios con Cloudflare/DataDome dan 403 y la cascada
  cae al paso **3 (navegación)**, que sí usa el navegador con el **fetch escalonado §4**.
- El paso 2 (**JSON-LD**) es el gran nivelador: muchos sitios custom igual exponen
  schema.org Vehicle, y eso evita pagar IA.
- Por eso "custom" **no es** sinónimo de "IA": la mayoría se resuelve en API o JSON embebido.

---

## 4. Capa de FETCH escalonada (anti-bot)  ← el servicio gestionado

Cada navegación de cada extractor pasa por `gotoTiered(page, url)`:

```
            gotoTiered(page, url)
                    │
                    ▼
        ┌───────────────────────────┐
        │ TIER 1: navegador headless │   page.goto(url)  (gratis)
        └─────────────┬─────────────┘
                      ▼
              ┌───────────────┐
              │ isBlocked()?  │   ¿Cloudflare "just a moment"? ¿DataDome
              │               │   captcha-delivery? ¿HTTP 403/429/503?
              └───┬───────┬───┘   ¿HTML < 1500 bytes?
              NO  │       │  SÍ
                  ▼       ▼
            ┌─────────┐  ┌────────────────────────────────────┐
            │ usar el │  │ ¿hay SCRAPER_API_KEY?               │
            │ DOM     │  └───────┬──────────────────┬─────────┘
            │ (Tier 1)│      SÍ  │              NO   │
            └─────────┘          ▼                  ▼
                      ┌────────────────────┐  ┌──────────────────┐
                      │ TIER 2: servicio    │  │ degradar:         │
                      │ gestionado          │  │ marcar BLOQUEADO  │
                      │ scrapfly|zenrows|   │  │ (sin escalado)    │
                      │ scrapedo|scrapingbee│  └──────────────────┘
                      │ (proxies+CAPTCHA+JS)│
                      └─────────┬──────────┘
                                ▼
                      page.setContent(html)   ← inyecta el HTML resuelto
                                │
                                ▼
                      el extractor sigue igual
                      (page.evaluate sobre el DOM)
```

- **Tier 1 ya pasa muchos Cloudflare** (offleaseimports lo cruzó sin nada).
- **Tier 2 solo se invoca al ser bloqueado** → aísla el costo a los ~100 DataDome.
- **El extractor no sabe ni le importa** de qué tier vino el HTML.
- Config: `SCRAPER_PROVIDER` + `SCRAPER_API_KEY` (sin key → solo Tier 1).

---

## 5-6. Extracción + normalización (común a todas las plataformas)

```
 HTML / API del listado (del fetch)
        │
        ▼
 parser de la plataforma  →  tarjetas crudas { vin, year, make, model, mileage, price, … }
        │                    (lee el LISTADO en bloque — NO visita fichas una por una)
        ▼
 paginación (?page_no / ?page / _p / scroll / botón Next)  → acumular
        │
        ▼
 normalizeMany()  →  esquema unificado + dedup por VIN (o stock / make+model+year+url)
        │
        ▼
 vehículos normalizados
```

**Por qué es rápido:** el sistema viejo visitaba la ficha de cada coche (60 min / 56 autos).
Aquí se lee el listado completo en una sesión → **segundos** (ej. DealerSync 104 autos en 13s).

---

## 7. Persistencia (idempotente)

```
 vehículos normalizados
        │
        ├─► upsertVehicles()   ON CONFLICT (dealer_id, vin) → no duplica;
        │                      COALESCE para no borrar campos en re-scrape
        │
        └─► recordResult()     scrape_run_results: estrategia ganadora, nº vehículos,
                               razones, duración, worker  (UNIQUE run_id+url → idempotente)
        ▼
 tablas: dealers · vehicles · scrape_runs · scrape_run_results
```

Salida lista para el match (Zoomer): `vin · year · make · model · mileage · stock · price`.

---

## Resultado por dealer (todos los desenlaces posibles)

```
 dealer
   ├─ plataforma conocida + accesible        → ✅ inventario completo en segundos
   ├─ plataforma conocida + Cloudflare        → ✅ Tier 1 (o Tier 2 si hace falta)
   ├─ plataforma conocida + DataDome          → ✅ Tier 2 (con SCRAPER_API_KEY) | 🔴 sin key
   ├─ DealerInspire (API)                     → ✅ datos riquísimos vía Cars Commerce
   ├─ Dealer.com                              → ⚠️ parcial (extractor experimental / genérico)
   ├─ WordPress / GoDaddy / custom            → cascada §3.5:
   │     ├─ tiene API o JSON-LD/embebido      → ✅ sin IA
   │     ├─ solo render dinámico              → ✅ navegación (DOM/XHR)
   │     └─ nada de lo anterior               → 🤖 IA (último recurso)
   ├─ CarsForSale (marketplace)               → ⏸ diferido (vía feed con hash de dealer)
   └─ DNS muerto / parqueado (~22% flota)     → ⛔ descartar (sin web scrapeable)
```

---

## Comandos del flujo

```bash
# 1-2. limpiar + detectar plataforma de toda la flota
node src/detect-platform.js urls.fleet.txt           # → platform-map.csv

# 3-7. extraer un dealer (el routing elige la plataforma; el fetch escala solo)
node src/extract.js dws           https://www.offleaseimports.com
node src/extract.js dealersync    https://auto206.com
node src/extract.js dealr         https://coloradomotorcars.com
node src/extract.js overfuel      https://jerryhuntsupercenter.com
node src/extract.js dealerinspire https://www.fordofupland.com

# probar solo la capa de fetch (anti-bot)
node src/fetch-test.js https://feelgoodmotors.com    # DataDome → detecta bloqueo

# activar el servicio gestionado
export SCRAPER_PROVIDER=scrapfly
export SCRAPER_API_KEY=tu_key
```
