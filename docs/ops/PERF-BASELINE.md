# Performance Baseline Measurement (R07-P2)

> **Important Notice — Measurements Only, No Approved Targets Yet**
> No SLO, RPO, or RTO targets have been approved yet. All numbers produced by these scripts are factual baseline measurements against a disposable synthetic dataset—not commitments, not pass/fail thresholds, and not production sizing guarantees.

---

## 1. Prerequisites & Safety Guardrails

- Both scripts (`scripts/perf/seedSynthetic.ts` and `scripts/perf/loadModel.ts`) enforce **fail-closed loopback-only guards**:
  - Database URLs (`PERF_ADMIN_URL`, `PERF_DB_URL`, `LOCAL_PG_OWNER_URL`, `MIGRATION_DATABASE_URL`, `DATABASE_URL`) are rejected unless the host is `localhost`, `127.0.0.1`, or `::1`.
  - Target HTTP `PERF_BASE_URL` is restricted to loopback hosts.
  - Disposable database names must match PostgreSQL safe-identifier rules and start with `perf_` (default: `perf_an_erp`).
- If no local/loopback PostgreSQL server or running API server is reachable, the scripts exit cleanly with code **`2`** (`[BLOCKED]`).

---

## 2. Step 1 — Seed Disposable Synthetic Dataset (`npm run perf:seed`)

`scripts/perf/seedSynthetic.ts` drops and recreates its disposable `perf_*` database, bootstraps local stub roles (`ciBootstrapRoles`), applies all database migrations, configures `an_app` grants, seeds a non-trivial synthetic dataset, runs `ANALYZE`, prints actual row counts per table, and writes non-secret metadata to `.test-reports/perf/seed-meta.json`.

### Declared Volume Constants (defaults)

| Parameter | Env Override | Default |
| --- | --- | ---: |
| Companies | — | 1 |
| Platform / Operator Users | — | 2 (`perf_admin`, `perf_operator`) |
| Postable Accounts (+ 5 headers) | `PERF_ACCOUNTS` | 50 |
| Warehouses | `PERF_WAREHOUSES` | 3 |
| Inventory Items | `PERF_ITEMS` | 200 |
| Customers | `PERF_CUSTOMERS` | 40 |
| Suppliers | `PERF_SUPPLIERS` | 20 |
| Months of Activity | `PERF_MONTHS` | 6 |
| Posted Journal Entries | `PERF_JOURNAL_ENTRIES` | 5,000 |
| Posted Sales Invoices | `PERF_SALES_INVOICES` | 2,000 |
| Posted Purchase Receipts (GRNs) | `PERF_PURCHASE_RECEIPTS` | 2,000 |
| Disposable DB Name | `PERF_DB_NAME` | `perf_an_erp` |

Example:

```bash
PERF_ADMIN_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres" npm run perf:seed
```

---

## 3. Step 2 — Start the API Server Against the Disposable DB

Start the application server pointing at the seeded `perf_*` database on loopback:

```bash
APP_DB_HOST=127.0.0.1 \
APP_DB_PORT=5432 \
APP_DB_NAME=perf_an_erp \
APP_DB_USER=an_app \
APP_DB_PASSWORD='PerfAppRole#2026!' \
DATABASE_URL="postgresql://an_app:PerfAppRole%232026!@127.0.0.1:5432/perf_an_erp" \
PORT=3001 \
npm run dev:api
```

---

## 4. Step 3 — Run Concurrent Load Model (`npm run perf:load`)

`scripts/perf/loadModel.ts` logs workers in before starting timers, runs an excluded warmup window, drives concurrent posting + report requests, computes `pgbench`-style metrics (p50, p95, p99, avg, stddev, TPS excluding warmup/login, separate error count), optionally diffs `pg_stat_statements` if installed on the `perf_*` DB, and captures `EXPLAIN (ANALYZE, FORMAT JSON)` for the top 5 slowest endpoints.

### Declared Load Parameters (defaults)

| Parameter | Env / CLI Flag | Default |
| --- | --- | --- |
| Base URL | `PERF_BASE_URL` / `--base-url` | `http://127.0.0.1:3001` |
| Concurrent Clients | `PERF_CLIENTS` / `--clients` | `8` |
| Measurement Duration (s) | `PERF_DURATION_SEC` / `--duration` | `20` |
| Warmup Duration (s, excluded) | `PERF_WARMUP_SEC` / `--warmup` | `5` |
| Posting Ratio (`0..1`) | `PERF_POSTING_RATIO` / `--posting-ratio` | `0.30` |

### Endpoint Mix

- **Posting flows** (`postingRatio`, alternating JE & Sales Invoice create + post):
  - `POST /api/accounting/journals` -> `POST /api/accounting/journals/:id/post`
  - `POST /api/sales/invoices` -> `POST /api/sales/invoices/:id/post`
- **Read-heavy report flows** (`1 - postingRatio`):
  - `GET /api/accounting/trial-balance?companyId=...`
  - `GET /api/inventory/balances?companyId=...`
  - `GET /api/sales/ar/aging?companyId=...`

Example:

```bash
PERF_DB_URL="postgresql://postgres:postgres@127.0.0.1:5432/perf_an_erp" \
PERF_BASE_URL="http://127.0.0.1:3001" \
npm run perf:load
```

---

## 5. Artifacts & EXPLAIN Observation Flags

All measurement outputs land in `.test-reports/perf/` (gitignored):

- `.test-reports/perf/seed-meta.json` — Non-secret IDs and declared volume constants from the seed run.
- `.test-reports/perf/baseline-report.json` — Full `pgbench`-style summary, per-endpoint breakdown, error samples, `pg_stat_statements` delta (or `available: false`), and `EXPLAIN` metadata.
- `.test-reports/perf/baseline-summary.md` — Human-readable Markdown summary table.
- `.test-reports/perf/explain-*.json` — Raw `EXPLAIN (ANALYZE, FORMAT JSON)` plans for the top 5 slowest endpoints (executed inside a rolled-back transaction with `SET LOCAL app.current_tenant_id`).

`EXPLAIN` observation flags (reported as observations only, never auto-fixed):
1. `EST_VS_ACTUAL_DIVERGENCE_GT_10X` — Plan node with `Actual Loops > 0` whose estimated vs actual row ratio exceeds `10x`.
2. `SEQ_SCAN_OVER_10K` — `Seq Scan` node on a relation whose estimated/actual row count exceeds `10,000` rows.

---

## المستهدفات المعتمدة (قرار المالك بتفويضه، 2026-11-25)

### مستويات الحجم (قيود مرحّلة سنويًا / مستخدمون متزامنون)
| المستوى | القيود السنوية | المتزامنون |
| --- | ---: | ---: |
| صغير | حتى 25K | 2 |
| متوسط | حتى 250K | 10 |
| كبير | حتى 2M | 50 |
| كبير جدًا | أكثر من 2M | 200 (مراجعة معمارية إضافية) |

### مستهدفات زمن الاستجابة (من جهة الخادم، عند حجم كل مستوى)
- مسارات الترحيل/الكتابة: p50 ≤ 300ms، p95 ≤ 1000ms
- التقارير/القراءة القياسية: p50 ≤ 200ms، p95 ≤ 500ms
- التقارير الثقيلة (ميزان مراجعة سنة كاملة، أعمار الذمم): p95 ≤ 2000ms
- معدل الأخطاء < 0.1%

**قياس 2026-11-25 يحققها بهامش** عند حجم يمثل الصغير/المتوسط: 2822 معاملة، 0 فشل، TPS 46.9، p95 كتابة 528ms، تقارير ~230ms (تفاصيله في `.test-reports/perf/baseline-report.json` وقت التشغيل).
