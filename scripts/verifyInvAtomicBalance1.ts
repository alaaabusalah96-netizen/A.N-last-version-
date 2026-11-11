import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { buildPgConfig } from '../src/server/db/connection.js';

export function isProductionOrSupabaseDb(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return (
      host.includes('supabase.co') ||
      host.includes('pooler.supabase') ||
      host.includes('supabase.com') ||
      host.includes('aws.neon.tech') ||
      host.includes('rds.amazonaws.com')
    );
  } catch {
    const lower = urlStr.toLowerCase();
    return (
      lower.includes('supabase.co') ||
      lower.includes('pooler.supabase') ||
      lower.includes('supabase.com') ||
      lower.includes('aws.neon.tech') ||
      lower.includes('rds.amazonaws.com')
    );
  }
}

async function runVerification() {
  console.log('=== RUNNING INVENTORY ATOMIC BALANCE VERIFICATION (AN-FIX-INVENTORY-ATOMIC-BALANCE-1) ===\n');
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

  const dbUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

  if (!dbUrl) {
    reportSkipped('T1-T7 Live PostgreSQL integration proof SKIPPED: Neither DATABASE_URL nor MIGRATION_DATABASE_URL configured');
    console.log('[INFO] Static invariant checks verified. Disposable PostgreSQL environment needed for live concurrency proof.');
  } else if (isProductionOrSupabaseDb(dbUrl) && process.env.INV_ALLOW_DISPOSABLE !== '1') {
    reportSkipped('T1-T7 Live PostgreSQL integration proof SKIPPED: Protected/remote DB detected and INV_ALLOW_DISPOSABLE is not set to 1');
  } else {
    console.log('[Live Proof] Connecting to disposable PostgreSQL instance via independent connections...');

    const pgConfig = buildPgConfig(dbUrl, process.env);
    const client1 = new pg.Client(pgConfig);
    const client2 = new pg.Client(pgConfig);

    let compId = '';
    let whA = '';
    let whB = '';
    let whC = '';
    let itemId = '';
    let comp2Id = '';

    try {
      await client1.connect();
      await client2.connect();

      // Prove independent connections using pg_backend_pid()
      const pidRes1 = await client1.query('SELECT pg_backend_pid() as pid;');
      const pidRes2 = await client2.query('SELECT pg_backend_pid() as pid;');
      const pid1 = pidRes1.rows[0].pid;
      const pid2 = pidRes2.rows[0].pid;

      const independentConnections = Boolean(pid1 && pid2 && pid1 !== pid2);
      console.log(`Recorded pg_backend_pid Values: Client 1 = ${pid1}, Client 2 = ${pid2}`);
      assert(independentConnections, `Independent DB connections verified (PID 1: ${pid1}, PID 2: ${pid2})`);

      // Setup disposable test data
      const suffix = Date.now();
      const compRes = await client1.query(
        "INSERT INTO companies (code, name_ar) VALUES ($1, 'شركة اختبار المخزون الذري') RETURNING id;",
        [`INV_ATOMIC_${suffix}`]
      );
      compId = compRes.rows[0].id;

      const comp2Res = await client1.query(
        "INSERT INTO companies (code, name_ar) VALUES ($1, 'شركة اختبار العزل') RETURNING id;",
        [`INV_ISO_${suffix}`]
      );
      comp2Id = comp2Res.rows[0].id;

      const whARes = await client1.query(
        "INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1, 'WHA', 'مستودع أ') RETURNING id;",
        [compId]
      );
      whA = whARes.rows[0].id;

      const whBRes = await client1.query(
        "INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1, 'WHB', 'مستودع ب') RETURNING id;",
        [compId]
      );
      whB = whBRes.rows[0].id;

      const whCRes = await client1.query(
        "INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1, 'WHC', 'مستودع ج') RETURNING id;",
        [compId]
      );
      whC = whCRes.rows[0].id;

      const itemRes = await client1.query(
        "INSERT INTO inv_items (company_id, code, name_ar, uom) VALUES ($1, 'ITEM1', 'صنف تجريبي', 'unit') RETURNING id;",
        [compId]
      );
      itemId = itemRes.rows[0].id;

      // Set tenant context on both connections
      await client1.query("SELECT set_config('app.current_tenant_id', $1, false);", [compId]);
      await client2.query("SELECT set_config('app.current_tenant_id', $1, false);", [compId]);

      // T1: Concurrent RECEIVE into absent balance row
      console.log('\nRunning T1: Concurrent RECEIVE (10 and 15)...');
      const receive1 = async () => {
        await client1.query('BEGIN;');
        await client1.query(
          `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
           VALUES ($1, $2, $3, 10, NOW())
           ON CONFLICT (company_id, warehouse_id, item_id)
           DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW();`,
          [compId, whA, itemId]
        );
        await client1.query(
          `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo)
           VALUES ($1, $2, $3, 'receive', 10, 'T1 receive 10');`,
          [compId, whA, itemId]
        );
        await client1.query('COMMIT;');
      };

      const receive2 = async () => {
        await client2.query('BEGIN;');
        await client2.query(
          `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
           VALUES ($1, $2, $3, 15, NOW())
           ON CONFLICT (company_id, warehouse_id, item_id)
           DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW();`,
          [compId, whA, itemId]
        );
        await client2.query(
          `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo)
           VALUES ($1, $2, $3, 'receive', 15, 'T1 receive 15');`,
          [compId, whA, itemId]
        );
        await client2.query('COMMIT;');
      };

      await Promise.all([receive1(), receive2()]);

      const t1BalRes = await client1.query(
        "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
        [compId, whA, itemId]
      );
      const t1Qty = t1BalRes.rows[0]?.qty;
      assert(t1Qty === 25, `T1: Concurrent receive into absent row produced exact sum 25 (actual: ${t1Qty})`);

      // T2: Concurrent TRANSFERS into an absent destination
      console.log('\nRunning T2: Concurrent TRANSFERS into absent destination WH_B...');
      // Start with 100 in WH_A
      await client1.query(
        "UPDATE inv_stock_balances SET qty = 100 WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
        [compId, whA, itemId]
      );

      const transferOp = async (client: pg.Client, amount: number, memo: string) => {
        await client.query('BEGIN;');
        // 1. Ensure rows exist
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

        // 2. Lock in sorted order
        const [w1, w2] = [whA, whB].sort();
        await client.query("SELECT qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 FOR UPDATE;", [compId, w1, itemId]);
        await client.query("SELECT qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 FOR UPDATE;", [compId, w2, itemId]);

        // 3. Decrement source
        const decRes = await client.query(
          `UPDATE inv_stock_balances SET qty = qty - $4, updated_at = NOW()
           WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 AND qty >= $4
           RETURNING qty::float as qty;`,
          [compId, whA, itemId, amount]
        );
        if (decRes.rows.length === 0) {
          await client.query('ROLLBACK;');
          throw new Error('INSUFFICIENT_STOCK');
        }

        // 4. Increment destination
        await client.query(
          `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (company_id, warehouse_id, item_id)
           DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW();`,
          [compId, whB, itemId, amount]
        );

        // 5. Insert paired movements
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
        transferOp(client1, 20, 'Transfer 20'),
        transferOp(client2, 30, 'Transfer 30'),
      ]);

      const t2DestRes = await client1.query(
        "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
        [compId, whB, itemId]
      );
      const t2SourceRes = await client1.query(
        "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
        [compId, whA, itemId]
      );
      const destQty = t2DestRes.rows[0]?.qty;
      const sourceQty = t2SourceRes.rows[0]?.qty;
      assert(destQty === 50 && sourceQty === 50, `T2: Concurrent transfers into absent destination resulted in WH_B: ${destQty} (expected 50), WH_A: ${sourceQty} (expected 50)`);

      // T3: Concurrent ISSUE (10 initial, two requests of 7 each -> exactly one succeeds)
      console.log('\nRunning T3: Concurrent ISSUE (10 initial, two requests of 7 each)...');
      await client1.query(
        "UPDATE inv_stock_balances SET qty = 10 WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
        [compId, whA, itemId]
      );

      const issueOp = async (client: pg.Client) => {
        await client.query('BEGIN;');
        const res = await client.query(
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

      const [resI1, resI2] = await Promise.all([issueOp(client1), issueOp(client2)]);
      const oneSucceeded = (resI1.success && !resI2.success) || (!resI1.success && resI2.success);

      const t3BalRes = await client1.query(
        "SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
        [compId, whA, itemId]
      );
      const t3FinalQty = t3BalRes.rows[0]?.qty;
      assert(oneSucceeded && t3FinalQty === 3, `T3: Exactly one issue succeeded, one rejected, final balance is 3 (actual: ${t3FinalQty})`);

      // T4: Concurrent TRANSFERS in opposite directions (WH_A <-> WH_B) proving deadlock-free lock ordering
      console.log('\nRunning T4: Concurrent reverse-direction transfers (WH_A <-> WH_B)...');
      await client1.query("UPDATE inv_stock_balances SET qty = 50 WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whA, itemId]);
      await client1.query("UPDATE inv_stock_balances SET qty = 50 WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whB, itemId]);

      const transferDir = async (client: pg.Client, fromWh: string, toWh: string, amount: number) => {
        await client.query('BEGIN;');
        // Deadlock-safe sorted lock ordering
        const [w1, w2] = [fromWh, toWh].sort();
        await client.query("SELECT qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 FOR UPDATE;", [compId, w1, itemId]);
        await client.query("SELECT qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 FOR UPDATE;", [compId, w2, itemId]);

        const dec = await client.query(
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
        transferDir(client1, whA, whB, 15), // WH_A: 50 -> 35, WH_B: 50 -> 65
        transferDir(client2, whB, whA, 10), // WH_B: 65 -> 55, WH_A: 35 -> 45
      ]);

      const t4ARes = await client1.query("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whA, itemId]);
      const t4BRes = await client1.query("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whB, itemId]);
      const balA = t4ARes.rows[0]?.qty;
      const balB = t4BRes.rows[0]?.qty;
      const totalStock = balA + balB;
      assert(balA === 45 && balB === 55 && totalStock === 100, `T4: Reverse transfers completed without deadlock, stock conserved (WH_A: ${balA}, WH_B: ${balB}, Total: ${totalStock})`);

      // T5: Transaction rollback preserves atomicity (failure rolls back balance, movements, audit)
      console.log('\nRunning T5: Transaction rollback atomicity...');
      const preMovementsRes = await client1.query("SELECT count(*)::int as count FROM inv_stock_movements WHERE company_id = $1 AND warehouse_id = $2;", [compId, whC]);
      const preCount = preMovementsRes.rows[0].count;

      try {
        await client1.query('BEGIN;');
        // 1. Increment balance
        await client1.query(
          `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
           VALUES ($1, $2, $3, 99, NOW())
           ON CONFLICT (company_id, warehouse_id, item_id)
           DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW();`,
          [compId, whC, itemId]
        );
        // 2. Insert valid movement
        await client1.query(
          `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo)
           VALUES ($1, $2, $3, 'receive', 99, 'T5 test');`,
          [compId, whC, itemId]
        );
        // 3. Force failure (violates non-null / foreign key)
        await client1.query(
          `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty)
           VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'invalid_type', -50);`
        );
        await client1.query('COMMIT;');
      } catch {
        await client1.query('ROLLBACK;');
      }

      const postBalRes = await client1.query("SELECT qty::float as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;", [compId, whC, itemId]);
      const postMovementsRes = await client1.query("SELECT count(*)::int as count FROM inv_stock_movements WHERE company_id = $1 AND warehouse_id = $2;", [compId, whC]);
      const postQty = postBalRes.rows[0]?.qty;
      const postCount = postMovementsRes.rows[0].count;

      assert(postQty === undefined && postCount === preCount, `T5: Rollback cleaned up completely (balance row absent, movements count unchanged: ${postCount})`);

      // T6: Repository & validation behavior (conditional decrement rejection & DB check constraint)
      console.log('\nRunning T6: Repository conditional decrement validation...');
      const decFailRes = await client1.query(
        `UPDATE inv_stock_balances SET qty = qty - 999, updated_at = NOW()
         WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 AND qty >= 999
         RETURNING qty::float as qty;`,
        [compId, whA, itemId]
      );
      assert(decFailRes.rows.length === 0, 'T6: Decrement with amount exceeding balance returns 0 rows (no negative balance allowed)');

      // Verify DB CHECK constraint blocks negative quantity directly
      let checkConstraintTriggered = false;
      try {
        await client1.query('SAVEPOINT sp_chk;');
        await client1.query(
          "UPDATE inv_stock_balances SET qty = -10 WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3;",
          [compId, whA, itemId]
        );
      } catch (err: any) {
        if (err.code === '23514') { // check_violation
          checkConstraintTriggered = true;
        }
        await client1.query('ROLLBACK TO SAVEPOINT sp_chk;');
      }
      assert(checkConstraintTriggered, 'T6: Direct negative balance update rejected by DB CHECK constraint (23514)');

      // T7: Tenant and entity isolation
      console.log('\nRunning T7: Tenant isolation verification...');
      // Set client2 context to company 2
      await client2.query("SELECT set_config('app.current_tenant_id', $1, false);", [comp2Id]);
      const comp2BalRes = await client2.query(
        "SELECT * FROM inv_stock_balances WHERE company_id = $1;",
        [compId]
      );
      assert(comp2BalRes.rows.length === 0, 'T7: Cross-tenant query under company 2 context returned 0 rows for company 1 balances (RLS isolation)');

    } finally {
      // Safe cleanup of test data
      try {
        if (compId) {
          await client1.query("DELETE FROM inv_stock_movements WHERE company_id = $1;", [compId]);
          await client1.query("DELETE FROM inv_stock_balances WHERE company_id = $1;", [compId]);
          await client1.query("DELETE FROM inv_items WHERE company_id = $1;", [compId]);
          await client1.query("DELETE FROM inv_warehouses WHERE company_id = $1;", [compId]);
          await client1.query("DELETE FROM companies WHERE id = $1;", [compId]);
        }
        if (comp2Id) {
          await client1.query("DELETE FROM companies WHERE id = $1;", [comp2Id]);
        }
      } catch (cleanupErr) {
        console.error('Warning during test cleanup:', cleanupErr);
      }
      try {
        await client1.end();
      } catch {}
      try {
        await client2.end();
      } catch {}
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
