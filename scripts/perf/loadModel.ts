import fs from 'fs';
import path from 'path';
import pg from 'pg';
import {
  assertLoopbackDatabaseUrl,
  assertSafePgIdentifier,
  redactLogText,
  sanitizeConnectionUrl,
} from '../ops/backupUtils.js';
import type { PerfSeedMetadata } from './seedSynthetic.js';

export interface LoadModelConfig {
  baseUrl: string;
  clients: number;
  durationSec: number;
  warmupSec: number;
  postingRatio: number;
  metaPath: string;
}

export interface RequestSample {
  endpoint: string;
  kind: 'posting' | 'report';
  status: number;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface EndpointStats {
  endpoint: string;
  requests: number;
  succeeded: number;
  failed: number;
  tps: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  stddevMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ExplainFlag {
  endpoint: string;
  flagType: 'EST_VS_ACTUAL_DIVERGENCE_GT_10X' | 'SEQ_SCAN_OVER_10K';
  nodeType: string;
  relationName: string | null;
  planRows: number;
  actualRows: number;
  ratio: number;
  tableRowsEstimate: number | null;
  detail: string;
}

export interface ExplainPlanReport {
  endpoint: string;
  queryLabel: string;
  executionTimeMs: number | null;
  planningTimeMs: number | null;
  planFile: string;
  flags: ExplainFlag[];
}

interface PgStatSnapshotRow {
  queryid: string;
  calls: number;
  totalExecTimeMs: number;
  rows: number;
  sample: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parsePositiveInt(raw: string | undefined, fallback: number, name: string, min: number = 1): number {
  if (!raw || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`Invalid integer for ${name}: '${raw}' (must be >= ${min})`);
  }
  return n;
}

function parseRatio(raw: string | undefined, fallback: number, name: string): number {
  if (!raw || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`Invalid ratio for ${name}: '${raw}' (must be between 0 and 1)`);
  }
  return n;
}

function assertLoopbackHttpUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL: '${rawUrl}'`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https protocol.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `[SAFETY GUARD] ${label} targets non-loopback host '${host}'. Load baseline runs are restricted to localhost / 127.0.0.1 / ::1.`
    );
  }
  return parsed;
}

function replaceUrlDatabase(parsed: URL, dbName: string): string {
  const clone = new URL(parsed.toString());
  clone.pathname = `/${dbName}`;
  return clone.toString();
}

function parseCliArgs(argv: string[]): {
  baseUrl?: string;
  dbUrl?: string;
  clients?: string;
  duration?: string;
  warmup?: string;
  postingRatio?: string;
  metaPath?: string;
} {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base-url' && argv[i + 1]) out.baseUrl = argv[++i];
    else if (arg === '--db-url' && argv[i + 1]) out.dbUrl = argv[++i];
    else if (arg === '--clients' && argv[i + 1]) out.clients = argv[++i];
    else if (arg === '--duration' && argv[i + 1]) out.duration = argv[++i];
    else if (arg === '--warmup' && argv[i + 1]) out.warmup = argv[++i];
    else if (arg === '--posting-ratio' && argv[i + 1]) out.postingRatio = argv[++i];
    else if (arg === '--meta-path' && argv[i + 1]) out.metaPath = argv[++i];
  }
  return out;
}

class WorkerSession {
  private cookies = new Map<string, string>();
  private csrfToken = '';
  public readonly origin: string;

  constructor(private readonly baseUrl: string) {
    this.origin = new URL(baseUrl).origin;
  }

  private captureSetCookies(res: Response): void {
    const headersObj = res.headers as unknown as { getSetCookie?: () => string[] };
    const setCookies: string[] =
      typeof headersObj.getSetCookie === 'function'
        ? headersObj.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie') as string]
          : [];

    for (const raw of setCookies) {
      const firstPart = raw.split(';')[0] || '';
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx > 0) {
        const name = firstPart.slice(0, eqIdx).trim();
        const val = firstPart.slice(eqIdx + 1).trim();
        if (name) {
          this.cookies.set(name, val);
          if (name === 'an_csrf') {
            this.csrfToken = decodeURIComponent(val);
          }
        }
      }
    }
  }

  private cookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async login(username: string, password: string): Promise<void> {
    const csrfRes = await fetch(`${this.baseUrl}/api/auth/csrf`, {
      method: 'GET',
      headers: { Origin: this.origin },
    });
    this.captureSetCookies(csrfRes);
    const csrfJson = (await csrfRes.json().catch(() => ({}))) as { csrfToken?: string };
    if (csrfJson.csrfToken) {
      this.csrfToken = csrfJson.csrfToken;
    }
    if (!csrfRes.ok || !this.csrfToken) {
      throw new Error(`Failed to fetch CSRF token before worker login (status ${csrfRes.status})`);
    }

    const loginRes = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: this.origin,
        Cookie: this.cookieHeader(),
        'x-csrf-token': this.csrfToken,
      },
      body: JSON.stringify({ username, password }),
    });
    this.captureSetCookies(loginRes);
    const loginJson = (await loginRes.json().catch(() => ({}))) as { csrfToken?: string; message?: string };
    if (loginJson.csrfToken) {
      this.csrfToken = loginJson.csrfToken;
    }
    if (!loginRes.ok) {
      throw new Error(`Worker login failed (status ${loginRes.status}): ${loginJson.message || 'unknown error'}`);
    }
  }

  async requestJson(
    method: 'GET' | 'POST',
    urlPath: string,
    body?: Record<string, unknown>
  ): Promise<{ status: number; ok: boolean; latencyMs: number; json: any; error?: string }> {
    const t0 = performance.now();
    try {
      const headers: Record<string, string> = {
        Origin: this.origin,
        Cookie: this.cookieHeader(),
      };
      if (method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        headers['x-csrf-token'] = this.csrfToken;
      }

      const res = await fetch(`${this.baseUrl}${urlPath}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      this.captureSetCookies(res);
      const latencyMs = performance.now() - t0;
      const json = await res.json().catch(() => null);
      if (json && typeof json.csrfToken === 'string' && json.csrfToken.length > 0) {
        this.csrfToken = json.csrfToken;
      }
      if (!res.ok) {
        const msg =
          (json && (json.message || json.error || json.code)) || `HTTP ${res.status}`;
        return { status: res.status, ok: false, latencyMs, json, error: String(msg) };
      }
      return { status: res.status, ok: true, latencyMs, json };
    } catch (err: unknown) {
      const latencyMs = performance.now() - t0;
      return {
        status: 0,
        ok: false,
        latencyMs,
        json: null,
        error: redactLogText(err instanceof Error ? err.message : String(err)),
      };
    }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeStats(endpoint: string, samples: RequestSample[], durationSec: number): EndpointStats {
  const count = samples.length;
  const succeeded = samples.filter((s) => s.ok).length;
  const failed = count - succeeded;

  if (count === 0) {
    return {
      endpoint,
      requests: 0,
      succeeded: 0,
      failed: 0,
      tps: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      stddevMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    };
  }

  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const sum = latencies.reduce((acc, v) => acc + v, 0);
  const avg = sum / count;
  const variance = latencies.reduce((acc, v) => acc + (v - avg) * (v - avg), 0) / count;
  const stddev = Math.sqrt(variance);

  const percentile = (p: number): number => {
    const idx = Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1));
    return latencies[idx];
  };

  return {
    endpoint,
    requests: count,
    succeeded,
    failed,
    tps: round2(count / Math.max(0.001, durationSec)),
    minMs: round2(latencies[0]),
    maxMs: round2(latencies[latencies.length - 1]),
    avgMs: round2(avg),
    stddevMs: round2(stddev),
    p50Ms: round2(percentile(50)),
    p95Ms: round2(percentile(95)),
    p99Ms: round2(percentile(99)),
  };
}

function collectExplainFlags(
  endpoint: string,
  node: any,
  tableRowCounts: Map<string, number>,
  out: ExplainFlag[]
): void {
  if (!node || typeof node !== 'object') return;

  const nodeType = String(node['Node Type'] || 'Unknown');
  const relationName = typeof node['Relation Name'] === 'string' ? node['Relation Name'] : null;
  const planRows = typeof node['Plan Rows'] === 'number' ? node['Plan Rows'] : 0;
  const actualRows = typeof node['Actual Rows'] === 'number' ? node['Actual Rows'] : 0;
  const actualLoops = typeof node['Actual Loops'] === 'number' ? node['Actual Loops'] : 0;

  if (actualLoops > 0) {
    const estFloor = Math.max(planRows, 1);
    const actFloor = Math.max(actualRows, 1);
    const ratio = Math.max(estFloor / actFloor, actFloor / estFloor);
    if (ratio > 10) {
      out.push({
        endpoint,
        flagType: 'EST_VS_ACTUAL_DIVERGENCE_GT_10X',
        nodeType,
        relationName,
        planRows,
        actualRows,
        ratio: round2(ratio),
        tableRowsEstimate: relationName ? (tableRowCounts.get(relationName) ?? null) : null,
        detail: `${nodeType}${relationName ? ` on ${relationName}` : ''}: planned=${planRows} vs actual=${actualRows} (${round2(ratio)}x divergence)`,
      });
    }
  }

  if (nodeType === 'Seq Scan' && relationName) {
    const removed = typeof node['Rows Removed by Filter'] === 'number' ? node['Rows Removed by Filter'] : 0;
    const scannedInNode = actualRows + removed;
    const catalogRows = tableRowCounts.get(relationName) ?? 0;
    const rowSize = Math.max(catalogRows, scannedInNode);
    if (rowSize > 10000) {
      out.push({
        endpoint,
        flagType: 'SEQ_SCAN_OVER_10K',
        nodeType,
        relationName,
        planRows,
        actualRows,
        ratio: 0,
        tableRowsEstimate: rowSize,
        detail: `Seq Scan on ${relationName} (~${rowSize} rows > 10,000 threshold)`,
      });
    }
  }

  if (Array.isArray(node['Plans'])) {
    for (const child of node['Plans']) {
      collectExplainFlags(endpoint, child, tableRowCounts, out);
    }
  }
}

async function capturePgStatSnapshot(db: pg.Client): Promise<{ available: boolean; rows: PgStatSnapshotRow[] }> {
  try {
    const extRes = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS exists`
    );
    if (!extRes.rows[0]?.exists) {
      return { available: false, rows: [] };
    }
    const res = await db.query<{
      queryid: string;
      calls: string;
      total_exec_time: number;
      rows: string;
      sample: string;
    }>(
      `SELECT
         queryid::text AS queryid,
         SUM(calls)::text AS calls,
         SUM(total_exec_time)::float8 AS total_exec_time,
         SUM(rows)::text AS rows,
         LEFT(MIN(query), 140) AS sample
       FROM pg_stat_statements
       WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
       GROUP BY queryid`
    );
    return {
      available: true,
      rows: res.rows.map((r) => ({
        queryid: r.queryid,
        calls: Number.parseInt(r.calls, 10) || 0,
        totalExecTimeMs: Number(r.total_exec_time) || 0,
        rows: Number.parseInt(r.rows, 10) || 0,
        sample: r.sample,
      })),
    };
  } catch {
    return { available: false, rows: [] };
  }
}

function buildExplainSpecs(
  meta: PerfSeedMetadata,
  sampleEntryId: string | null,
  sampleInvoiceId: string | null
): Record<string, { label: string; sql: string; params: unknown[] }> {
  const today = new Date().toISOString().slice(0, 10);
  const fallbackUuid = '00000000-0000-0000-0000-000000000000';
  return {
    'GET /api/accounting/trial-balance': {
      label: 'Trial Balance Aggregation (trialBalanceService)',
      sql: `
        SELECT
          a.id as "accountId",
          a.code as "accountCode",
          a.name_ar as "accountNameAr",
          a.name_en as "accountNameEn",
          a.account_type as "accountType",
          COALESCE(x.total_debit, 0)::text as "totalDebit",
          COALESCE(x.total_credit, 0)::text as "totalCredit",
          (COALESCE(x.total_debit, 0) - COALESCE(x.total_credit, 0))::text as "netBalance"
        FROM accounts a
        LEFT JOIN (
          SELECT
            l.account_id,
            SUM(l.debit) as total_debit,
            SUM(l.credit) as total_credit
          FROM journal_lines l
          INNER JOIN journal_entries e
            ON e.id = l.entry_id AND e.company_id = l.company_id
          WHERE e.status = 'posted'
            AND l.company_id = $1
            AND ($2::date IS NULL OR e.entry_date <= $2::date)
            AND ($3::uuid IS NULL OR e.org_unit_id = $3::uuid)
          GROUP BY l.account_id
        ) x ON x.account_id = a.id
        WHERE a.company_id = $1 AND a.is_postable = true
        ORDER BY a.code ASC
      `,
      params: [meta.companyId, null, null],
    },
    'GET /api/inventory/balances': {
      label: 'Inventory Stock Balances (stockRepository)',
      sql: `
        SELECT
          b.company_id as "companyId",
          b.warehouse_id as "warehouseId",
          w.code as "warehouseCode",
          w.name_ar as "warehouseNameAr",
          b.item_id as "itemId",
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          b.qty as "qty",
          b.updated_at as "updatedAt"
        FROM inv_stock_balances b
        INNER JOIN inv_warehouses w ON w.id = b.warehouse_id AND w.company_id = b.company_id
        INNER JOIN inv_items i ON i.id = b.item_id AND i.company_id = b.company_id
        WHERE b.company_id = $1
        ORDER BY w.code ASC, i.code ASC
      `,
      params: [meta.companyId],
    },
    'GET /api/sales/ar/aging': {
      label: 'Accounts Receivable Aging (arAgingService)',
      sql: `
        SELECT
          i.id as "invoiceId",
          i.invoice_no as "invoiceNo",
          i.invoice_date::text as "invoiceDate",
          i.due_date::text as "dueDate",
          i.customer_id as "customerId",
          c.code as "customerCode",
          c.name_ar as "customerNameAr",
          i.total_amount as "invoiceTotal",
          COALESCE(col.total, 0) as "collectedAmount",
          COALESCE(ret.total, 0) as "returnedAmount",
          GREATEST(0, ROUND((i.total_amount - COALESCE(col.total, 0) - COALESCE(ret.total, 0))::numeric, 2)) as "remainingOpenAmount",
          GREATEST(0, ($2::date - COALESCE(i.due_date, i.invoice_date)))::int as "agingDays"
        FROM sales_invoices i
        INNER JOIN sales_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
        LEFT JOIN (
          SELECT invoice_id, SUM(amount) as total
          FROM sales_collections
          WHERE company_id = $1 AND status = 'posted'
          GROUP BY invoice_id
        ) col ON col.invoice_id = i.id
        LEFT JOIN (
          SELECT invoice_id, SUM(total_amount) as total
          FROM sales_returns
          WHERE company_id = $1 AND status = 'posted'
          GROUP BY invoice_id
        ) ret ON ret.invoice_id = i.id
        WHERE i.company_id = $1 AND i.status = 'posted'
          AND ROUND((i.total_amount - COALESCE(col.total, 0) - COALESCE(ret.total, 0))::numeric, 2) > 0
        ORDER BY "agingDays" DESC, i.invoice_date ASC
      `,
      params: [meta.companyId, today],
    },
    'POST /api/accounting/journals': {
      label: 'Create Draft Journal Insert (journalRepository.createDraft)',
      sql: `
        INSERT INTO journal_entries (company_id, entry_date, memo, status, created_by, org_unit_id, created_at)
        VALUES ($1, $2::date, $3, 'draft', NULL, NULL, NOW())
        RETURNING id
      `,
      params: [meta.companyId, today, 'EXPLAIN baseline probe'],
    },
    'POST /api/accounting/journals/:id/post': {
      label: 'Journal Entry Post Line Fetch & Sequence Lock (journalRepository)',
      sql: `
        SELECT
          l.id,
          l.company_id as "companyId",
          l.entry_id as "entryId",
          l.account_id as "accountId",
          l.debit::text as "debit",
          l.credit::text as "credit",
          l.line_memo as "lineMemo",
          a.code as "accountCode",
          a.name_ar as "accountNameAr"
        FROM journal_lines l
        LEFT JOIN accounts a ON l.account_id = a.id
        WHERE l.entry_id = $1 AND l.company_id = $2
        ORDER BY l.debit DESC, l.credit DESC
      `,
      params: [sampleEntryId || fallbackUuid, meta.companyId],
    },
    'POST /api/sales/invoices': {
      label: 'Create Draft Sales Invoice Insert (salesInvoiceRepository.createDraft)',
      sql: `
        INSERT INTO sales_invoices (
          company_id, customer_id, delivery_id, invoice_date, due_date, memo,
          subtotal, tax_amount, total_amount, status, created_by
        )
        VALUES ($1, $2, NULL, COALESCE($3::date, CURRENT_DATE), NULL, $4, 100.00, 14.00, 114.00, 'draft', NULL)
        RETURNING id
      `,
      params: [meta.companyId, meta.sampleIds.customerIds[0], today, 'EXPLAIN baseline probe'],
    },
    'POST /api/sales/invoices/:id/post': {
      label: 'Sales Invoice Header Fetch (salesInvoiceRepository.findById)',
      sql: `
        SELECT
          i.id, i.company_id, i.customer_id, i.delivery_id, i.invoice_no, i.invoice_date::text as invoice_date,
          i.due_date::text as due_date, i.status, i.subtotal, i.tax_amount, i.total_amount, i.cogs_amount,
          i.cogs_posted_at, i.memo, i.journal_entry_id, i.reversal_journal_entry_id, i.cancelled_at,
          i.cancelled_by, i.cancellation_reason, i.posted_at, i.posted_by, i.created_by, i.created_at, i.updated_at,
          c.code as customer_code, c.name_ar as customer_name_ar,
          d.delivery_no as delivery_no,
          je.entry_no as journal_entry_no
        FROM sales_invoices i
        INNER JOIN sales_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
        LEFT JOIN sales_delivery_notes d ON d.id = i.delivery_id AND d.company_id = i.company_id
        LEFT JOIN journal_entries je ON je.id = i.journal_entry_id AND je.company_id = i.company_id
        WHERE i.company_id = $1 AND i.id = $2
      `,
      params: [meta.companyId, sampleInvoiceId || fallbackUuid],
    },
  };
}

export async function runLoadModel(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const config: LoadModelConfig = {
    baseUrl: (cli.baseUrl || process.env.PERF_BASE_URL || 'http://127.0.0.1:3001').trim().replace(/\/+$/, ''),
    clients: parsePositiveInt(cli.clients || process.env.PERF_CLIENTS, 8, 'PERF_CLIENTS', 1),
    durationSec: parsePositiveInt(cli.duration || process.env.PERF_DURATION_SEC, 20, 'PERF_DURATION_SEC', 1),
    warmupSec: parsePositiveInt(cli.warmup || process.env.PERF_WARMUP_SEC, 5, 'PERF_WARMUP_SEC', 0),
    postingRatio: parseRatio(cli.postingRatio || process.env.PERF_POSTING_RATIO, 0.3, 'PERF_POSTING_RATIO'),
    metaPath: path.resolve(process.cwd(), cli.metaPath || '.test-reports/perf/seed-meta.json'),
  };

  console.log('=== A.N ERP Performance Baseline — Concurrent Load Model ===');
  console.log('Declared Load Parameters:');
  console.log(JSON.stringify(config, null, 2));

  // Safety checks FIRST (fail closed on remote hosts)
  assertLoopbackHttpUrl(config.baseUrl, 'Perf Load Base URL');

  const rawDbUrl = (
    cli.dbUrl ||
    process.env.PERF_DB_URL ||
    process.env.LOCAL_PG_OWNER_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();

  if (!rawDbUrl) {
    console.log(
      '[BLOCKED] No loopback PostgreSQL URL found (set PERF_DB_URL or LOCAL_PG_OWNER_URL or loopback MIGRATION_DATABASE_URL). Load measurement is BLOCKED.'
    );
    process.exit(2);
  }

  const parsedDbUrl = assertLoopbackDatabaseUrl(rawDbUrl, 'Perf Load DB URL');

  if (!fs.existsSync(config.metaPath)) {
    console.log(
      `[BLOCKED] Seed metadata not found at ${config.metaPath}. Run 'npm run perf:seed' against a loopback PostgreSQL instance first. Load measurement is BLOCKED.`
    );
    process.exit(2);
  }

  const meta = JSON.parse(fs.readFileSync(config.metaPath, 'utf8')) as PerfSeedMetadata;
  const safeDbName = assertSafePgIdentifier(meta.dbName);
  if (!safeDbName.startsWith('perf_')) {
    throw new Error(`[SAFETY GUARD] Metadata DB name must start with 'perf_' (got '${safeDbName}').`);
  }

  const targetDbUrl = replaceUrlDatabase(parsedDbUrl, safeDbName);
  console.log(`[perf:load] Target DB: ${sanitizeConnectionUrl(targetDbUrl)}`);

  const db = new pg.Client({ connectionString: targetDbUrl });
  try {
    await db.connect();
  } catch (err: unknown) {
    const msg = redactLogText(err instanceof Error ? err.message : String(err));
    console.log(`[BLOCKED] Loopback PostgreSQL database '${safeDbName}' is unreachable (${msg}). Load measurement is BLOCKED.`);
    process.exit(2);
  }

  try {
    // Verify app server readiness before starting workers
    try {
      const readyRes = await fetch(`${config.baseUrl}/api/ready`, {
        method: 'GET',
        headers: { Origin: new URL(config.baseUrl).origin },
      });
      if (!readyRes.ok) {
        console.log(
          `[BLOCKED] App server at ${config.baseUrl}/api/ready returned HTTP ${readyRes.status}. Ensure the API server is running against '${safeDbName}'.`
        );
        process.exit(2);
      }
    } catch (err: unknown) {
      const msg = redactLogText(err instanceof Error ? err.message : String(err));
      console.log(
        `[BLOCKED] App server at ${config.baseUrl} is unreachable (${msg}). Start the server against '${safeDbName}' before running perf:load.`
      );
      process.exit(2);
    }

    const perfPassword = process.env.PERF_PASSWORD || 'PerfBaseline#2026!';
    console.log(`[perf:load] Authenticating ${config.clients} concurrent workers (excluded from TPS/latency)...`);

    const workers: WorkerSession[] = [];
    for (let i = 0; i < config.clients; i++) {
      const w = new WorkerSession(config.baseUrl);
      await w.login(meta.username, perfPassword);
      workers.push(w);
    }

    const today = new Date().toISOString().slice(0, 10);
    const readEndpoints = [
      `GET /api/accounting/trial-balance`,
      `GET /api/inventory/balances`,
      `GET /api/sales/ar/aging`,
    ] as const;

    const executeSingleOperation = async (
      worker: WorkerSession,
      workerIdx: number,
      opIndex: number,
      collectInto: RequestSample[] | null
    ): Promise<{ kind: 'posting' | 'report'; ok: boolean; latencyMs: number }> => {
      const opStart = performance.now();
      const deterministicSlot = (workerIdx * 1000003 + opIndex) % 100;
      const isPosting = deterministicSlot < Math.round(config.postingRatio * 100);

      if (!isPosting) {
        const readPick = readEndpoints[(workerIdx + opIndex) % readEndpoints.length];
        let urlPath = '';
        if (readPick === 'GET /api/accounting/trial-balance') {
          urlPath = `/api/accounting/trial-balance?companyId=${meta.companyId}`;
        } else if (readPick === 'GET /api/inventory/balances') {
          urlPath = `/api/inventory/balances?companyId=${meta.companyId}`;
        } else {
          urlPath = `/api/sales/ar/aging?companyId=${meta.companyId}`;
        }

        const res = await worker.requestJson('GET', urlPath);
        if (collectInto) {
          collectInto.push({
            endpoint: readPick,
            kind: 'report',
            status: res.status,
            ok: res.ok,
            latencyMs: res.latencyMs,
            error: res.error,
          });
        }
        return { kind: 'report', ok: res.ok, latencyMs: performance.now() - opStart };
      }

      // Alternating posting flow: Journal Entry create+post vs Sales Invoice create+post
      const isJournal = (workerIdx + opIndex) % 2 === 0;
      if (isJournal) {
        const amount = 150 + ((opIndex * 13) % 500);
        const createRes = await worker.requestJson('POST', '/api/accounting/journals', {
          companyId: meta.companyId,
          entryDate: today,
          memo: `Load baseline JE w${workerIdx}-${opIndex}`,
          lines: [
            { accountId: meta.sampleIds.debitAccountId, debit: amount, credit: 0, lineMemo: 'Perf Debit' },
            { accountId: meta.sampleIds.creditAccountId, debit: 0, credit: amount, lineMemo: 'Perf Credit' },
          ],
        });
        if (collectInto) {
          collectInto.push({
            endpoint: 'POST /api/accounting/journals',
            kind: 'posting',
            status: createRes.status,
            ok: createRes.ok,
            latencyMs: createRes.latencyMs,
            error: createRes.error,
          });
        }
        const entryId = createRes.json?.journal?.id as string | undefined;
        if (!createRes.ok || !entryId) {
          return { kind: 'posting', ok: false, latencyMs: performance.now() - opStart };
        }

        const postRes = await worker.requestJson('POST', `/api/accounting/journals/${entryId}/post`, {
          companyId: meta.companyId,
        });
        if (collectInto) {
          collectInto.push({
            endpoint: 'POST /api/accounting/journals/:id/post',
            kind: 'posting',
            status: postRes.status,
            ok: postRes.ok,
            latencyMs: postRes.latencyMs,
            error: postRes.error,
          });
        }
        return { kind: 'posting', ok: postRes.ok, latencyMs: performance.now() - opStart };
      } else {
        const customerId = meta.sampleIds.customerIds[(workerIdx + opIndex) % meta.sampleIds.customerIds.length];
        const itemId = meta.sampleIds.itemIds[(workerIdx + opIndex) % meta.sampleIds.itemIds.length];
        const createRes = await worker.requestJson('POST', '/api/sales/invoices', {
          companyId: meta.companyId,
          customerId,
          invoiceDate: today,
          memo: `Load baseline INV w${workerIdx}-${opIndex}`,
          lines: [
            {
              itemId,
              qty: 1,
              unitPrice: 120 + (opIndex % 50),
              taxRate: 14,
            },
          ],
        });
        if (collectInto) {
          collectInto.push({
            endpoint: 'POST /api/sales/invoices',
            kind: 'posting',
            status: createRes.status,
            ok: createRes.ok,
            latencyMs: createRes.latencyMs,
            error: createRes.error,
          });
        }
        const invoiceId = createRes.json?.invoice?.id as string | undefined;
        if (!createRes.ok || !invoiceId) {
          return { kind: 'posting', ok: false, latencyMs: performance.now() - opStart };
        }

        const postRes = await worker.requestJson('POST', `/api/sales/invoices/${invoiceId}/post`, {
          companyId: meta.companyId,
        });
        if (collectInto) {
          collectInto.push({
            endpoint: 'POST /api/sales/invoices/:id/post',
            kind: 'posting',
            status: postRes.status,
            ok: postRes.ok,
            latencyMs: postRes.latencyMs,
            error: postRes.error,
          });
        }
        return { kind: 'posting', ok: postRes.ok, latencyMs: performance.now() - opStart };
      }
    };

    const runWindow = async (seconds: number, collectSamples: boolean) => {
      if (seconds <= 0) {
        return {
          samples: [] as RequestSample[],
          txIntended: 0,
          txProcessed: 0,
          txFailed: 0,
          txLatenciesMs: [] as number[],
          actualDurationSec: 0,
        };
      }
      const samples: RequestSample[] = [];
      const txLatenciesMs: number[] = [];
      let txIntended = 0;
      let txProcessed = 0;
      let txFailed = 0;
      const tStart = performance.now();
      const deadline = tStart + seconds * 1000;

      await Promise.all(
        workers.map(async (worker, wIdx) => {
          let opIdx = 0;
          while (performance.now() < deadline) {
            txIntended += 1;
            const opRes = await executeSingleOperation(worker, wIdx, opIdx++, collectSamples ? samples : null);
            txLatenciesMs.push(opRes.latencyMs);
            if (opRes.ok) {
              txProcessed += 1;
            } else {
              txFailed += 1;
            }
          }
        })
      );

      return {
        samples,
        txIntended,
        txProcessed,
        txFailed,
        txLatenciesMs,
        actualDurationSec: (performance.now() - tStart) / 1000,
      };
    };

    if (config.warmupSec > 0) {
      console.log(`[perf:load] Running warmup (${config.warmupSec}s, excluded from metrics)...`);
      await runWindow(config.warmupSec, false);
    }

    const pgStatBefore = await capturePgStatSnapshot(db);

    console.log(`[perf:load] Running measurement window (${config.durationSec}s with ${config.clients} concurrent clients)...`);
    const measured = await runWindow(config.durationSec, true);

    const pgStatAfter = await capturePgStatSnapshot(db);

    // pg_stat_statements diff
    let pgStatSummary: {
      available: boolean;
      note?: string;
      totalDbCalls?: number;
      callsPerHttpRequest?: number;
      callsPerLogicalTransaction?: number;
      topStatements?: Array<{ calls: number; totalExecTimeMs: number; sample: string }>;
    };

    if (pgStatBefore.available && pgStatAfter.available) {
      const beforeMap = new Map(pgStatBefore.rows.map((r) => [r.queryid, r]));
      let totalCalls = 0;
      const deltas: Array<{ calls: number; totalExecTimeMs: number; sample: string }> = [];
      for (const afterRow of pgStatAfter.rows) {
        const prev = beforeMap.get(afterRow.queryid);
        const callDelta = afterRow.calls - (prev?.calls ?? 0);
        const timeDelta = afterRow.totalExecTimeMs - (prev?.totalExecTimeMs ?? 0);
        if (callDelta > 0) {
          totalCalls += callDelta;
          deltas.push({
            calls: callDelta,
            totalExecTimeMs: round2(timeDelta),
            sample: afterRow.sample,
          });
        }
      }
      deltas.sort((a, b) => b.totalExecTimeMs - a.totalExecTimeMs);
      pgStatSummary = {
        available: true,
        totalDbCalls: totalCalls,
        callsPerHttpRequest: round2(totalCalls / Math.max(1, measured.samples.length)),
        callsPerLogicalTransaction: round2(totalCalls / Math.max(1, measured.txIntended)),
        topStatements: deltas.slice(0, 10),
      };
    } else {
      pgStatSummary = {
        available: false,
        note: 'pg_stat_statements extension not installed on perf DB; DB query counts per request unavailable without server instrumentation.',
      };
    }

    // Aggregate per-endpoint and overall stats
    const byEndpointMap = new Map<string, RequestSample[]>();
    for (const sample of measured.samples) {
      const list = byEndpointMap.get(sample.endpoint) || [];
      list.push(sample);
      byEndpointMap.set(sample.endpoint, list);
    }

    const perEndpoint: EndpointStats[] = Array.from(byEndpointMap.entries()).map(([ep, list]) =>
      computeStats(ep, list, measured.actualDurationSec)
    );
    perEndpoint.sort((a, b) => b.p95Ms - a.p95Ms);

    const overallHttp = computeStats('ALL_HTTP_REQUESTS', measured.samples, measured.actualDurationSec);
    const failureDetails = measured.samples
      .filter((s) => !s.ok)
      .slice(0, 20)
      .map((s) => ({ endpoint: s.endpoint, status: s.status, error: s.error || 'unknown' }));

    // Transaction-level latency stats (pgbench style)
    const sortedTxLat = [...measured.txLatenciesMs].sort((a, b) => a - b);
    const txAvg =
      sortedTxLat.length > 0 ? sortedTxLat.reduce((a, b) => a + b, 0) / sortedTxLat.length : 0;
    const txVar =
      sortedTxLat.length > 0
        ? sortedTxLat.reduce((a, v) => a + (v - txAvg) * (v - txAvg), 0) / sortedTxLat.length
        : 0;
    const txP95 =
      sortedTxLat.length > 0
        ? sortedTxLat[Math.min(sortedTxLat.length - 1, Math.ceil(0.95 * sortedTxLat.length) - 1)]
        : 0;

    // Fetch sample IDs and catalog reltuples for EXPLAIN (ANALYZE, FORMAT JSON)
    const reportDir = path.resolve(process.cwd(), '.test-reports/perf');
    fs.mkdirSync(reportDir, { recursive: true });

    let sampleEntryId: string | null = null;
    let sampleInvoiceId: string | null = null;
    const tableRowCounts = new Map<string, number>();

    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [meta.companyId]);
      const jeRes = await db.query<{ id: string }>(
        `SELECT id FROM journal_entries WHERE company_id = $1 LIMIT 1`,
        [meta.companyId]
      );
      sampleEntryId = jeRes.rows[0]?.id ?? null;

      const invRes = await db.query<{ id: string }>(
        `SELECT id FROM sales_invoices WHERE company_id = $1 LIMIT 1`,
        [meta.companyId]
      );
      sampleInvoiceId = invRes.rows[0]?.id ?? null;

      const relRes = await db.query<{ relname: string; reltuples: number }>(
        `SELECT c.relname, GREATEST(0, c.reltuples)::float8 AS reltuples
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'`
      );
      for (const r of relRes.rows) {
        tableRowCounts.set(r.relname, Math.round(r.reltuples));
      }
    } finally {
      await db.query('ROLLBACK');
    }

    const appRoleCheck = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'an_app') AS exists`
    );
    const hasAppRole = Boolean(appRoleCheck.rows[0]?.exists);

    const explainSpecs = buildExplainSpecs(meta, sampleEntryId, sampleInvoiceId);
    const topSlowestEndpoints = perEndpoint
      .map((e) => e.endpoint)
      .filter((ep) => Boolean(explainSpecs[ep]))
      .slice(0, 5);

    const explainReports: ExplainPlanReport[] = [];
    const allFlags: ExplainFlag[] = [];

    console.log(`\n[perf:load] Capturing EXPLAIN (ANALYZE, FORMAT JSON) for top ${topSlowestEndpoints.length} slowest endpoints...`);
    for (const endpoint of topSlowestEndpoints) {
      const spec = explainSpecs[endpoint];
      const slug = endpoint
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const planFileName = `explain-${slug}.json`;
      const planFilePath = path.join(reportDir, planFileName);

      await db.query('BEGIN');
      try {
        if (hasAppRole) {
          await db.query('SET LOCAL ROLE an_app');
        }
        await db.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [meta.companyId]);

        const explainSql = `EXPLAIN (ANALYZE, FORMAT JSON) ${spec.sql}`;
        const explainRes = await db.query<Record<string, unknown>>(explainSql, spec.params);
        const rawJson = explainRes.rows[0]?.['QUERY PLAN'];
        fs.writeFileSync(planFilePath, JSON.stringify(rawJson, null, 2), 'utf8');

        const topPlan = Array.isArray(rawJson) ? rawJson[0] : rawJson;
        const planFlags: ExplainFlag[] = [];
        if (topPlan?.Plan) {
          collectExplainFlags(endpoint, topPlan.Plan, tableRowCounts, planFlags);
        }
        allFlags.push(...planFlags);

        explainReports.push({
          endpoint,
          queryLabel: spec.label,
          executionTimeMs: typeof topPlan?.['Execution Time'] === 'number' ? round2(topPlan['Execution Time']) : null,
          planningTimeMs: typeof topPlan?.['Planning Time'] === 'number' ? round2(topPlan['Planning Time']) : null,
          planFile: `.test-reports/perf/${planFileName}`,
          flags: planFlags,
        });
      } finally {
        await db.query('ROLLBACK');
      }
    }

    const report = {
      measuredAt: new Date().toISOString(),
      note: 'Baseline factual measurements only. No SLO/RPO/RTO targets have been approved yet.',
      config,
      pgbenchStyleSummary: {
        clientCount: config.clients,
        durationSecondsRequested: config.durationSec,
        durationSecondsActual: round2(measured.actualDurationSec),
        warmupSecondsExcluded: config.warmupSec,
        postingRatio: config.postingRatio,
        transactionsIntended: measured.txIntended,
        transactionsProcessed: measured.txProcessed,
        failedTransactions: measured.txFailed,
        tpsIncludingFailedExcludedWarmup: round2(measured.txProcessed / Math.max(0.001, measured.actualDurationSec)),
        transactionLatencyAvgMs: round2(txAvg),
        transactionLatencyStddevMs: round2(Math.sqrt(txVar)),
        transactionLatencyP95Ms: round2(txP95),
        httpRequestsTotal: overallHttp.requests,
        httpRequestsFailed: overallHttp.failed,
        httpTps: overallHttp.tps,
        httpP50Ms: overallHttp.p50Ms,
        httpP95Ms: overallHttp.p95Ms,
      },
      perEndpoint,
      failureSamples: failureDetails,
      dbQueryCounter: pgStatSummary,
      explainAnalysisTop5: explainReports,
      explainFlagsObserved: allFlags,
    };

    const reportJsonPath = path.join(reportDir, 'baseline-report.json');
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');

    const mdLines: string[] = [
      `# Performance Baseline Run Summary (${report.measuredAt})`,
      '',
      '> Factual measurement report only — no SLO/RPO/RTO targets are approved yet.',
      '',
      '## pgbench-Style Run Summary',
      `- Clients: ${report.pgbenchStyleSummary.clientCount}`,
      `- Duration (actual / requested): ${report.pgbenchStyleSummary.durationSecondsActual}s / ${report.pgbenchStyleSummary.durationSecondsRequested}s (warmup ${config.warmupSec}s excluded)`,
      `- Posting ratio: ${Math.round(config.postingRatio * 100)}%`,
      `- Logical operations processed / intended: ${measured.txProcessed} / ${measured.txIntended} (failed: ${measured.txFailed})`,
      `- Logical TPS (excl. warmup & login): ${report.pgbenchStyleSummary.tpsIncludingFailedExcludedWarmup}`,
      `- Logical latency avg / stddev / p95: ${report.pgbenchStyleSummary.transactionLatencyAvgMs}ms / ${report.pgbenchStyleSummary.transactionLatencyStddevMs}ms / ${report.pgbenchStyleSummary.transactionLatencyP95Ms}ms`,
      `- HTTP requests total / failed: ${overallHttp.requests} / ${overallHttp.failed}`,
      '',
      '## Per-Endpoint Breakdown',
      '| Endpoint | Requests | Failed | TPS | Avg (ms) | Stddev (ms) | p50 (ms) | p95 (ms) |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...perEndpoint.map(
        (e) =>
          `| ${e.endpoint} | ${e.requests} | ${e.failed} | ${e.tps} | ${e.avgMs} | ${e.stddevMs} | ${e.p50Ms} | ${e.p95Ms} |`
      ),
      '',
      '## EXPLAIN (ANALYZE, FORMAT JSON) Flags Observed (Top 5 Slowest)',
      allFlags.length === 0
        ? '- None (>10x est/actual divergence or >10k Seq Scan not observed).'
        : allFlags.map((f) => `- [${f.flagType}] ${f.endpoint}: ${f.detail}`).join('\n'),
    ];
    fs.writeFileSync(path.join(reportDir, 'baseline-summary.md'), mdLines.join('\n'), 'utf8');

    console.log('\npgbench-Style Overall Summary:');
    console.table([report.pgbenchStyleSummary]);

    console.log('\nPer-Endpoint Latency & Throughput:');
    console.table(perEndpoint);

    if (overallHttp.failed > 0) {
      console.error(`\n[ERROR] Recorded ${overallHttp.failed} failed HTTP requests (first samples):`);
      console.table(failureDetails);
    }

    console.log('\nDB Query Counter (pg_stat_statements):');
    console.log(JSON.stringify(pgStatSummary, null, 2));

    console.log(`\nEXPLAIN Flags Observed (${allFlags.length}):`);
    if (allFlags.length > 0) {
      console.table(allFlags);
    } else {
      console.log('None');
    }

    console.log(`\n[perf:load] Saved full JSON report to .test-reports/perf/baseline-report.json`);

    if (overallHttp.failed > 0 || measured.txFailed > 0) {
      process.exit(1);
    }
  } finally {
    await db.end().catch(() => {});
  }
}

const isDirectCli = process.argv[1]?.endsWith('loadModel.ts');
if (isDirectCli) {
  runLoadModel().catch((err) => {
    const msg = redactLogText(err instanceof Error ? err.message : String(err));
    console.error('[perf:load] FAILED:', msg);
    process.exit(1);
  });
}
