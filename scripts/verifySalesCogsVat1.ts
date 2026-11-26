import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { tenantContextStorage } from '../src/server/db/tenantContext.js';
import { DbExecutor } from '../src/server/db/types.js';
import {
  computeSalesInvoiceTotals,
  multiplyToMinorUnits,
  percentOfMinorUnits,
} from '../src/server/sales/salesInvoiceRepository.js';
import { SalesInvoiceService } from '../src/server/sales/salesInvoiceService.js';
import { ValidationError } from '../src/server/http/errors.js';
import { MONEY_SCALE, fromMinorUnits, toMinorUnits } from '../src/server/lib/numeric.js';

import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { defaultSupplierService } from '../src/server/purchasing/supplierService.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultGrnService } from '../src/server/purchasing/grnService.js';
import { defaultCustomerService } from '../src/server/sales/customerService.js';
import { defaultSalesDeliveryService } from '../src/server/sales/salesDeliveryService.js';
import { defaultSalesInvoiceService } from '../src/server/sales/salesInvoiceService.js';
import { ensureTestCostingProfile } from './helpers/ensureTestCostingProfile.js';

console.log('============================================================================');
console.log('=== VERIFYING AN-INT-SALES-1: SALES COGS + VAT SPLIT + MONEY PRECISION    ===');
console.log('============================================================================');

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

const COMP_ID = '11111111-1111-4111-8111-111111111111';
const CUST_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '44444444-4444-4444-8444-444444444444';
const DEL_LINE_ID = '55555555-5555-4555-8555-555555555556';
const INV_ID = '66666666-6666-4666-8666-666666666666';
const AR_ACC_ID = '99999999-9999-4999-8999-999999999991';
const REV_ACC_ID = '99999999-9999-4999-8999-999999999992';
const VAT_ACC_ID = '99999999-9999-4999-8999-999999999993';
const COGS_ACC_ID = '99999999-9999-4999-8999-999999999994';
const INV_ACC_ID = '99999999-9999-4999-8999-999999999995';
const JE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createFakeExecutor(handler: (sql: string, params?: any[]) => any[]): DbExecutor {
  return {
    query: async <T = any>(sql: string, params?: any[]) => ({
      rows: handler(sql, params) as T[],
      rowCount: 1,
    }),
    withTransaction: async <T>(fn: (tx: DbExecutor) => Promise<T>) => fn(createFakeExecutor(handler)),
    health: async () => ({ ok: true }),
    close: async () => undefined,
  };
}

function buildAccountCatalogRows(ids: string[], overrides?: Record<string, Partial<any>>) {
  const catalog: Record<string, any> = {
    [AR_ACC_ID]: { id: AR_ACC_ID, code: '1200', nameAr: 'العملاء', accountType: 'asset', isActive: true, isPostable: true },
    [REV_ACC_ID]: { id: REV_ACC_ID, code: '4100', nameAr: 'إيراد المبيعات', accountType: 'revenue', isActive: true, isPostable: true },
    [VAT_ACC_ID]: { id: VAT_ACC_ID, code: '2150', nameAr: 'ضريبة القيمة المضافة المستحقة', accountType: 'liability', isActive: true, isPostable: true },
    [COGS_ACC_ID]: { id: COGS_ACC_ID, code: '5110', nameAr: 'تكلفة البضاعة المباعة', accountType: 'expense', isActive: true, isPostable: true },
    [INV_ACC_ID]: { id: INV_ACC_ID, code: '1130', nameAr: 'المخزون', accountType: 'asset', isActive: true, isPostable: true },
  };
  return ids
    .map((id) => (catalog[id] ? { ...catalog[id], ...(overrides?.[id] || {}) } : null))
    .filter(Boolean);
}

async function run() {
  const rootDir = process.cwd();

  // S0: Registration & migration 048 structural checks
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  await check(
    'S0: verifySalesCogsVat1.ts registered in runFoundationBattery.ts and package.json',
    batterySrc.includes('scripts/verifySalesCogsVat1.ts') &&
      pkgJson?.scripts?.['test:sales-cogs-vat-1'] === 'tsx scripts/verifySalesCogsVat1.ts'
  );

  const mig048Path = path.join(rootDir, 'database/migrations/048_sales_cogs_vat_accounts.sql');
  const mig048Exists = fs.existsSync(mig048Path);
  const mig048 = mig048Exists ? fs.readFileSync(mig048Path, 'utf8') : '';
  const mig048NoComments = mig048.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');
  await check(
    'S1: Migration 048 defines cogs_account_id & vat_payable_account_id with column-scoped ON DELETE SET NULL and zero EXCEPTION WHEN OTHERS',
    mig048Exists &&
      mig048.includes('cogs_account_id') &&
      mig048.includes('vat_payable_account_id') &&
      mig048.includes('ON DELETE SET NULL (cogs_account_id)') &&
      mig048.includes('ON DELETE SET NULL (vat_payable_account_id)') &&
      !/\bEXCEPTION\s+WHEN\s+OTHERS\b/i.test(mig048NoComments)
  );

  const repoSrc = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesInvoiceRepository.ts'), 'utf8');
  const svcSrc = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesInvoiceService.ts'), 'utf8');
  await check(
    'S2: Repository & Service use toMinorUnits/fromMinorUnits/toMoney and fail-closed COGS/VAT resolvers',
    repoSrc.includes('toMinorUnits') &&
      repoSrc.includes('fromMinorUnits') &&
      repoSrc.includes('toMoney') &&
      svcSrc.includes('resolveCogsAndInventoryAccounts') &&
      svcSrc.includes('resolveVatPayableAccount')
  );

  // T1: Precision tests with toMinorUnits / computeSalesInvoiceTotals (gross = net + tax)
  const prodUnits = multiplyToMinorUnits(3, 4, 33.335, 4, MONEY_SCALE); // 3 * 33.335 = 100.005 -> 100.01
  const taxUnits = percentOfMinorUnits(prodUnits, 15); // 100.01 * 0.15 = 15.0015 -> 15.00
  const computed = computeSalesInvoiceTotals([
    { itemId: ITEM_ID, qty: 3, unitPrice: 33.335, taxRate: 15 },
    { itemId: ITEM_ID, qty: 2, unitPrice: 10.05, taxRate: 15 },
  ]);
  // Line 1: sub=100.01, tax=15.00, total=115.01
  // Line 2: sub=20.10, tax=3.015->3.02, total=23.12
  // Sum: sub=120.11, tax=18.02, gross=138.13
  await check(
    'T1: Minor-unit invoice math ensures zero float drift and gross = net + tax',
    fromMinorUnits(prodUnits, 2) === '100.01' &&
      fromMinorUnits(taxUnits, 2) === '15.00' &&
      computed.subtotal === '120.11' &&
      computed.taxAmount === '18.02' &&
      computed.totalAmount === '138.13' &&
      toMinorUnits(computed.subtotal, 2) + toMinorUnits(computed.taxAmount, 2) === toMinorUnits(computed.totalAmount, 2)
  );

  // Helper to run SalesInvoiceService.postInvoice cleanly under tenantContextStorage
  const runPostScenario = async (opts: {
    invoice: any;
    dlUnitCost?: number;
    settings?: {
      arAccountId?: string | null;
      revAccountId?: string | null;
      vatAccountId?: string | null;
      cogsAccountId?: string | null;
      inventoryAccountId?: string | null;
    };
    accountOverrides?: Record<string, Partial<any>>;
  }) => {
    let capturedJeInput: any = null;
    let markedPosted = false;

    const fakeInvoiceRepo = {
      findByIdForUpdate: async () => ({ id: INV_ID, status: 'draft', totalAmount: opts.invoice.totalAmount }),
      findById: async () => opts.invoice,
      markPosted: async () => {
        markedPosted = true;
      },
    } as any;

    const fakeJournalRepo = {
      allocateSequenceNumber: async () => 'SINV-00001',
    } as any;

    const fakeJournalService = {
      createDraftEntry: async (_cid: string, input: any) => {
        capturedJeInput = input;
        return { id: JE_ID, status: 'draft' };
      },
      postEntry: async () => ({ id: JE_ID, entryNo: 'JE-001', status: 'posted' }),
    } as any;

    const fakeAuditService = { record: async () => undefined } as any;

    const settings = {
      arAccountId: AR_ACC_ID,
      revAccountId: REV_ACC_ID,
      vatAccountId: VAT_ACC_ID,
      cogsAccountId: COGS_ACC_ID,
      inventoryAccountId: INV_ACC_ID,
      ...(opts.settings || {}),
    };

    const fakeTx = createFakeExecutor((sql, params) => {
      if (sql.includes('FROM sales_delivery_lines dl')) {
        const qty = opts.invoice.lines[0]?.qty ?? 5;
        const unitCost = opts.dlUnitCost ?? 0;
        const frozenTotalCost = Number(qty) * Number(unitCost);
        return [{
          id: DEL_LINE_ID,
          qty: String(qty),
          unit_cost: String(unitCost),
          effective_unit_cost: String(unitCost),
          frozen_total_cost: String(frozenTotalCost),
          valuation_movement_id: (opts as any).valuationMovementId ?? 'mov-1111-1111-1111-1111',
          dl_item_id: opts.invoice.lines[0]?.itemId ?? ITEM_ID,
          dn_customer_id: opts.invoice.customerId ?? CUST_ID,
          dn_status: 'posted',
        }];
      }
      if (sql.includes('SUM(sil.qty)')) {
        return [{ invoiced_qty: '0' }];
      }
      if (sql.includes('accounts_receivable_account_id')) {
        return [{ arAccountId: settings.arAccountId }];
      }
      if (sql.includes('sales_revenue_account_id')) {
        return [{ revAccountId: settings.revAccountId }];
      }
      if (sql.includes('vat_payable_account_id')) {
        return [{ vatAccountId: settings.vatAccountId }];
      }
      if (sql.includes('cogs_account_id') && sql.includes('inventory_account_id')) {
        return [{ cogsAccountId: settings.cogsAccountId, inventoryAccountId: settings.inventoryAccountId }];
      }
      if (sql.includes('FROM accounts') && Array.isArray(params?.[1])) {
        return buildAccountCatalogRows(params[1], opts.accountOverrides);
      }
      if (sql.includes('FROM accounts') && typeof params?.[1] === 'string') {
        return buildAccountCatalogRows([params[1]], opts.accountOverrides);
      }
      return [];
    });

    const service = new SalesInvoiceService(
      fakeInvoiceRepo,
      { findById: async () => ({ id: 'cust', isActive: true, creditLimit: 0 }) } as any,
      fakeJournalRepo,
      fakeJournalService,
      fakeAuditService
    );

    const posted = await tenantContextStorage.run({ companyId: COMP_ID, userId: ACTOR_ID, executor: fakeTx }, async () => {
      return await service.postInvoice(COMP_ID, INV_ID, ACTOR_ID);
    });

    return { posted, capturedJeInput, markedPosted };
  };

  // T2: Invoice WITHOUT tax, WITHOUT delivery/cost
  const noTaxRes = await runPostScenario({
    invoice: {
      id: INV_ID,
      companyId: COMP_ID,
      customerId: CUST_ID,
      customerNameAr: 'عميل الاختبار',
      invoiceDate: '2026-11-16',
      subtotal: 1000,
      taxAmount: 0,
      totalAmount: 1000,
      status: 'draft',
      lines: [{ id: 'sil-1', itemId: ITEM_ID, deliveryLineId: null, qty: 10, unitPrice: 100, taxRate: 0, taxAmount: 0, lineTotal: 1000 }],
    },
  });
  await check(
    'T2 (WP-C no-tax): Posting non-tax non-cost invoice generates Dr AR 1000 / Cr REV 1000 only',
    noTaxRes.capturedJeInput?.lines?.length === 2 &&
      noTaxRes.capturedJeInput.lines[0].accountId === AR_ACC_ID &&
      noTaxRes.capturedJeInput.lines[0].debit === 1000 &&
      noTaxRes.capturedJeInput.lines[1].accountId === REV_ACC_ID &&
      noTaxRes.capturedJeInput.lines[1].credit === 1000
  );

  // T3: Invoice WITH VAT split (net 1000 + VAT 150 = gross 1150)
  const vatRes = await runPostScenario({
    invoice: {
      id: INV_ID,
      companyId: COMP_ID,
      customerId: CUST_ID,
      customerNameAr: 'عميل الضريبة',
      invoiceDate: '2026-11-16',
      subtotal: 1000,
      taxAmount: 150,
      totalAmount: 1150,
      status: 'draft',
      lines: [{ id: 'sil-1', itemId: ITEM_ID, deliveryLineId: null, qty: 10, unitPrice: 100, taxRate: 15, taxAmount: 150, lineTotal: 1150 }],
    },
  });
  await check(
    'T3 (WP-B VAT split): Separates Cr Revenue 1000 vs Cr VAT Payable 150 against Dr AR 1150',
    vatRes.capturedJeInput?.lines?.length === 3 &&
      vatRes.capturedJeInput.lines[0].accountId === AR_ACC_ID &&
      vatRes.capturedJeInput.lines[0].debit === 1150 &&
      vatRes.capturedJeInput.lines[1].accountId === REV_ACC_ID &&
      vatRes.capturedJeInput.lines[1].credit === 1000 &&
      vatRes.capturedJeInput.lines[2].accountId === VAT_ACC_ID &&
      vatRes.capturedJeInput.lines[2].credit === 150
  );

  // T4: Fail-closed VAT when vat_payable_account_id is missing
  let vatMissingRejected = false;
  try {
    await runPostScenario({
      invoice: {
        id: INV_ID,
        companyId: COMP_ID,
        customerId: CUST_ID,
        invoiceDate: '2026-11-16',
        subtotal: 1000,
        taxAmount: 150,
        totalAmount: 1150,
        status: 'draft',
        lines: [{ id: 'sil-1', itemId: ITEM_ID, deliveryLineId: null, qty: 10, unitPrice: 100, taxRate: 15, taxAmount: 150, lineTotal: 1150 }],
      },
      settings: { vatAccountId: null },
    });
  } catch (err) {
    if (err instanceof ValidationError) vatMissingRejected = true;
  }
  await check('T4 (WP-B fail-closed): Rejects taxable invoice posting when vat_payable_account_id is missing', vatMissingRejected);

  // T5: Delivery + Invoice WITH COGS (qty 5 * unitCost 60 = 300) AND VAT (net 500 + VAT 75 = gross 575)
  const cogsVatRes = await runPostScenario({
    dlUnitCost: 60,
    invoice: {
      id: INV_ID,
      companyId: COMP_ID,
      customerId: CUST_ID,
      customerNameAr: 'عميل متكامل',
      invoiceDate: '2026-11-16',
      subtotal: 500,
      taxAmount: 75,
      totalAmount: 575,
      status: 'draft',
      lines: [{ id: 'sil-1', itemId: ITEM_ID, deliveryLineId: DEL_LINE_ID, qty: 5, unitPrice: 100, taxRate: 15, taxAmount: 75, lineTotal: 575 }],
    },
  });
  const lines5 = cogsVatRes.capturedJeInput?.lines || [];
  const sumDr5 = lines5.reduce((s: bigint, l: any) => s + toMinorUnits(l.debit, 2), 0n);
  const sumCr5 = lines5.reduce((s: bigint, l: any) => s + toMinorUnits(l.credit, 2), 0n);
  await check(
    'T5 (WP-A COGS + WP-B VAT): Generates Dr AR 575 / Cr REV 500 / Cr VAT 75 / Dr COGS 300 / Cr INV 300 balanced (875=875)',
    lines5.length === 5 &&
      sumDr5 === 87500n &&
      sumCr5 === 87500n &&
      lines5.some((l: any) => l.accountId === COGS_ACC_ID && l.debit === 300 && l.credit === 0) &&
      lines5.some((l: any) => l.accountId === INV_ACC_ID && l.debit === 0 && l.credit === 300) &&
      cogsVatRes.posted?.cogsAmount === 300
  );

  // T6: Fail-closed COGS when cogs_account_id missing
  let cogsMissingRejected = false;
  try {
    await runPostScenario({
      dlUnitCost: 60,
      invoice: {
        id: INV_ID,
        companyId: COMP_ID,
        customerId: CUST_ID,
        invoiceDate: '2026-11-16',
        subtotal: 500,
        taxAmount: 0,
        totalAmount: 500,
        status: 'draft',
        lines: [{ id: 'sil-1', itemId: ITEM_ID, deliveryLineId: DEL_LINE_ID, qty: 5, unitPrice: 100, taxRate: 0, taxAmount: 0, lineTotal: 500 }],
      },
      settings: { cogsAccountId: null },
    });
  } catch (err) {
    if (err instanceof ValidationError) cogsMissingRejected = true;
  }
  await check('T6 (WP-A fail-closed): Rejects invoice posting with cost when cogs_account_id is missing', cogsMissingRejected);

  // T7: Fail-closed COGS when inventory_account_id missing OR COGS has wrong account type
  let invMissingRejected = false;
  try {
    await runPostScenario({
      dlUnitCost: 60,
      invoice: {
        id: INV_ID,
        companyId: COMP_ID,
        customerId: CUST_ID,
        invoiceDate: '2026-11-16',
        subtotal: 500,
        taxAmount: 0,
        totalAmount: 500,
        status: 'draft',
        lines: [{ id: 'sil-1', itemId: ITEM_ID, deliveryLineId: DEL_LINE_ID, qty: 5, unitPrice: 100, taxRate: 0, taxAmount: 0, lineTotal: 500 }],
      },
      settings: { inventoryAccountId: null },
    });
  } catch (err) {
    if (err instanceof ValidationError) invMissingRejected = true;
  }
  let wrongTypeRejected = false;
  try {
    await runPostScenario({
      dlUnitCost: 60,
      invoice: {
        id: INV_ID,
        companyId: COMP_ID,
        customerId: CUST_ID,
        invoiceDate: '2026-11-16',
        subtotal: 500,
        taxAmount: 0,
        totalAmount: 500,
        status: 'draft',
        lines: [{ id: 'sil-1', itemId: ITEM_ID, deliveryLineId: DEL_LINE_ID, qty: 5, unitPrice: 100, taxRate: 0, taxAmount: 0, lineTotal: 500 }],
      },
      accountOverrides: {
        [COGS_ACC_ID]: { accountType: 'asset' },
      },
    });
  } catch (err) {
    if (err instanceof ValidationError) wrongTypeRejected = true;
  }
  await check('T7 (WP-A role validation): Rejects missing inventory_account_id or non-expense COGS account', invMissingRejected && wrongTypeRejected);

  // Live Loopback PostgreSQL E2E Test
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live Sales COGS & VAT E2E verification is BLOCKED.');
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
    blocked('Database executor unavailable. Live Sales COGS & VAT E2E verification is BLOCKED.');
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
      username: `scv_usr_${unique}`,
      passwordHash: 'dummy_hash_scv_1',
      role: 'platform_admin',
    });
    userIds.push(user.id);

    const comp = await companyRepo.create({
      code: `SCV-${unique}`.slice(0, 20),
      nameAr: `شركة اختبار التكلفة والضريبة ${unique}`,
      createdBy: user.id,
    });
    companyIds.push(comp.id);
    const companyId = comp.id;

    const arAcc = await defaultAccountService.createAccount(companyId, { code: '1200', nameAr: 'العملاء', accountType: 'asset', isPostable: true }, user.id);
    const invAcc = await defaultAccountService.createAccount(companyId, { code: '1130', nameAr: 'المخزون', accountType: 'asset', isPostable: true }, user.id);
    const clrAcc = await defaultAccountService.createAccount(companyId, { code: '2120', nameAr: 'مشتريات معلقة', accountType: 'liability', isPostable: true }, user.id);
    const vatAcc = await defaultAccountService.createAccount(companyId, { code: '2150', nameAr: 'ضريبة القيمة المضافة المستحقة', accountType: 'liability', isPostable: true }, user.id);
    const revAcc = await defaultAccountService.createAccount(companyId, { code: '4100', nameAr: 'إيراد المبيعات', accountType: 'revenue', isPostable: true }, user.id);
    const cogsAcc = await defaultAccountService.createAccount(companyId, { code: '5110', nameAr: 'تكلفة البضاعة المباعة', accountType: 'expense', isPostable: true }, user.id);

    // First configure only GRN & AR/Rev (deliberately leave cogs_account_id & vat_payable_account_id NULL)
    await defaultCompanySettingsRepository.upsert(
      companyId,
      { inventoryAccountId: invAcc.id, purchasesClearingAccountId: clrAcc.id },
      user.id
    );
    const adminPoolUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    const setupClient = new pg.Client(buildPgConfig(adminPoolUrl, process.env));
    await setupClient.connect();
    try {
      await setupClient.query(
        `UPDATE company_settings
         SET accounts_receivable_account_id = $2, sales_revenue_account_id = $3
         WHERE company_id = $1`,
        [companyId, arAcc.id, revAcc.id]
      );
    } finally {
      await setupClient.end();
    }

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
    await defaultPeriodService.createPeriod(
      companyId,
      { code: `${y}-${m}-SCV-${unique}`, startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}` },
      user.id
    );

    const supplier = await defaultSupplierService.createSupplier(companyId, { code: `SUP-${unique}`.slice(0, 20), nameAr: 'مورد الاختبار' }, user.id);
    const warehouse = await defaultWarehouseService.createWarehouse(companyId, { code: `WH-${unique}`.slice(0, 20), nameAr: 'مستودع رئيسي' }, user.id);
    const item = await defaultItemService.createItem(companyId, { code: `ITM-${unique}`.slice(0, 20), nameAr: 'صنف اختبار', uom: 'قطعة' }, user.id);
    await ensureTestCostingProfile(companyId, [item.id], user.id);
    const customer = await defaultCustomerService.createCustomer(companyId, { code: `CUST-${unique}`.slice(0, 20), nameAr: 'عميل الاختبار' }, user.id);

    // Receive qty 10 @ 60 -> Stock = 10, Inv GL += 600
    const grn = await defaultGrnService.createGrn(
      companyId,
      { supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ itemId: item.id, qty: 10, unitCost: 60 }] },
      user.id
    );
    await defaultGrnService.postGrn(companyId, grn.id, user.id);

    // Deliver qty 4 @ 60 -> Stock = 6
    const del = await defaultSalesDeliveryService.createDelivery(
      companyId,
      { customerId: customer.id, warehouseId: warehouse.id, lines: [{ itemId: item.id, qty: 4, unitPrice: 150, unitCost: 60 }] },
      user.id
    );
    const postedDel = await defaultSalesDeliveryService.postDelivery(companyId, del.id, user.id);
    const delLineId = postedDel.lines![0].id;

    // Create taxable + cost invoice draft (net 600 + 15% VAT 90 = gross 690, COGS = 4 * 60 = 240)
    const invTaxCogsDraft = await defaultSalesInvoiceService.createInvoice(
      companyId,
      {
        customerId: customer.id,
        deliveryId: postedDel.id,
        lines: [{ itemId: item.id, deliveryLineId: delLineId, qty: 4, unitPrice: 150, taxRate: 15 }],
      },
      user.id
    );

    // L1: Fail-closed before configuring VAT & COGS mappings
    let failClosedLive = false;
    try {
      await defaultSalesInvoiceService.postInvoice(companyId, invTaxCogsDraft.id, user.id);
    } catch (err) {
      if (err instanceof ValidationError) failClosedLive = true;
    }
    await check('L1: Live fail-closed rejects taxable/COGS invoice post before company_settings mapping is configured', failClosedLive);

    // Configure cogs_account_id & vat_payable_account_id on company_settings
    const mapClient = new pg.Client(buildPgConfig(adminPoolUrl, process.env));
    await mapClient.connect();
    try {
      await mapClient.query(
        `UPDATE company_settings
         SET cogs_account_id = $2, vat_payable_account_id = $3
         WHERE company_id = $1`,
        [companyId, cogsAcc.id, vatAcc.id]
      );
    } finally {
      await mapClient.end();
    }

    // L2: Invoice WITHOUT tax, WITHOUT delivery (net 200, tax 0, gross 200)
    const invNoTaxDraft = await defaultSalesInvoiceService.createInvoice(
      companyId,
      { customerId: customer.id, lines: [{ itemId: item.id, qty: 2, unitPrice: 100, taxRate: 0 }] },
      user.id
    );
    const postedNoTax = await defaultSalesInvoiceService.postInvoice(companyId, invNoTaxDraft.id, user.id);
    await check(
      'L2: Live non-tax invoice posts cleanly (subtotal=200, tax=0, total=200)',
      postedNoTax.status === 'posted' && postedNoTax.subtotal === 200 && postedNoTax.taxAmount === 0 && postedNoTax.totalAmount === 200
    );

    // L2a: invoice-level money fields are never silently ignored: a wrong taxAmount/subtotal is rejected,
    // a matching one is accepted (tax comes only from the lines)
    let wrongTaxRejected = false;
    try {
      await defaultSalesInvoiceService.createInvoice(
        companyId,
        { customerId: customer.id, taxAmount: 999, lines: [{ itemId: item.id, qty: 2, unitPrice: 100, taxRate: 15 }] } as any,
        user.id
      );
    } catch (err) {
      if (err instanceof ValidationError) wrongTaxRejected = true;
    }
    await check('L2a: invoice-level taxAmount that disagrees with the lines is rejected (not ignored)', wrongTaxRejected);
    const matchingTaxDraft = await defaultSalesInvoiceService.createInvoice(
      companyId,
      { customerId: customer.id, taxAmount: 30, subtotal: 200, lines: [{ itemId: item.id, qty: 2, unitPrice: 100, taxRate: 15 }] } as any,
      user.id
    );
    await check('L2a2: a matching invoice-level taxAmount/subtotal is accepted', Number(matchingTaxDraft.taxAmount) === 30 && Number(matchingTaxDraft.subtotal) === 200);

    // L2b: a draft created while the item was active must NOT post after the item is disabled
    const itemOff = await defaultItemService.createItem(companyId, { code: `OFF-${unique}`.slice(0, 20), nameAr: 'صنف سيعطل', uom: 'قطعة' }, user.id);
    const offDraft = await defaultSalesInvoiceService.createInvoice(
      companyId,
      { customerId: customer.id, lines: [{ itemId: itemOff.id, qty: 1, unitPrice: 50, taxRate: 0 }] },
      user.id
    );
    await defaultItemService.updateItem(companyId, itemOff.id, { isActive: false }, user.id);
    let offMsg = '';
    try {
      await defaultSalesInvoiceService.postInvoice(companyId, offDraft.id, user.id);
    } catch (e: any) {
      offMsg = String(e?.message || e);
    }
    await check('L2b: posting a draft that contains a disabled item is rejected with a clear message', offMsg.includes('معطّل'), offMsg);

    // L3: Post taxable + COGS invoice
    const postedTaxCogs = await defaultSalesInvoiceService.postInvoice(companyId, invTaxCogsDraft.id, user.id);
    await check(
      'L3: Live taxable+COGS invoice posts cleanly (subtotal=600, vat=90, total=690, cogs=240)',
      postedTaxCogs.status === 'posted' &&
        postedTaxCogs.subtotal === 600 &&
        postedTaxCogs.taxAmount === 90 &&
        postedTaxCogs.totalAmount === 690 &&
        postedTaxCogs.cogsAmount === 240
    );

    // L4: Verify GL account balances & stock balance in Postgres
    const checkClient = new pg.Client(buildPgConfig(adminPoolUrl, process.env));
    await checkClient.connect();
    try {
      const glRes = await checkClient.query<{ code: string; net_dr_cr: string }>(
        `SELECT a.code, ROUND(SUM(jl.debit - jl.credit), 2)::text as net_dr_cr
         FROM journal_lines jl
         INNER JOIN journal_entries je ON je.id = jl.entry_id AND je.company_id = jl.company_id
         INNER JOIN accounts a ON a.id = jl.account_id AND a.company_id = jl.company_id
         WHERE jl.company_id = $1 AND je.status = 'posted'
         GROUP BY a.code`,
        [companyId]
      );
      const glMap = new Map(glRes.rows.map((r) => [r.code, Number(r.net_dr_cr)]));
      const stockRes = await checkClient.query<{ qty: string }>(
        `SELECT qty::text as qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3`,
        [companyId, warehouse.id, item.id]
      );
      const stockQty = Number(stockRes.rows[0]?.qty ?? 0);

      const delMovRes = await checkClient.query<{ id: string; valuation_movement_id: string | null; linked_mov_id: string | null }>(
        `SELECT sdl.id, sdl.valuation_movement_id, ivm.id as linked_mov_id
         FROM sales_delivery_lines sdl
         INNER JOIN sales_delivery_notes sdn ON sdn.id = sdl.delivery_id AND sdn.company_id = sdl.company_id
         LEFT JOIN inv_valuation_movements ivm ON ivm.id = sdl.valuation_movement_id AND ivm.company_id = sdl.company_id
         WHERE sdl.company_id = $1 AND sdn.status = 'posted'`,
        [companyId]
      );
      const deliveryMovLinked =
        delMovRes.rows.length > 0 &&
        delMovRes.rows.every((r) => Boolean(r.valuation_movement_id) && Boolean(r.linked_mov_id));

      await check(
        'L4: GL balances (AR=+890, REV=-800, VAT=-90, COGS=+240, INV=+360), Stock (qty=6), and non-null sales_delivery_lines.valuation_movement_id match exactly',
        glMap.get('1200') === 890 &&
          glMap.get('4100') === -800 &&
          glMap.get('2150') === -90 &&
          glMap.get('5110') === 240 &&
          glMap.get('1130') === 360 &&
          stockQty === 6 &&
          deliveryMovLinked
      );
    } finally {
      await checkClient.end();
    }
  } catch (err) {
    console.error('[verifySalesCogsVat1] Live test error:', err);
    await check('Live Sales COGS & VAT suite execution', false, err instanceof Error ? err.message : String(err));
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

        await client.query('DELETE FROM inv_sales_cogs_reversals WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_sales_cogs_links WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_collections WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_invoice_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_delivery_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_delivery_notes WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_customers WHERE company_id = ANY($1::uuid[])', [companyIds]);
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
        await client.query('COMMIT');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          console.error('[cleanup] Rollback failed:', rbErr);
        }
        console.error('[cleanup] Failed cleaning up verifySalesCogsVat1:', cleanupErr);
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
  console.error('[verifySalesCogsVat1] Fatal error:', err);
  process.exit(1);
});
