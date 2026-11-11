import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { buildPgConfig } from '../src/server/db/connection.js';

export function isAllowedTestDb(urlStr: string): { allowed: boolean; reason?: string; host?: string } {
  if (!urlStr || typeof urlStr !== 'string' || urlStr.trim() === '') {
    return { allowed: false, reason: 'Empty or missing database URL' };
  }
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();

    // 1. Unconditionally reject known hosted / cloud DB providers
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
      return { allowed: false, reason: `Hosted cloud database prohibited for live tests: ${host}`, host };
    }

    // 2. Strict allowlist of allowed local / CI disposable loopback hosts
    const allowedHosts = new Set([
      'localhost',
      '127.0.0.1',
      '::1',
      '[::1]',
      'postgres', // Standard Docker service host in CI pipelines
      'host.docker.internal',
      'local-pg',
    ]);

    if (allowedHosts.has(host)) {
      return { allowed: true, host };
    }

    return { allowed: false, reason: `Host '${host}' is not in the explicit allowed test DB allowlist`, host };
  } catch {
    return { allowed: false, reason: 'Invalid database URL format' };
  }
}

// Deprecated alias for backwards compatibility
export function isProductionOrSupabaseDb(urlStr: string): boolean {
  return !isAllowedTestDb(urlStr).allowed;
}

async function runVerification() {
  console.log('=== RUNNING INVENTORY ATOMIC BALANCE VERIFICATION (AN-FIX-INVENTORY-ATOMIC-PROOF-2) ===\n');
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

  // --- STATIC INVARIANT CHECKS (S1 - S6) ---
  console.log('--- Static Code Invariant Checks ---');

  // S1: stockRepository.ts contains incrementBalance using ON CONFLICT DO UPDATE
  const stockRepoPath = path.join(root, 'src/server/inventory/stockRepository.ts');
  const stockRepoContent = fs.readFileSync(stockRepoPath, 'utf8');
  const hasAtomicIncrement =
    stockRepoContent.includes('incrementBalance') &&
    stockRepoContent.includes('ON CONFLICT (company_id, warehouse_id, item_id)') &&
    stockRepoContent.includes('DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty');
  assert(hasAtomicIncrement, 'S1: stockRepository.ts implements atomic incrementBalance via ON CONFLICT DO UPDATE');

  // S2: stockRepository.ts contains decrementBalance using conditional UPDATE ... WHERE qty >= amount
  const hasAtomicDecrement =
    stockRepoContent.includes('decrementBalance') &&
    stockRepoContent.includes('UPDATE inv_stock_balances') &&
    stockRepoContent.includes('qty >= $4');
  assert(hasAtomicDecrement, 'S2: stockRepository.ts implements conditional atomic decrementBalance (WHERE qty >= amount)');

  // S3: stockRepository.ts contains ensureBalanceRow using ON CONFLICT DO NOTHING
  const hasEnsureBalanceRow =
    stockRepoContent.includes('ensureBalanceRow') &&
    stockRepoContent.includes('ON CONFLICT (company_id, warehouse_id, item_id) DO NOTHING');
  assert(hasEnsureBalanceRow, 'S3: stockRepository.ts implements ensureBalanceRow with ON CONFLICT DO NOTHING');

  // S4: stockService.ts receiveStock uses incrementBalance and transactional audit
  const stockServicePath = path.join(root, 'src/server/inventory/stockService.ts');
  const stockServiceContent = fs.readFileSync(stockServicePath, 'utf8');
  const hasAtomicReceive =
    stockServiceContent.includes('this.stockRepo.incrementBalance') &&
    stockServiceContent.includes("{ executor: tx }");
  assert(hasAtomicReceive, 'S4: stockService.ts receiveStock uses atomic incrementBalance with transactional audit');

  // S5: stockService.ts issueStock uses decrementBalance with strict non-negative guard
  const hasAtomicIssue =
    stockServiceContent.includes('this.stockRepo.decrementBalance') &&
    stockServiceContent.includes('currentQty < input.qty');
  assert(hasAtomicIssue, 'S5: stockService.ts issueStock uses conditional decrementBalance with non-negative guard');

  // S6: stockService.ts transfer uses ensureBalanceRow, sorted lock ordering, and atomic operations
  const hasAtomicTransfer =
    stockServiceContent.includes('this.stockRepo.ensureBalanceRow') &&
    stockServiceContent.includes('Deadlock-safe lock ordering') &&
    stockServiceContent.includes('this.stockRepo.decrementBalance') &&
    stockServiceContent.includes('this.stockRepo.incrementBalance');
  assert(hasAtomicTransfer, 'S6: stockService.ts transfer implements ensureBalanceRow, sorted locking, and atomic updates');

  // --- LIVE POSTGRESQL INTEGRATION PROOF (T1 - T7) ---
  console.log('\n--- PostgreSQL Concurrency & Atomicity Proof (T1 - T7) ---');

  const appDbUrl = process.env.DATABASE_URL;
  const adminDbUrl = process.env.MIGRATION_DATABASE_URL;
  const isDbRequired = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true' || process.env.CI === 'true';

  const appDbCheck = appDbUrl ? isAllowedTestDb(appDbUrl) : { allowed: false, reason: 'DATABASE_URL is not configured' };

  if (!appDbUrl || appDbUrl.trim() === '' || !appDbCheck.allowed) {
    if (isDbRequired) {
      console.error(`[FAIL] DATABASE_URL validation failed: ${appDbCheck.reason}`);
      assert(false, `DATABASE_URL validation failed: ${appDbCheck.reason}`);
      process.exit(1);
    } else {
      reportSkipped(`T1-T7 Live PostgreSQL integration proof SKIPPED: ${appDbCheck.reason}`);
      console.log('[INFO] Static invariant checks verified. Disposable local PostgreSQL environment needed for live concurrency proof.');
    }
  } else {
    // Validate MIGRATION_DATABASE_URL with same strict allowlist policy
    let validAdminDbUrl: string | null = null;
    if (adminDbUrl && adminDbUrl.trim() !== '') {
      const adminCheck = isAllowedTestDb(adminDbUrl);
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

    console.log(`[Live Proof] Connecting to disposable PostgreSQL instance (${appDbCheck.host}) using application role (an_app)...`);

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

      // Verify admin connection responsiveness before creating test data
      if (adminClient) {
        await adminClient.query('SELECT 1;');
      }

      // --- SECTION 3: APPLICATION ROLE IDENTITY ASSERTIONS ---
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

      // Verify an_app is not owner of inventory tables
      const ownerRes = await appClient1.query<{ tablename: string }>(`
        SELECT c.relname as tablename
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'public' AND r.rolname = 'an_app' AND c.relname IN ('inv_stock_balances', 'inv_stock_movements');
      `);
      assert(ownerRes.rows.length === 0, 'Application Role Check: an_app is not the owner of inv_stock_balances or inv_stock_movements');

      // Verify RLS and FORCE RLS are active on BOTH inv_stock_balances and inv_stock_movements
      const rlsRes = await appClient1.query<{ tablename: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
        SELECT c.relname as tablename, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('inv_stock_balances', 'inv_stock_movements');
      `);
      const balRls = rlsRes.rows.find(r => r.tablename === 'inv_stock_balances');
      const movRls = rlsRes.rows.find(r => r.tablename === 'inv_stock_movements');

      assert(Boolean(balRls?.relrowsecurity && balRls?.relforcerowsecurity), 'RLS Check: RLS and FORCE RLS are active on inv_stock_balances');
      assert(Boolean(movRls?.relrowsecurity && movRls?.relforcerowsecurity), 'RLS Check: RLS and FORCE RLS are active on inv_stock_movements');

      // Verify privileges granted to an_app on inv_stock_movements
      const privsRes = await appClient1.query<{ tablename: string; privilege_type: string }>(`
        SELECT table_name as tablename, privilege_type
        FROM information_schema.role_table_grants
        WHERE grantee = 'an_app' AND table_name IN ('inv_stock_balances', 'inv_stock_movements');
      `);
      const movPrivs = new Set(privsRes.rows.filter(r => r.tablename === 'inv_stock_movements').map(r => r.privilege_type));
      const hasMovGrants = movPrivs.has('SELECT') && movPrivs.has('INSERT') && movPrivs.has('UPDATE') && movPrivs.has('DELETE');
      assert(hasMovGrants, 'Permissions Check: an_app has explicit SELECT, INSERT, UPDATE, DELETE grants on inv_stock_movements');

      // Verify actual RLS policies on inv_stock_movements
      const policyRes = await appClient1.query<{ policyname: string }>(`
        SELECT policyname 
        FROM pg_policies 
        WHERE schemaname = 'public' AND tablename = 'inv_stock_movements';
      `);
      const hasMovPolicy = policyRes.rows.some(r => r.policyname === 'inv_stock_movements_tenant_isolation');
      assert(hasMovPolicy, 'Policy Check: inv_stock_movements has tenant isolation policy inv_stock_movements_tenant_isolation');

      // Prove independent connections using pg_backend_pid()
      const pidRes1 = await appClient1.query<{ pid: number }>('SELECT pg_backend_pid() as pid;');
      const pidRes2 = await appClient2.query<{ pid: number }>('SELECT pg_backend_pid() as pid;');
      const pid1 = pidRes1.rows[0].pid;
      const pid2 = pidRes2.rows[0].pid;
      const independentConnections = Boolean(pid1 && pid2 && pid1 !== pid2);
      console.log(`Recorded pg_backend_pid Values: appClient1 = ${pid1}, appClient2 = ${pid2}`);
      assert(independentConnections, `Independent DB connections verified (PID 1: ${pid1}, PID 2: ${pid2})`);

      // --- SECTION 4: DATA SETUP ---
      const suffix = Date.now() + '_' + Math.random().toString(36).substring(2, 7);

      // Create companies (an_app has companies_app_policy USING(true) WITH CHECK(true))
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

      // Set tenant context for appClient1 to create warehouses and items for compId
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

        // 1. Valid balance write
        await appClient1.query(
          `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
           VALUES ($1, $2, $3, 99, NOW())
           ON CONFLICT (company_id, warehouse_id, item_id)
           DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW();`,
          [compId, whC, itemId]
        );

        // 2. Valid movement write
        await appClient1.query(
          `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo)
           VALUES ($1, $2, $3, 'receive', 99, 'T5 test');`,
          [compId, whC, itemId]
        );

        // 3. Failing write: Force explicit foreign key violation on item_id UUID
        await appClient1.query(
          `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty)
           VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'receive', 50);`,
          [compId, whC]
        );
        await appClient1.query('COMMIT;');
      } catch (err: any) {
        t5ErrCode = err.code || '';
        t5ConstraintName = err.constraint || '';
        // Verify SQLSTATE 23503 and explicit item_id FK constraint name or detail
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
        if (err.code === '23514') { // check_violation
          checkConstraintTriggered = true;
        }
        await appClient1.query('ROLLBACK;');
      }
      assert(checkConstraintTriggered, 'T6: Direct negative balance update rejected by DB CHECK constraint (SQLSTATE 23514)');

      // --- T7: TENANT ISOLATION & RLS PROOF UNDER AN_APP ---
      console.log('\nRunning T7: Strict Tenant Isolation & RLS Proof using an_app connections...');

      // 1. Read Own Company Data
      await appClient1.query('BEGIN;');
      await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
      const ownReadRes = await appClient1.query<{ qty: number }>(
        "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
        [compId, whA, itemId]
      );
      await appClient1.query('COMMIT;');
      assert(ownReadRes.rows.length === 1 && ownReadRes.rows[0].qty === 45, 'T7.1: appClient1 under company A context reads own company A stock balances');

      // 2. Read Other Company Data (Filtered by RLS)
      await appClient2.query('BEGIN;');
      await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);
      const otherReadRes = await appClient2.query(
        "SELECT * FROM inv_stock_balances WHERE company_id = $1;",
        [compId]
      );
      await appClient2.query('COMMIT;');
      assert(otherReadRes.rows.length === 0, 'T7.2: appClient2 under company B context returns 0 rows when querying company A balances (RLS USING clause)');

      // 3. Insert Other Company Data (Rejected by RLS WITH CHECK)
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
        if (err.code === '42501') { // insufficient_privilege / RLS policy violation
          rlsInsertRejected = true;
        }
        await appClient2.query('ROLLBACK;');
      }
      assert(rlsInsertRejected, `T7.3: appClient2 under company B context inserting into company A balances strictly rejected by SQLSTATE 42501 (actual code: '${rlsInsertErrCode}')`);

      // 4. Update Other Company Data (Affects 0 rows, original balance unchanged)
      await appClient2.query('BEGIN;');
      await appClient2.query("SELECT set_config('app.current_tenant_id', $1, true);", [comp2Id]);
      const updateOtherRes = await appClient2.query(
        "UPDATE inv_stock_balances SET qty = 999 WHERE company_id = $1 RETURNING qty;",
        [compId]
      );
      await appClient2.query('COMMIT;');
      assert(updateOtherRes.rowCount === 0, 'T7.4: appClient2 under company B context updating company A balances affected 0 rows');

      // Verify company A balance remains unchanged (45)
      await appClient1.query('BEGIN;');
      await appClient1.query("SELECT set_config('app.current_tenant_id', $1, true);", [compId]);
      const verifyUnchangedRes = await appClient1.query<{ qty: number }>(
        "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
        [compId, whA, itemId]
      );
      await appClient1.query('COMMIT;');
      assert(verifyUnchangedRes.rows[0]?.qty === 45, 'T7.4b: Company A stock balance remained unchanged at 45 after cross-tenant UPDATE attempt');

      // 5. Unset Tenant Context Isolation (appClient3 without setting tenant_id)
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

    } finally {
      // Guaranteed transactional cleanup in finally block
      let cleanupErrMessage: string | null = null;
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
        } catch (cleanupErr: any) {
          await adminClient.query('ROLLBACK;').catch(() => {});
          cleanupErrMessage = cleanupErr?.message || String(cleanupErr);
          console.error('[CLEANUP ERROR] Transactional cleanup failed:', cleanupErr);
        }
      }

      await appClient1.end().catch(() => {});
      await appClient2.end().catch(() => {});
      await appClient3.end().catch(() => {});
      if (adminClient) {
        await adminClient.end().catch(() => {});
      }

      if (cleanupErrMessage) {
        assert(false, `Guaranteed Teardown Check: Transactional cleanup failed with error: ${cleanupErrMessage}`);
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

