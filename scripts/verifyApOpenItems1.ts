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
import { defaultPurchReturnService } from '../src/server/purchasing/purchReturnService.js';
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';
import { defaultSupplierPaymentService } from '../src/server/purchasing/supplierPaymentService.js';
import {
  computeApOpenAmounts,
  defaultApOpenItemsService,
} from '../src/server/purchasing/apOpenItemsService.js';
import { ensureTestCostingProfile } from './helpers/ensureTestCostingProfile.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-INT-PURCH-1 WP-C: AP Open Items (Posted-Only)       ===');
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

  // S0: Registration check
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  await check(
    'S0: verifyApOpenItems1.ts registered in runFoundationBattery.ts and package.json',
    batterySrc.includes('scripts/verifyApOpenItems1.ts') &&
      pkgJson?.scripts?.['test:ap-open-items-1'] === 'tsx scripts/verifyApOpenItems1.ts'
  );

  // S1: SQL posted-only filter check
  const apSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/apOpenItemsService.ts'), 'utf8');
  await check(
    'S1: apOpenItemsService enforces status = posted across invoices, returns, and payments',
    apSrc.includes("si.status = 'posted'") &&
      apSrc.includes("pr.status = 'posted'") &&
      apSrc.includes("status = 'posted'")
  );

  // S2: Numeric minor-unit arithmetic checks
  const aPartial = computeApOpenAmounts('1500.00', '300.00', '700.00');
  const aDecimal = computeApOpenAmounts('100.10', '33.03', '67.07');
  const aClamp = computeApOpenAmounts('100.00', '60.00', '50.00');
  await check(
    'S2: computeApOpenAmounts computes exact minor-unit balances and clamps negative to 0',
    aPartial.remainingOpenAmount === 500 &&
      aPartial.paymentStatus === 'partial' &&
      aDecimal.remainingOpenAmount === 0 &&
      aDecimal.paymentStatus === 'paid' &&
      aClamp.remainingOpenAmount === 0 &&
      aClamp.paymentStatus === 'paid'
  );

  // Live DB verification
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live AP open items verification is BLOCKED.');
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
    blocked('Unable to connect to database executor. Live AP open items verification is BLOCKED.');
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
      username: `ap_usr_a_${unique}`,
      passwordHash: 'dummy_hash_ap_1',
      role: 'platform_admin',
    });
    userIds.push(userA.id);

    const compA = await companyRepo.create({
      code: `APA-${unique}`.slice(0, 20),
      nameAr: `شركة اختبار المستحقات المفتوحة ${unique}`,
      createdBy: userA.id,
    });
    const compB = await companyRepo.create({
      code: `APB-${unique}`.slice(0, 20),
      nameAr: `شركة عزل المستحقات ب ${unique}`,
      createdBy: userA.id,
    });
    companyIds.push(compA.id, compB.id);

    const companyAId = compA.id;
    const companyBId = compB.id;
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
    const cashAcc = await defaultAccountService.createAccount(
      companyAId,
      { code: `CSH-${unique}`.slice(0, 20), nameAr: 'الصندوق الرئيسي', accountType: 'asset', isPostable: true },
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
      { code: `${y}-${m}-AP-${unique}`, startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}` },
      userId
    );

    const eqAcc = await defaultAccountService.createAccount(
      companyAId,
      { code: `EQ-${unique}`.slice(0, 20), nameAr: 'رأس المال', accountType: 'equity', isPostable: true },
      userId
    );
    const cashReg = await defaultCashRegisterService.createRegister(
      companyAId,
      { code: `REG-${unique}`.slice(0, 20), nameAr: 'صندوق المدفوعات', glAccountId: cashAcc.id, openingBalance: 5000, openingOffsetAccountId: eqAcc.id },
      userId
    );

    const supplier = await defaultSupplierService.createSupplier(
      companyAId,
      { code: `SUP-${unique}`.slice(0, 20), nameAr: 'مورد المستحقات' },
      userId
    );
    const warehouse = await defaultWarehouseService.createWarehouse(
      companyAId,
      { code: `WH-${unique}`.slice(0, 20), nameAr: 'مستودع المستحقات' },
      userId
    );
    const item = await defaultItemService.createItem(
      companyAId,
      { code: `ITM-${unique}`.slice(0, 20), nameAr: 'صنف مستحقات', uom: 'وحدة' },
      userId
    );
    await ensureTestCostingProfile(companyAId, [item.id], userId);

    // A1: Posted GRN WITHOUT invoice -> must NOT appear in AP open items
    const grn = await defaultGrnService.createGrn(
      companyAId,
      { supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ itemId: item.id, qty: 10, unitCost: 100 }] },
      userId
    );
    await defaultGrnService.postGrn(companyAId, grn.id, userId);
    const postedGrn = await defaultGrnService.getGrn(companyAId, grn.id);
    const grnLineId = postedGrn.lines![0].id;

    const apAfterGrnOnly = await defaultApOpenItemsService.listOpenItems(companyAId, supplier.id);
    await check(
      'A1: Un-invoiced posted GRN does NOT appear in AP open items',
      apAfterGrnOnly.length === 0
    );

    // A2: Draft invoice -> still must NOT appear in AP open items
    const invDraft = await defaultInvoiceService.createInvoice(
      companyAId,
      { supplierId: supplier.id, supplierInvoiceNo: `AP-INV-${unique}`, lines: [{ grnLineId, qty: 10, unitCost: 100 }] },
      userId
    );
    const apAfterDraftInv = await defaultApOpenItemsService.listOpenItems(companyAId, supplier.id);
    await check(
      'A2: Draft supplier invoice does NOT appear in AP open items',
      apAfterDraftInv.length === 0
    );

    // A3: Post invoice (1000) -> openAmount = 1000, status = 'open'
    const postedInv = await defaultInvoiceService.postInvoice(companyAId, invDraft.id, userId);
    const apAfterPost = await defaultApOpenItemsService.listOpenItems(companyAId, supplier.id);
    await check(
      'A3: Posted supplier invoice appears with remainingOpenAmount=1000 and status=open',
      apAfterPost.length === 1 &&
        apAfterPost[0].invoiceId === postedInv.id &&
        apAfterPost[0].invoiceTotal === 1000 &&
        apAfterPost[0].remainingOpenAmount === 1000 &&
        apAfterPost[0].paymentStatus === 'open'
    );

    // A4: Draft return (200) and Draft payment (300) MUST NOT reduce AP open amount
    const retDraft = await defaultPurchReturnService.createReturn(
      companyAId,
      {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        grnId: grn.id,
        invoiceId: postedInv.id,
        lines: [{ grnLineId, qty: 2, unitCost: 100 }],
      },
      userId
    );
    const payDraft = await defaultSupplierPaymentService.createPayment(
      companyAId,
      { supplierId: supplier.id, invoiceId: postedInv.id, registerId: cashReg.id, amount: 300 },
      userId
    );
    const apWithDrafts = await defaultApOpenItemsService.listOpenItems(companyAId, supplier.id);
    await check(
      'A4: Draft return and draft payment do NOT reduce AP open amount (still 1000, status=open)',
      apWithDrafts.length === 1 &&
        apWithDrafts[0].creditedReturnTotal === 0 &&
        apWithDrafts[0].paidPaymentTotal === 0 &&
        apWithDrafts[0].remainingOpenAmount === 1000 &&
        apWithDrafts[0].paymentStatus === 'open'
    );

    // A5: Post return (200) -> creditedReturnTotal=200, remainingOpenAmount=800, status='partial'
    await defaultPurchReturnService.postReturn(companyAId, retDraft.id, userId);
    const apAfterRet = await defaultApOpenItemsService.listOpenItems(companyAId, supplier.id);
    await check(
      'A5: Posting purchase return reduces AP open amount to 800 (credited=200, status=partial)',
      apAfterRet.length === 1 &&
        apAfterRet[0].creditedReturnTotal === 200 &&
        apAfterRet[0].paidPaymentTotal === 0 &&
        apAfterRet[0].remainingOpenAmount === 800 &&
        apAfterRet[0].paymentStatus === 'partial'
    );

    // A6: Post payment 1 (300) -> remaining=500; post payment 2 (500) -> remaining=0, status='paid'
    await defaultSupplierPaymentService.postPayment(companyAId, payDraft.id, userId);
    const apAfterPay1 = await defaultApOpenItemsService.listOpenItems(companyAId, supplier.id);

    const pay2Draft = await defaultSupplierPaymentService.createPayment(
      companyAId,
      { supplierId: supplier.id, invoiceId: postedInv.id, registerId: cashReg.id, amount: 500 },
      userId
    );
    await defaultSupplierPaymentService.postPayment(companyAId, pay2Draft.id, userId);
    const apAfterPay2 = await defaultApOpenItemsService.listOpenItems(companyAId, supplier.id);

    await check(
      'A6: Posting payments drops remainingOpenAmount to 500 (partial) and then 0 (paid)',
      apAfterPay1.length === 1 &&
        apAfterPay1[0].paidPaymentTotal === 300 &&
        apAfterPay1[0].remainingOpenAmount === 500 &&
        apAfterPay1[0].paymentStatus === 'partial' &&
        apAfterPay2.length === 1 &&
        apAfterPay2[0].paidPaymentTotal === 800 &&
        apAfterPay2[0].remainingOpenAmount === 0 &&
        apAfterPay2[0].paymentStatus === 'paid'
    );

    // A7: Tenant isolation
    const apCompanyB = await defaultApOpenItemsService.listOpenItems(companyBId);
    await check('A7: Cross-tenant listOpenItems returns empty for Company B', apCompanyB.length === 0);
  } catch (err) {
    console.error('[verifyApOpenItems1] Fatal test error:', err);
    await check('Live AP open items suite execution', false, err instanceof Error ? err.message : String(err));
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

        await client.query(
          `DELETE FROM inv_cost_allocations
           WHERE company_id = ANY($1::uuid[])
             AND (
               cost_layer_id IN (SELECT id FROM inv_cost_layers WHERE company_id = ANY($1::uuid[]))
               OR valuation_movement_id IN (SELECT id FROM inv_valuation_movements WHERE company_id = ANY($1::uuid[]))
             )`,
          [companyIds]
        );
        await client.query('DELETE FROM inv_cost_adjustments WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_ma_source_events WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_ma_source_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_cost_layers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_valuation_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_valuation_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_item_costing_profiles WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_costing_profiles WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_supplier_payments WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_return_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_returns WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_supplier_invoice_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_supplier_invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_grn_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_grn WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM cash_registers WHERE company_id = ANY($1::uuid[])', [companyIds]);
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
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('[cleanup] Failed cleaning up verifyApOpenItems1:', cleanupErr);
      } finally {
        await client.end();
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

run().catch((err) => {
  console.error('[verifyApOpenItems1] Fatal error:', err);
  process.exit(1);
});
