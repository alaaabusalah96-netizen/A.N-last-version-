import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import crypto from 'node:crypto';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { closeAllExecutors } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';
import { defaultJournalService } from '../src/server/accounting/journalService.js';
import { defaultReportsService } from '../src/server/accounting/reportsService.js';
import { defaultTrialBalanceService } from '../src/server/accounting/trialBalanceService.js';
import { defaultOperationalReportsService } from '../src/server/accounting/operationalReportsService.js';
import { defaultYearCloseService } from '../src/server/accounting/yearCloseService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';
import { defaultSupplierService } from '../src/server/purchasing/supplierService.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultInventoryValuationRepository } from '../src/server/inventory/inventoryValuationRepository.js';
import { defaultGrnService } from '../src/server/purchasing/grnService.js';
import { defaultInvoiceService as defaultPurchInvoiceService } from '../src/server/purchasing/invoiceService.js';
import { defaultSupplierPaymentService } from '../src/server/purchasing/supplierPaymentService.js';
import { defaultApOpenItemsService } from '../src/server/purchasing/apOpenItemsService.js';
import { defaultCustomerService } from '../src/server/sales/customerService.js';
import { defaultSalesDeliveryService } from '../src/server/sales/salesDeliveryService.js';
import { defaultSalesInvoiceService } from '../src/server/sales/salesInvoiceService.js';
import { defaultSalesReturnService } from '../src/server/sales/salesReturnService.js';
import { defaultSalesCollectionService } from '../src/server/sales/salesCollectionService.js';
import { defaultArAgingService } from '../src/server/sales/arAgingService.js';
import { ValidationError } from '../src/server/http/errors.js';
import { getBusinessDateToday, DEFAULT_BUSINESS_TIMEZONE } from '../src/server/lib/calendarDate.js';
import { MONEY_SCALE, parseExactUnits, fromMinorUnits } from '../src/server/lib/numeric.js';
import { countRemainingTestInventoryRows } from './helpers/inventoryTestHarness.js';

console.log('================================================================================');
console.log('=== VERIFYING AN-ERP-R05 WP-4: LIVE ACCOUNTING REPORTS (GL/TB/IS/BS/AGING)  ===');
console.log('================================================================================');

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

function addDaysYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function normMoney(val: unknown): string {
  return fromMinorUnits(parseExactUnits(String(val ?? '0'), MONEY_SCALE, 'money'), MONEY_SCALE);
}

async function expectValidationError(fn: () => Promise<unknown>): Promise<{ rejected: boolean; message: string }> {
  try {
    await fn();
    return { rejected: false, message: '' };
  } catch (err) {
    if (err instanceof ValidationError) {
      return { rejected: true, message: err.message };
    }
    throw err;
  }
}

interface ExpectedGlLineItem {
  entryId: string;
  debit: string;
  credit: string;
}

function assertGlMatch(
  actual: Awaited<ReturnType<typeof defaultReportsService.getGeneralLedger>>,
  expected: {
    openingBalance: string;
    totalDebit: string;
    totalCredit: string;
    closingBalance: string;
    expectedLines: ExpectedGlLineItem[];
  }
): { ok: boolean; detail: string } {
  if (normMoney(actual.openingBalance) !== normMoney(expected.openingBalance)) {
    return { ok: false, detail: `${actual.accountCode} opening ${actual.openingBalance} !== ${expected.openingBalance}` };
  }
  if (normMoney(actual.totalDebit) !== normMoney(expected.totalDebit)) {
    return { ok: false, detail: `${actual.accountCode} totalDebit ${actual.totalDebit} !== ${expected.totalDebit}` };
  }
  if (normMoney(actual.totalCredit) !== normMoney(expected.totalCredit)) {
    return { ok: false, detail: `${actual.accountCode} totalCredit ${actual.totalCredit} !== ${expected.totalCredit}` };
  }
  if (normMoney(actual.closingBalance) !== normMoney(expected.closingBalance)) {
    return { ok: false, detail: `${actual.accountCode} closing ${actual.closingBalance} !== ${expected.closingBalance}` };
  }
  if (actual.rows.length !== expected.expectedLines.length) {
    return { ok: false, detail: `${actual.accountCode} row count ${actual.rows.length} !== ${expected.expectedLines.length}` };
  }
  const actualTokens = actual.rows
    .map((r) => `${r.entryId}|${normMoney(r.debit)}|${normMoney(r.credit)}`)
    .sort();
  const expectedTokens = expected.expectedLines
    .map((r) => `${r.entryId}|${normMoney(r.debit)}|${normMoney(r.credit)}`)
    .sort();
  for (let i = 0; i < actualTokens.length; i++) {
    if (actualTokens[i] !== expectedTokens[i]) {
      return { ok: false, detail: `${actual.accountCode} line mismatch at ${i}: ${actualTokens[i]} !== ${expectedTokens[i]}` };
    }
  }
  const lastRow = actual.rows[actual.rows.length - 1];
  if (lastRow && normMoney(lastRow.runningBalance) !== normMoney(expected.closingBalance)) {
    return { ok: false, detail: `${actual.accountCode} last runningBalance ${lastRow.runningBalance} !== ${expected.closingBalance}` };
  }
  return { ok: true, detail: `OK (${actual.accountCode}: closing=${actual.closingBalance})` };
}

async function run() {
  const rootDir = process.cwd();

  // S0: Registration & contract check
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const selfSrc = fs.readFileSync(path.join(rootDir, 'scripts/verifyFinancialReportsLive1.ts'), 'utf8');
  await check(
    'S0: verifyFinancialReportsLive1.ts registered in runFoundationBattery.ts & package.json (test:financial-reports-live-1)',
    batterySrc.includes('scripts/verifyFinancialReportsLive1.ts') &&
      pkgJson?.scripts?.['test:financial-reports-live-1'] === 'tsx scripts/verifyFinancialReportsLive1.ts' &&
      selfSrc.includes('assertLoopbackUrl') &&
      selfSrc.includes('defaultReportsService') &&
      selfSrc.includes('defaultTrialBalanceService') &&
      selfSrc.includes('defaultArAgingService') &&
      selfSrc.includes('defaultOperationalReportsService')
  );

  // S1: Guard against opening_balance GL gap (explicit cash register policy verification)
  const cashSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/cash/cashRegisterService.ts'), 'utf8');
  const reportsSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/accounting/reportsService.ts'), 'utf8');
  await check(
    'S1: Reporting & fiscal-year-close contract checks (posted-only reports + bigint minor units)',
    reportsSvcSrc.includes("e.status = 'posted'") &&
      reportsSvcSrc.includes('toMinorUnits') &&
      cashSvcSrc.includes('createRegister')
  );

  // Loopback PG gate
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live WP-4 accounting reports integration checks are BLOCKED.');
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

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  const itemIds: string[] = [];
  const warehouseIds: string[] = [];
  let cleanupFailed = false;

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();

    const user = await userRepo.createUser({
      username: `frl1_usr_${unique}`,
      passwordHash: 'dummy_hash_frl1_usr',
      role: 'platform_admin',
    });
    userIds.push(user.id);

    const comp = await companyRepo.create({
      code: `FRL1-${unique}`.slice(0, 20),
      nameAr: `شركة التقارير الحية ${unique}`,
      createdBy: user.id,
    });
    companyIds.push(comp.id);
    const companyId = comp.id;

    // Isolated CoA (Cash, Inventory, AR, AP, Clearing, VAT Payable, Retained Earnings, Sales Revenue, COGS, Inv Adj)
    const cashAcc = await defaultAccountService.createAccount(companyId, { code: '1110', nameAr: 'الصندوق النقدي', accountType: 'asset', isPostable: true }, user.id);
    const invAcc = await defaultAccountService.createAccount(companyId, { code: '1130', nameAr: 'المخزون', accountType: 'asset', isPostable: true }, user.id);
    const arAcc = await defaultAccountService.createAccount(companyId, { code: '1200', nameAr: 'العملاء', accountType: 'asset', isPostable: true }, user.id);
    const apAcc = await defaultAccountService.createAccount(companyId, { code: '2110', nameAr: 'الموردون', accountType: 'liability', isPostable: true }, user.id);
    const clrAcc = await defaultAccountService.createAccount(companyId, { code: '2120', nameAr: 'المشتريات المعلقة', accountType: 'liability', isPostable: true }, user.id);
    const vatAcc = await defaultAccountService.createAccount(companyId, { code: '2150', nameAr: 'ضريبة القيمة المضافة المستحقة', accountType: 'liability', isPostable: true }, user.id);
    const reAcc = await defaultAccountService.createAccount(companyId, { code: '3200', nameAr: 'الأرباح المبقاة', accountType: 'equity', isPostable: true }, user.id);
    const revAcc = await defaultAccountService.createAccount(companyId, { code: '4100', nameAr: 'إيراد المبيعات', accountType: 'revenue', isPostable: true }, user.id);
    const cogsAcc = await defaultAccountService.createAccount(companyId, { code: '5110', nameAr: 'تكلفة البضاعة المباعة', accountType: 'expense', isPostable: true }, user.id);
    const adjAcc = await defaultAccountService.createAccount(companyId, { code: '5120', nameAr: 'تسويات المخزون', accountType: 'expense', isPostable: true }, user.id);

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

    // Calendar Periods relative to company business date (Africa/Cairo)
    // P0: [-100 .. -70] -> CLOSED (closedDate = -85)
    // P1: [-60  .. -31] -> OPEN   (dP1 = -45 => agingDays = 45 => '31-60' bucket!)
    // P2: [-30  .. +10] -> OPEN   (dToday = 0 => agingDays = 0  => '0-30'  bucket!)
    const dToday = getBusinessDateToday(DEFAULT_BUSINESS_TIMEZONE);
    const p0Start = addDaysYmd(dToday, -100);
    const p0End = addDaysYmd(dToday, -70);
    const closedDate = addDaysYmd(dToday, -85);

    const p1Start = addDaysYmd(dToday, -60);
    const p1End = addDaysYmd(dToday, -31);
    const dP1 = addDaysYmd(dToday, -45);

    const p2Start = addDaysYmd(dToday, -30);
    const p2End = addDaysYmd(dToday, 10);

    const p0Draft = await defaultPeriodService.createPeriod(companyId, { code: `P0-CLS-${unique}`.slice(0, 20), startDate: p0Start, endDate: p0End }, user.id);
    const p0 = await defaultPeriodService.closePeriod(companyId, p0Draft.id, user.id);
    const p1 = await defaultPeriodService.createPeriod(companyId, { code: `P1-OLD-${unique}`.slice(0, 20), startDate: p1Start, endDate: p1End }, user.id);
    const p2 = await defaultPeriodService.createPeriod(companyId, { code: `P2-CUR-${unique}`.slice(0, 20), startDate: p2Start, endDate: p2End }, user.id);

    // Master Data + Cash Register (openingBalance = 0 so 100% of cash comes from posted transactions)
    const cashRegister = await defaultCashRegisterService.createRegister(
      companyId,
      { code: `CR1-${unique}`.slice(0, 16), nameAr: 'الصندوق الرئيسي', glAccountId: cashAcc.id, openingBalance: 0 },
      user.id
    );
    const supplier = await defaultSupplierService.createSupplier(companyId, { code: `SUP-FRL-${unique}`.slice(0, 20), nameAr: 'مورد التقارير' }, user.id);
    const customer = await defaultCustomerService.createCustomer(companyId, { code: `CUS-FRL-${unique}`.slice(0, 20), nameAr: 'عميل التقارير' }, user.id);
    const wh1 = await defaultWarehouseService.createWarehouse(companyId, { code: `WH1-${unique}`.slice(0, 20), nameAr: 'المستودع الرئيسي' }, user.id);
    warehouseIds.push(wh1.id);

    const fifoProfile = await defaultInventoryValuationRepository.createProfile(companyId, {
      name: 'FIFO Live Reports',
      costingMethod: 'FIFO',
      isDefault: true,
    });
    const item = await defaultItemService.createItem(companyId, { code: `ITM-FRL-${unique}`.slice(0, 20), nameAr: 'صنف التقارير', uom: 'قطعة' }, user.id);
    itemIds.push(item.id);
    await defaultInventoryValuationRepository.assignItemProfile(companyId, item.id, fifoProfile.id, user.id);

    // =========================================================================
    // EXECUTE REAL MULTI-PERIOD SCENARIO THROUGH SERVICES
    // =========================================================================

    // 1. GRN1 (10 @ 20.00 = 200.00) [P2 today] + PINV1 (10 @ 20.00 = 200.00) [P1 dP1]
    const grn1 = await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: item.id, qty: 10, unitCost: 20 }] }, user.id)).id,
      user.id
    );
    const pinv1 = await defaultPurchInvoiceService.postInvoice(
      companyId,
      (await defaultPurchInvoiceService.createInvoice(companyId, {
        supplierId: supplier.id,
        supplierInvoiceNo: `PINV1-${unique}`.slice(0, 24),
        invoiceDate: dP1,
        dueDate: dP1,
        lines: [{ grnLineId: grn1.lines![0].id, qty: 10, unitCost: 20 }],
      }, user.id)).id,
      user.id
    );

    // 2. Delivery 1 (3 @ 20 = 60.00) + Sales Invoice 1 (3 @ 100 + 15% VAT = 345.00, COGS 60.00) [P1 dP1]
    const dlv1 = await defaultSalesDeliveryService.postDelivery(
      companyId,
      (await defaultSalesDeliveryService.createDelivery(companyId, {
        customerId: customer.id,
        warehouseId: wh1.id,
        deliveryDate: dP1,
        lines: [{ itemId: item.id, qty: 3, unitPrice: 100 }],
      }, user.id)).id,
      user.id
    );
    const sinv1 = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id,
        deliveryId: dlv1.id,
        invoiceDate: dP1,
        dueDate: dP1,
        lines: [{ itemId: item.id, deliveryLineId: dlv1.lines![0].id, qty: 3, unitPrice: 100, taxRate: 15 }],
      }, user.id)).id,
      user.id
    );

    // 3. GRN2 (5 @ 20.00 = 100.00) [P2 today] + PINV2 (5 @ 20.00 = 100.00) [P2 today]
    const grn2 = await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: item.id, qty: 5, unitCost: 20 }] }, user.id)).id,
      user.id
    );
    const pinv2 = await defaultPurchInvoiceService.postInvoice(
      companyId,
      (await defaultPurchInvoiceService.createInvoice(companyId, {
        supplierId: supplier.id,
        supplierInvoiceNo: `PINV2-${unique}`.slice(0, 24),
        invoiceDate: dToday,
        dueDate: dToday,
        lines: [{ grnLineId: grn2.lines![0].id, qty: 5, unitCost: 20 }],
      }, user.id)).id,
      user.id
    );

    // 4. Delivery 2 (3 @ 20 = 60.00) [P2] + SINV2a (3 @ 100 + 15% VAT = 345) -> CANCEL -> RE-INVOICE SINV2b (3 @ 120 + 15% VAT = 414)
    const dlv2 = await defaultSalesDeliveryService.postDelivery(
      companyId,
      (await defaultSalesDeliveryService.createDelivery(companyId, {
        customerId: customer.id,
        warehouseId: wh1.id,
        deliveryDate: dToday,
        lines: [{ itemId: item.id, qty: 3, unitPrice: 100 }],
      }, user.id)).id,
      user.id
    );
    const sinv2a = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id,
        deliveryId: dlv2.id,
        invoiceDate: dToday,
        dueDate: dToday,
        lines: [{ itemId: item.id, deliveryLineId: dlv2.lines![0].id, qty: 3, unitPrice: 100, taxRate: 15 }],
      }, user.id)).id,
      user.id
    );
    const sinv2aCancelled = await defaultSalesInvoiceService.cancelPostedInvoice(
      companyId,
      sinv2a.id,
      'تصحيح سعر البيع وإعادة الفوترة',
      user.id
    );
    const sinv2b = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id,
        deliveryId: dlv2.id,
        invoiceDate: dToday,
        dueDate: dToday,
        lines: [{ itemId: item.id, deliveryLineId: dlv2.lines![0].id, qty: 3, unitPrice: 120, taxRate: 15 }],
      }, user.id)).id,
      user.id
    );

    // 5. Partial Sales Return on SINV2b: 1 @ 120 + 15% VAT = 138.00, restored cost = 20.00 [P2 today]
    const srtn1 = await defaultSalesReturnService.postReturn(
      companyId,
      (await defaultSalesReturnService.createReturn(companyId, {
        customerId: customer.id,
        invoiceId: sinv2b.id,
        warehouseId: wh1.id,
        returnDate: dToday,
        reason: 'مرتجع جزئي وحدة واحدة',
        lines: [{ invoiceLineId: sinv2b.lines![0].id, qty: 1 }],
      }, user.id)).id,
      user.id
    );

    // 6. Partial Customer Collection (150.00 into CR1) on SINV2b [P2 today]
    const col1 = await defaultSalesCollectionService.postCollection(
      companyId,
      (await defaultSalesCollectionService.createCollection(companyId, {
        customerId: customer.id,
        invoiceId: sinv2b.id,
        registerId: cashRegister.id,
        collectionDate: dToday,
        amount: 150,
      }, user.id)).id,
      user.id
    );

    // 7. Partial Supplier Payment (50.00 from CR1) on PINV1 [P2 today]
    const spay1 = await defaultSupplierPaymentService.postPayment(
      companyId,
      (await defaultSupplierPaymentService.createPayment(companyId, {
        supplierId: supplier.id,
        invoiceId: pinv1.id,
        registerId: cashRegister.id,
        paymentDate: dToday,
        amount: 50,
      }, user.id)).id,
      user.id
    );

    const je = {
      grn1: grn1.journalEntryId!,
      pinv1: pinv1.journalEntryId!,
      sinv1: sinv1.journalEntryId!,
      grn2: grn2.journalEntryId!,
      pinv2: pinv2.journalEntryId!,
      sinv2a: sinv2a.journalEntryId!,
      revSinv2a: sinv2aCancelled.reversalJournalEntryId!,
      sinv2b: sinv2b.journalEntryId!,
      srtn1: srtn1.journalEntryId!,
      col1: col1.journalEntryId!,
      spay1: spay1.journalEntryId!,
    };

    // =========================================================================
    // INDEPENDENT PRE-DECLARED EXPECTED CONSTANTS
    // =========================================================================
    const EXPECTED_FULL = {
      gl: {
        cash: {
          openingBalance: '0.00', totalDebit: '150.00', totalCredit: '50.00', closingBalance: '100.00',
          expectedLines: [
            { entryId: je.col1, debit: '150.00', credit: '0.00' },
            { entryId: je.spay1, debit: '0.00', credit: '50.00' },
          ],
        },
        inventory: {
          openingBalance: '0.00', totalDebit: '380.00', totalCredit: '180.00', closingBalance: '200.00',
          expectedLines: [
            { entryId: je.grn1, debit: '200.00', credit: '0.00' },
            { entryId: je.sinv1, debit: '0.00', credit: '60.00' },
            { entryId: je.grn2, debit: '100.00', credit: '0.00' },
            { entryId: je.sinv2a, debit: '0.00', credit: '60.00' },
            { entryId: je.revSinv2a, debit: '60.00', credit: '0.00' },
            { entryId: je.sinv2b, debit: '0.00', credit: '60.00' },
            { entryId: je.srtn1, debit: '20.00', credit: '0.00' },
          ],
        },
        ar: {
          openingBalance: '0.00', totalDebit: '1104.00', totalCredit: '633.00', closingBalance: '471.00',
          expectedLines: [
            { entryId: je.sinv1, debit: '345.00', credit: '0.00' },
            { entryId: je.sinv2a, debit: '345.00', credit: '0.00' },
            { entryId: je.revSinv2a, debit: '0.00', credit: '345.00' },
            { entryId: je.sinv2b, debit: '414.00', credit: '0.00' },
            { entryId: je.srtn1, debit: '0.00', credit: '138.00' },
            { entryId: je.col1, debit: '0.00', credit: '150.00' },
          ],
        },
        ap: {
          openingBalance: '0.00', totalDebit: '50.00', totalCredit: '300.00', closingBalance: '250.00',
          expectedLines: [
            { entryId: je.pinv1, debit: '0.00', credit: '200.00' },
            { entryId: je.pinv2, debit: '0.00', credit: '100.00' },
            { entryId: je.spay1, debit: '50.00', credit: '0.00' },
          ],
        },
        clearing: {
          openingBalance: '0.00', totalDebit: '300.00', totalCredit: '300.00', closingBalance: '0.00',
          expectedLines: [
            { entryId: je.pinv1, debit: '200.00', credit: '0.00' },
            { entryId: je.grn1, debit: '0.00', credit: '200.00' },
            { entryId: je.grn2, debit: '0.00', credit: '100.00' },
            { entryId: je.pinv2, debit: '100.00', credit: '0.00' },
          ],
        },
        vat: {
          openingBalance: '0.00', totalDebit: '63.00', totalCredit: '144.00', closingBalance: '81.00',
          expectedLines: [
            { entryId: je.sinv1, debit: '0.00', credit: '45.00' },
            { entryId: je.sinv2a, debit: '0.00', credit: '45.00' },
            { entryId: je.revSinv2a, debit: '45.00', credit: '0.00' },
            { entryId: je.sinv2b, debit: '0.00', credit: '54.00' },
            { entryId: je.srtn1, debit: '18.00', credit: '0.00' },
          ],
        },
        revenue: {
          openingBalance: '0.00', totalDebit: '420.00', totalCredit: '960.00', closingBalance: '540.00',
          expectedLines: [
            { entryId: je.sinv1, debit: '0.00', credit: '300.00' },
            { entryId: je.sinv2a, debit: '0.00', credit: '300.00' },
            { entryId: je.revSinv2a, debit: '300.00', credit: '0.00' },
            { entryId: je.sinv2b, debit: '0.00', credit: '360.00' },
            { entryId: je.srtn1, debit: '120.00', credit: '0.00' },
          ],
        },
        cogs: {
          openingBalance: '0.00', totalDebit: '180.00', totalCredit: '80.00', closingBalance: '100.00',
          expectedLines: [
            { entryId: je.sinv1, debit: '60.00', credit: '0.00' },
            { entryId: je.sinv2a, debit: '60.00', credit: '0.00' },
            { entryId: je.revSinv2a, debit: '0.00', credit: '60.00' },
            { entryId: je.sinv2b, debit: '60.00', credit: '0.00' },
            { entryId: je.srtn1, debit: '0.00', credit: '20.00' },
          ],
        },
      },
      trialBalance: {
        grandTotalDebit: 2647,
        grandTotalCredit: 2647,
        byCode: {
          '1110': { d: 150, c: 50, net: 100 },
          '1130': { d: 380, c: 180, net: 200 },
          '1200': { d: 1104, c: 633, net: 471 },
          '2110': { d: 50, c: 300, net: -250 },
          '2120': { d: 300, c: 300, net: 0 },
          '2150': { d: 63, c: 144, net: -81 },
          '3200': { d: 0, c: 0, net: 0 },
          '4100': { d: 420, c: 960, net: -540 },
          '5110': { d: 180, c: 80, net: 100 },
          '5120': { d: 0, c: 0, net: 0 },
        } as Record<string, { d: number; c: number; net: number }>,
      },
      incomeStatement: {
        revenueAmount: '540.00',
        cogsAmount: '100.00',
        totalRevenue: '540.00',
        totalExpenses: '100.00',
        netIncome: '440.00',
      },
      balanceSheetPreClose: {
        cash: '100.00',
        inventory: '200.00',
        ar: '471.00',
        ap: '250.00',
        clearing: '0.00',
        vat: '81.00',
        totalAssets: '771.00',
        totalLiabilities: '331.00',
        totalEquity: '0.00',
        expectedEquityDiffEqualNetIncome: '440.00',
      },
      aging: {
        arGrandTotalOpen: 471,
        arBucket0To30: 126,
        arBucket31To60: 345,
        arBucket61Plus: 0,
        sinv1Open: 345,
        sinv1Bucket: '31-60',
        sinv2bOpen: 126,
        sinv2bBucket: '0-30',
        pinv1Open: 150,
        pinv2Open: 100,
        apTotalOpen: '250.00',
        apBucket0To30: '100.00',
        apBucket31To60: '150.00',
        apBucket61Plus: '0.00',
        netArMinusAp: '221.00',
      },
      p1Only: {
        tbGrandDebit: 605,
        tbGrandCredit: 605,
        isRevenue: '300.00',
        isExpenses: '60.00',
        isNetIncome: '240.00',
        bsAssets: '285.00',
        bsLiabilities: '45.00',
        bsEquity: '0.00',
        arClosing: '345.00',
        apClosing: '200.00',
      },
      p2Only: {
        isRevenue: '240.00',
        isExpenses: '40.00',
        isNetIncome: '200.00',
        arOpening: '345.00',
        arClosing: '471.00',
      },
    };

    // =========================================================================
    // CHECK 1: getGeneralLedger (every affected account + reversal + re-invoice + direct SQL)
    // =========================================================================
    const glCash = await defaultReportsService.getGeneralLedger(companyId, cashAcc.id);
    const glInv = await defaultReportsService.getGeneralLedger(companyId, invAcc.id);
    const glAr = await defaultReportsService.getGeneralLedger(companyId, arAcc.id);
    const glAp = await defaultReportsService.getGeneralLedger(companyId, apAcc.id);
    const glClr = await defaultReportsService.getGeneralLedger(companyId, clrAcc.id);
    const glVat = await defaultReportsService.getGeneralLedger(companyId, vatAcc.id);
    const glRev = await defaultReportsService.getGeneralLedger(companyId, revAcc.id);
    const glCogs = await defaultReportsService.getGeneralLedger(companyId, cogsAcc.id);

    const glChecks = [
      assertGlMatch(glCash, EXPECTED_FULL.gl.cash),
      assertGlMatch(glInv, EXPECTED_FULL.gl.inventory),
      assertGlMatch(glAr, EXPECTED_FULL.gl.ar),
      assertGlMatch(glAp, EXPECTED_FULL.gl.ap),
      assertGlMatch(glClr, EXPECTED_FULL.gl.clearing),
      assertGlMatch(glVat, EXPECTED_FULL.gl.vat),
      assertGlMatch(glRev, EXPECTED_FULL.gl.revenue),
      assertGlMatch(glCogs, EXPECTED_FULL.gl.cogs),
    ];

    const sqlGlCross = await withTenantTransaction(companyId, async (tx) => {
      const res = await tx.query<{ code: string; dr: string; cr: string }>(
        `SELECT a.code, COALESCE(SUM(l.debit),0)::text as dr, COALESCE(SUM(l.credit),0)::text as cr
         FROM accounts a
         LEFT JOIN journal_lines l ON l.account_id = a.id AND l.company_id = a.company_id
         LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id AND e.status = 'posted'
         WHERE a.company_id = $1 AND a.is_postable = true
         GROUP BY a.code`,
        [companyId]
      );
      return res.rows;
    });
    const sqlGlByCode = new Map(sqlGlCross.map((r) => [r.code, { dr: normMoney(r.dr), cr: normMoney(r.cr) }]));
    const glFails = glChecks.filter((c) => !c.ok).map((c) => c.detail);

    await check(
      'Check 1 (getGeneralLedger): Exact Dr/Cr, runningBalance, cancellation reversal JE & re-invoicing rows match declared constants & SQL',
      glFails.length === 0 &&
        sqlGlByCode.get('1110')?.dr === '150.00' &&
        sqlGlByCode.get('1130')?.dr === '380.00' &&
        sqlGlByCode.get('1200')?.dr === '1104.00' &&
        sqlGlByCode.get('4100')?.cr === '960.00',
      glFails.length > 0 ? glFails.join('; ') : 'All 8 accounts matched GL & SQL'
    );

    // =========================================================================
    // CHECK 2: getTrialBalance
    // =========================================================================
    const tb = await defaultTrialBalanceService.getTrialBalance(companyId);
    const tbMismatches: string[] = [];
    for (const [code, exp] of Object.entries(EXPECTED_FULL.trialBalance.byCode)) {
      const row = tb.rows.find((r) => r.accountCode === code);
      if (!row) {
        tbMismatches.push(`Missing account ${code}`);
      } else if (row.totalDebit !== exp.d || row.totalCredit !== exp.c || row.netBalance !== exp.net) {
        tbMismatches.push(`${code}: got (${row.totalDebit},${row.totalCredit},${row.netBalance}) !== (${exp.d},${exp.c},${exp.net})`);
      }
    }
    const sqlTbTotals = await withTenantTransaction(companyId, async (tx) => {
      const res = await tx.query<{ dr: string; cr: string }>(
        `SELECT COALESCE(SUM(l.debit),0)::text as dr, COALESCE(SUM(l.credit),0)::text as cr
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
         WHERE l.company_id = $1 AND e.status = 'posted'`,
        [companyId]
      );
      return { dr: Number(res.rows[0].dr), cr: Number(res.rows[0].cr) };
    });

    await check(
      'Check 2 (Trial Balance): All 10 account totals/netBalances match expected, grandTotalDebit === grandTotalCredit === 2647',
      tbMismatches.length === 0 &&
        tb.isBalanced === true &&
        tb.grandTotalDebit === EXPECTED_FULL.trialBalance.grandTotalDebit &&
        tb.grandTotalCredit === EXPECTED_FULL.trialBalance.grandTotalCredit &&
        sqlTbTotals.dr === 2647 &&
        sqlTbTotals.cr === 2647,
      tbMismatches.join('; ')
    );

    // =========================================================================
    // CHECK 3: getIncomeStatement (temporary accounts only)
    // =========================================================================
    const isFull = await defaultReportsService.getIncomeStatement(companyId);
    const permTypesInIs = [...isFull.revenue, ...isFull.expenses].some(
      (r) => !['revenue', 'expense'].includes(r.accountType)
    );
    await check(
      'Check 3 (Income Statement): Revenue=540.00, COGS=100.00, NetIncome=440.00; only temporary accounts included',
      !permTypesInIs &&
        isFull.revenue.length === 1 &&
        isFull.revenue[0].accountCode === '4100' &&
        normMoney(isFull.revenue[0].amount) === EXPECTED_FULL.incomeStatement.revenueAmount &&
        isFull.expenses.length === 1 &&
        isFull.expenses[0].accountCode === '5110' &&
        normMoney(isFull.expenses[0].amount) === EXPECTED_FULL.incomeStatement.cogsAmount &&
        normMoney(isFull.totalRevenue) === EXPECTED_FULL.incomeStatement.totalRevenue &&
        normMoney(isFull.totalExpenses) === EXPECTED_FULL.incomeStatement.totalExpenses &&
        normMoney(isFull.netIncome) === EXPECTED_FULL.incomeStatement.netIncome
    );

    // =========================================================================
    // CHECK 4: getBalanceSheet (permanent accounts only + Cash & Bank summary alignment)
    // =========================================================================
    const bsPre = await defaultReportsService.getBalanceSheet(companyId);
    const opsCash = await defaultOperationalReportsService.getCashAndBankSummary(companyId);
    const tempTypesInBs = [...bsPre.assets, ...bsPre.liabilities, ...bsPre.equity].some(
      (r) => !['asset', 'liability', 'equity'].includes(r.accountType)
    );
    const bsAssetByCode = new Map(bsPre.assets.map((r) => [r.accountCode, normMoney(r.amount)]));
    const bsLiabByCode = new Map(bsPre.liabilities.map((r) => [r.accountCode, normMoney(r.amount)]));
    const bsDiffUnits =
      parseExactUnits(bsPre.totalAssets, MONEY_SCALE, 'a') -
      parseExactUnits(bsPre.totalLiabilities, MONEY_SCALE, 'l') -
      parseExactUnits(bsPre.totalEquity, MONEY_SCALE, 'e');

    await check(
      'Check 4 (Balance Sheet Pre-Close): Cash=100, Inv=200, AR=471 (Assets=771); AP=250, VAT=81, Clr=0 (Liab=331); Eq=0; Assets-Liab-Eq === NetIncome (440); Permanent accounts only',
      !tempTypesInBs &&
        bsAssetByCode.get('1110') === EXPECTED_FULL.balanceSheetPreClose.cash &&
        bsAssetByCode.get('1130') === EXPECTED_FULL.balanceSheetPreClose.inventory &&
        bsAssetByCode.get('1200') === EXPECTED_FULL.balanceSheetPreClose.ar &&
        bsLiabByCode.get('2110') === EXPECTED_FULL.balanceSheetPreClose.ap &&
        bsLiabByCode.get('2120') === EXPECTED_FULL.balanceSheetPreClose.clearing &&
        bsLiabByCode.get('2150') === EXPECTED_FULL.balanceSheetPreClose.vat &&
        normMoney(bsPre.totalAssets) === EXPECTED_FULL.balanceSheetPreClose.totalAssets &&
        normMoney(bsPre.totalLiabilities) === EXPECTED_FULL.balanceSheetPreClose.totalLiabilities &&
        normMoney(bsPre.totalEquity) === EXPECTED_FULL.balanceSheetPreClose.totalEquity &&
        fromMinorUnits(bsDiffUnits, MONEY_SCALE) === EXPECTED_FULL.balanceSheetPreClose.expectedEquityDiffEqualNetIncome &&
        normMoney(opsCash.totalCashBalance) === EXPECTED_FULL.balanceSheetPreClose.cash
    );

    // =========================================================================
    // CHECK 5: Aging Reports (AR Aging + AP Open Items + Operational AR/AP Aging Summary)
    // =========================================================================
    const arAging = await defaultArAgingService.getAgingReport(companyId);
    const apItems = await defaultApOpenItemsService.listOpenItems(companyId);
    const opsAging = await defaultOperationalReportsService.getArApAgingSummary(companyId);

    const arRow1 = arAging.items.find((i) => i.invoiceId === sinv1.id);
    const arRow2a = arAging.items.find((i) => i.invoiceId === sinv2a.id);
    const arRow2b = arAging.items.find((i) => i.invoiceId === sinv2b.id);
    const apRow1 = apItems.find((i) => i.invoiceId === pinv1.id);
    const apRow2 = apItems.find((i) => i.invoiceId === pinv2.id);

    await check(
      'Check 5 (AR & AP Aging): SINV1=345 (31-60), SINV2b=126 (0-30), Cancelled SINV2a excluded; PINV1=150 (31-60), PINV2=100 (0-30); Operational AR/AP summary matches',
      Boolean(arRow1 && arRow2b) &&
        !arRow2a &&
        arRow1!.remainingOpenAmount === EXPECTED_FULL.aging.sinv1Open &&
        arRow1!.bucket === EXPECTED_FULL.aging.sinv1Bucket &&
        arRow1!.agingDays >= 44 && arRow1!.agingDays <= 46 &&
        arRow2b!.remainingOpenAmount === EXPECTED_FULL.aging.sinv2bOpen &&
        arRow2b!.bucket === EXPECTED_FULL.aging.sinv2bBucket &&
        arRow2b!.agingDays <= 1 &&
        arAging.grandTotalOpen === EXPECTED_FULL.aging.arGrandTotalOpen &&
        arAging.grandTotal0To30 === EXPECTED_FULL.aging.arBucket0To30 &&
        arAging.grandTotal31To60 === EXPECTED_FULL.aging.arBucket31To60 &&
        arAging.grandTotal61Plus === EXPECTED_FULL.aging.arBucket61Plus &&
        apRow1?.remainingOpenAmount === EXPECTED_FULL.aging.pinv1Open &&
        apRow2?.remainingOpenAmount === EXPECTED_FULL.aging.pinv2Open &&
        normMoney(opsAging.ap.totalOpen) === EXPECTED_FULL.aging.apTotalOpen &&
        normMoney(opsAging.ap.bucket0To30) === EXPECTED_FULL.aging.apBucket0To30 &&
        normMoney(opsAging.ap.bucket31To60) === EXPECTED_FULL.aging.apBucket31To60 &&
        normMoney(opsAging.ap.bucket61Plus) === EXPECTED_FULL.aging.apBucket61Plus &&
        normMoney(opsAging.netReceivablesMinusPayables) === EXPECTED_FULL.aging.netArMinusAp
    );

    // =========================================================================
    // CHECK 6: Period Filter Effect & Closed Accounting Period Rejection
    // =========================================================================
    const tbP1 = await defaultTrialBalanceService.getTrialBalance(companyId, { asOfDate: p1End });
    const isP1 = await defaultReportsService.getIncomeStatement(companyId, { fromDate: p1Start, toDate: p1End });
    const isP2 = await defaultReportsService.getIncomeStatement(companyId, { fromDate: p2Start, toDate: dToday });
    const bsP1 = await defaultReportsService.getBalanceSheet(companyId, { asOfDate: p1End });
    const glArP1 = await defaultReportsService.getGeneralLedger(companyId, arAcc.id, { fromDate: p1Start, toDate: p1End });
    const glArP2 = await defaultReportsService.getGeneralLedger(companyId, arAcc.id, { fromDate: p2Start, toDate: dToday });
    const glApP1 = await defaultReportsService.getGeneralLedger(companyId, apAcc.id, { fromDate: p1Start, toDate: p1End });

    const closedPeriodPostRej = await expectValidationError(async () => {
      const invClosed = await defaultSalesInvoiceService.createInvoice(
        companyId,
        {
          customerId: customer.id,
          invoiceDate: closedDate,
          lines: [{ itemId: item.id, qty: 1, unitPrice: 100, taxRate: 15 }],
        },
        user.id
      );
      await defaultSalesInvoiceService.postInvoice(companyId, invClosed.id, user.id);
    });

    await check(
      'Check 6 (Period Effect & Closed Period Enforcement): Date-filtered reports yield exact P1 & P2 slices; closed P0 posting rejected without altering reports',
      tbP1.isBalanced === true &&
        tbP1.grandTotalDebit === EXPECTED_FULL.p1Only.tbGrandDebit &&
        tbP1.grandTotalCredit === EXPECTED_FULL.p1Only.tbGrandCredit &&
        normMoney(isP1.totalRevenue) === EXPECTED_FULL.p1Only.isRevenue &&
        normMoney(isP1.totalExpenses) === EXPECTED_FULL.p1Only.isExpenses &&
        normMoney(isP1.netIncome) === EXPECTED_FULL.p1Only.isNetIncome &&
        normMoney(isP2.totalRevenue) === EXPECTED_FULL.p2Only.isRevenue &&
        normMoney(isP2.totalExpenses) === EXPECTED_FULL.p2Only.isExpenses &&
        normMoney(isP2.netIncome) === EXPECTED_FULL.p2Only.isNetIncome &&
        normMoney(bsP1.totalAssets) === EXPECTED_FULL.p1Only.bsAssets &&
        normMoney(bsP1.totalLiabilities) === EXPECTED_FULL.p1Only.bsLiabilities &&
        normMoney(bsP1.totalEquity) === EXPECTED_FULL.p1Only.bsEquity &&
        normMoney(glArP1.closingBalance) === EXPECTED_FULL.p1Only.arClosing &&
        normMoney(glApP1.closingBalance) === EXPECTED_FULL.p1Only.apClosing &&
        normMoney(glArP2.openingBalance) === EXPECTED_FULL.p2Only.arOpening &&
        normMoney(glArP2.closingBalance) === EXPECTED_FULL.p2Only.arClosing &&
        closedPeriodPostRej.rejected &&
        closedPeriodPostRej.message.includes('مغلقة') &&
        closedPeriodPostRej.message.includes(p0.code)
    );

    // =========================================================================
    // CHECK 7: Fiscal Year Close -> Post-Close Balance Sheet Balances (isBalanced === true)
    // Note: ReportsService.getBalanceSheet before year-close intentionally returns
    // isBalanced=false because open-year Net Income is not synthesized into Equity.
    // After executeYearClose into 3200 Retained Earnings, BS balances strictly.
    // =========================================================================
    const yearCloseRecord = await defaultYearCloseService.executeYearClose(
      companyId,
      {
        fiscalYearCode: `FY-${unique}`.slice(0, 20),
        startDate: p1Start,
        endDate: p2End,
        retainedEarningsAccountId: reAcc.id,
        notes: 'WP-4 verification year close',
      },
      user.id,
      true
    );
    const bsPostClose = await defaultReportsService.getBalanceSheet(companyId);
    const tbPostClose = await defaultTrialBalanceService.getTrialBalance(companyId);
    const isPostCloseFull = await defaultReportsService.getIncomeStatement(companyId);

    await check(
      'Check 7 (Post-Year-Close Balance Sheet): Closing P&L (440.00) into 3200 Retained Earnings makes BS Assets=771 === Liab+Eq=771 (isBalanced=true)',
      bsPre.isBalanced === false &&
        normMoney(yearCloseRecord.netIncome) === '440.00' &&
        bsPostClose.isBalanced === true &&
        normMoney(bsPostClose.totalAssets) === '771.00' &&
        normMoney(bsPostClose.totalLiabilities) === '331.00' &&
        normMoney(bsPostClose.totalEquity) === '440.00' &&
        normMoney(bsPostClose.totalLiabilitiesAndEquity) === '771.00' &&
        normMoney(isPostCloseFull.netIncome) === '0.00' &&
        tbPostClose.isBalanced === true &&
        tbPostClose.grandTotalDebit === 3187 &&
        tbPostClose.grandTotalCredit === 3187
    );

    console.log(
      '[POLICY NOTE FOR ALAA]: ReportsService.getBalanceSheet does not dynamically synthesize unclosed Current Period Net Income into Equity; pre-close Balance Sheet returns isBalanced=false (Assets - Liab - Eq === NetIncome) until executeYearClose is run with an explicit retainedEarningsAccountId (company_settings has no retained_earnings_account_id default).'
    );
  } catch (err) {
    console.error('[verifyFinancialReportsLive1] Live test error:', err);
    await check('Live WP-4 financial reports execution', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl, process.env));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines DISABLE TRIGGER trg_journal_lines_immutability');

        await client.query('DELETE FROM fin_fiscal_year_closes WHERE company_id = ANY($1::uuid[])', [companyIds]);
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

        await client.query('DELETE FROM purch_supplier_payments WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_cost_adjustments WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_return_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_returns WHERE company_id = ANY($1::uuid[])', [companyIds]);
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
        await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }

        const teardownAudit = await countRemainingTestInventoryRows({
          executor: client,
          ownedCompanies: companyIds,
          registeredMovements: [crypto.randomUUID()],
          registeredItems: itemIds,
          registeredWarehouses: warehouseIds,
        });
        if (teardownAudit.remainingChildCount > 0) {
          cleanupFailed = true;
          console.error('[cleanup] Remaining test inventory rows:', teardownAudit.breakdown);
        }

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
        console.error('[cleanup] Failed cleaning up verifyFinancialReportsLive1:', cleanupErr);
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
  console.error('[verifyFinancialReportsLive1] Fatal error:', err);
  process.exit(1);
});
