# Vehicle Inventory Scraper — AWS (SQS + ECS Fargate + PostgreSQL)

Scraper distribuido de inventario de vehículos para hasta 500+ dealers por corrida.
Por cada URL intenta en orden: **API → HTML embebido → Navegación (Playwright) → IA**,
y registra en la base de datos la estrategia ganadora o las razones de fallo de cada una.

## Arquitectura

```
EventBridge Scheduler (opcional)
        │
        ▼
Lambda "dispatcher" ──► SQS (1 mensaje por dealer) ──► DLQ (fallos repetidos)
   (lee urls.txt              │
    desde S3)                 ▼  auto scaling por profundidad de cola (0 → 25 tareas)
                      ECS Fargate workers (imagen Playwright)
                              │  2 dealers en paralelo por tarea
                              ▼
                      RDS PostgreSQL (dealers, vehicles, scrape_runs, scrape_run_results)
```

- **Idempotente**: `scrape_run_results` tiene `UNIQUE(run_id, url)` y los vehículos se
  deduplican por VIN, así que una reentrega de SQS nunca duplica datos.
- **Reintentos**: los fallos de scraping (razones deterministas) se registran y no se
  reintentan; los fallos de infraestructura (BD caída, timeout) dejan el mensaje en la
  cola y tras 3 intentos van a la DLQ.
- **Costo**: los workers escalan a 0 cuando la cola se vacía; solo pagas mientras corre
  (~1–2 USD por corrida de 500 dealers) + RDS t4g.micro (~12 USD/mes). Sin NAT Gateway:
  las tareas usan IP pública.

## Despliegue (una sola vez)

Requisitos: Terraform >= 1.5, Docker, AWS CLI configurado.

```bash
cd ../vehicle-scraper-iac                       # la infra vive en el folder hermano
cp terraform.tfvars.example terraform.tfvars   # edita región/repo (los secretos van aparte)
terraform init
terraform apply        # al final imprime "next_steps" con los comandos exactos
```

Luego construye y sube la imagen (los comandos exactos con tu cuenta salen en `next_steps`):

```bash
aws ecr get-login-password | docker login --username AWS --password-stdin <ECR_URL>
docker build --platform linux/amd64 -t <ECR_URL>:latest .
docker push <ECR_URL>:latest
```

## Lanzar una corrida

```bash
# 1) Sube la lista de dealers (una URL por línea, # para comentarios)
aws s3 cp urls.txt s3://<URLS_BUCKET>/urls.txt

# 2) Invoca el dispatcher
aws lambda invoke --function-name vehicle-scraper-dispatcher --payload '{}' out.json && cat out.json
# → {"runId":"run-2026-06-12T...","totalUrls":500,"enqueued":500}
```

El auto scaling detecta los mensajes, levanta los workers (5 → 15 → 25 tareas según el
backlog), procesa todo y vuelve a 0 tareas cuando la cola queda vacía 5 minutos.

También puedes pasar URLs directamente: `--payload '{"urls":["https://dealer1.com"]}'`,
o programar corridas automáticas con la variable `schedule_expression` de Terraform.

## Monitoreo

```bash
# Logs en vivo de los workers
aws logs tail /ecs/vehicle-scraper-worker --follow

# Estado de la cola
aws sqs get-queue-attributes --queue-url <QUEUE_URL> \
  --attribute-names ApproximateNumberOfMessagesVisible ApproximateNumberOfMessagesNotVisible

# Estado de la corrida (SQL)
SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT 5;
SELECT url, status, strategy_used, vehicles_found, left(reason,80)
  FROM scrape_run_results WHERE run_id = 'run-...' ORDER BY status;
```

RDS no es público: conéctate por SSM/bastion, o temporalmente añade tu IP al SG de RDS.

## Esquema de la base de datos

| Tabla | Contenido |
|---|---|
| `dealers` | Un registro por dealer: URL base, dominio, plataforma detectada. |
| `vehicles` | Inventario completo: VIN, stock, marca, modelo, trim, año, millaje, precio, MSRP, colores, transmisión, tracción, combustible, motor, carrocería, condición, localidad, URL de ficha, imagen, `raw_json`, estrategia, primera/última corrida en que se vio. Único por `(dealer_id, vin)`. |
| `scrape_runs` | Control de corridas: totales, OK/fallidas, vehículos, estado. Se cierra sola cuando llegan todos los resultados. |
| `scrape_run_results` | Resultado por URL: estrategia ganadora, JSON con cada estrategia intentada y su razón, vehículos nuevos/actualizados, duración, worker que lo procesó. |

Vehículos que salieron del inventario (vendidos): `SELECT * FROM vehicles WHERE last_seen_run <> '<runId más reciente>'`.

## Desarrollo local

```bash
docker compose up -d postgres        # PostgreSQL local
npm install && npm run browsers      # dependencias + Chromium
npm run scrape                       # procesa urls.txt sin SQS (modo local)
npm run report                       # resumen en terminal
```

## Ajustes

- `../vehicle-scraper-iac/variables.tf`: `max_workers`, `worker_concurrency`, tamaños de tarea y BD.
- `src/config.js`: timeouts, máximo de páginas, pausa entre requests, endpoints a probar.
- La versión de `playwright` en `package.json` debe coincidir con la de la imagen base
  del `Dockerfile` (actualmente 1.47.0).

## CI/CD (GitHub Actions)

El repo incluye dos workflows en `.github/workflows/` que despliegan automáticamente
al hacer push a `main`, autenticándose en AWS vía **OIDC** (sin access keys):

- **deploy-worker.yml** — cuando cambia `src/`, `Dockerfile` o `package.json`: construye
  la imagen, la sube a ECR con tags `latest` + SHA del commit y recicla el servicio ECS.
  Como las tareas escalan desde 0 en cada corrida y la task definition apunta a `latest`,
  toda corrida nueva usa siempre la última imagen.
- **deploy-dispatcher.yml** — cuando cambia `dispatcher/`: empaqueta y actualiza la Lambda.

Configuración (una sola vez):

1. En `terraform.tfvars` define `github_repo = "tu-usuario/tu-repo"` y aplica
   (`terraform apply`). Esto crea el proveedor OIDC y el rol; el output
   `github_actions_role_arn` te da el ARN.
   > Si tu cuenta AWS ya tiene el proveedor OIDC de GitHub (es único por cuenta),
   > impórtalo: `terraform import 'aws_iam_openid_connect_provider.github[0]' <su-arn>`.
2. En GitHub: Settings → Secrets and variables → Actions → **Variables**, crea:
   `AWS_ROLE_ARN` (el output anterior), `AWS_REGION`, `ECR_REPOSITORY`
   (`vehicle-scraper-worker`), `ECS_CLUSTER` (`vehicle-scraper`), `ECS_SERVICE`
   (`vehicle-scraper-worker`) y `LAMBDA_FUNCTION` (`vehicle-scraper-dispatcher`).
3. Sube el código al repo. El primer push a `main` ya despliega.

Ambos workflows también se pueden lanzar a mano (`workflow_dispatch`). El rol solo
puede asumirse desde la rama configurada (`github_branch`, por defecto `main`) y sus
permisos están limitados a este ECR, este servicio ECS y esta Lambda.

## Notas

- Antes de scrapear un sitio revisa sus términos de servicio y `robots.txt`; muchos
  dealers ofrecen feeds oficiales de inventario, que siempre serán la opción más estable.
- Sitios con anti-bot fuerte (Cloudflare) quedarán como `failed` con su razón en la BD.
- Si la BD crece o necesitas más conexiones, sube `db_instance_class` o añade RDS Proxy.
