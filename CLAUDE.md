# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Distributed vehicle-inventory scraper for car dealer websites. For each dealer URL it tries four
strategies **in order** — API → embedded HTML → browser navigation → AI — and persists the winning
strategy's inventory plus a per-strategy record of what was tried and why each one failed.

Two runtime modes share the same `src/pipeline.js` core:
- **Local** (`src/index.js`): processes a URL list sequentially against `DATABASE_URL`, no AWS.
- **Distributed** (`src/worker.js`): ECS Fargate workers long-poll SQS; a Lambda dispatcher
  (`dispatcher/index.mjs`) reads `urls.txt` from S3 and enqueues one message per dealer. Infra is
  Terraform in the sibling folder `../vehicle-scraper-iac/`.

The README (Spanish) is the authoritative operations guide — deploy, run, monitor, schema, CI/CD.

## Commands

```bash
# Local development
docker compose up -d postgres   # local PostgreSQL (scraper/scraper@localhost:5432/scraper)
npm install && npm run browsers  # deps + Chromium for the navigate strategy
npm run scrape                   # node src/index.js --urls urls.txt  (local mode, no SQS)
npm run scrape -- https://dealer1.com https://dealer2.com  # ad-hoc URLs
npm run report                   # terminal summary of recent runs (src/report.js)
npm run worker                   # run the SQS worker locally (needs QUEUE_URL + AWS creds)
```

There is **no test suite, linter, or build step** — it's plain ES modules (`"type": "module"`, Node >=18).
Verify changes by running `npm run scrape` against a few URLs and inspecting `npm run report` / the DB.

## Architecture

### The 4-strategy pipeline (`src/pipeline.js`)
`processUrl(url, runId, workerId)` is the heart of the system. It runs strategies sequentially and
**stops at the first one that returns `ok: true`**. Each strategy returns a uniform shape
`{ ok, vehicles, reason, attempts? }`; failures are *expected* and carry a human-readable `reason`.
Key data handoffs between strategies (don't break these):
- `api` returns the base-page `html` → reused by `embedded` to avoid a re-fetch.
- `navigate` returns `renderedHtml` → fed to `ai` so the AI never launches its own browser.

The pipeline always returns a row for `scrape_run_results` (status `ok` or `failed`); it does not throw
for scraping failures. `strategies_tried` is a JSON array logging every attempt and its reason — this is
the primary debugging artifact, so keep populating it when adding/altering strategies.

Strategies live in `src/strategies/`:
- `api.js` — detects platform from base HTML, probes known + generic API endpoints (`CONFIG.apiEndpointGuesses`).
- `embedded.js` — JSON-LD, framework initial-state (`__NEXT_DATA__`, `__NUXT__`, …), and inline JSON in `<script>`. Exports `extractFromHtml`, reused by `navigate.js`.
- `navigate.js` — Playwright Chromium: intercepts XHR/fetch JSON responses (cleanest source), follows the inventory link, scrolls for lazy-load, paginates up to `CONFIG.maxPagesPerDealer`.
- `ai.js` — sends cleaned `renderedHtml` to the Claude Messages API; **only runs if `ANTHROPIC_API_KEY` is set** and there is rendered HTML. Model is `CONFIG.ai.model`.

### Normalization (`src/normalizer.js`)
All four strategies funnel raw objects through `normalizeMany()`. It flattens nested objects, maps a
large alias dictionary (`KEY_MAP`, English + Spanish keys) onto the unified `vehicles` schema, coerces
types, validates VINs, and dedupes. A vehicle is kept only if `isValidVehicle` passes (has VIN, or
make+model, or make+year). **When the DB schema gains a vehicle column, update both `KEY_MAP` and
`VEHICLE_COLS` in `db.js`.**

### Persistence & idempotency (`src/db.js`)
`migrate()` runs the embedded `SCHEMA` (CREATE IF NOT EXISTS) on every startup — there are no migration
files; schema changes go directly in that string. Idempotency is the central design invariant because
SQS can redeliver:
- `scrape_run_results` has `UNIQUE(run_id, url)` + `ON CONFLICT DO NOTHING`.
- Vehicles dedupe by `(dealer_id, vin)` via a partial unique index; rows without a VIN fall back to
  manual matching on `stock_number` or `(make, model, year, url)`. Upserts use
  `COALESCE(EXCLUDED.col, existing.col)` so a sparser re-scrape never erases existing fields.
- `ensureRun`/`refreshRun` are concurrency-safe — any worker can call them; a run auto-finishes when
  result count reaches `total_urls`.
- "Sold" inventory is detected by `last_seen_run` lagging behind the latest run, not by deletion.

### Worker reliability contract (`src/worker.js`)
The distinction the whole retry model rests on:
- A **scraping result** (even `failed` with reasons) is final → record it and **delete** the SQS message
  (deterministic failures aren't worth retrying).
- An **infrastructure error** (DB down, timeout, uncaught throw) → **do not delete**; SQS redelivers and
  after `maxReceiveCount` the message goes to the DLQ. Each dealer has a hard `dealerTimeoutMs` < queue
  visibility timeout. SIGTERM (ECS scale-in) drains in-flight work.

### Config (`src/config.js`)
Single source of truth, everything overridable by env vars. `DATABASE_URL`, `QUEUE_URL`,
`WORKER_CONCURRENCY` (dealers in parallel per task), `DEALER_TIMEOUT_MS`, scraping timeouts/limits,
`inventoryPathGuesses`, `apiEndpointGuesses`, and the `ai` block live here.

### Infrastructure (`../vehicle-scraper-iac/`)
ECS service scales 0→`max_workers` via **step scaling on SQS queue depth** (`ecs.tf`); `desired_count`
starts at 0 and is gitignored from drift (`ignore_changes`). No NAT gateway — tasks get public IPs.
CI/CD is two GitHub Actions workflows (referenced in README) deploying via AWS OIDC on push to `main`:
`src/`/Dockerfile/package.json changes rebuild the worker image; `dispatcher/` changes update the Lambda.
The task definition points at the `latest` image tag, so every run pulls the newest build.

## Conventions

- **Code comments, log messages, DB `reason` strings, and the README are in Spanish.** Match this when
  editing — user-facing scraper output and the `strategies_tried` reasons are expected to be Spanish.
- The Playwright version in `package.json` **must** equal the Playwright base-image tag in `Dockerfile`
  (currently 1.47.0) — they drift independently and break the navigate strategy if mismatched.
- The Dockerfile builds `FROM` a **mirror of the Playwright base in your own ECR**
  (`<acct>.dkr.ecr.<region>.amazonaws.com/vehicle-scraper-playwright-base:<tag>`), not from
  `mcr.microsoft.com` — MCR throttles anonymous pulls (HTTP 429) and breaks CI. The mirror repo is
  created by terraform (`ecr_base.tf`) and seeded once. **To bump Playwright:** pull the new
  `mcr.microsoft.com/playwright:vX-jammy` (amd64), retag+push it to the mirror repo under the new tag,
  then update both `package.json` and the `PW_BASE` tag in `Dockerfile`. See AWS-DEPLOY.md.
- Adding a strategy means: implement the `{ ok, vehicles, reason, attempts }` contract, run output
  through `normalizeMany`, and wire it into the ordered chain in `pipeline.js` (pass along any reusable
  HTML so later strategies don't re-fetch).
