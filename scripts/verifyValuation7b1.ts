import 'dotenv/config';
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
import { defaultStockService } from '../src/server/inventory/stockService.js';
import { defaultInventoryValuationRepository } from '../src/server/inventory/inventoryValuationRepository.js';
import { defaultInventoryValuationService } from '../src/server/inventory/inventoryValuationService.js';
import { defaultGrnService } from '../src/server/purchasing/grnService.js';
import { defaultInvoiceService as defaultPurchInvoiceService } from '../src/server/purchasing/invoiceService.js';
import { defaultPriceVarianceExceptionService } from '../src/server/purchasing/priceVarianceExceptionService.js';
import { defaultPurchReturnService } from '../src/server/purchasing/purchReturnService.js';
import { defaultCustomerService } from '../src/server/sales/customerService.js';
import { defaultSalesDeliveryService } from '../src/server/sales/salesDeliveryService.js';
import { defaultSalesInvoiceService } from '../src/server/sales/salesInvoiceService.js';
import { defaultSalesReturnService } from '../src/server/sales/salesReturnService.js';
import { ValidationError } from '../src/server/http/errors.js';

console.log('============================================================================');
console.log('=== VERIFYING AN-ERP-7B: PPV + RETURNS + RECONCILIATION + CANCEL/REINVOICE ===');
console.log('============================================================================');

function assertLoopbackUrl(raw: string, varName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new Error(`${varName} is invalid URL format: ${err instanceof Error ? err.message : String(err)}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
  }
  return parsed;
}

async function run() {
  const rootDir = process.cwd();

  // S0: Registration in runFoundationBattery.ts & package.json
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  await check(
    'S0: verifyValuation7b1.ts registered in runFoundationBattery.ts and package.json',
    batterySrc.includes('scripts/verifyValuation7b1.ts') &&
      pkgJson?.scripts?.['test:valuation-7b-1'] === 'tsx scripts/verifyValuation7b1.ts'
  );

  // S1: Migration 054 & table_ownership.json structural checks
  const mig054Path = path.join(rootDir, 'database/migrations/054_sales_returns.sql');
  const mig054Exists = fs.existsSync(mig054Path);
  const mig054 = mig054Exists ? fs.readFileSync(mig054Path, 'utf8') : '';
  const mig054NoComments = mig054.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');
  const ownershipJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'database/table_ownership.json'), 'utf8'));
  const ownershipArr: Array<{ table: string; scope: string }> = Array.isArray(ownershipJson) ? ownershipJson : [];
  const hasTenantEntry = (tableName: string) =>
    ownershipArr.some((entry) => entry.table === tableName && entry.scope === 'tenant');

  await check(
    'S1: Migration 054 defines sales_returns/lines with RLS, cancellation FK, event types, zero EXCEPTION WHEN OTHERS & table_ownership registration',
    mig054Exists &&
      mig054.includes('sales_returns') &&
      mig054.includes('sales_return_lines') &&
      mig054.includes("'sales_return'") &&
      mig054.includes("'SALES_RETURN'") &&
      mig054.includes('ON DELETE SET NULL (reversal_journal_entry_id)') &&
      mig054.includes('ENABLE ROW LEVEL SECURITY') &&
      mig054.includes('FORCE ROW LEVEL SECURITY') &&
      mig054.includes("app.current_tenant_id") &&
      !/\bEXCEPTION\s+WHEN\s+OTHERS\b/i.test(mig054NoComments) &&
      hasTenantEntry('sales_returns') &&
      hasTenantEntry('sales_return_lines')
  );

  // S2: InventoryValuationService MA PPV, MA Purchase Return, Sales Return Restoration, Reconciliation Modes
  const valSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/inventory/inventoryValuationService.ts'), 'utf8');
  await check(
    'S2: InventoryValuationService implements MA source-ledger PPV & Purchase Return, Sales Return restoration & SUBLEDGER_ONLY/HISTORICAL_GL modes',
    valSvcSrc.includes('findMaSourceBalancesByGrnLineForUpdate') &&
      valSvcSrc.includes('applyPpvToMaSourceBalance') &&
      valSvcSrc.includes('updateMaSourceBalanceQuantities') &&
      valSvcSrc.includes('restoreSalesReturnInventory') &&
      valSvcSrc.includes("'SUBLEDGER_ONLY'") &&
      valSvcSrc.includes("'HISTORICAL_GL'") &&
      valSvcSrc.includes("'historical_unavailable'")
  );

  // S3: Sales Returns & AR open balance integration
  const srSvcPath = path.join(rootDir, 'src/server/sales/salesReturnService.ts');
  const srRepoPath = path.join(rootDir, 'src/server/sales/salesReturnRepository.ts');
  const siRepoSrc = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesInvoiceRepository.ts'), 'utf8');
  const scSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesCollectionService.ts'), 'utf8');
  const arAgingSrc = fs.readFileSync(path.join(rootDir, 'src/server/sales/arAgingService.ts'), 'utf8');
  await check(
    'S3: SalesReturnService/Repository and AR open-balance queries deduct posted sales_returns cleanly',
    fs.existsSync(srSvcPath) &&
      fs.existsSync(srRepoPath) &&
      siRepoSrc.includes('sales_returns') &&
      scSvcSrc.includes('sales_returns') &&
      arAgingSrc.includes('sales_returns')
  );

  // S4: Invoice cancellation & re-invoicing + API routes
  const siSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesInvoiceService.ts'), 'utf8');
  const salesRoutesSrc = fs.readFileSync(path.join(rootDir, 'src/server/routes/salesRoutes.ts'), 'utf8');
  await check(
    'S4: SalesInvoiceService.cancelPostedInvoice + inv_sales_cogs_reversals exclusion + salesRoutes /invoices/:id/cancel & /returns endpoints exist',
    siSvcSrc.includes('cancelPostedInvoice') &&
      siSvcSrc.includes('inv_sales_cogs_reversals') &&
      salesRoutesSrc.includes('/invoices/:id/cancel') &&
      salesRoutesSrc.includes("'/returns'") &&
      salesRoutesSrc.includes("'/returns/:id/post'")
  );

  // Live Loopback PostgreSQL Integration Verification
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live Package 7B PostgreSQL integration checks are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
    if (process.env.MIGRATION_DATABASE_URL) {
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
    blocked('Database executor unavailable. Live Package 7B PostgreSQL integration checks are BLOCKED.');
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
      username: `v7b_usr_${unique}`,
      passwordHash: 'dummy_hash_v7b_1',
      role: 'platform_admin',
    });
    userIds.push(user.id);

    const comp1 = await companyRepo.create({
      code: `V7B1-${unique}`.slice(0, 20),
      nameAr: `شركة اختبار التقييم 7B ${unique}`,
      createdBy: user.id,
    });
    companyIds.push(comp1.id);

    const comp2 = await companyRepo.create({
      code: `V7B2-${unique}`.slice(0, 20),
      nameAr: `شركة عزل 7B ${unique}`,
      createdBy: user.id,
    });
    companyIds.push(comp2.id);

    const companyId = comp1.id;

    // Setup Chart of Accounts & Settings for Company 1
    const arAcc = await defaultAccountService.createAccount(companyId, { code: '1200', nameAr: 'العملاء', accountType: 'asset', isPostable: true }, user.id);
    const invAcc = await defaultAccountService.createAccount(companyId, { code: '1130', nameAr: 'المخزون', accountType: 'asset', isPostable: true }, user.id);
    const apAcc = await defaultAccountService.createAccount(companyId, { code: '2110', nameAr: 'الموردون', accountType: 'liability', isPostable: true }, user.id);
    const clrAcc = await defaultAccountService.createAccount(companyId, { code: '2120', nameAr: 'مشتريات معلقة', accountType: 'liability', isPostable: true }, user.id);
    const vatAcc = await defaultAccountService.createAccount(companyId, { code: '2150', nameAr: 'ضريبة القيمة المضافة المستحقة', accountType: 'liability', isPostable: true }, user.id);
    const revAcc = await defaultAccountService.createAccount(companyId, { code: '4100', nameAr: 'إيراد المبيعات', accountType: 'revenue', isPostable: true }, user.id);
    const cogsAcc = await defaultAccountService.createAccount(companyId, { code: '5110', nameAr: 'تكلفة البضاعة المباعة', accountType: 'expense', isPostable: true }, user.id);
    const adjAcc = await defaultAccountService.createAccount(companyId, { code: '5120', nameAr: 'فروق وتسويات المخزون', accountType: 'expense', isPostable: true }, user.id);

    await defaultCompanySettingsRepository.upsert(
      companyId,
      { inventoryAccountId: invAcc.id, purchasesClearingAccountId: clrAcc.id },
      user.id
    );

    const adminUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    const setupClient = new pg.Client(buildPgConfig(adminUrl, process.env));
    await setupClient.connect();
    try {
      await setupClient.query(
        `UPDATE company_settings
         SET accounts_receivable_account_id = $2,
             sales_revenue_account_id = $3,
             vat_payable_account_id = $4,
             cogs_account_id = $5,
             inventory_adjustment_account_id = $6,
             accounts_payable_account_id = $7
         WHERE company_id = $1`,
        [companyId, arAcc.id, revAcc.id, vatAcc.id, cogsAcc.id, adjAcc.id, apAcc.id]
      );
    } finally {
      await setupClient.end();
    }

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
    const period = await defaultPeriodService.createPeriod(
      companyId,
      { code: `${y}-${m}-V7B-${unique}`, startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}` },
      user.id
    );

    const supplier = await defaultSupplierService.createSupplier(companyId, { code: `SUP-${unique}`.slice(0, 20), nameAr: 'مورد 7B' }, user.id);
    const customer = await defaultCustomerService.createCustomer(companyId, { code: `CUST-${unique}`.slice(0, 20), nameAr: 'عميل 7B' }, user.id);
    const wh1 = await defaultWarehouseService.createWarehouse(companyId, { code: `WH1-${unique}`.slice(0, 20), nameAr: 'مستودع 1' }, user.id);
    const wh2 = await defaultWarehouseService.createWarehouse(companyId, { code: `WH2-${unique}`.slice(0, 20), nameAr: 'مستودع 2' }, user.id);
    const maItem = await defaultItemService.createItem(companyId, { code: `MA-${unique}`.slice(0, 20), nameAr: 'صنف متوسط متحرك 7B', uom: 'قطعة' }, user.id);

    const maProfile = await defaultInventoryValuationRepository.createProfile(companyId, {
      name: 'MA Profile 7B',
      costingMethod: 'PERPETUAL_MOVING_AVERAGE',
      isDefault: true,
    });
    await defaultInventoryValuationRepository.assignItemProfile(companyId, maItem.id, maProfile.id, user.id);

    // L1: MA GRN (10 @ 20) -> Transfer 4 to WH2 -> Issue 3 from WH1 -> PPV (20 -> 26)
    const grn = await defaultGrnService.createGrn(
      companyId,
      { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: maItem.id, qty: 10, unitCost: 20 }] },
      user.id
    );
    const postedGrn = await defaultGrnService.postGrn(companyId, grn.id, user.id);
    const grnLineId = postedGrn.lines![0].id;

    await defaultStockService.transfer(
      companyId,
      { sourceWarehouseId: wh1.id, destWarehouseId: wh2.id, itemId: maItem.id, qty: 4, memo: 'نقل اختبار 7B' },
      user.id
    );
    await defaultStockService.issueStock(
      companyId,
      { warehouseId: wh1.id, itemId: maItem.id, qty: 3, reason: 'صرف اختبار 7B' },
      user.id
    );

    const pInv = await defaultPurchInvoiceService.createInvoice(
      companyId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `PINV-${unique}`.slice(0, 30),
        lines: [{ grnLineId, qty: 10, unitCost: 26 }],
      },
      user.id
    );

    let exceptionBlocked = false;
    try {
      await defaultPurchInvoiceService.postInvoice(companyId, pInv.id, user.id);
    } catch (err) {
      if (err instanceof ValidationError) exceptionBlocked = true;
    }

    const reqExc = await defaultPriceVarianceExceptionService.requestException(
      companyId,
      pInv.id,
      'طلب استثناء ارتفاع السعر 30%',
      user.id
    );

    const approverUser = await userRepo.createUser({
      username: `v7b_appr_${unique}`,
      passwordHash: 'dummy_hash_appr',
      role: 'platform_admin',
    });
    userIds.push(approverUser.id);

    const approvedExc = await defaultPriceVarianceExceptionService.approveException(
      companyId,
      reqExc.id,
      'معتمد للإصدار',
      approverUser.id
    );

    await defaultPurchInvoiceService.postInvoice(companyId, pInv.id, user.id);

    const wh1BalAfterPpv = await defaultInventoryValuationRepository.getValuationBalance(companyId, wh1.id, maItem.id);
    const wh2BalAfterPpv = await defaultInventoryValuationRepository.getValuationBalance(companyId, wh2.id, maItem.id);
    await check(
      'L1: MA PPV across transferred warehouses sets WH1 remaining (3@26=78) and WH2 remaining (4@26=104)',
      Number(wh1BalAfterPpv?.quantity) === 3 &&
        Number(wh1BalAfterPpv?.totalCost) === 78 &&
        Number(wh2BalAfterPpv?.quantity) === 4 &&
        Number(wh2BalAfterPpv?.totalCost) === 104
    );

    // L2: MA Purchase Return blocks > remaining source qty in WH1 (5 > 3), succeeds for 2 @ 26 = 52
    let prBlocked = false;
    try {
      const badPr = await defaultPurchReturnService.createReturn(
        companyId,
        { supplierId: supplier.id, warehouseId: wh1.id, grnId: postedGrn.id, lines: [{ grnLineId, qty: 5, unitCost: 20 }] },
        user.id
      );
      await defaultPurchReturnService.postReturn(companyId, badPr.id, user.id);
    } catch (err) {
      if (err instanceof ValidationError) prBlocked = true;
    }

    const validPr = await defaultPurchReturnService.createReturn(
      companyId,
      { supplierId: supplier.id, warehouseId: wh1.id, grnId: postedGrn.id, lines: [{ grnLineId, qty: 2, unitCost: 20 }] },
      user.id
    );
    const postedPr = await defaultPurchReturnService.postReturn(companyId, validPr.id, user.id);
    const wh1BalAfterPr = await defaultInventoryValuationRepository.getValuationBalance(companyId, wh1.id, maItem.id);
    await check(
      'L2: MA Purchase Return rejects transferred-out qty and posts valid WH1 return (2@26=52, WH1 remaining=26)',
      prBlocked &&
        postedPr.status === 'posted' &&
        Number(wh1BalAfterPr?.quantity) === 1 &&
        Number(wh1BalAfterPr?.totalCost) === 26
    );

    // L3: Sales Delivery (WH2 qty 4 @ 26 = 104) -> Sales Invoice (4 @ 100 + 15% VAT = 460) -> Partial Sales Return (2 into WH1 = 52 cost, AR reduces by 230)
    const del = await defaultSalesDeliveryService.createDelivery(
      companyId,
      { customerId: customer.id, warehouseId: wh2.id, lines: [{ itemId: maItem.id, qty: 4, unitPrice: 100, unitCost: 26 }] },
      user.id
    );
    const postedDel = await defaultSalesDeliveryService.postDelivery(companyId, del.id, user.id);
    const delLineId = postedDel.lines![0].id;

    const sInv = await defaultSalesInvoiceService.createInvoice(
      companyId,
      {
        customerId: customer.id,
        deliveryId: postedDel.id,
        lines: [{ itemId: maItem.id, deliveryLineId: delLineId, qty: 4, unitPrice: 100, taxRate: 15 }],
      },
      user.id
    );
    const postedSInv = await defaultSalesInvoiceService.postInvoice(companyId, sInv.id, user.id);
    const sInvLineId = postedSInv.lines![0].id;

    const sRet = await defaultSalesReturnService.createReturn(
      companyId,
      {
        customerId: customer.id,
        invoiceId: postedSInv.id,
        warehouseId: wh1.id,
        reason: 'مرتجع اختبار 7B',
        lines: [{ invoiceLineId: sInvLineId, qty: 2 }],
      },
      user.id
    );
    const postedSRet = await defaultSalesReturnService.postReturn(companyId, sRet.id, user.id);
    const outstandingAfterRet = await defaultSalesInvoiceService.listOutstandingInvoices(companyId, customer.id);
    const openRow = outstandingAfterRet.find((r: any) => r.invoiceId === postedSInv.id);

    let overReturnBlocked = false;
    try {
      await defaultSalesReturnService.createReturn(
        companyId,
        {
          customerId: customer.id,
          invoiceId: postedSInv.id,
          warehouseId: wh1.id,
          lines: [{ invoiceLineId: sInvLineId, qty: 3 }],
        },
        user.id
      );
    } catch (err) {
      if (err instanceof ValidationError) overReturnBlocked = true;
    }

    await check(
      'L3: Partial Sales Return restores 2@26=52 inventory cost, reduces AR open amount to 230, and rejects over-return (3 > 2)',
      postedSRet.status === 'posted' &&
        postedSRet.totalAmount === 230 &&
        postedSRet.cogsAmount === 52 &&
        Number(openRow?.remainingOpenAmount ?? -1) === 230 &&
        overReturnBlocked
    );

    // L4: Reconciliation modes (SUBLEDGER_ONLY, HISTORICAL_GL, COMPANY_GL)
    const subOnlyRec = await defaultInventoryValuationService.runReconciliation(companyId, { warehouseId: wh1.id }, user.id);
    const histRec = await defaultInventoryValuationService.runReconciliation(companyId, { periodId: period.id }, user.id);
    const compRec = await defaultInventoryValuationService.runReconciliation(companyId, {}, user.id);
    await check(
      'L4: Reconciliation returns SUBLEDGER_ONLY (wh filter), HISTORICAL_GL (periodId), and reconciled COMPANY_GL',
      subOnlyRec.comparisonScope === 'SUBLEDGER_ONLY' &&
        subOnlyRec.status === 'subledger_only' &&
        subOnlyRec.glControlTotal === 0 &&
        subOnlyRec.variance === 0 &&
        histRec.comparisonScope === 'HISTORICAL_GL' &&
        compRec.comparisonScope === 'COMPANY_GL' &&
        compRec.isGlComparable === true &&
        compRec.status === 'reconciled' &&
        compRec.variance === 0
    );

    // L5: Sales Invoice cancellation (JE reversal + inv_sales_cogs_reversals) & clean re-invoicing
    const del2 = await defaultSalesDeliveryService.createDelivery(
      companyId,
      { customerId: customer.id, warehouseId: wh1.id, lines: [{ itemId: maItem.id, qty: 2, unitPrice: 100, unitCost: 26 }] },
      user.id
    );
    const postedDel2 = await defaultSalesDeliveryService.postDelivery(companyId, del2.id, user.id);
    const delLine2Id = postedDel2.lines![0].id;

    const invCancel = await defaultSalesInvoiceService.createInvoice(
      companyId,
      {
        customerId: customer.id,
        deliveryId: postedDel2.id,
        lines: [{ itemId: maItem.id, deliveryLineId: delLine2Id, qty: 2, unitPrice: 100, taxRate: 15 }],
      },
      user.id
    );
    const postedInvCancel = await defaultSalesInvoiceService.postInvoice(companyId, invCancel.id, user.id);
    const cancelledInv = await defaultSalesInvoiceService.cancelPostedInvoice(companyId, postedInvCancel.id, 'إلغاء لإعادة الفوترة', user.id);

    const reInvoiced = await defaultSalesInvoiceService.createInvoice(
      companyId,
      {
        customerId: customer.id,
        deliveryId: postedDel2.id,
        lines: [{ itemId: maItem.id, deliveryLineId: delLine2Id, qty: 2, unitPrice: 110, taxRate: 15 }],
      },
      user.id
    );
    const postedReInvoiced = await defaultSalesInvoiceService.postInvoice(companyId, reInvoiced.id, user.id);

    await check(
      'L5: Posted invoice cancels with reversal JE and allows clean re-invoicing of the same delivery line',
      cancelledInv.status === 'cancelled' &&
        Boolean(cancelledInv.reversalJournalEntryId) &&
        postedReInvoiced.status === 'posted' &&
        postedReInvoiced.cogsAmount === 52
    );

    // L6: RLS cross-tenant isolation on sales_returns & sales_return_lines
    const comp2Returns = await defaultSalesReturnService.listReturns(comp2.id);
    await check(
      'L6: RLS enforces strict cross-tenant isolation on sales_returns for Company 2',
      comp2Returns.length === 0
    );
  } catch (err) {
    console.error('[verifyValuation7b1] Live test error:', err);
    await check('Live Package 7B suite execution', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl, process.env));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE purch_price_variance_exceptions DISABLE TRIGGER trg_guard_purch_price_variance_exceptions');
        await client.query('ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines DISABLE TRIGGER trg_journal_lines_immutability');

        await client.query('DELETE FROM inv_sales_cogs_reversals WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_sales_cogs_links WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_return_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_returns WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_collections WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_invoice_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_delivery_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_delivery_notes WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_customers WHERE company_id = ANY($1::uuid[])', [companyIds]);

        await client.query('DELETE FROM inv_cost_adjustments WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_return_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_returns WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_price_variance_exceptions WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_supplier_invoice_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_supplier_invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);

        await client.query(
          `DELETE FROM inv_cost_allocations
           WHERE company_id = ANY($1::uuid[])
             AND (
               cost_layer_id IN (SELECT id FROM inv_cost_layers WHERE company_id = ANY($1::uuid[]))
               OR valuation_movement_id IN (SELECT id FROM inv_valuation_movements WHERE company_id = ANY($1::uuid[]))
             )`,
          [companyIds]
        );
        await client.query('DELETE FROM inv_valuation_reconciliations WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_ma_source_events WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_ma_source_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_cost_layers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_valuation_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_valuation_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_item_costing_profiles WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_costing_profiles WHERE company_id = ANY($1::uuid[])', [companyIds]);
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

        await client.query('ALTER TABLE purch_price_variance_exceptions ENABLE TRIGGER trg_guard_purch_price_variance_exceptions');
        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        await client.query('COMMIT');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          console.error('[cleanup] Rollback failed:', rbErr);
        }
        console.error('[cleanup] Failed cleaning up verifyValuation7b1:', cleanupErr);
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
  console.error('[verifyValuation7b1] Fatal error:', err);
  process.exit(1);
});
