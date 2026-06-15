# Notas de despliegue — worker nuevo en ECS Fargate (tiempo real, 0→25)

Todo lo construido esta sesión ya está **cableado al worker** que sube a ECS. La infra de
Fargate + autoescalado 0→25 ya existía; abajo solo lo que cambió y lo que tú haces para desplegar.

## Qué ejecuta ahora el worker (arquitectura nueva)

```
SQS msg {runId, url, platform}  →  worker.js  →  processUrl(url, runId, workerId, platform)
   │
   ├─ platform conocida (DealerCenter/DealerCarSearch/DealerSync/Dealr/OverFuel/
   │  DealerInspire/Dealer.com/CarsForSale)  →  extractor específico (registry.js)
   │     └─ usa gotoTiered: navegador → si DataDome/Cloudflare, Bright Data (Tier 2)
   │
   └─ sin platform o el extractor falla  →  cascada genérica (API → JSON embebido → navegación → IA)
```

- Routing: [src/pipeline.js](src/pipeline.js) + [src/strategies/platforms/registry.js](src/strategies/platforms/registry.js)
- Fetch anti-bot: [src/fetch/managed-fetch.js](src/fetch/managed-fetch.js)
- El dispatcher ahora acepta `platform` por dealer (string `"url,platform"` en S3, o
  `{"urls":[{"url","platform"}]}` en el payload).

## Cambios de Terraform (ya aplicados a los .tf, en `../vehicle-scraper-iac/`)

| Archivo | Cambio |
|---|---|
| `queue_db.tf` | **Un solo secreto `config`** (JSON) con DATABASE_URL + ANTHROPIC_API_KEY + SCRAPER_*; `ignore_changes` para llenarlo a mano |
| `ecs.tf` | el task lee cada clave del secreto único (`config:CLAVE::`) como env var |
| `iam.tf` | permiso de lectura del secreto `config` al rol de ejecución |
| `dispatcher.tf` | **`aws_lambda_function_url`** (trigger tiempo real, AWS_IAM) + scheduler **desactivado** por defecto |
| `outputs.tf` | outputs `dispatcher_function_url` y `config_secret_arn` |
| `variables.tf` | se quitaron las vars sensibles (van en el secreto, no en terraform) |

La escala **0→25 ya estaba** (`max_workers=25`, `min_capacity=0`, step-scaling por cola). No se tocó.

> **Estructura:** la infra (terraform) está en `../vehicle-scraper-iac/` (hermano de este
> proyecto). El código del worker (este folder, `vehicle-scraper-aws/`).

## Pasos para desplegar (los haces tú)

1. **Aplicar terraform** (crea el secreto único `config`, la Function URL, ECS, etc.):
   ```bash
   cd ../vehicle-scraper-iac
   cp terraform.tfvars.example terraform.tfvars   # ajusta region/repo (sin secretos)
   terraform init && terraform apply
   ```
2. **Llenar el secreto único a mano** (no va en terraform). Toma el ARN del output
   `config_secret_arn` y pon los valores reales:
   ```bash
   aws secretsmanager put-secret-value --secret-id <config_secret_arn> --secret-string '{
     "DATABASE_URL":"postgres://...:5432/scraper",   # ya viene pre-armado; consérvalo
     "ANTHROPIC_API_KEY":"sk-ant-...",
     "SCRAPER_API_KEY":"TU_TOKEN_BRIGHTDATA",         # rota el que compartiste en el chat
     "SCRAPER_PROVIDER":"brightdata",
     "SCRAPER_ZONE":"web_unlocker1"
   }'
   ```
   > Terraform ya dejó `DATABASE_URL` pre-armado y las demás vacías; con `ignore_changes`,
   > un `apply` futuro NO pisa lo que pongas aquí.
3. **Sembrar el espejo de la base de Playwright en ECR** (una sola vez; el `FROM` del
   Dockerfile apunta a este espejo, no a `mcr.microsoft.com`, que throttlea los pulls
   anónimos y rompe el build). Terraform ya creó el repo `vehicle-scraper-playwright-base`:
   ```bash
   PW=v1.47.0-jammy   # debe coincidir con "playwright" en package.json y el ARG PW_BASE del Dockerfile
   BASE=<ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com/vehicle-scraper-playwright-base:1.47.0-jammy
   docker pull --platform linux/amd64 mcr.microsoft.com/playwright:$PW   # cuando MCR no esté throttleado
   docker tag mcr.microsoft.com/playwright:$PW "$BASE"
   docker push "$BASE"
   ```
   > Solo hay que repetirlo al **subir de versión** de Playwright. Si MCR está throttleado,
   > se puede sembrar desde cualquier imagen amd64 que ya tenga la base (p.ej. una `:latest`
   > previa): `FROM <ECR_URL>:latest` + `USER root` + `RUN rm -rf /app`, build y push al espejo.
4. **Construir y subir la imagen** del worker (incluye todo el `src/` nuevo):
   ```bash
   cd ../vehicle-scraper-aws
   aws ecr get-login-password | docker login --username AWS --password-stdin <ECR_URL>
   docker build --platform linux/amd64 -t <ECR_URL>:latest .   # FROM = espejo ECR, sin tocar MCR
   docker push <ECR_URL>:latest
   ```

## Disparar una corrida EN TIEMPO REAL (no programado)

Tu app hace un **POST firmado SigV4** a `dispatcher_function_url` (output de terraform):

```bash
# ejemplo con awscurl (o firma SigV4 desde tu backend)
awscurl --service lambda -X POST "<DISPATCHER_FUNCTION_URL>" \
  -d '{"urls":[
        {"url":"https://www.offleaseimports.com","platform":"DealerCenter"},
        {"url":"https://auto206.com","platform":"DealerSync"},
        {"url":"https://alpha1automotivegroup.com","platform":"CarsForSale.com"}
      ]}'
```

- El dispatcher encola los dealers en SQS → la alarma de profundidad de cola enciende
  workers en ~60s → escalan 5→15→25 según backlog → vuelven a 0 al vaciarse.
- La app que invoca necesita permiso IAM `lambda:InvokeFunctionUrl` sobre la función.
- Si querés mandar la flota completa con sus plataformas, usá `platform-map.csv`
  (un dealer→plataforma por fila) como fuente.

## Pendientes / notas honestas

- **CarsForSale**: el listado (año/marca/modelo/precio) sale vía Bright Data; **VIN y millaje
  viven en la ficha (VDP)**, cuyo acceso es flaky — activable con `CARSFORSALE_ENRICH_VDP=true`
  (cuesta 1 request Bright Data por coche).
- **Dealer.com**: extractor experimental; cae a la cascada genérica si no resuelve.
- `gotoTiered` está integrado en `dws` y `carsforsale`. Los otros extractores (dealersync,
  dealr, overfuel, dealerinspire) hoy usan `page.goto` directo — esas plataformas no son
  DataDome, pero si alguna apareciera tras Cloudflare, basta cambiar su `page.goto`→`gotoTiered`.
- **Bright Data** mostró respuestas ocasionalmente vacías bajo muchas pruebas seguidas; en
  producción conviene un reintento simple en `fetchViaApi` (1-2 retries).
