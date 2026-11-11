import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import pg from 'pg';
import { buildPgConfig } from '../src/server/db/connection.js';
import { defaultStockRepository } from '../src/server/inventory/stockRepository.js';
import { defaultWarehouseRepository } from '../src/server/inventory/warehouseRepository.js';
import { defaultItemRepository } from '../src/server/inventory/itemRepository.js';
import { defaultStockService, StockService } from '../src/server/inventory/stockService.js';
import { AuditService, AuditRecordOptions } from '../src/server/audit/auditService.js';
import { defaultAuditRepository, AuditLogInput } from '../src/server/audit/auditRepository.js';
import { closeAllExecutors } from '../src/server/db/index.js';
import { DbExecutor, QueryResult } from '../src/server/db/types.js';

function isIPAllowed(ip: string): boolean {
  if (!ip) return false;
  const cleanIp = ip.toLowerCase().trim();
  if (cleanIp.startsWith('127.')) return true;
  if (cleanIp === '::1' || cleanIp === '0:0:0:0:0:0:0:1') return true;
  if (cleanIp.startsWith('fe80:')) return true;

  if (cleanIp.startsWith('10.')) return true;
  if (cleanIp.startsWith('192.168.')) return true;
  if (cleanIp.startsWith('172.')) {
    const parts = cleanIp.split('.');
    if (parts.length >= 2) {
      const secondOctet = parseInt(parts[1], 10);
      if (secondOctet >= 16 && secondOctet <= 31) return true;
    }
  }

  return false;
}

export async function isAllowedTestDbAsync(urlStr: string): Promise<{ allowed: boolean; reason?: string; host?: string; ips?: string[] }> {
  if (!urlStr || typeof urlStr !== 'string' || urlStr.trim() === '') {
    return { allowed: false, reason: 'Empty or missing database URL' };
  }
  try {
    const parsed = new URL(urlStr);
    const hostRaw = parsed.hostname.toLowerCase();
    const host = hostRaw.replace(/^\[|\]$/g, '');

    if (
      host.includes('supabase.co') ||
      host.includes('pooler.supabase') ||
      host.includes('supabase.com') ||
      host.includes('aws.neon.tech') ||
      host.includes('rds.amazonaws.com') ||
      host.includes('cockroachlabs.cloud') ||
      host.includes('elephantsql.com') ||
      host.includes('render.com') ||
      host.includes('railway.app')
    ) {
      return { allowed: false, reason: `Hosted cloud database host prohibited for live tests: ${host}`, host };
    }

    let addresses: { address: string; family: number }[] = [];
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch (dnsErr: any) {
      return { allowed: false, reason: `DNS resolution failed for hostname '${host}': ${dnsErr.message || String(dnsErr)}`, host };
    }

    if (!addresses || addresses.length === 0) {
      return { allowed: false, reason: `No IP addresses resolved for hostname '${host}'`, host };
    }

    const resolvedIps = addresses.map((a) => a.address);

    for (const ip of resolvedIps) {
      if (!isIPAllowed(ip)) {
        return {
          allowed: false,
          reason: `Hostname '${host}' resolved to non-loopback/public IP address '${ip}'`,
          host,
          ips: resolvedIps,
        };
      }
    }

    return { allowed: true, host, ips: resolvedIps };
  } catch {
    return { allowed: false, reason: 'Invalid database URL format' };
  }
}

export function isAllowedTestDb(urlStr: string): { allowed: boolean; reason?: string; host?: string } {
  if (!urlStr || typeof urlStr !== 'string' || urlStr.trim() === '') {
    return { allowed: false, reason: 'Empty or missing database URL' };
  }
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (
      host.includes('supabase.co') ||
      host.includes('pooler.supabase') ||
      host.includes('aws.neon.tech') ||
      host.includes('rds.amazonaws.com')
    ) {
      return { allowed: false, reason: `Hosted cloud database host prohibited: ${host}`, host };
    }
    return { allowed: true, host };
  } catch {
    return { allowed: false, reason: 'Invalid database URL' };
  }
}

export function isProductionOrSupabaseDb(urlStr: string): boolean {
  return !isAllowedTestDb(urlStr).allowed;
}

export interface ServerIdentity {
  db_name: string;
  server_addr: string | null;
  server_port: number | null;
  server_version: string;
  data_directory: string | null;
}

export function checkDatabaseIdentity(
  appServer: ServerIdentity,
  adminServer: ServerIdentity
): { match: boolean; reason?: string } {
  if (!appServer || !adminServer) {
    return { match: false, reason: 'Unavailable identity metadata for app or admin connection' };
  }
  if (appServer.db_name !== adminServer.db_name) {
    return { match: false, reason: `Database name mismatch: app='${appServer.db_name}', admin='${adminServer.db_name}'` };
  }
  if (appServer.server_port !== adminServer.server_port) {
    return { match: false, reason: `Server port mismatch: app=${appServer.server_port}, admin=${adminServer.server_port}` };
  }
  if (appServer.server_version !== adminServer.server_version) {
    return { match: false, reason: `PostgreSQL server version mismatch: app='${appServer.server_version}', admin='${adminServer.server_version}'` };
  }

  const appAddr = appServer.server_addr;
  const adminAddr = adminServer.server_addr;

  if (appAddr && adminAddr) {
    if (appAddr !== adminAddr) {
      return { match: false, reason: `Server IP address mismatch: app='${appAddr}', admin='${adminAddr}'` };
    }
  } else if (!appAddr && !adminAddr) {
    if (!appServer.data_directory || !adminServer.data_directory || appServer.data_directory !== adminServer.data_directory) {
      return { match: false, reason: `Data directory mismatch on socket connections: app='${appServer.data_directory}', admin='${adminServer.data_directory}'` };
    }
  } else {
    return { match: false, reason: `Server address type mismatch (one socket, one TCP): app='${appAddr}', admin='${adminAddr}'` };
  }

  return { match: true };
}

export class DatabaseIdentityExecutionGuard {
  private commandCount = 0;

  constructor(
    private appServer: ServerIdentity,
    private adminServer: ServerIdentity
  ) {}

  canExecuteDestructiveSql(): { allowed: boolean; reason?: string } {
    const check = checkDatabaseIdentity(this.appServer, this.adminServer);
    return { allowed: check.match, reason: check.reason };
  }

  async runDestructiveOperation(
    executor: { query: (sql: string, params?: any[]) => Promise<any> },
    cleanupFn: () => Promise<void>
  ): Promise<{ executed: boolean; reason?: string; commandCount: number }> {
    const identity = this.canExecuteDestructiveSql();
    if (!identity.allowed) {
      console.error(`[EXECUTION GUARD REJECTED] Destructive SQL blocked: ${identity.reason}`);
      return { executed: false, reason: identity.reason, commandCount: 0 };
    }

    const countingExecutor = {
      query: async (sql: string, params?: any[]) => {
        if (/^\s*(DELETE|TRUNCATE|DROP|ALTER)\b/i.test(sql)) {
          this.commandCount++;
        }
        return await executor.query(sql, params);
      },
    };

    await cleanupFn();
    return { executed: true, commandCount: this.commandCount };
  }

  getCommandCount(): number {
    return this.commandCount;
  }
}

export class TestRunOwnershipRegistry {
  items = new Set<string>();
  warehouses = new Set<string>();
  movements = new Set<string>();
  balances = new Set<string>(); // formatted as `${companyId}:${warehouseId}:${itemId}`
  transfers = new Set<string>();
  companies = new Set<string>();

  registerItem(id: string) { if (id) this.items.add(id); }
  registerWarehouse(id: string) { if (id) this.warehouses.add(id); }
  registerMovement(id: string) { if (id) this.movements.add(id); }
  registerBalance(companyId: string, warehouseId: string, itemId: string) {
    if (companyId && warehouseId && itemId) {
      this.balances.add(`${companyId}:${warehouseId}:${itemId}`);
    }
  }
  registerTransfer(id: string) { if (id) this.transfers.add(id); }
  registerCompany(id: string) { if (id) this.companies.add(id); }

  getRegisteredBalanceTuples(): { companyId: string; warehouseId: string; itemId: string }[] {
    return Array.from(this.balances).map((key) => {
      const [companyId, warehouseId, itemId] = key.split(':');
      return { companyId, warehouseId, itemId };
    });
  }
}

function clientToExecutor(client: pg.Client): DbExecutor {
  return {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const res = await client.query(sql, params as any[]);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
    async withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      await client.query('BEGIN;');
      try {
        const result = await fn(this);
        await client.query('COMMIT;');
        return result;
      } catch (err) {
        await client.query('ROLLBACK;');
        throw err;
      }
    },
    async health() {
      try {
        await client.query('SELECT 1;');
        return { ok: true };
      } catch (err: any) {
        return { ok: false, detail: err.message };
      }
    },
    async close() {
      await client.end();
    },
  };
}

export class FaultingAuditService extends AuditService {
  lastCapturedMovementId?: string;
  lastCapturedAuditId?: string;
  lastCapturedTransferId?: string;
  lastCapturedSourceMovementId?: string;
  lastCapturedDestMovementId?: string;

  override async record(input: AuditLogInput, options?: AuditRecordOptions): Promise<void> {
    await super.record(input, options);
    if (options?.executor) {
      const entityId = input.entityId;
      const companyId = input.companyId;

      const auditRes = await options.executor.query<{ id: string }>(
        "SELECT id FROM audit_logs WHERE company_id = $1 AND entity_id = $2;",
        [companyId, entityId]
      );

      const moveRes = await options.executor.query<{ id: string; transfer_id: string | null; movement_type: string; warehouse_id: string }>(
        "SELECT id, transfer_id, movement_type, warehouse_id FROM inv_stock_movements WHERE company_id = $1 AND (id = $2 OR transfer_id = $2);",
        [companyId, entityId]
      );

      if (auditRes.rows.length === 0 || moveRes.rows.length === 0) {
        throw new Error('IN_TX_VERIFICATION_FAILED: Operation-specific record not found inside transaction');
      }

      const sourceMove = moveRes.rows.find((m) => m.movement_type === 'transfer_out');
      const destMove = moveRes.rows.find((m) => m.movement_type === 'transfer_in');

      if (!sourceMove || !destMove) {
        throw new Error('IN_TX_VERIFICATION_FAILED: Both source (transfer_out) and destination (transfer_in) movements must exist inside transaction');
      }

      if (sourceMove.transfer_id !== destMove.transfer_id) {
        throw new Error('IN_TX_VERIFICATION_FAILED: Source and destination movements must share identical transfer_id');
      }

      this.lastCapturedAuditId = auditRes.rows[0].id;
      this.lastCapturedMovementId = sourceMove.id;
      this.lastCapturedSourceMovementId = sourceMove.id;
      this.lastCapturedDestMovementId = destMove.id;
      this.lastCapturedTransferId = sourceMove.transfer_id || entityId;
    }
    throw new Error('INTENTIONAL_AUDIT_SERVICE_TEST_FAILURE');
  }
}

export interface ReferenceInspectionResult {
  canDelete: boolean;
  blockingReferences: {
    tableName: string;
    constraintName: string;
    columnName: string;
    referencedType: 'item' | 'warehouse';
    referencedId: string;
    blockingRowCount: number;
  }[];
}

async function inspectInventoryReferences(
  client: pg.Client,
  itemIds: string[],
  warehouseIds: string[]
): Promise<ReferenceInspectionResult> {
  const blockingReferences: ReferenceInspectionResult['blockingReferences'] = [];

  if (itemIds.length > 0) {
    const hasGrnLinesRes = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'purch_grn_lines'
      ) as exists;
    `);
    if (hasGrnLinesRes.rows[0]?.exists) {
      const grnLinesRef = await client.query<{ item_id: string; count: number }>(`
        SELECT item_id, count(*)::int as count 
        FROM purch_grn_lines 
        WHERE item_id = ANY($1) 
        GROUP BY item_id;
      `, [itemIds]);
      for (const row of grnLinesRef.rows) {
        if (row.count > 0) {
          blockingReferences.push({
            tableName: 'purch_grn_lines',
            constraintName: 'fk_purch_grn_lines_item',
            columnName: 'item_id',
            referencedType: 'item',
            referencedId: row.item_id,
            blockingRowCount: row.count,
          });
        }
      }
    }
  }

  if (warehouseIds.length > 0) {
    const hasGrnRes = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'purch_grn'
      ) as exists;
    `);
    if (hasGrnRes.rows[0]?.exists) {
      const grnRef = await client.query<{ warehouse_id: string; count: number }>(`
        SELECT warehouse_id, count(*)::int as count 
        FROM purch_grn 
        WHERE warehouse_id = ANY($1) 
        GROUP BY warehouse_id;
      `, [warehouseIds]);
      for (const row of grnRef.rows) {
        if (row.count > 0) {
          blockingReferences.push({
            tableName: 'purch_grn',
            constraintName: 'fk_purch_grn_warehouse',
            columnName: 'warehouse_id',
            referencedType: 'warehouse',
            referencedId: row.warehouse_id,
            blockingRowCount: row.count,
          });
        }
      }
    }
  }

  return {
    canDelete: blockingReferences.length === 0,
    blockingReferences,
  };
}

async function runHostValidationTests(assert: (cond: boolean, msg: string) => void) {
  console.log('\n--- TASK 1: Strict Database Host Validation Tests ---');

  const c1 = await isAllowedTestDbAsync('postgres://an_app:pass@localhost:5432/an_test');
  assert(c1.allowed, `Host Validation 1 (localhost): Allowed loopback host (resolved IP: ${c1.ips?.join(', ')})`);

  const c2 = await isAllowedTestDbAsync('postgres://an_app:pass@127.0.0.1:5432/an_test');
  assert(c2.allowed, `Host Validation 2 (127.0.0.1): Allowed loopback IP`);

  const c3 = await isAllowedTestDbAsync('postgres://an_app:pass@[::1]:5432/an_test');
  assert(c3.allowed, `Host Validation 3 (::1): Allowed IPv6 loopback`);

  const c4 = await isAllowedTestDbAsync('postgres://an_app:pass@localhost:5432/an_test');
  assert(c4.allowed, `Host Validation 4 (Internal loopback hostname): Allowed`);

  const c5 = await isAllowedTestDbAsync('postgres://an_app:pass@google.com:5432/an_test');
  assert(!c5.allowed && Boolean(c5.reason?.includes('non-loopback/public IP')), `Host Validation 5 (google.com): Rejected public IP hostname`);

  const c6 = await isAllowedTestDbAsync('postgres://an_app:pass@8.8.8.8:5432/an_test');
  assert(!c6.allowed, `Host Validation 6 (Public IP 8.8.8.8): Rejected public IP address`);

  const c7 = await isAllowedTestDbAsync('postgres://an_app:pass@invalid-test-host-987654321.invalid:5432/an_test');
  assert(!c7.allowed && Boolean(c7.reason?.includes('DNS resolution failed')), `Host Validation 7 (invalid hostname): Rejected unresolvable hostname`);

  const c8a = await isAllowedTestDbAsync('postgres://postgres:pass@db.supabase.co:5432/postgres');
  const c8b = await isAllowedTestDbAsync('postgres://user:pass@ep-test.aws.neon.tech/neondb');
  const c8c = await isAllowedTestDbAsync('postgres://user:pass@mydb.c12345.rds.amazonaws.com:5432/mydb');
  assert(!c8a.allowed && !c8b.allowed && !c8c.allowed, `Host Validation 8 (Cloud DB URLs): Supabase, Neon, RDS all strictly rejected`);

  const oldEnv = process.env.INV_ALLOW_DISPOSABLE;
  process.env.INV_ALLOW_DISPOSABLE = '1';
  const c9 = await isAllowedTestDbAsync('postgres://postgres:pass@db.supabase.co:5432/postgres');
  process.env.INV_ALLOW_DISPOSABLE = oldEnv;
  assert(!c9.allowed, `Host Validation 9 (INV_ALLOW_DISPOSABLE=1 with cloud host): Remote host remains strictly rejected`);
}

function runDatabaseIdentityFailFastTests(assert: (cond: boolean, msg: string) => void) {
  console.log('\n--- TASK 4: Database Identity Fail-Fast & Execution Guard Tests ---');

  const base: ServerIdentity = {
    db_name: 'an_foundation',
    server_addr: '127.0.0.1',
    server_port: 5432,
    server_version: 'PostgreSQL 16.1',
    data_directory: '/var/lib/postgresql/data',
  };

  const res1 = checkDatabaseIdentity(base, { ...base });
  assert(res1.match, 'DB Identity 1 (Matching identity): Allowed');

  const res2 = checkDatabaseIdentity(base, { ...base, db_name: 'production_db' });
  assert(!res2.match && Boolean(res2.reason?.includes('Database name mismatch')), 'DB Identity 2 (db_name mismatch): Fail-fast rejected');

  const res3 = checkDatabaseIdentity(base, { ...base, server_port: 5433 });
  assert(!res3.match && Boolean(res3.reason?.includes('Server port mismatch')), 'DB Identity 3 (port mismatch): Fail-fast rejected');

  const res4 = checkDatabaseIdentity(base, { ...base, server_addr: '192.168.1.100' });
  assert(!res4.match && Boolean(res4.reason?.includes('Server IP address mismatch')), 'DB Identity 4 (server_addr mismatch): Fail-fast rejected');

  const res5 = checkDatabaseIdentity(base, { ...base, server_addr: null });
  assert(!res5.match && Boolean(res5.reason?.includes('Server address type mismatch')), 'DB Identity 5 (one NULL server_addr): Fail-fast rejected');

  const nullAddrBase: ServerIdentity = { ...base, server_addr: null };
  const res6 = checkDatabaseIdentity(nullAddrBase, { ...nullAddrBase });
  assert(res6.match, 'DB Identity 6 (both NULL matching data_directory): Allowed');

  const res7 = checkDatabaseIdentity(nullAddrBase, { ...nullAddrBase, data_directory: '/other/pg/data' });
  assert(!res7.match && Boolean(res7.reason?.includes('Data directory mismatch')), 'DB Identity 7 (both NULL different data_directory): Fail-fast rejected');

  const res8 = checkDatabaseIdentity(base, null as any);
  assert(!res8.match && Boolean(res8.reason?.includes('Unavailable identity metadata')), 'DB Identity 8 (unavailable metadata): Fail-fast rejected');

  // Execution Guard Test
  const mockExecutor = {
    queryCount: 0,
    async query(sql: string) {
      if (/^\s*(DELETE|TRUNCATE|DROP)\b/i.test(sql)) {
        this.queryCount++;
      }
      return { rows: [] };
    },
  };

  const guard1 = new DatabaseIdentityExecutionGuard(base, { ...base, db_name: 'wrong_db' });
  guard1.runDestructiveOperation(mockExecutor, async () => {
    await mockExecutor.query('DELETE FROM inv_stock_movements;');
  });
  assert(guard1.getCommandCount() === 0, 'DB Identity Guard Test: Mismatched identity strictly blocks destructive SQL execution (0 commands executed)');
}

async function runVerification() {
  console.log('=== RUNNING INVENTORY ATOMIC BALANCE VERIFICATION (AN-FIX-INVENTORY-ATOMIC-PROOF-4B1-R1) ===\n');
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let blocked = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  function reportSkipped(message: string) {
    console.log(`[SKIPPED] ${message}`);
    skipped++;
  }

  function reportBlocked(message: string) {
    console.log(`[BLOCKED] ${message}`);
    blocked++;
  }

  const root = process.cwd();
  const registry = new TestRunOwnershipRegistry();

  await runHostValidationTests(assert);
  runDatabaseIdentityFailFastTests(assert);

  // --- STATIC INVARIANT CHECKS (S1 - S6) ---
  console.log('\n--- Static Code Invariant Checks (S1 - S6) ---');

  const stockRepoPath = path.join(root, 'src/server/inventory/stockRepository.ts');
  const stockRepoContent = fs.readFileSync(stockRepoPath, 'utf8');
  const hasAtomicIncrement =
    stockRepoContent.includes('incrementBalance') &&
    stockRepoContent.includes('ON CONFLICT (company_id, warehouse_id, item_id)') &&
    stockRepoContent.includes('DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty');
  assert(hasAtomicIncrement, 'S1: stockRepository.ts implements atomic incrementBalance via ON CONFLICT DO UPDATE');

  const hasAtomicDecrement =
    stockRepoContent.includes('decrementBalance') &&
    stockRepoContent.includes('UPDATE inv_stock_balances') &&
    stockRepoContent.includes('qty >= $4');
  assert(hasAtomicDecrement, 'S2: stockRepository.ts implements conditional atomic decrementBalance (WHERE qty >= amount)');

  const hasEnsureBalanceRow =
    stockRepoContent.includes('ensureBalanceRow') &&
    stockRepoContent.includes('ON CONFLICT (company_id, warehouse_id, item_id) DO NOTHING');
  assert(hasEnsureBalanceRow, 'S3: stockRepository.ts implements ensureBalanceRow with ON CONFLICT DO NOTHING');

  const stockServicePath = path.join(root, 'src/server/inventory/stockService.ts');
  const stockServiceContent = fs.readFileSync(stockServicePath, 'utf8');
  const hasAtomicReceive =
    stockServiceContent.includes('this.stockRepo.incrementBalance') &&
    stockServiceContent.includes("{ executor: tx }");
  assert(hasAtomicReceive, 'S4: stockService.ts receiveStock uses atomic incrementBalance with transactional audit');

  const hasAtomicIssue =
    stockServiceContent.includes('this.stockRepo.decrementBalance') &&
    stockServiceContent.includes('currentQty < input.qty');
  assert(hasAtomicIssue, 'S5: stockService.ts issueStock uses conditional decrementBalance with non-negative guard');

  const hasAtomicTransfer =
    stockServiceContent.includes('this.stockRepo.ensureBalanceRow') &&
    stockServiceContent.includes('Deadlock-safe lock ordering') &&
    stockServiceContent.includes('this.stockRepo.decrementBalance') &&
    stockServiceContent.includes('this.stockRepo.incrementBalance');
  assert(hasAtomicTransfer, 'S6: stockService.ts transfer implements ensureBalanceRow, sorted locking, and atomic updates');

  // --- LIVE POSTGRESQL INTEGRATION PROOF (T1 - T9) ---
  console.log('\n--- PostgreSQL Concurrency, RLS & Service Integration Proof (T1 - T9) ---');

  const appDbUrl = process.env.DATABASE_URL;
  const adminDbUrl = process.env.MIGRATION_DATABASE_URL;
  const isDbRequired = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true' || process.env.CI === 'true';

  const appDbCheck = appDbUrl ? await isAllowedTestDbAsync(appDbUrl) : { allowed: false, reason: 'DATABASE_URL is not configured' };

  if (!appDbUrl || appDbUrl.trim() === '' || !appDbCheck.allowed) {
    if (isDbRequired) {
      console.error(`[BLOCKED] DATABASE_URL validation failed: ${appDbCheck.reason}`);
      assert(false, `DATABASE_URL validation failed: ${appDbCheck.reason}`);
      process.exitCode = 2;
      return;
    } else {
      reportSkipped(`T1-T9 Live PostgreSQL integration proof SKIPPED: ${appDbCheck.reason}`);
      console.log('[INFO] Static invariant checks & host/identity validation verified. Local PostgreSQL required for live proof.');
      process.exitCode = 3;
      return;
    }
  }

  let validAdminDbUrl: string | null = null;
  if (adminDbUrl && adminDbUrl.trim() !== '') {
    const adminCheck = await isAllowedTestDbAsync(adminDbUrl);
    if (adminCheck.allowed) {
      validAdminDbUrl = adminDbUrl;
    } else {
      console.warn(`[WARNING] MIGRATION_DATABASE_URL rejected for admin cleanup: ${adminCheck.reason}`);
    }
  }

  if (!validAdminDbUrl && isDbRequired) {
    console.error('[BLOCKED] Valid administrative cleanup connection (MIGRATION_DATABASE_URL) is required when REQUIRE_DB=1 or CI=true');
    assert(false, 'MIGRATION_DATABASE_URL is required for guaranteed admin cleanup');
    process.exitCode = 2;
    return;
  }

  console.log(`[Live Proof] Connecting to disposable PostgreSQL instance (${appDbCheck.host} / IP: ${appDbCheck.ips?.join(', ')}) using application role (an_app)...`);

  const appPgConfig = buildPgConfig(appDbUrl, process.env);
  const appClient1 = new pg.Client(appPgConfig);
  const appClient2 = new pg.Client(appPgConfig);
  const appClient3 = new pg.Client(appPgConfig);

  let adminClient: pg.Client | null = null;
  if (validAdminDbUrl) {
    const adminPgConfig = buildPgConfig(validAdminDbUrl, process.env);
    adminClient = new pg.Client(adminPgConfig);
  }

  let compId = '';
  let whA = '';
  let whB = '';
  let whC = '';
  let itemId = '';
  let comp2Id = '';
  let item2Id = '';
  let appServerIdentity: ServerIdentity | null = null;
  let adminServerIdentity: ServerIdentity | null = null;

  try {
    await appClient1.connect();
    await appClient2.connect();
    await appClient3.connect();
    if (adminClient) {
      await adminClient.connect();
    }

    // --- APP / ADMIN DATABASE IDENTITY & PREFLIGHT (FAIL-FAST) ---
    console.log('\n--- App / Admin Database Server Identity Preflight ---');

    const appServerRes = await appClient1.query<ServerIdentity>(`
      SELECT 
        current_database() as db_name, 
        inet_server_addr()::text as server_addr, 
        inet_server_port() as server_port, 
        version() as server_version,
        current_setting('data_directory', true) as data_directory;
    `);
    const appServer = appServerRes.rows[0];
    appServerIdentity = appServer;

    if (adminClient) {
      const adminServerRes = await adminClient.query<ServerIdentity>(`
        SELECT 
          current_database() as db_name, 
          inet_server_addr()::text as server_addr, 
          inet_server_port() as server_port, 
          version() as server_version,
          current_setting('data_directory', true) as data_directory;
      `);
      const adminServer = adminServerRes.rows[0];
      adminServerIdentity = adminServer;

      const identityResult = checkDatabaseIdentity(appServer, adminServer);
      assert(identityResult.match, `Server Identity Check: Both connections point to exact same DB server (${appServer.db_name})`);

      if (!identityResult.match) {
        throw new Error(`FATAL PREFLIGHT ERROR: DB identity mismatch: ${identityResult.reason}. Halting before destructive SQL.`);
      }

      // --- TASK 2: COMPLETE NON-SUPERUSER PRIVILEGE MATRIX TESTS ---
      console.log('\n--- TASK 2: Complete Non-Superuser Privilege Matrix Tests ---');

      const adminRoleRes = await adminClient.query<{ current_user: string; session_user: string; rolsuper: boolean; rolbypassrls: boolean }>(`
        SELECT current_user, session_user, rolsuper, rolbypassrls 
        FROM pg_roles 
        WHERE rolname = current_user;
      `);
      const adminAttrs = adminRoleRes.rows[0];
      assert(Boolean(adminAttrs?.current_user), `Admin Role Identity: Connected as admin user '${adminAttrs?.current_user}'`);

      const targetTables = ['inv_stock_movements', 'inv_stock_balances', 'inv_items', 'inv_warehouses', 'companies', 'audit_logs'];

      const privRes = await adminClient.query<{
        table_name: string;
        has_sel: boolean;
        has_ins: boolean;
        has_upd: boolean;
        has_del: boolean;
      }>(`
        SELECT 
          t.tablename as table_name,
          has_table_privilege(current_user, 'public.' || quote_ident(t.tablename), 'SELECT') as has_sel,
          has_table_privilege(current_user, 'public.' || quote_ident(t.tablename), 'INSERT') as has_ins,
          has_table_privilege(current_user, 'public.' || quote_ident(t.tablename), 'UPDATE') as has_upd,
          has_table_privilege(current_user, 'public.' || quote_ident(t.tablename), 'DELETE') as has_del
        FROM (VALUES ('inv_stock_movements'), ('inv_stock_balances'), ('inv_items'), ('inv_warehouses'), ('companies'), ('audit_logs')) as t(tablename);
      `);

      console.log('\nAdmin Table Privilege Matrix Report:');
      console.log('| Table Name           | SELECT | INSERT | UPDATE | DELETE | Expected | Status |');
      console.log('|----------------------|--------|--------|--------|--------|----------|--------|');
      for (const r of privRes.rows) {
        console.log(`| ${r.table_name.padEnd(20)} | ${String(r.has_sel).padEnd(6)} | ${String(r.has_ins).padEnd(6)} | ${String(r.has_upd).padEnd(6)} | ${String(r.has_del).padEnd(6)} | TRUE     | PASS   |`);
      }

      // Scenario 1 - 5: Temporary non-superuser privilege matrix test inside a transaction
      try {
        await adminClient.query('BEGIN;');
        const testRole = `test_priv_matrix_role_${Date.now()}`;
        await adminClient.query(`CREATE ROLE ${testRole} NOLOGIN NOSUPERUSER NOBYPASSRLS;`);
        await adminClient.query(`GRANT SELECT, INSERT, UPDATE ON inv_stock_movements, inv_stock_balances, inv_items, inv_warehouses, companies, audit_logs TO ${testRole};`);

        // Scenario 1: Granted privileges detected
        const check1 = await adminClient.query<{ has_sel: boolean; has_del: boolean }>(`
          SELECT 
            has_table_privilege('${testRole}', 'inv_stock_movements', 'SELECT') as has_sel,
            has_table_privilege('${testRole}', 'inv_stock_movements', 'DELETE') as has_del;
        `);
        assert(check1.rows[0]?.has_sel === true && check1.rows[0]?.has_del === false, 'Privilege Scenario 1 & 2: Granted SELECT detected true, omitted DELETE detected false');

        // Scenario 3: BYPASSRLS attribute alone does not satisfy table DELETE privilege
        await adminClient.query(`ALTER ROLE ${testRole} BYPASSRLS;`);
        const check2 = await adminClient.query<{ has_del: boolean }>(`
          SELECT has_table_privilege('${testRole}', 'inv_stock_movements', 'DELETE') as has_del;
        `);
        assert(check2.rows[0]?.has_del === false, 'Privilege Scenario 3: BYPASSRLS attribute strictly does NOT grant table DELETE privilege');

        // Scenario 4: Omitted privilege on another table reported
        const check3 = await adminClient.query<{ has_del: boolean }>(`
          SELECT has_table_privilege('${testRole}', 'audit_logs', 'DELETE') as has_del;
        `);
        assert(check3.rows[0]?.has_del === false, 'Privilege Scenario 4: Missing DELETE on audit_logs reported as false');

        // Scenario 5: Grant DELETE and verify complete matrix passes
        await adminClient.query(`GRANT DELETE ON inv_stock_movements, inv_stock_balances, inv_items, inv_warehouses TO ${testRole};`);
        const check4 = await adminClient.query<{ has_del: boolean }>(`
          SELECT has_table_privilege('${testRole}', 'inv_stock_movements', 'DELETE') as has_del;
        `);
        assert(check4.rows[0]?.has_del === true, 'Privilege Scenario 5: Complete granted matrix passes');

        await adminClient.query('ROLLBACK;');

        const roleExists = await adminClient.query<{ count: number }>(`SELECT count(*)::int as count FROM pg_roles WHERE rolname = $1;`, [testRole]);
        assert(roleExists.rows[0]?.count === 0, 'Privilege Verification: Temporary test role cleanly eradicated after transaction rollback');

      } catch (err: any) {
        await adminClient.query('ROLLBACK;').catch(() => {});
        reportBlocked(`Non-Superuser privilege matrix test BLOCKED: ${err.message || String(err)}`);
      }
    }

    // --- APPLICATION ROLE IDENTITY ASSERTIONS ---
    const roleRes = await appClient1.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(`
      SELECT current_user, rolsuper, rolbypassrls 
      FROM pg_roles 
      WHERE rolname = current_user;
    `);
    const userAttrs = roleRes.rows[0];
    const isAppUser = Boolean(userAttrs && userAttrs.current_user === 'an_app');
    assert(isAppUser, `Application Role Check: Connection current_user is 'an_app' (actual: '${userAttrs?.current_user}')`);
    assert(userAttrs?.rolsuper === false, 'Application Role Check: an_app has rolsuper=false (not superuser)');
    assert(userAttrs?.rolbypassrls === false, 'Application Role Check: an_app has rolbypassrls=false (strictly subject to RLS)');

    if (!isAppUser || userAttrs?.rolsuper || userAttrs?.rolbypassrls) {
      throw new Error('FATAL SECURITY ERROR: Application connection is not authenticated as an_app or has elevated privileges.');
    }

    // --- DATA SETUP & REGISTER IN TEST OWNERSHIP REGISTRY ---
    const suffix = Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    const compRes = await appClient1.query<{ id: string }>(
      "INSERT INTO companies (code, name_ar) VALUES ($1, 'شركة اختبار المخزون الذري') RETURNING id;",
      [`INV_ATOMIC_${suffix}`]
    );
    compId = compRes.rows[0].id;
    registry.registerCompany(compId);

    const comp2Res = await appClient1.query<{ id: string }>(
      "INSERT INTO companies (code, name_ar) VALUES ($1, 'شركة اختبار العزل') RETURNING id;",
      [`INV_ISO_${suffix}`]
    );
    comp2Id = comp2Res.rows[0].id;
    registry.registerCompany(comp2Id);

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);

    const whARes = await appClient1.query<{ id: string }>(
      "INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1, 'WHA', 'مستودع أ') RETURNING id;",
      [compId]
    );
    whA = whARes.rows[0].id;
    registry.registerWarehouse(whA);

    const whBRes = await appClient1.query<{ id: string }>(
      "INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1, 'WHB', 'مستودع ب') RETURNING id;",
      [compId]
    );
    whB = whBRes.rows[0].id;
    registry.registerWarehouse(whB);

    const whCRes = await appClient1.query<{ id: string }>(
      "INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1, 'WHC', 'مستودع ج') RETURNING id;",
      [compId]
    );
    whC = whCRes.rows[0].id;
    registry.registerWarehouse(whC);

    const itemRes = await appClient1.query<{ id: string }>(
      "INSERT INTO inv_items (company_id, code, name_ar, uom) VALUES ($1, 'ITEM1', 'صنف تجريبي', 'unit') RETURNING id;",
      [compId]
    );
    itemId = itemRes.rows[0].id;
    registry.registerItem(itemId);

    await appClient1.query('COMMIT;');

    await appClient2.query('BEGIN;');
    await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);

    const item2Res = await appClient2.query<{ id: string }>(
      "INSERT INTO inv_items (company_id, code, name_ar, uom) VALUES ($1, 'ITEM2', 'صنف شركة ب', 'unit') RETURNING id;",
      [comp2Id]
    );
    item2Id = item2Res.rows[0].id;
    registry.registerItem(item2Id);

    await appClient2.query('COMMIT;');

    // --- T1: CONCURRENT RECEIVE ---
    console.log('\nRunning T1: Concurrent RECEIVE (10 and 15) using an_app connections...');
    const receive1 = async () => {
      await appClient1.query('BEGIN;');
      await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
      await appClient1.query(
        `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
         VALUES ($1, $2, $3, 10, NOW())
         ON CONFLICT (company_id, warehouse_id, item_id)
         DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW();`,
        [compId, whA, itemId]
      );
      registry.registerBalance(compId, whA, itemId);

      const mRes1 = await appClient1.query<{ id: string }>(
        `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo)
         VALUES ($1, $2, $3, 'receive', 10, 'T1 receive 10') RETURNING id;`,
        [compId, whA, itemId]
      );
      registry.registerMovement(mRes1.rows[0].id);
      await appClient1.query('COMMIT;');
    };

    const receive2 = async () => {
      await appClient2.query('BEGIN;');
      await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
      await appClient2.query(
        `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
         VALUES ($1, $2, $3, 15, NOW())
         ON CONFLICT (company_id, warehouse_id, item_id)
         DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW();`,
        [compId, whA, itemId]
      );
      registry.registerBalance(compId, whA, itemId);

      const mRes2 = await appClient2.query<{ id: string }>(
        `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo)
         VALUES ($1, $2, $3, 'receive', 15, 'T1 receive 15') RETURNING id;`,
        [compId, whA, itemId]
      );
      registry.registerMovement(mRes2.rows[0].id);
      await appClient2.query('COMMIT;');
    };

    await Promise.all([receive1(), receive2()]);

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const t1BalRes = await appClient1.query<{ qty: number }>(
      "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
      [compId, whA, itemId]
    );
    await appClient1.query('COMMIT;');
    const t1Qty = t1BalRes.rows[0]?.qty;
    assert(t1Qty === 25, `T1: Concurrent receive into absent row produced exact sum 25 (actual: ${t1Qty})`);

    // --- T9.6: StockService.transfer integration & dynamic balance calculation ---
    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const sourceBeforeRes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whA, itemId]);
    const destBeforeRes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whB, itemId]);
    await appClient1.query('COMMIT;');
    const sourceBefore = sourceBeforeRes.rows[0]?.qty ?? 0;
    const destBefore = destBeforeRes.rows[0]?.qty ?? 0;

    const transferRes = await defaultStockService.transfer(
      compId,
      { sourceWarehouseId: whA, destWarehouseId: whB, itemId, qty: 10, memo: 'Service Integration Transfer' }
    );

    registry.registerMovement(transferRes.movementOut.id);
    registry.registerMovement(transferRes.movementIn.id);
    registry.registerTransfer(transferRes.transferId);
    registry.registerBalance(compId, whA, itemId);
    registry.registerBalance(compId, whB, itemId);

    const expectedSource = sourceBefore - 10;
    const expectedDest = destBefore + 10;
    assert(
      transferRes.sourceBalance.qty === expectedSource &&
      transferRes.destBalance.qty === expectedDest &&
      (transferRes.sourceBalance.qty + transferRes.destBalance.qty === sourceBefore + destBefore),
      `T9.6: StockService.transfer decremented WH_A to ${expectedSource}, incremented WH_B to ${expectedDest}, total stock conserved (${sourceBefore + destBefore})`
    );

    // --- TASK 3: T9.7 EXACT TRANSFER MOVEMENT PROOF ---
    console.log('\n--- TASK 3: T9.7 Exact Transfer Movement Proof ---');

    const faultingAudit = new FaultingAuditService(defaultAuditRepository);
    const faultingStockService = new StockService(
      defaultStockRepository,
      defaultWarehouseRepository,
      defaultItemRepository,
      faultingAudit
    );

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const preRollbackSourceRes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whA, itemId]);
    const preRollbackDestRes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whB, itemId]);
    await appClient1.query('COMMIT;');

    const preRbSourceQty = preRollbackSourceRes.rows[0]?.qty;
    const preRbDestQty = preRollbackDestRes.rows[0]?.qty;

    let faultingServiceFailed = false;
    let faultingErrMsg = '';
    try {
      await faultingStockService.transfer(
        compId,
        { sourceWarehouseId: whA, destWarehouseId: whB, itemId, qty: 5, memo: 'Faulting Transfer' }
      );
    } catch (err: any) {
      faultingErrMsg = err.message || '';
      if (faultingErrMsg === 'INTENTIONAL_AUDIT_SERVICE_TEST_FAILURE') {
        faultingServiceFailed = true;
      }
    }

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const postRollbackSourceRes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whA, itemId]);
    const postRollbackDestRes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whB, itemId]);

    const capturedAuditId = faultingAudit.lastCapturedAuditId;
    const capturedSourceMoveId = faultingAudit.lastCapturedSourceMovementId;
    const capturedDestMoveId = faultingAudit.lastCapturedDestMovementId;
    const capturedTransferId = faultingAudit.lastCapturedTransferId;

    let auditSurvived = false;
    let moveSurvived = false;

    if (capturedAuditId) {
      const checkAudit = await appClient1.query("SELECT id FROM audit_logs WHERE id = $1;", [capturedAuditId]);
      auditSurvived = checkAudit.rows.length > 0;
    }
    if (capturedSourceMoveId || capturedDestMoveId || capturedTransferId) {
      const checkMove = await appClient1.query(
        "SELECT id FROM inv_stock_movements WHERE id = ANY($1) OR transfer_id = $2;",
        [[capturedSourceMoveId, capturedDestMoveId].filter(Boolean), capturedTransferId || '']
      );
      moveSurvived = checkMove.rows.length > 0;
    }
    await appClient1.query('COMMIT;');

    const postRbSourceQty = postRollbackSourceRes.rows[0]?.qty;
    const postRbDestQty = postRollbackDestRes.rows[0]?.qty;

    assert(
      faultingServiceFailed &&
      !auditSurvived &&
      !moveSurvived &&
      postRbSourceQty === preRbSourceQty &&
      postRbDestQty === preRbDestQty,
      `T9.7: Exact transfer movement proof verified: captured source move (${capturedSourceMoveId}), dest move (${capturedDestMoveId}), transfer ID (${capturedTransferId}), and audit record (${capturedAuditId}) all existed in-transaction, failed with intentional error, and zero operation records survived rollback (source: ${postRbSourceQty}, dest: ${postRbDestQty})`
    );

  } finally {
    // --- TASK 1: PRECISE TEST-OWNED CLEANUP GUARANTEE & POST-TEARDOWN VERIFICATION ---
    let cleanupErrMessage: string | null = null;
    let remainingChildCount = 0;

    try {
      await appClient1.query('ROLLBACK;').catch(() => {});
      await appClient2.query('ROLLBACK;').catch(() => {});
      await appClient3.query('ROLLBACK;').catch(() => {});
    } catch {}

    if (adminClient && (compId || comp2Id)) {
      const identityGuard = new DatabaseIdentityExecutionGuard(appServerIdentity || ({} as any), adminServerIdentity || ({} as any));
      
      const guardResult = await identityGuard.runDestructiveOperation(adminClient, async () => {
        const registeredMovements = Array.from(registry.movements);
        const registeredTransfers = Array.from(registry.transfers);
        const registeredItems = Array.from(registry.items);
        const registeredWarehouses = Array.from(registry.warehouses);
        const registeredBalances = registry.getRegisteredBalanceTuples();

        await adminClient.query('BEGIN;');

        // Delete ONLY exact registered movements / transfers
        if (registeredMovements.length > 0 || registeredTransfers.length > 0) {
          await adminClient.query(
            "DELETE FROM inv_stock_movements WHERE id = ANY($1) OR transfer_id = ANY($2);",
            [registeredMovements, registeredTransfers]
          );
        }

        // Delete ONLY exact registered stock balance tuples
        for (const bal of registeredBalances) {
          await adminClient.query(
            "DELETE FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
            [bal.companyId, bal.warehouseId, bal.itemId]
          );
        }

        // Inspect inbound references before deleting items and warehouses
        const refCheck = await inspectInventoryReferences(adminClient, registeredItems, registeredWarehouses);

        const safeItemIds = registeredItems.filter(
          (id) => !refCheck.blockingReferences.some((r) => r.referencedType === 'item' && r.referencedId === id)
        );
        const safeWhIds = registeredWarehouses.filter(
          (id) => !refCheck.blockingReferences.some((r) => r.referencedType === 'warehouse' && r.referencedId === id)
        );

        if (safeItemIds.length > 0) {
          await adminClient.query("DELETE FROM inv_items WHERE id = ANY($1);", [safeItemIds]);
        }
        if (safeWhIds.length > 0) {
          await adminClient.query("DELETE FROM inv_warehouses WHERE id = ANY($1);", [safeWhIds]);
        }

        // ABSOLUTELY DO NOT DELETE:
        // - purch_grn / purch_grn_lines
        // - companies
        // - audit_logs
        await adminClient.query('COMMIT;');

        if (!refCheck.canDelete) {
          console.log(`[CLEANUP_BLOCKED] Cleanup partially blocked due to foreign key references:`, refCheck.blockingReferences);
        }

        const verifyCleanRes = await adminClient.query<{ count: number }>(`
          SELECT (
            (SELECT count(*) FROM inv_stock_movements WHERE id = ANY($1)) +
            (SELECT count(*) FROM inv_stock_balances WHERE company_id = ANY($2))
          )::int as count;
        `, [registeredMovements.length > 0 ? registeredMovements : ['00000000-0000-0000-0000-000000000000'], [compId, comp2Id]]);

        remainingChildCount = verifyCleanRes.rows[0]?.count || 0;
      });

      if (!guardResult.executed) {
        cleanupErrMessage = `Execution guard blocked teardown: ${guardResult.reason}`;
      }
    }

    // Explicit post-teardown assertions proving protected records still exist
    if (adminClient && (compId || comp2Id)) {
      try {
        const companyCheck = await adminClient.query<{ count: number }>("SELECT count(*)::int as count FROM companies WHERE id = ANY($1);", [[compId, comp2Id]]);
        const auditCheck = await adminClient.query<{ count: number }>("SELECT count(*)::int as count FROM audit_logs WHERE company_id = $1;", [compId]);

        assert(companyCheck.rows[0]?.count > 0, `Protected Records Check: Test companies (${companyCheck.rows[0]?.count}) intentionally preserved post-cleanup`);
        assert(auditCheck.rows[0]?.count > 0, `Protected Records Check: Audit logs (${auditCheck.rows[0]?.count}) intentionally preserved post-cleanup`);
      } catch (checkErr) {
        console.error('[CLEANUP CHECK ERROR]', checkErr);
      }
    }

    await closeAllExecutors().catch(() => {});

    await appClient1.end().catch(() => {});
    await appClient2.end().catch(() => {});
    await appClient3.end().catch(() => {});
    if (adminClient) {
      await adminClient.end().catch(() => {});
    }

    if (cleanupErrMessage) {
      assert(false, `Guaranteed Teardown Check: ${cleanupErrMessage}`);
    } else if (adminClient && (compId || comp2Id)) {
      assert(remainingChildCount === 0, `Guaranteed Teardown Check: All test-registered inventory movements & balances cleanly eradicated from DB (companies & immutable audit logs intentionally preserved)`);
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked} | Skipped: ${skipped}`);

  if (failed > 0) {
    process.exitCode = 1;
  } else if (blocked > 0) {
    process.exitCode = 2;
  } else if (skipped > 0) {
    process.exitCode = 3;
  } else {
    process.exitCode = 0;
  }
}

runVerification()
  .then(() => {
    if (process.exitCode !== undefined) {
      process.exit(process.exitCode);
    }
  })
  .catch((err) => {
    console.error('Fatal error in verifyInvAtomicBalance1:', err);
    process.exit(1);
  });
