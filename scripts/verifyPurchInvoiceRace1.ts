import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultInvoiceService } from '../src/server/purchasing/invoiceService.js';
import { defaultGrnService } from '../src/server/purchasing/grnService.js';
import { defaultSupplierService } from '../src/server/purchasing/supplierService.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { ValidationError } from '../src/server/http/errors.js';
import { ensureTestCostingProfile } from './helpers/ensureTestCostingProfile.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-FIX-INVOICE-P0-1 (Qty & Concurrency Race Proof)     ===');
console.log('========================================================================');

function assertLoopbackUrl(raw: string, varName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${varName} is invalid URL format`);
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
  }
  return parsed;
}

async function run() {
  const rootDir = process.cwd();

  // ==========================================
  // Section 1: Static Code & Migration Guards (S1 - S4)
  // ==========================================
  const mig042Path = path.join(rootDir, 'database/migrations/042_supplier_invoice_qty_guards.sql');
  const invoiceServicePath = path.join(rootDir, 'src/server/purchasing/invoiceService.ts');
  const invoiceRepoPath = path.join(rootDir, 'src/server/purchasing/invoiceRepository.ts');
  const pkgPath = path.join(rootDir, 'package.json');
  const batteryPath = path.join(rootDir, 'scripts/runFoundationBattery.ts');

  const mig042Src = fs.existsSync(mig042Path) ? fs.readFileSync(mig042Path, 'utf8') : '';
  const invoiceServiceSrc = fs.readFileSync(invoiceServicePath, 'utf8');
  const invoiceRepoSrc = fs.readFileSync(invoiceRepoPath, 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const batterySrc = fs.readFileSync(batteryPath, 'utf8');

  await check(
    'S1: Migration 042 defines UNIQUE (company_id, invoice_id, grn_line_id) & FOR UPDATE trigger guard without EXCEPTION WHEN OTHERS',
    Boolean(mig042Src) &&
      mig042Src.includes('UNIQUE (company_id, invoice_id, grn_line_id)') &&
      mig042Src.includes('FOR UPDATE OF gl') &&
      mig042Src.includes('OVER_INVOICED_GRN_LINE') &&
      !/EXCEPTION\s+WHEN\s+OTHERS/i.test(mig042Src)
  );

  await check(
    'S2: invoiceService.ts rejects duplicate grnLineId on create/post and locks GRN lines via lockGrnLinesAndGetPostedTotals',
    invoiceServiceSrc.includes('seenGrnLineIds') &&
      invoiceServiceSrc.includes('seenPostGrnLineIds') &&
      invoiceServiceSrc.includes('lockGrnLinesAndGetPostedTotals') &&
      invoiceServiceSrc.includes('toMinorUnits')
  );

  await check(
    'S3: invoiceRepository.ts acquires deterministic FOR UPDATE OF gl locks ordered by gl.id ASC',
    invoiceRepoSrc.includes('lockGrnLinesAndGetPostedTotals') &&
      invoiceRepoSrc.includes('ORDER BY gl.id ASC') &&
      invoiceRepoSrc.includes('FOR UPDATE OF gl')
  );

  await check(
    'S4: verifyPurchInvoiceRace1.ts is wired in package.json and runFoundationBattery.ts',
    pkgJson?.scripts?.['test:purch-invoice-race-1'] === 'tsx scripts/verifyPurchInvoiceRace1.ts' &&
      batterySrc.includes('scripts/verifyPurchInvoiceRace1.ts')
  );

  // ==========================================
  // Section 2: Loopback PostgreSQL Race & DB Constraint Proof (T1 - T4)
  // ==========================================
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live loopback PostgreSQL invoice race tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
    if (process.env.MIGRATION_DATABASE_URL && process.env.MIGRATION_DATABASE_URL.trim() !== '') {
      assertLoopbackUrl(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
    }
  } catch (err) {
    blocked(err instanceof Error ? err.message : String(err));
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Database executor unavailable. Live invoice race tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  let cleanupFailed = false;

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();

    const user = await userRepo.createUser({
      username: `inv_race_usr_${unique}`,
      passwordHash: 'dummy_hash_race_1',
      role: 'platform_admin',
    });
    userIds.push(user.id);

    const comp = await companyRepo.create({
      code: `INR-${unique}`.slice(0, 20),
      nameAr: `شركة اختبار سباق الفواتير ${unique}`,
      createdBy: user.id,
    });
    companyIds.push(comp.id);

    const companyId = comp.id;
    const userId = user.id;

    // Setup GL accounts & settings
    const invAcc = await defaultAccountService.createAccount(
      companyId,
      { code: `INV-R-${unique}`.slice(0, 20), nameAr: 'مخزون سباق', accountType: 'asset', isPostable: true },
      userId
    );
    const clrAcc = await defaultAccountService.createAccount(
      companyId,
      { code: `CLR-R-${unique}`.slice(0, 20), nameAr: 'مشتريات معلقة سباق', accountType: 'liability', isPostable: true },
      userId
    );
    const apAcc = await defaultAccountService.createAccount(
      companyId,
      { code: `AP-R-${unique}`.slice(0, 20), nameAr: 'ذمم موردين سباق', accountType: 'liability', isPostable: true },
      userId
    );

    await defaultCompanySettingsRepository.upsert(
      companyId,
      {
        inventoryAccountId: invAcc.id,
        purchasesClearingAccountId: clrAcc.id,
        accountsPayableAccountId: apAcc.id,
      },
      userId
    );

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
    await defaultPeriodService.createPeriod(
      companyId,
      {
        code: `${y}-${m}-RACE-${unique}`,
        startDate: `${y}-${m}-01`,
        endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}`,
      },
      userId
    );

    const supplier = await defaultSupplierService.createSupplier(
      companyId,
      { code: `SUP-R-${unique}`.slice(0, 20), nameAr: 'مورد سباق' },
      userId
    );
    const warehouse = await defaultWarehouseService.createWarehouse(
      companyId,
      { code: `WH-R-${unique}`.slice(0, 20), nameAr: 'مستودع سباق' },
      userId
    );
    const item = await defaultItemService.createItem(
      companyId,
      { code: `ITM-R-${unique}`.slice(0, 20), nameAr: 'صنف سباق', uom: 'حبة' },
      userId
    );
    await ensureTestCostingProfile(companyId, [item.id], userId);

    const grn = await defaultGrnService.createGrn(
      companyId,
      {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        lines: [{ itemId: item.id, qty: 10, unitCost: 100 }],
      },
      userId
    );
    const postedGrn = await defaultGrnService.postGrn(companyId, grn.id, userId);
    const grnLineId = postedGrn.lines![0].id;

    // T1: Reject duplicate grnLineId in single createInvoice (6 + 6 > 10)
    let dupRejected = false;
    try {
      await defaultInvoiceService.createInvoice(
        companyId,
        {
          supplierId: supplier.id,
          supplierInvoiceNo: `RACE-DUP-001`,
          lines: [
            { grnLineId, qty: 6, unitCost: 100 },
            { grnLineId, qty: 6, unitCost: 100 },
          ],
        },
        userId
      );
    } catch (err: any) {
      if (err instanceof ValidationError) dupRejected = true;
    }
    await check('T1a: Duplicate grnLineId in single createInvoice rejected cleanly', dupRejected);

    // T1b: Over-qty single line rejected cleanly (11 > 10)
    let overQtyRejected = false;
    try {
      await defaultInvoiceService.createInvoice(
        companyId,
        {
          supplierId: supplier.id,
          supplierInvoiceNo: `RACE-OVER-001`,
          lines: [{ grnLineId, qty: 11, unitCost: 100 }],
        },
        userId
      );
    } catch (err: any) {
      if (err instanceof ValidationError) overQtyRejected = true;
    }
    await check('T1b: Single line exceeding remainingQty rejected cleanly', overQtyRejected);

    // T2: Create two separate valid drafts of qty=6 each (total 12 > 10), then race postInvoice via Promise.allSettled
    const draftA = await defaultInvoiceService.createInvoice(
      companyId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `RACE-CONC-A`,
        lines: [{ grnLineId, qty: 6, unitCost: 100 }],
      },
      userId
    );
    const draftB = await defaultInvoiceService.createInvoice(
      companyId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `RACE-CONC-B`,
        lines: [{ grnLineId, qty: 6, unitCost: 100 }],
      },
      userId
    );

    const settled = await Promise.allSettled([
      defaultInvoiceService.postInvoice(companyId, draftA.id, userId),
      defaultInvoiceService.postInvoice(companyId, draftB.id, userId),
    ]);
    const fulfilledCount = settled.filter((r) => r.status === 'fulfilled').length;
    const rejectedCount = settled.filter((r) => r.status === 'rejected').length;

    const outstandingAfter = await defaultInvoiceService.getOutstandingLines(companyId, supplier.id);
    const remainingQty = outstandingAfter.length === 1 ? Number(outstandingAfter[0].remainingQty) : -1;

    await check(
      'T2: Concurrent postInvoice race (6 + 6 against 10) lets strictly 1 succeed and 1 fail, leaving remaining=4',
      fulfilledCount === 1 && rejectedCount === 1 && remainingQty === 4
    );

    // T3: Verify DB unique constraint rejects raw duplicate grn_line_id insert on a draft invoice (SQLSTATE 23505)
    //     Must use a guaranteed 'draft' invoice so trg_purch_supplier_invoice_lines_posted_guard does not trigger first.
    const draftForUnique = await defaultInvoiceService.createInvoice(
      companyId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `RACE-UNIQ-DRAFT`,
        lines: [{ grnLineId, qty: 1, unitCost: 100 }],
      },
      userId
    );
    let dbUniqueRejected = false;
    await executor.withTransaction(async (tx) => {
      await tx.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [companyId]);
      await tx.query('SAVEPOINT sp_dup');
      try {
        await tx.query(
          `INSERT INTO purch_supplier_invoice_lines (invoice_id, company_id, grn_line_id, item_id, qty, unit_cost, line_no)
           VALUES ($1, $2, $3, $4, 1, 100, 99)`,
          [draftForUnique.id, companyId, grnLineId, item.id]
        );
      } catch (pgErr: any) {
        if (pgErr?.code === '23505') {
          dbUniqueRejected = true;
        }
        await tx.query('ROLLBACK TO SAVEPOINT sp_dup');
      }
    });
    await check(
      'T3: PostgreSQL UNIQUE (company_id, invoice_id, grn_line_id) rejects duplicate grn_line_id on draft invoice with SQLSTATE 23505',
      dbUniqueRejected
    );
  } catch (err) {
    console.error('[verifyPurchInvoiceRace1] Live test error:', err);
    blocked(err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines DISABLE TRIGGER trg_journal_lines_immutability');

        await client.query('DELETE FROM purch_supplier_invoice_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_supplier_invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_grn_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_grn WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM journal_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM journal_entries WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_stock_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_stock_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM company_settings WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_periods WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_sequences WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounts WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_items WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_warehouses WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_suppliers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);

        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }

        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        await client.query('COMMIT');
      } catch (cleanupErr) {
        cleanupFailed = true;
        await client.query('ROLLBACK').catch(() => {});
        console.error('[verifyPurchInvoiceRace1] Cleanup failed:', cleanupErr);
      } finally {
        await client.end().catch(() => {});
      }
    }
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  if (cleanupFailed) {
    process.exit(1);
  }
  process.exit(exitCode);
}

run().catch(async (err) => {
  console.error('[verifyPurchInvoiceRace1] Fatal error:', err);
  await closeAllExecutors().catch(() => {});
  process.exit(1);
});
