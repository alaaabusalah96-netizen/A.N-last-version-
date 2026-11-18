import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { defaultSupplierService } from '../src/server/purchasing/supplierService.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultGrnService } from '../src/server/purchasing/grnService.js';
import { defaultInvoiceService } from '../src/server/purchasing/invoiceService.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { ValidationError } from '../src/server/http/errors.js';
import { ensureTestCostingProfile } from './helpers/ensureTestCostingProfile.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-FIX-THREEWAY-POST-GATE-1: Three-Way Match Post Gate ===');
console.log('========================================================================');

function assertLoopbackUrl(raw: string, varName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${varName} is invalid URL format`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
  }
  return parsed;
}

async function run() {
  const rootDir = process.cwd();

  // S0: Registration check
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  await check(
    'S0: verifyPurch3WayPostGate1.ts registered in runFoundationBattery.ts and package.json',
    batterySrc.includes('scripts/verifyPurch3WayPostGate1.ts') &&
      pkgJson?.scripts?.['test:purch-3way-post-gate-1'] === 'tsx scripts/verifyPurch3WayPostGate1.ts'
  );

  // S1-S3: Static order and source checks
  const invoiceSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/invoiceService.ts'), 'utf8');
  const threeWaySvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/threeWayMatchService.ts'), 'utf8');

  await check(
    'S1: postInvoice body references evaluateInvoice',
    invoiceSvcSrc.includes('this.threeWayMatchService.evaluateInvoice')
  );

  await check(
    'S2: variance_exceeded throws ValidationError',
    invoiceSvcSrc.includes("matchReport.overallStatus === 'variance_exceeded'") &&
      invoiceSvcSrc.includes('ValidationError')
  );

  const postInvoiceCode = invoiceSvcSrc.slice(invoiceSvcSrc.indexOf('async postInvoice'));
  const evalIdx = postInvoiceCode.indexOf('evaluateInvoice');
  const lockGrnIdx = postInvoiceCode.indexOf('lockGrnLinesAndGetPostedTotals');
  const createJeIdx = postInvoiceCode.indexOf('createDraftEntry');

  await check(
    'S3 ORDER: evaluateInvoice occurs after lockGrnLinesAndGetPostedTotals and before createDraftEntry',
    evalIdx > lockGrnIdx && evalIdx < createJeIdx
  );

  await check(
    'S4: evaluateInvoice passes tx',
    invoiceSvcSrc.includes('evaluateInvoice(') && invoiceSvcSrc.includes(',\n        tx\n      )')
  );

  await check(
    'S5: DEFAULT_THREE_WAY_POLICY tolerances correct (qty=0, price=5)',
    threeWaySvcSrc.includes('qtyTolerancePct: 0') && threeWaySvcSrc.includes('priceTolerancePct: 5')
  );

  // Live DB Verification
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live Three-Way match post gate verification is BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
  } catch (err) {
    blocked(err instanceof Error ? err.message : String(err));
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor. Live Three-Way match verification is BLOCKED.');
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

    const userA = await userRepo.createUser({
      username: `t3w_usr_${unique}`,
      passwordHash: 'dummy_hash_t3w',
      role: 'platform_admin',
    });
    userIds.push(userA.id);

    const compA = await companyRepo.create({
      code: `T3W-${unique}`.slice(0, 20),
      nameAr: `شركة اختبار المطابقة الثلاثية ${unique}`,
      createdBy: userA.id,
    });
    companyIds.push(compA.id);

    const companyAId = compA.id;
    const userId = userA.id;

    const invAcc = await defaultAccountService.createAccount(
      companyAId,
      { code: `INV-${unique}`.slice(0, 20), nameAr: 'المخزون', accountType: 'asset', isPostable: true },
      userId
    );
    const clrAcc = await defaultAccountService.createAccount(
      companyAId,
      { code: `CLR-${unique}`.slice(0, 20), nameAr: 'المشتريات المعلقة', accountType: 'liability', isPostable: true },
      userId
    );
    const apAcc = await defaultAccountService.createAccount(
      companyAId,
      { code: `AP-${unique}`.slice(0, 20), nameAr: 'الدائنين', accountType: 'liability', isPostable: true },
      userId
    );

    await defaultCompanySettingsRepository.upsert(
      companyAId,
      { inventoryAccountId: invAcc.id, purchasesClearingAccountId: clrAcc.id, accountsPayableAccountId: apAcc.id },
      userId
    );

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
    await defaultPeriodService.createPeriod(
      companyAId,
      { code: `${y}-${m}-T3W-${unique}`, startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}` },
      userId
    );

    const supplier = await defaultSupplierService.createSupplier(
      companyAId,
      { code: `SUP-${unique}`.slice(0, 20), nameAr: 'مورد المطابقة' },
      userId
    );
    const warehouse = await defaultWarehouseService.createWarehouse(
      companyAId,
      { code: `WH-${unique}`.slice(0, 20), nameAr: 'مستودع المطابقة' },
      userId
    );
    const item = await defaultItemService.createItem(
      companyAId,
      { code: `ITM-${unique}`.slice(0, 20), nameAr: 'صنف مطابقة', uom: 'قطعة' },
      userId
    );
    await ensureTestCostingProfile(companyAId, [item.id], userId);

    // Post GRN with unitCost = 100
    const grn = await defaultGrnService.createGrn(
      companyAId,
      { supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ itemId: item.id, qty: 10, unitCost: 100 }] },
      userId
    );
    await defaultGrnService.postGrn(companyAId, grn.id, userId);
    const postedGrn = await defaultGrnService.getGrn(companyAId, grn.id);
    const grnLineId = postedGrn.lines![0].id;

    // L1 REJECT: Invoice unitCost = 110 (10% variance > 5% tolerance) -> variance_exceeded
    const rejectDraft = await defaultInvoiceService.createInvoice(
      companyAId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `INV-REJ-${unique}`,
        lines: [{ grnLineId, qty: 5, unitCost: 110 }],
      },
      userId
    );

    let l1Rejected = false;
    try {
      await defaultInvoiceService.postInvoice(companyAId, rejectDraft.id, userId);
    } catch (err) {
      if (err instanceof ValidationError) l1Rejected = true;
    }

    const invAfterRej = await defaultInvoiceService.getInvoice(companyAId, rejectDraft.id);
    const jeRejRes = await withTenantTransaction(companyAId, async (tx) =>
      tx.query(
        `SELECT id FROM journal_entries WHERE company_id = $1 AND memo LIKE $2`,
        [companyAId, `%${rejectDraft.supplierInvoiceNo}%`]
      )
    );

    await check(
      'L1 REJECT: Invoice with 10% price variance is rejected by postInvoice, remains draft, and has zero journal entries',
      l1Rejected && invAfterRej.status === 'draft' && jeRejRes.rows.length === 0
    );

    // Create draft invoice 1 (partial: qty=4, unitCost=100)
    const partialDraft1 = await defaultInvoiceService.createInvoice(
      companyAId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `INV-PART-1-${unique}`,
        lines: [{ grnLineId, qty: 4, unitCost: 100 }],
      },
      userId
    );

    // Create draft invoice 2 (partial: qty=6, unitCost=104 within 5% tolerance)
    const partialDraft2 = await defaultInvoiceService.createInvoice(
      companyAId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `INV-PART-2-${unique}`,
        lines: [{ grnLineId, qty: 6, unitCost: 104 }],
      },
      userId
    );

    // L4 scenario order (mandatory):
    // BEFORE posting partial1 and partial2:
    // Create draft invoice3 (qty=2) valid against remaining at create time (10 remaining)
    const overDraft = await defaultInvoiceService.createInvoice(
      companyAId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `INV-OVER-${unique}`,
        lines: [{ grnLineId, qty: 2, unitCost: 100 }],
      },
      userId
    );

    // L2 ACCEPT partial invoice 1 (qty=4 of 10, unitCost=100) -> status=posted, JE exists and is posted
    const postedPart1 = await defaultInvoiceService.postInvoice(companyAId, partialDraft1.id, userId);
    const jePart1Res = await withTenantTransaction(companyAId, async (tx) =>
      tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM journal_entries WHERE company_id = $1 AND id = $2`,
        [companyAId, postedPart1.journalEntryId]
      )
    );
    await check(
      'L2 ACCEPT partial: Invoice 1 with partial qty (4 of 10) posts successfully and creates posted journal entry',
      postedPart1.status === 'posted' && jePart1Res.rows.length === 1 && jePart1Res.rows[0].status === 'posted'
    );

    // L3 ACCEPT completing remaining (qty=6 of 10 remaining, unitCost=104 within 5% tolerance) -> status=posted
    const postedPart2 = await defaultInvoiceService.postInvoice(companyAId, partialDraft2.id, userId);
    const jePart2Res = await withTenantTransaction(companyAId, async (tx) =>
      tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM journal_entries WHERE company_id = $1 AND id = $2`,
        [companyAId, postedPart2.journalEntryId]
      )
    );
    await check(
      'L3 ACCEPT completing: Invoice 2 completing remaining qty (6 of 10) at +4% cost posts successfully',
      postedPart2.status === 'posted' && jePart2Res.rows.length === 1 && jePart2Res.rows[0].status === 'posted'
    );

    // L4 REJECT over remaining: Post invoice 3 (qty=2 when remaining=0) -> throws ValidationError, remains draft, zero JE
    let l4Rejected = false;
    try {
      await defaultInvoiceService.postInvoice(companyAId, overDraft.id, userId);
    } catch (err) {
      if (err instanceof ValidationError) l4Rejected = true;
    }
    const invAfterOver = await defaultInvoiceService.getInvoice(companyAId, overDraft.id);
    const jeOverRes = await withTenantTransaction(companyAId, async (tx) =>
      tx.query(
        `SELECT id FROM journal_entries WHERE company_id = $1 AND memo LIKE $2`,
        [companyAId, `%${overDraft.supplierInvoiceNo}%`]
      )
    );

    const postedQtyRes = await withTenantTransaction(companyAId, async (tx) =>
      tx.query<{ posted_qty: string | number }>(
        `SELECT COALESCE(SUM(sil.qty), 0) AS posted_qty
         FROM purch_supplier_invoice_lines sil
         INNER JOIN purch_supplier_invoices si
           ON si.id = sil.invoice_id
          AND si.company_id = sil.company_id
         WHERE sil.company_id = $1
           AND si.company_id = $1
           AND sil.grn_line_id = $2
           AND si.status = 'posted'`,
        [companyAId, grnLineId]
      )
    );
    const postedQty = Number(postedQtyRes.rows[0]?.posted_qty ?? 0);

    await check(
      'L4 REJECT over remaining: Invoice 3 exceeding remaining GRN qty is rejected, remains draft, and has zero journal entries and posted_qty=10',
      l4Rejected &&
        invAfterOver.status === 'draft' &&
        !invAfterOver.journalEntryId &&
        jeOverRes.rows.length === 0 &&
        postedQty === 10
    );

    console.log('PASS: verifyPurch3WayPostGate1 completed successfully.');
  } finally {
    const adminPoolUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (adminPoolUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(adminPoolUrl, process.env));
      let triggersDisabled = false;
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines DISABLE TRIGGER trg_journal_lines_immutability');
        triggersDisabled = true;

        await client.query('DELETE FROM purch_supplier_invoice_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_supplier_invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_grn_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_grn WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_suppliers WHERE company_id = ANY($1::uuid[])', [companyIds]);
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
        await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        triggersDisabled = false;
        await client.query('COMMIT');
      } catch (e) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('[cleanup] error during cleanup transaction:', e);
      } finally {
        if (triggersDisabled) {
          try {
            await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
            await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
            await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
            console.log('[cleanup] Restored immutability triggers on maintenance connection in finally block.');
          } catch (enableErr) {
            cleanupFailed = true;
            console.error('[cleanup] FATAL: Failed to re-enable triggers in finally block:', enableErr);
          }
        }
        await client.end();
      }
    }
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  if (cleanupFailed) {
    console.error('[cleanup] Cleanup failed. Treating test as failure.');
    process.exit(1);
  }
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
