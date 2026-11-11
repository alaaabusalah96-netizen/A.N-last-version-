import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import pg from 'pg';
import { buildPgConfig } from '../src/server/db/connection.js';
import { defaultStockRepository } from '../src/server/inventory/stockRepository.js';
import { defaultStockService } from '../src/server/inventory/stockService.js';
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

async function runVerification() {
  console.log('=== RUNNING INVENTORY ATOMIC BALANCE VERIFICATION (AN-FIX-INVENTORY-PROOF-HARDENING-3) ===\n');
  let passed = 0;
  let failed = 0;
  let skipped = 0;

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

  const root = process.cwd();

  await runHostValidationTests(assert);

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
      console.error(`[FAIL] DATABASE_URL validation failed: ${appDbCheck.reason}`);
      assert(false, `DATABASE_URL validation failed: ${appDbCheck.reason}`);
      process.exit(1);
    } else {
      reportSkipped(`T1-T9 Live PostgreSQL integration proof SKIPPED: ${appDbCheck.reason}`);
      console.log('[INFO] Static invariant checks & Task 1 host validation verified. Disposable local PostgreSQL needed for live concurrency proof.');
    }
  } else {
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
      console.error('[FAIL] Valid administrative cleanup connection (MIGRATION_DATABASE_URL) is required when REQUIRE_DB=1 or CI=true');
      assert(false, 'MIGRATION_DATABASE_URL is required for guaranteed admin cleanup');
      process.exit(1);
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

    try {
      await appClient1.connect();
      await appClient2.connect();
      await appClient3.connect();
      if (adminClient) {
        await adminClient.connect();
      }

      // --- TASK 2: APP / ADMIN DATABASE IDENTITY & PREFLIGHT ---
      console.log('\n--- TASK 2: App / Admin Database Server Identity Preflight ---');

      const appServerRes = await appClient1.query<{ db_name: string; server_addr: string | null; server_port: number | null; server_version: string }>(`
        SELECT 
          current_database() as db_name, 
          inet_server_addr()::text as server_addr, 
          inet_server_port() as server_port, 
          version() as server_version;
      `);
      const appServer = appServerRes.rows[0];

      if (adminClient) {
        const adminServerRes = await adminClient.query<{ db_name: string; server_addr: string | null; server_port: number | null; server_version: string }>(`
          SELECT 
            current_database() as db_name, 
            inet_server_addr()::text as server_addr, 
            inet_server_port() as server_port, 
            version() as server_version;
        `);
        const adminServer = adminServerRes.rows[0];

        const dbNameMatch = appServer.db_name === adminServer.db_name;
        assert(dbNameMatch, `Server Identity Check: Both connections point to same database '${appServer.db_name}'`);

        const portMatch = appServer.server_port === adminServer.server_port;
        assert(portMatch, `Server Identity Check: Server port match (${appServer.server_port})`);

        const versionMatch = appServer.server_version === adminServer.server_version;
        assert(versionMatch, `Server Identity Check: PostgreSQL server version match`);

        if (appServer.server_addr && adminServer.server_addr) {
          assert(appServer.server_addr === adminServer.server_addr, `Server Identity Check: IP address match (${appServer.server_addr})`);
        } else {
          const appDirRes = await appClient1.query<{ setting: string }>("SHOW data_directory;");
          const adminDirRes = await adminClient.query<{ setting: string }>("SHOW data_directory;");
          const dirMatch = appDirRes.rows[0]?.setting === adminDirRes.rows[0]?.setting;
          assert(dirMatch, `Server Identity Check: Unix socket data directory match (${appDirRes.rows[0]?.setting})`);
        }

        if (!dbNameMatch || !versionMatch) {
          console.error('[FATAL PREFLIGHT ERROR] appClient and adminClient do not point to the same database server instance. Halting.');
          process.exit(1);
        }

        const adminRoleRes = await adminClient.query<{ current_user: string; session_user: string; rolsuper: boolean; rolbypassrls: boolean }>(`
          SELECT current_user, session_user, rolsuper, rolbypassrls 
          FROM pg_roles 
          WHERE rolname = current_user;
        `);
        const adminAttrs = adminRoleRes.rows[0];
        assert(Boolean(adminAttrs?.current_user), `Admin Role Identity: Connected as admin user '${adminAttrs?.current_user}'`);

        const adminPrivRes = await adminClient.query<{ table_name: string }>(`
          SELECT table_name
          FROM information_schema.role_table_grants
          WHERE grantee = current_user AND privilege_type = 'DELETE' AND table_name IN ('inv_stock_movements', 'companies');
        `);
        const canDelete = Boolean(adminAttrs?.rolsuper || adminAttrs?.rolbypassrls || adminPrivRes.rows.length > 0);
        assert(canDelete, `Admin Role Check: Admin role '${adminAttrs?.current_user}' possesses necessary DELETE privileges for safe teardown`);
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
        console.error('[FATAL SECURITY ERROR] Application connection is not authenticated as an_app or has elevated privileges. Halting test.');
        process.exit(1);
      }

      const ownerRes = await appClient1.query<{ tablename: string }>(`
        SELECT c.relname as tablename
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'public' AND r.rolname = 'an_app' AND c.relname IN ('inv_stock_balances', 'inv_stock_movements');
      `);
      assert(ownerRes.rows.length === 0, 'Application Role Check: an_app is not the owner of inv_stock_balances or inv_stock_movements');

      // --- TASK 3: FULL RLS POLICY METADATA ASSERTIONS ---
      console.log('\n--- TASK 3: Full RLS Policy Metadata Assertions ---');

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

      // --- T5: TRANSACTION ROLLBACK ATOMICITY & FK CONSTRAINT PROOF ---
      console.log('\nRunning T5: Transaction rollback atomicity & explicit FK constraint proof using an_app...');
      await appClient1.query('BEGIN;');
      await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
      const preMovementsRes = await appClient1.query<{ count: number }>("SELECT count(*)::int as count FROM inv_stock_movements WHERE company_id = $1 AND warehouse_id = $2;", [compId, whC]);
      await appClient1.query('COMMIT;');
      const preCount = preMovementsRes.rows[0].count;

      let t5FailedAsExpected = false;
      let t5ErrCode = '';
      let t5ConstraintName = '';
      try {
        await appClient1.query('BEGIN;');
        await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);

        await appClient1.query(
          `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
           VALUES ($1, $2, $3, 99, NOW())
           ON CONFLICT (company_id, warehouse_id, item_id)
           DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW();`,
          [compId, whC, itemId]
        );

        await appClient1.query(
          `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo)
           VALUES ($1, $2, $3, 'receive', 99, 'T5 test');`,
          [compId, whC, itemId]
        );

        await appClient1.query(
          `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty)
           VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'receive', 50);`,
          [compId, whC]
        );
        await appClient1.query('COMMIT;');
      } catch (err: any) {
        t5ErrCode = err.code || '';
        t5ConstraintName = err.constraint || '';
        const isFkMatch = err.code === '23503' && (t5ConstraintName === 'inv_stock_movements_item_id_fkey' || err.detail?.includes('inv_items'));
        if (isFkMatch) {
          t5FailedAsExpected = true;
        }
        await appClient1.query('ROLLBACK;').catch(() => {});
      }

      await appClient1.query('BEGIN;');
      await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
      const postBalRes = await appClient1.query<{ qty: number }>("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whC, itemId]);
      const postMovementsRes = await appClient1.query<{ count: number }>("SELECT count(*)::int as count FROM inv_stock_movements WHERE company_id = $1 AND warehouse_id = $2;", [compId, whC]);
      await appClient1.query('COMMIT;');
      const postQty = postBalRes.rows[0]?.qty;
      const postCount = postMovementsRes.rows[0].count;

      assert(
        t5FailedAsExpected && postQty === undefined && postCount === preCount,
        `T5: Rollback cleaned up completely on SQLSTATE 23503 (constraint: '${t5ConstraintName || 'inv_stock_movements_item_id_fkey'}', balance row absent, movements count unchanged: ${postCount})`
      );

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

      // --- TASK 4: MOVEMENTS TENANT ISOLATION (T8.1 - T8.8) ---
      console.log('\n--- TASK 4: Movements Tenant Isolation Tests (T8.1 - T8.8) ---');

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

      // --- TASK 5: REAL APPLICATION SERVICE INTEGRATION (T9.1 - T9.8) ---
      console.log('\n--- TASK 5: Real Application Service Integration (T9.1 - T9.8) ---');

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

      // T9.6: StockService.transfer integration
      const transferRes = await defaultStockService.transfer(
        compId,
        { sourceWarehouseId: whA, destWarehouseId: whB, itemId, qty: 30, memo: 'Service Integration Transfer' }
      );
      assert(
        transferRes.sourceBalance.qty === 60 &&
        transferRes.destBalance.qty === 80 &&
        transferRes.movementOut.movementType === 'transfer_out' &&
        transferRes.movementIn.movementType === 'transfer_in' &&
        transferRes.movementOut.transferId === transferRes.movementIn.transferId,
        `T9.6: StockService.transfer decremented WH_A to 60, incremented WH_B to 80, and linked movements via transferId`
      );

      // T9.7: Transaction atomicity on service failure
      let serviceTxFailed = false;
      try {
        await defaultStockService.transfer(
          compId,
          { sourceWarehouseId: whA, destWarehouseId: '00000000-0000-0000-0000-000000000000', itemId, qty: 10 }
        );
      } catch (err: any) {
        serviceTxFailed = true;
      }
      assert(serviceTxFailed, `T9.7: StockService transaction failed safely on non-existent destination warehouse`);

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
      // --- TASK 6: CLEANUP GUARANTEE & POST-TEARDOWN VERIFICATION ---
      let cleanupErrMessage: string | null = null;
      let remainingCount = 0;

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
          await adminClient.query("DELETE FROM inv_items WHERE company_id = ANY($1);", [targetIds]);
          await adminClient.query("DELETE FROM inv_warehouses WHERE company_id = ANY($1);", [targetIds]);
          await adminClient.query("DELETE FROM companies WHERE id = ANY($1);", [targetIds]);
          await adminClient.query('COMMIT;');

          const verifyCleanRes = await adminClient.query<{ count: number }>(`
            SELECT (
              (SELECT count(*) FROM inv_stock_movements WHERE company_id = ANY($1)) +
              (SELECT count(*) FROM inv_stock_balances WHERE company_id = ANY($1)) +
              (SELECT count(*) FROM inv_items WHERE company_id = ANY($1)) +
              (SELECT count(*) FROM inv_warehouses WHERE company_id = ANY($1)) +
              (SELECT count(*) FROM companies WHERE id = ANY($1))
            )::int as count;
          `, [targetIds]);

          remainingCount = verifyCleanRes.rows[0]?.count || 0;
          if (remainingCount > 0) {
            cleanupErrMessage = `Post-teardown check failed: ${remainingCount} residual records remain in database for test companies (${targetIds.join(', ')})`;
          }
        } catch (cleanupErr: any) {
          await adminClient.query('ROLLBACK;').catch(() => {});
          cleanupErrMessage = cleanupErr?.message || String(cleanupErr);
          console.error('[CLEANUP ERROR] Transactional cleanup failed:', cleanupErr);
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
        assert(remainingCount === 0, `Guaranteed Teardown Check: All test companies and child records cleanly eradicated from DB (remaining count: 0)`);
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Fatal error in verifyInvAtomicBalance1:', err);
  process.exit(1);
});
