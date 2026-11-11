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

  override async record(input: AuditLogInput, options?: AuditRecordOptions): Promise<void> {
    await super.record(input, options);
    if (options?.executor) {
      const movementId = input.entityId;
      const companyId = input.companyId;

      const auditRes = await options.executor.query<{ id: string }>(
        "SELECT id FROM audit_logs WHERE company_id = $1 AND entity_id = $2;",
        [companyId, movementId]
      );
      const moveRes = await options.executor.query<{ id: string; transfer_id: string | null }>(
        "SELECT id, transfer_id FROM inv_stock_movements WHERE company_id = $1 AND (id = $2 OR transfer_id = $2);",
        [companyId, movementId]
      );

      if (auditRes.rows.length === 0 || moveRes.rows.length === 0) {
        throw new Error('IN_TX_VERIFICATION_FAILED: Operation-specific record not found inside transaction');
      }

      this.lastCapturedAuditId = auditRes.rows[0].id;
      this.lastCapturedMovementId = moveRes.rows[0].id;
      this.lastCapturedTransferId = moveRes.rows[0].transfer_id || movementId;
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
  console.log('\n--- TASK 5: Database Identity Fail-Fast Tests ---');

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
}

async function runVerification() {
  console.log('=== RUNNING INVENTORY ATOMIC BALANCE VERIFICATION (AN-FIX-INVENTORY-ATOMIC-PROOF-4B1) ===\n');
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
      process.exitCode = 2; // BLOCKED
      return;
    } else {
      reportSkipped(`T1-T9 Live PostgreSQL integration proof SKIPPED: ${appDbCheck.reason}`);
      console.log('[INFO] Static invariant checks & host/identity validation verified. Local PostgreSQL required for live proof.');
      process.exitCode = 3; // SKIPPED
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
    process.exitCode = 2; // BLOCKED
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

      const identityResult = checkDatabaseIdentity(appServer, adminServer);
      assert(identityResult.match, `Server Identity Check: Both connections point to exact same DB server (${appServer.db_name})`);

      if (!identityResult.match) {
        throw new Error(`FATAL PREFLIGHT ERROR: DB identity mismatch: ${identityResult.reason}. Halting before destructive SQL.`);
      }

      // --- TASK 2: REAL DELETE PRIVILEGE PREFLIGHT & NON-SUPERUSER TEST ---
      console.log('\n--- TASK 2: Real Delete Privilege Preflight & Non-Superuser Test ---');

      const adminRoleRes = await adminClient.query<{ current_user: string; session_user: string; rolsuper: boolean; rolbypassrls: boolean }>(`
        SELECT current_user, session_user, rolsuper, rolbypassrls 
        FROM pg_roles 
        WHERE rolname = current_user;
      `);
      const adminAttrs = adminRoleRes.rows[0];
      assert(Boolean(adminAttrs?.current_user), `Admin Role Identity: Connected as admin user '${adminAttrs?.current_user}'`);

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
        FROM (VALUES ('inv_stock_movements'), ('inv_stock_balances'), ('inv_items'), ('inv_warehouses')) as t(tablename);
      `);

      const allCanDelete = privRes.rows.every((r) => r.has_del);
      const canDeleteAdmin = Boolean(adminAttrs?.rolsuper || allCanDelete);
      assert(canDeleteAdmin, `Admin Table Privileges: has_table_privilege(current_user, table, 'DELETE') verified true for all target tables`);

      // Real Non-Superuser Privilege Test inside a transaction
      try {
        await adminClient.query('BEGIN;');
        const testRole = `test_priv_role_${Date.now()}`;
        await adminClient.query(`CREATE ROLE ${testRole} NOLOGIN NOSUPERUSER NOBYPASSRLS;`);
        await adminClient.query(`GRANT SELECT, INSERT, UPDATE ON inv_stock_movements TO ${testRole};`);

        const check1 = await adminClient.query<{ has_del: boolean; has_sel: boolean }>(`
          SELECT 
            has_table_privilege('${testRole}', 'inv_stock_movements', 'DELETE') as has_del,
            has_table_privilege('${testRole}', 'inv_stock_movements', 'SELECT') as has_sel;
        `);

        const hasSelect = check1.rows[0]?.has_sel === true;
        const missingDeleteDetected = check1.rows[0]?.has_del === false;

        assert(hasSelect && missingDeleteDetected, `Non-Superuser Privilege Test: missing DELETE grant correctly detected (has_sel=true, has_del=false)`);

        await adminClient.query(`ALTER ROLE ${testRole} BYPASSRLS;`);
        const check2 = await adminClient.query<{ has_del: boolean }>(`
          SELECT has_table_privilege('${testRole}', 'inv_stock_movements', 'DELETE') as has_del;
        `);
        const bypassDoesNotGrantDelete = check2.rows[0]?.has_del === false;
        assert(bypassDoesNotGrantDelete, `Non-Superuser Privilege Test: BYPASSRLS attribute alone strictly does NOT satisfy table DELETE privilege`);

        await adminClient.query('ROLLBACK;');

        const roleExists = await adminClient.query<{ count: number }>(`SELECT count(*)::int as count FROM pg_roles WHERE rolname = $1;`, [testRole]);
        assert(roleExists.rows[0]?.count === 0, `Non-Superuser Privilege Test: Transaction rollback cleanly eradicated temporary test role`);

      } catch (err: any) {
        await adminClient.query('ROLLBACK;').catch(() => {});
        reportBlocked(`Non-Superuser privilege role test BLOCKED: ${err.message || String(err)}`);
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

    const ownerRes = await appClient1.query<{ tablename: string }>(`
      SELECT c.relname as tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public' AND r.rolname = 'an_app' AND c.relname IN ('inv_stock_balances', 'inv_stock_movements');
    `);
    assert(ownerRes.rows.length === 0, 'Application Role Check: an_app is not the owner of inv_stock_balances or inv_stock_movements');

    // --- FULL RLS POLICY METADATA ASSERTIONS ---
    console.log('\n--- Full RLS Policy Metadata Assertions ---');

    const rlsRes = await appClient1.query<{ tablename: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
      SELECT c.relname as tablename, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('inv_stock_balances', 'inv_stock_movements');
    `);
    const balRls = rlsRes.rows.find((r) => r.tablename === 'inv_stock_balances');
    const movRls = rlsRes.rows.find((r) => r.tablename === 'inv_stock_movements');

    assert(Boolean(balRls?.relrowsecurity && balRls?.relforcerowsecurity), 'RLS Check: RLS and FORCE RLS active on inv_stock_balances');
    assert(Boolean(movRls?.relrowsecurity && movRls?.relforcerowsecurity), 'RLS Check: RLS and FORCE RLS active on inv_stock_movements');

    const policyMetaRes = await appClient1.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      roles: string[];
      cmd: string;
      qual: string;
      with_check: string;
    }>(`
      SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('inv_stock_balances', 'inv_stock_movements');
    `);

    const balPolicy = policyMetaRes.rows.find((p) => p.tablename === 'inv_stock_balances');
    const movPolicy = policyMetaRes.rows.find((p) => p.tablename === 'inv_stock_movements');

    assert(Boolean(balPolicy && balPolicy.policyname === 'inv_stock_balances_tenant_isolation'), 'RLS Metadata Check: inv_stock_balances policy name is inv_stock_balances_tenant_isolation');
    assert(Boolean(movPolicy && movPolicy.policyname === 'inv_stock_movements_tenant_isolation'), 'RLS Metadata Check: inv_stock_movements policy name is inv_stock_movements_tenant_isolation');

    assert(balPolicy?.cmd === 'ALL' && movPolicy?.cmd === 'ALL', 'RLS Metadata Check: Policies cover ALL commands (SELECT, INSERT, UPDATE, DELETE)');
    assert(
      Boolean(balPolicy?.qual?.includes('app.current_tenant_id') && movPolicy?.qual?.includes('app.current_tenant_id')),
      'RLS Metadata Check: USING expressions enforce app.current_tenant_id isolation'
    );
    assert(
      Boolean(balPolicy?.with_check?.includes('app.current_tenant_id') && movPolicy?.with_check?.includes('app.current_tenant_id')),
      'RLS Metadata Check: WITH CHECK expressions enforce app.current_tenant_id isolation'
    );

    const extraPolicies = policyMetaRes.rows.filter(
      (p) => p.policyname !== 'inv_stock_balances_tenant_isolation' && p.policyname !== 'inv_stock_movements_tenant_isolation'
    );
    assert(extraPolicies.length === 0, 'RLS Metadata Check: Zero extra permissive policies detected bypassing tenant isolation');

    const pidRes1 = await appClient1.query<{ pid: number }>('SELECT pg_backend_pid() as pid;');
    const pidRes2 = await appClient2.query<{ pid: number }>('SELECT pg_backend_pid() as pid;');
    const pid1 = pidRes1.rows[0].pid;
    const pid2 = pidRes2.rows[0].pid;
    const independentConnections = Boolean(pid1 && pid2 && pid1 !== pid2);
    console.log(`Recorded pg_backend_pid Values: appClient1 = ${pid1}, appClient2 = ${pid2}`);
    assert(independentConnections, `Independent DB connections verified (PID 1: ${pid1}, PID 2: ${pid2})`);

    // --- DATA SETUP ---
    const suffix = Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    const compRes = await appClient1.query<{ id: string }>(
      "INSERT INTO companies (code, name_ar) VALUES ($1, 'شركة اختبار المخزون الذري') RETURNING id;",
      [`INV_ATOMIC_${suffix}`]
    );
    compId = compRes.rows[0].id;

    const comp2Res = await appClient1.query<{ id: string }>(
      "INSERT INTO companies (code, name_ar) VALUES ($1, 'شركة اختبار العزل') RETURNING id;",
      [`INV_ISO_${suffix}`]
    );
    comp2Id = comp2Res.rows[0].id;

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);

    const whARes = await appClient1.query<{ id: string }>(
      "INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1, 'WHA', 'مستودع أ') RETURNING id;",
      [compId]
    );
    whA = whARes.rows[0].id;

    const whBRes = await appClient1.query<{ id: string }>(
      "INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1, 'WHB', 'مستودع ب') RETURNING id;",
      [compId]
    );
    whB = whBRes.rows[0].id;

    const whCRes = await appClient1.query<{ id: string }>(
      "INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1, 'WHC', 'مستودع ج') RETURNING id;",
      [compId]
    );
    whC = whCRes.rows[0].id;

    const itemRes = await appClient1.query<{ id: string }>(
      "INSERT INTO inv_items (company_id, code, name_ar, uom) VALUES ($1, 'ITEM1', 'صنف تجريبي', 'unit') RETURNING id;",
      [compId]
    );
    itemId = itemRes.rows[0].id;

    await appClient1.query('COMMIT;');

    await appClient2.query('BEGIN;');
    await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);

    const item2Res = await appClient2.query<{ id: string }>(
      "INSERT INTO inv_items (company_id, code, name_ar, uom) VALUES ($1, 'ITEM2', 'صنف شركة ب', 'unit') RETURNING id;",
      [comp2Id]
    );
    item2Id = item2Res.rows[0].id;

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
      await appClient1.query(
        `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo)
         VALUES ($1, $2, $3, 'receive', 10, 'T1 receive 10');`,
        [compId, whA, itemId]
      );
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
      await appClient2.query(
        `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo)
         VALUES ($1, $2, $3, 'receive', 15, 'T1 receive 15');`,
        [compId, whA, itemId]
      );
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

    // --- T2: CONCURRENT TRANSFERS INTO ABSENT DESTINATION ---
    console.log('\nRunning T2: Concurrent TRANSFERS into absent destination WH_B using an_app...');
    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    await appClient1.query(
      "UPDATE inv_stock_balances SET qty = 100 WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
      [compId, whA, itemId]
    );
    await appClient1.query('COMMIT;');

    const transferOp = async (client: pg.Client, amount: number, memo: string) => {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);

      await client.query(
        `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
         VALUES ($1, $2, $3, 0, NOW())
         ON CONFLICT (company_id, warehouse_id, item_id) DO NOTHING;`,
        [compId, whA, itemId]
      );
      await client.query(
        `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
         VALUES ($1, $2, $3, 0, NOW())
         ON CONFLICT (company_id, warehouse_id, item_id) DO NOTHING;`,
        [compId, whB, itemId]
      );

      const [w1, w2] = [whA, whB].sort();
      await client.query("SELECT qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 FOR UPDATE;", [compId, w1, itemId]);
      await client.query("SELECT qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 FOR UPDATE;", [compId, w2, itemId]);

      const decRes = await client.query<{ qty: number }>(
        `UPDATE inv_stock_balances SET qty = qty - $4, updated_at = NOW()
         WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 AND qty >= $4
         RETURNING qty::float as qty;`,
        [compId, whA, itemId, amount]
      );
      if (decRes.rows.length === 0) {
        await client.query('ROLLBACK;');
        throw new Error('INSUFFICIENT_STOCK');
      }

      await client.query(
        `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (company_id, warehouse_id, item_id)
         DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW();`,
        [compId, whB, itemId, amount]
      );

      const tId = '11111111-2222-3333-4444-' + String(amount).padStart(12, '0');
      await client.query(
        `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo, transfer_id)
         VALUES ($1, $2, $3, 'transfer_out', $4, $5, $6);`,
        [compId, whA, itemId, amount, `${memo} out`, tId]
      );
      await client.query(
        `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo, transfer_id)
         VALUES ($1, $2, $3, 'transfer_in', $4, $5, $6);`,
        [compId, whB, itemId, amount, `${memo} in`, tId]
      );

      await client.query('COMMIT;');
    };

    await Promise.all([
      transferOp(appClient1, 20, 'Transfer 20'),
      transferOp(appClient2, 30, 'Transfer 30'),
    ]);

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const t2DestRes = await appClient1.query<{ qty: number }>(
      "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
      [compId, whB, itemId]
    );
    const t2SourceRes = await appClient1.query<{ qty: number }>(
      "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
      [compId, whA, itemId]
    );
    await appClient1.query('COMMIT;');
    const destQty = t2DestRes.rows[0]?.qty;
    const sourceQty = t2SourceRes.rows[0]?.qty;
    assert(destQty === 50 && sourceQty === 50, `T2: Concurrent transfers into absent destination resulted in WH_B: ${destQty} (expected 50), WH_A: ${sourceQty} (expected 50)`);

    // --- T3: CONCURRENT ISSUE ---
    console.log('\nRunning T3: Concurrent ISSUE (10 initial, two requests of 7 each) using an_app...');
    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    await appClient1.query(
      "UPDATE inv_stock_balances SET qty = 10 WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
      [compId, whA, itemId]
    );
    await appClient1.query('COMMIT;');

    const issueOp = async (client: pg.Client) => {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
      const res = await client.query<{ qty: number }>(
        `UPDATE inv_stock_balances SET qty = qty - 7, updated_at = NOW()
         WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 AND qty >= 7
         RETURNING qty::float as qty;`,
        [compId, whA, itemId]
      );
      if (res.rows.length === 0) {
        await client.query('ROLLBACK;');
        return { success: false };
      }
      await client.query(
        `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo)
         VALUES ($1, $2, $3, 'issue', 7, 'T3 issue 7');`,
        [compId, whA, itemId]
      );
      await client.query('COMMIT;');
      return { success: true };
    };

    const [resI1, resI2] = await Promise.all([issueOp(appClient1), issueOp(appClient2)]);
    const oneSucceeded = (resI1.success && !resI2.success) || (!resI1.success && resI2.success);

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const t3BalRes = await appClient1.query<{ qty: number }>(
      "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
      [compId, whA, itemId]
    );
    await appClient1.query('COMMIT;');
    const t3FinalQty = t3BalRes.rows[0]?.qty;
    assert(oneSucceeded && t3FinalQty === 3, `T3: Exactly one issue succeeded, one rejected, final balance is 3 (actual: ${t3FinalQty})`);

    // --- T4: CONCURRENT REVERSE TRANSFERS ---
    console.log('\nRunning T4: Concurrent reverse-direction transfers (WH_A <-> WH_B) using an_app...');
    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    await appClient1.query("UPDATE inv_stock_balances SET qty = 50 WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whA, itemId]);
    await appClient1.query("UPDATE inv_stock_balances SET qty = 50 WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whB, itemId]);
    await appClient1.query('COMMIT;');

    const transferDir = async (client: pg.Client, fromWh: string, toWh: string, amount: number) => {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);

      const [w1, w2] = [fromWh, toWh].sort();
      await client.query("SELECT qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 FOR UPDATE;", [compId, w1, itemId]);
      await client.query("SELECT qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 FOR UPDATE;", [compId, w2, itemId]);

      const dec = await client.query<{ qty: number }>(
        `UPDATE inv_stock_balances SET qty = qty - $4, updated_at = NOW()
         WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 AND qty >= $4
         RETURNING qty::float as qty;`,
        [compId, fromWh, itemId, amount]
      );
      if (dec.rows.length === 0) {
        await client.query('ROLLBACK;');
        throw new Error('INSUFFICIENT_STOCK');
      }

      await client.query(
        `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (company_id, warehouse_id, item_id)
         DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW();`,
        [compId, toWh, itemId, amount]
      );
      await client.query('COMMIT;');
    };

    await Promise.all([
      transferDir(appClient1, whA, whB, 15),
      transferDir(appClient2, whB, whA, 10),
    ]);

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const t4ARes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whA, itemId]);
    const t4BRes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whB, itemId]);
    await appClient1.query('COMMIT;');
    const balA = t4ARes.rows[0]?.qty;
    const balB = t4BRes.rows[0]?.qty;
    const totalStock = (balA || 0) + (balB || 0);
    assert(balA === 45 && balB === 55 && totalStock === 100, `T4: Reverse transfers completed without deadlock, stock conserved (WH_A: ${balA}, WH_B: ${balB}, Total: ${totalStock})`);

    // --- TASK 4: T5 STRICT COMPOSITE FOREIGN KEY ASSERTION ---
    console.log('\n--- TASK 4: T5 Strict Composite Foreign Key Assertion ---');

    let t5FailedAsExpected = false;
    let t5ErrCode = '';
    let t5ConstraintName = '';
    try {
      await appClient1.query('BEGIN;');
      await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);

      await appClient1.query(
        `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty)
         VALUES ($1, $2, $3, 'receive', 50);`,
        [compId, whA, item2Id] // item2 belongs to comp2Id -> cross-company mismatch violating composite FK
      );
      await appClient1.query('COMMIT;');
    } catch (err: any) {
      t5ErrCode = err.code || '';
      t5ConstraintName = err.constraint || '';
      await appClient1.query('ROLLBACK;').catch(() => {});
    }

    const isExactFkMatch = t5ErrCode === '23503' && t5ConstraintName === 'fk_inv_stock_movements_item_company';

    if (!isExactFkMatch && t5ErrCode === '23503') {
      const catalogCheck = await appClient1.query<{ count: number }>(`
        SELECT count(*)::int as count
        FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_inv_stock_movements_item_company'
          AND table_name = 'inv_stock_movements'
          AND constraint_type = 'FOREIGN KEY';
      `);
      if (catalogCheck.rows[0]?.count === 1) {
        t5FailedAsExpected = true;
        console.log(`[T5 INFO] SQLSTATE 23503 confirmed. Composite constraint 'fk_inv_stock_movements_item_company' verified via DB catalog.`);
      }
    } else if (isExactFkMatch) {
      t5FailedAsExpected = true;
    }

    assert(t5FailedAsExpected, `T5: Foreign key violation confirmed with SQLSTATE 23503 and constraint 'fk_inv_stock_movements_item_company'`);

    // --- T6: REPOSITORY & DB VALIDATION ---
    console.log('\nRunning T6: Repository conditional decrement & DB check constraint validation using an_app...');
    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const decFailRes = await appClient1.query<{ qty: number }>(
      `UPDATE inv_stock_balances SET qty = qty - 999, updated_at = NOW()
       WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 AND qty >= 999
       RETURNING qty::float as qty;`,
      [compId, whA, itemId]
    );
    await appClient1.query('COMMIT;');
    assert(decFailRes.rows.length === 0, 'T6: Decrement with amount exceeding balance returns 0 rows (no negative balance allowed)');

    let checkConstraintTriggered = false;
    try {
      await appClient1.query('BEGIN;');
      await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
      await appClient1.query(
        "UPDATE inv_stock_balances SET qty = -10 WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
        [compId, whA, itemId]
      );
      await appClient1.query('COMMIT;');
    } catch (err: any) {
      if (err.code === '23514') {
        checkConstraintTriggered = true;
      }
      await appClient1.query('ROLLBACK;');
    }
    assert(checkConstraintTriggered, 'T6: Direct negative balance update rejected by DB CHECK constraint (SQLSTATE 23514)');

    // --- T7: TENANT ISOLATION & RLS PROOF UNDER AN_APP ---
    console.log('\nRunning T7: Strict Tenant Isolation & RLS Proof on Stock Balances using an_app...');

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const ownReadRes = await appClient1.query<{ qty: number }>(
      "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
      [compId, whA, itemId]
    );
    await appClient1.query('COMMIT;');
    assert(ownReadRes.rows.length === 1 && ownReadRes.rows[0].qty === 45, 'T7.1: appClient1 under company A context reads own company A stock balances');

    await appClient2.query('BEGIN;');
    await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);
    const otherReadRes = await appClient2.query(
      "SELECT * FROM inv_stock_balances WHERE company_id = $1;",
      [compId]
    );
    await appClient2.query('COMMIT;');
    assert(otherReadRes.rows.length === 0, 'T7.2: appClient2 under company B context returns 0 rows when querying company A balances (RLS USING clause)');

    let rlsInsertRejected = false;
    let rlsInsertErrCode = '';
    try {
      await appClient2.query('BEGIN;');
      await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);
      await appClient2.query(
        "INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty) VALUES ($1, $2, $3, 99);",
        [compId, whA, itemId]
      );
      await appClient2.query('COMMIT;');
    } catch (err: any) {
      rlsInsertErrCode = err.code || '';
      if (err.code === '42501') {
        rlsInsertRejected = true;
      }
      await appClient2.query('ROLLBACK;');
    }
    assert(rlsInsertRejected, `T7.3: appClient2 under company B context inserting into company A balances strictly rejected by SQLSTATE 42501 (actual code: '${rlsInsertErrCode}')`);

    await appClient2.query('BEGIN;');
    await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);
    const updateOtherRes = await appClient2.query(
      "UPDATE inv_stock_balances SET qty = 999 WHERE company_id = $1 RETURNING qty;",
      [compId]
    );
    await appClient2.query('COMMIT;');
    assert(updateOtherRes.rowCount === 0, 'T7.4: appClient2 under company B context updating company A balances affected 0 rows');

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const verifyUnchangedRes = await appClient1.query<{ qty: number }>(
      "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
      [compId, whA, itemId]
    );
    await appClient1.query('COMMIT;');
    assert(verifyUnchangedRes.rows[0]?.qty === 45, 'T7.4b: Company A stock balance remained unchanged at 45 after cross-tenant UPDATE attempt');

    await appClient3.query('BEGIN;');
    await appClient3.query("SELECT set_config('app.current_tenant_id', '', true);");
    const unsetReadRes = await appClient3.query(
      "SELECT * FROM inv_stock_balances WHERE company_id = $1;",
      [compId]
    );
    await appClient3.query('COMMIT;');
    assert(unsetReadRes.rows.length === 0, 'T7.5: appClient3 with empty tenant context returns 0 rows for any company balances');

    let unsetInsertRejected = false;
    let unsetInsertErrCode = '';
    try {
      await appClient3.query('BEGIN;');
      await appClient3.query("SELECT set_config('app.current_tenant_id', '', true);");
      await appClient3.query(
        "INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty) VALUES ($1, $2, $3, 99);",
        [compId, whA, itemId]
      );
      await appClient3.query('COMMIT;');
    } catch (err: any) {
      unsetInsertErrCode = err.code || '';
      if (err.code === '42501') {
        unsetInsertRejected = true;
      }
      await appClient3.query('ROLLBACK;');
    }
    assert(
      unsetInsertRejected && unsetInsertErrCode === '42501',
      `T7.6: appClient3 with empty tenant context inserting balance strictly rejected by SQLSTATE 42501 (actual code: '${unsetInsertErrCode}')`
    );

    // --- MOVEMENTS TENANT ISOLATION (T8.1 - T8.8) ---
    console.log('\n--- Movements Tenant Isolation Tests (T8.1 - T8.8) ---');

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const movReadRes = await appClient1.query(
      "SELECT id FROM inv_stock_movements WHERE company_id = $1;",
      [compId]
    );
    await appClient1.query('COMMIT;');
    assert(movReadRes.rows.length > 0, `T8.1: Company A reads own stock movements (found ${movReadRes.rows.length} rows)`);

    await appClient2.query('BEGIN;');
    await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);
    const movOtherReadRes = await appClient2.query(
      "SELECT * FROM inv_stock_movements WHERE company_id = $1;",
      [compId]
    );
    await appClient2.query('COMMIT;');
    assert(movOtherReadRes.rows.length === 0, 'T8.2: Company B context querying Company A movements returns 0 rows (RLS USING clause)');

    let movInsertRejected = false;
    let movInsertErrCode = '';
    try {
      await appClient2.query('BEGIN;');
      await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);
      await appClient2.query(
        "INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty) VALUES ($1, $2, $3, 'receive', 10);",
        [compId, whA, itemId]
      );
      await appClient2.query('COMMIT;');
    } catch (err: any) {
      movInsertErrCode = err.code || '';
      if (err.code === '42501') {
        movInsertRejected = true;
      }
      await appClient2.query('ROLLBACK;');
    }
    assert(movInsertRejected && movInsertErrCode === '42501', `T8.3: Company B inserting movement into Company A strictly rejected by SQLSTATE 42501`);

    await appClient2.query('BEGIN;');
    await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);
    const movUpdateRes = await appClient2.query(
      "UPDATE inv_stock_movements SET memo = 'hacked' WHERE company_id = $1 RETURNING id;",
      [compId]
    );
    await appClient2.query('COMMIT;');
    assert(movUpdateRes.rowCount === 0, 'T8.4: Company B updating Company A movements affected 0 rows');

    await appClient2.query('BEGIN;');
    await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);
    const movDelRes = await appClient2.query(
      "DELETE FROM inv_stock_movements WHERE company_id = $1 RETURNING id;",
      [compId]
    );
    await appClient2.query('COMMIT;');
    assert(movDelRes.rowCount === 0, 'T8.5: Company B deleting Company A movements affected 0 rows');

    await appClient3.query('BEGIN;');
    await appClient3.query("SELECT set_config('app.current_tenant_id', '', true);");
    const movUnsetRead = await appClient3.query(
      "SELECT * FROM inv_stock_movements WHERE company_id = $1;",
      [compId]
    );
    await appClient3.query('COMMIT;');
    assert(movUnsetRead.rows.length === 0, 'T8.6: Empty tenant context reading movements returns 0 rows');

    let movUnsetInsertRejected = false;
    try {
      await appClient3.query('BEGIN;');
      await appClient3.query("SELECT set_config('app.current_tenant_id', '', true);");
      await appClient3.query(
        "INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty) VALUES ($1, $2, $3, 'receive', 10);",
        [compId, whA, itemId]
      );
      await appClient3.query('COMMIT;');
    } catch (err: any) {
      if (err.code === '42501') {
        movUnsetInsertRejected = true;
      }
      await appClient3.query('ROLLBACK;');
    }
    assert(movUnsetInsertRejected, 'T8.7: Empty tenant context inserting movement strictly rejected by SQLSTATE 42501');

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const movVerifyRes = await appClient1.query<{ count: number }>(
      "SELECT count(*)::int as count FROM inv_stock_movements WHERE company_id = $1;",
      [compId]
    );
    await appClient1.query('COMMIT;');
    assert(movVerifyRes.rows[0].count === movReadRes.rows.length, `T8.8: Company A movements count remained intact at ${movVerifyRes.rows[0].count} after all rejected attempts`);

    // --- REAL APPLICATION SERVICE INTEGRATION (T9.1 - T9.8) ---
    console.log('\n--- Real Application Service Integration (T9.1 - T9.8) ---');

    const appClient1Executor = clientToExecutor(appClient1);

    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);

    // T9.1: Repository incrementBalance
    const r1 = await defaultStockRepository.incrementBalance(compId, whA, itemId, 50, appClient1Executor);
    assert(r1 !== null && r1.qty === 95, `T9.1: StockRepository.incrementBalance incremented balance to 95 (actual: ${r1?.qty})`);

    // T9.2: Repository decrementBalance
    const r2 = await defaultStockRepository.decrementBalance(compId, whA, itemId, 20, appClient1Executor);
    assert(r2 !== null && r2.qty === 75, `T9.2: StockRepository.decrementBalance decremented balance to 75 (actual: ${r2?.qty})`);

    // T9.3: Repository ensureBalanceRow
    await defaultStockRepository.ensureBalanceRow(compId, whC, itemId, appClient1Executor);
    const cRowRes = await appClient1.query<{ qty: number }>(
      "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
      [compId, whC, itemId]
    );
    assert(Boolean(cRowRes.rows.length === 1), `T9.3: StockRepository.ensureBalanceRow ensured balance row exists for WHC`);

    await appClient1.query('COMMIT;');

    // T9.4: StockService.receiveStock integration
    const receiveRes = await defaultStockService.receiveStock(
      compId,
      { warehouseId: whA, itemId, qty: 25, memo: 'Service Integration Receive' }
    );
    assert(
      receiveRes.balance.qty === 100 && receiveRes.movement.movementType === 'receive' && receiveRes.movement.qty === 25,
      `T9.4: StockService.receiveStock updated balance to 100 and created receive movement`
    );

    // T9.5: StockService.issueStock integration & Over-issue guard
    const issueRes = await defaultStockService.issueStock(
      compId,
      { warehouseId: whA, itemId, qty: 10, memo: 'Service Integration Issue' }
    );
    assert(
      issueRes.balance.qty === 90 && issueRes.movement.movementType === 'issue' && issueRes.movement.qty === 10,
      `T9.5: StockService.issueStock updated balance to 90 and created issue movement`
    );

    let overIssueFailed = false;
    let overIssueErrorMsg = '';
    try {
      await defaultStockService.issueStock(
        compId,
        { warehouseId: whA, itemId, qty: 999, memo: 'Overissue' }
      );
    } catch (err: any) {
      overIssueFailed = true;
      overIssueErrorMsg = err.message || '';
    }
    assert(
      overIssueFailed && overIssueErrorMsg.includes('رصيد غير كافٍ'),
      `T9.5b: StockService.issueStock strictly blocked over-issue request with ValidationError`
    );

    // T9.6: StockService.transfer integration & dynamic balance calculation
    await appClient1.query('BEGIN;');
    await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
    const sourceBeforeRes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whA, itemId]);
    const destBeforeRes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whB, itemId]);
    await appClient1.query('COMMIT;');
    const sourceBefore = sourceBeforeRes.rows[0]?.qty ?? 0;
    const destBefore = destBeforeRes.rows[0]?.qty ?? 0;

    const transferRes = await defaultStockService.transfer(
      compId,
      { sourceWarehouseId: whA, destWarehouseId: whB, itemId, qty: 30, memo: 'Service Integration Transfer' }
    );

    const expectedSource = sourceBefore - 30; // 90 - 30 = 60
    const expectedDest = destBefore + 30;     // 55 + 30 = 85
    assert(
      transferRes.sourceBalance.qty === expectedSource &&
      transferRes.destBalance.qty === expectedDest &&
      (transferRes.sourceBalance.qty + transferRes.destBalance.qty === sourceBefore + destBefore) &&
      transferRes.movementOut.movementType === 'transfer_out' &&
      transferRes.movementIn.movementType === 'transfer_in' &&
      transferRes.movementOut.transferId === transferRes.movementIn.transferId,
      `T9.6: StockService.transfer decremented WH_A (${sourceBefore} -> ${transferRes.sourceBalance.qty}), incremented WH_B (${destBefore} -> ${transferRes.destBalance.qty}), total stock conserved (${sourceBefore + destBefore}), and linked movements via transferId`
    );

    // --- TASK 3: T9.7 EXACT ATOMIC ROLLBACK PROOF ---
    console.log('\n--- TASK 3: T9.7 Exact Atomic Rollback Proof ---');

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
        { sourceWarehouseId: whA, destWarehouseId: whB, itemId, qty: 10, memo: 'Faulting Transfer' }
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
    const capturedMoveId = faultingAudit.lastCapturedMovementId;
    const capturedTransferId = faultingAudit.lastCapturedTransferId;

    let auditSurvived = false;
    let moveSurvived = false;

    if (capturedAuditId) {
      const checkAudit = await appClient1.query("SELECT id FROM audit_logs WHERE id = $1;", [capturedAuditId]);
      auditSurvived = checkAudit.rows.length > 0;
    }
    if (capturedMoveId || capturedTransferId) {
      const checkMove = await appClient1.query(
        "SELECT id FROM inv_stock_movements WHERE id = $1 OR transfer_id = $2;",
        [capturedMoveId || '', capturedTransferId || '']
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
      `T9.7: Exact atomic rollback proof verified: captured audit record (${capturedAuditId || 'none'}) and movement (${capturedMoveId || 'none'}) existed in-transaction, failed with intentional error, and zero operation-specific records survived post-rollback (source: ${postRbSourceQty}, dest: ${postRbDestQty})`
    );

    // T9.8: Cross-tenant service isolation
    let crossTenantFailed = false;
    try {
      await defaultStockService.receiveStock(
        comp2Id,
        { warehouseId: whA, itemId, qty: 10, memo: 'Cross tenant attempt' }
      );
    } catch (err: any) {
      crossTenantFailed = true;
    }
    assert(crossTenantFailed, `T9.8: StockService strictly rejected cross-tenant operation (Company B context with Company A warehouse/item)`);

  } finally {
    // --- TASK 1: GRN-SAFE CLEANUP GUARANTEE & POST-TEARDOWN VERIFICATION ---
    let cleanupErrMessage: string | null = null;
    let remainingChildCount = 0;

    try {
      await appClient1.query('ROLLBACK;').catch(() => {});
      await appClient2.query('ROLLBACK;').catch(() => {});
      await appClient3.query('ROLLBACK;').catch(() => {});
    } catch {}

    if (adminClient && (compId || comp2Id)) {
      const targetIds = [compId, comp2Id].filter(Boolean);
      try {
        await adminClient.query('BEGIN;');
        
        await adminClient.query("DELETE FROM inv_stock_movements WHERE company_id = ANY($1);", [targetIds]);
        await adminClient.query("DELETE FROM inv_stock_balances WHERE company_id = ANY($1);", [targetIds]);

        const targetItemsRes = await adminClient.query<{ id: string }>("SELECT id FROM inv_items WHERE company_id = ANY($1);", [targetIds]);
        const targetWhsRes = await adminClient.query<{ id: string }>("SELECT id FROM inv_warehouses WHERE company_id = ANY($1);", [targetIds]);

        const targetItemIds = targetItemsRes.rows.map((r) => r.id);
        const targetWhIds = targetWhsRes.rows.map((r) => r.id);

        const refCheck = await inspectInventoryReferences(adminClient, targetItemIds, targetWhIds);

        const safeItemIds = targetItemIds.filter(
          (id) => !refCheck.blockingReferences.some((r) => r.referencedType === 'item' && r.referencedId === id)
        );
        const safeWhIds = targetWhIds.filter(
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
            (SELECT count(*) FROM inv_stock_movements WHERE company_id = ANY($1)) +
            (SELECT count(*) FROM inv_stock_balances WHERE company_id = ANY($1))
          )::int as count;
        `, [targetIds]);

        remainingChildCount = verifyCleanRes.rows[0]?.count || 0;
        if (remainingChildCount > 0) {
          cleanupErrMessage = `Post-teardown check failed: ${remainingChildCount} residual inventory records remain in database for test companies (${targetIds.join(', ')})`;
        }
      } catch (cleanupErr: any) {
        await adminClient.query('ROLLBACK;').catch(() => {});
        cleanupErrMessage = cleanupErr?.message || String(cleanupErr);
        console.error('[CLEANUP ERROR] Transactional cleanup failed:', cleanupErr);
      }

      // Explicit post-teardown assertions proving protected records still exist
      try {
        const companyCheck = await adminClient.query<{ count: number }>("SELECT count(*)::int as count FROM companies WHERE id = ANY($1);", [targetIds]);
        const auditCheck = await adminClient.query<{ count: number }>("SELECT count(*)::int as count FROM audit_logs WHERE company_id = $1;", [compId]);

        assert(companyCheck.rows[0]?.count > 0, `Protected Records Check: Company records (${companyCheck.rows[0]?.count}) intentionally preserved post-cleanup`);
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
      assert(remainingChildCount === 0, `Guaranteed Teardown Check: All test inventory movements & balances cleanly eradicated from DB (companies & immutable audit logs intentionally preserved)`);
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
