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
import { defaultApOpenItemsService } from '../src/server/purchasing/apOpenItemsService.js';
import { defaultCustomerService } from '../src/server/sales/customerService.js';
import { defaultSalesDeliveryService } from '../src/server/sales/salesDeliveryService.js';
import { defaultSalesInvoiceService } from '../src/server/sales/salesInvoiceService.js';
import { defaultSalesReturnService } from '../src/server/sales/salesReturnService.js';
import { ValidationError } from '../src/server/http/errors.js';
import { MONEY_SCALE, COST_SCALE, QTY_SCALE, parseExactUnits, fromMinorUnits } from '../src/server/lib/numeric.js';
import { countRemainingTestInventoryRows } from './helpers/inventoryTestHarness.js';

console.log('================================================================================');
console.log('=== VERIFYING AN-ERP-R05 WP-3: VALUATION + INVENTORY + GL NUMERIC MATRIX      ===');
console.log('================================================================================');

interface ExpectedGlLine {
  accountId: string;
  debit: string;
  credit: string;
}

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

function normalizeMoneyStr(val: unknown): string {
  return fromMinorUnits(parseExactUnits(String(val ?? '0'), MONEY_SCALE, 'money'), MONEY_SCALE);
}

function normalizeCostStr(val: unknown): string {
  return fromMinorUnits(parseExactUnits(String(val ?? '0'), COST_SCALE, 'cost'), COST_SCALE);
}

function normalizeQtyStr(val: unknown): string {
  return fromMinorUnits(parseExactUnits(String(val ?? '0'), QTY_SCALE, 'qty'), QTY_SCALE);
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

async function verifyJournalEntryExact(
  companyId: string,
  entryId: string,
  expectedLines: ExpectedGlLine[],
  expectedStatus: string = 'posted'
): Promise<{ ok: boolean; detail: string }> {
  return await withTenantTransaction(companyId, async (tx) => {
    const hdrRes = await tx.query<{ id: string; status: string; period_id: string | null }>(
      `SELECT id, status, period_id FROM journal_entries WHERE company_id = $1 AND id = $2`,
      [companyId, entryId]
    );
    if (hdrRes.rows.length === 0) {
      return { ok: false, detail: `Journal entry ${entryId} missing` };
    }
    if (hdrRes.rows[0].status !== expectedStatus) {
      return { ok: false, detail: `Journal status ${hdrRes.rows[0].status} !== ${expectedStatus}` };
    }

    const linesRes = await tx.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit::text, credit::text
       FROM journal_lines
       WHERE company_id = $1 AND entry_id = $2`,
      [companyId, entryId]
    );
    const actualSorted = linesRes.rows
      .map((l) => `${l.account_id}|${normalizeMoneyStr(l.debit)}|${normalizeMoneyStr(l.credit)}`)
      .sort();
    const expectedSorted = expectedLines
      .map((l) => `${l.accountId}|${normalizeMoneyStr(l.debit)}|${normalizeMoneyStr(l.credit)}`)
      .sort();

    if (actualSorted.length !== expectedSorted.length) {
      return {
        ok: false,
        detail: `Line count mismatch (${actualSorted.length} vs ${expectedSorted.length}): actual=${JSON.stringify(actualSorted)} expected=${JSON.stringify(expectedSorted)}`,
      };
    }

    let sumDebitUnits = 0n;
    let sumCreditUnits = 0n;
    for (let i = 0; i < actualSorted.length; i++) {
      if (actualSorted[i] !== expectedSorted[i]) {
        return {
          ok: false,
          detail: `Line ${i} mismatch: actual=${actualSorted[i]} expected=${expectedSorted[i]}`,
        };
      }
      sumDebitUnits += parseExactUnits(linesRes.rows[i].debit, MONEY_SCALE, 'd');
      sumCreditUnits += parseExactUnits(linesRes.rows[i].credit, MONEY_SCALE, 'c');
    }

    if (sumDebitUnits !== sumCreditUnits) {
      return { ok: false, detail: `Entry ${entryId} unbalanced: Dr=${sumDebitUnits} Cr=${sumCreditUnits}` };
    }
    return { ok: true, detail: `OK (${actualSorted.length} exact lines balanced)` };
  });
}

async function getStockAndValuationSql(companyId: string, warehouseId: string, itemId: string) {
  return await withTenantTransaction(companyId, async (tx) => {
    const stockRes = await tx.query<{ qty: string }>(
      `SELECT COALESCE((SELECT qty::text FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3), '0') AS qty`,
      [companyId, warehouseId, itemId]
    );
    const valRes = await tx.query<{ quantity: string; unit_cost: string; total_cost: string }>(
      `SELECT
         COALESCE((SELECT quantity::text FROM inv_valuation_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3), '0') AS quantity,
         COALESCE((SELECT unit_cost::text FROM inv_valuation_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3), '0') AS unit_cost,
         COALESCE((SELECT total_cost::text FROM inv_valuation_balances WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3), '0') AS total_cost`,
      [companyId, warehouseId, itemId]
    );
    return {
      stockQty: normalizeQtyStr(stockRes.rows[0]?.qty ?? '0'),
      valQty: normalizeQtyStr(valRes.rows[0]?.quantity ?? '0'),
      valUnitCost: normalizeCostStr(valRes.rows[0]?.unit_cost ?? '0'),
      valTotalCost: normalizeCostStr(valRes.rows[0]?.total_cost ?? '0'),
    };
  });
}

async function run() {
  const rootDir = process.cwd();

  // S0: Registration in runFoundationBattery.ts & package.json + harness reuse check
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const selfSrc = fs.readFileSync(path.join(rootDir, 'scripts/verifyValuationNumericMatrix1.ts'), 'utf8');
  await check(
    'S0: verifyValuationNumericMatrix1.ts registered in runFoundationBattery.ts and package.json (test:valuation-numeric-matrix-1)',
    batterySrc.includes('scripts/verifyValuationNumericMatrix1.ts') &&
      pkgJson?.scripts?.['test:valuation-numeric-matrix-1'] === 'tsx scripts/verifyValuationNumericMatrix1.ts' &&
      selfSrc.includes('inventoryTestHarness') &&
      selfSrc.includes('assertLoopbackUrl')
  );

  // S0b: Numeric precision & period enforcement core definitions present
  const numericSrc = fs.readFileSync(path.join(rootDir, 'src/server/lib/numeric.ts'), 'utf8');
  const journalSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/accounting/journalService.ts'), 'utf8');
  await check(
    'S0b: Exact BigInt scale constants (QTY_SCALE=4, COST_SCALE=4, MONEY_SCALE=2) and closed-period guard present',
    numericSrc.includes('QTY_SCALE = 4') &&
      numericSrc.includes('COST_SCALE = 4') &&
      numericSrc.includes('MONEY_SCALE = 2') &&
      journalSvcSrc.includes('isClosed') &&
      journalSvcSrc.includes('findCoveringDateForUpdate')
  );

  // Live Loopback PostgreSQL Matrix Execution
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live WP-3 numeric matrix integration checks are BLOCKED.');
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
      username: `vnmx_usr_${unique}`,
      passwordHash: 'dummy_hash_vnmx_usr',
      role: 'platform_admin',
    });
    userIds.push(user.id);

    const approverUser = await userRepo.createUser({
      username: `vnmx_app_${unique}`,
      passwordHash: 'dummy_hash_vnmx_app',
      role: 'platform_admin',
    });
    userIds.push(approverUser.id);

    const comp1 = await companyRepo.create({
      code: `NMX1-${unique}`.slice(0, 20),
      nameAr: `شركة مصفوفة التقييم ${unique}`,
      createdBy: user.id,
    });
    companyIds.push(comp1.id);
    const companyId = comp1.id;

    // Isolated CoA for matrix company
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

    // Open current month period + Closed previous month period
    const now = new Date();
    const curYear = now.getUTCFullYear();
    const curMonthIdx = now.getUTCMonth();
    const curMonthStr = String(curMonthIdx + 1).padStart(2, '0');
    const curLastDay = String(new Date(Date.UTC(curYear, curMonthIdx + 1, 0)).getUTCDate()).padStart(2, '0');
    const todayStr = `${curYear}-${curMonthStr}-${String(now.getUTCDate()).padStart(2, '0')}`;

    const prevDateObj = new Date(Date.UTC(curYear, curMonthIdx - 1, 15));
    const prevYear = prevDateObj.getUTCFullYear();
    const prevMonthIdx = prevDateObj.getUTCMonth();
    const prevMonthStr = String(prevMonthIdx + 1).padStart(2, '0');
    const prevLastDay = String(new Date(Date.UTC(prevYear, prevMonthIdx + 1, 0)).getUTCDate()).padStart(2, '0');
    const closedDateStr = `${prevYear}-${prevMonthStr}-15`;

    const openPeriod = await defaultPeriodService.createPeriod(
      companyId,
      { code: `${curYear}-${curMonthStr}-NMX`, startDate: `${curYear}-${curMonthStr}-01`, endDate: `${curYear}-${curMonthStr}-${curLastDay}` },
      user.id
    );
    const prevPeriodDraft = await defaultPeriodService.createPeriod(
      companyId,
      { code: `${prevYear}-${prevMonthStr}-NMX`, startDate: `${prevYear}-${prevMonthStr}-01`, endDate: `${prevYear}-${prevMonthStr}-${prevLastDay}` },
      user.id
    );
    const closedPeriod = await defaultPeriodService.closePeriod(companyId, prevPeriodDraft.id, user.id);

    const supplier = await defaultSupplierService.createSupplier(companyId, { code: `SUP-NMX-${unique}`.slice(0, 20), nameAr: 'مورد المصفوفة' }, user.id);
    const customer = await defaultCustomerService.createCustomer(companyId, { code: `CUS-NMX-${unique}`.slice(0, 20), nameAr: 'عميل المصفوفة' }, user.id);
    const wh1 = await defaultWarehouseService.createWarehouse(companyId, { code: `WH1-${unique}`.slice(0, 20), nameAr: 'مستودع رئيسي' }, user.id);
    const wh2 = await defaultWarehouseService.createWarehouse(companyId, { code: `WH2-${unique}`.slice(0, 20), nameAr: 'مستودع فرعي' }, user.id);
    warehouseIds.push(wh1.id, wh2.id);

    const fifoProfile = await defaultInventoryValuationRepository.createProfile(companyId, {
      name: 'FIFO Matrix Profile',
      costingMethod: 'FIFO',
      isDefault: true,
    });
    const maProfile = await defaultInventoryValuationRepository.createProfile(companyId, {
      name: 'MA Matrix Profile',
      costingMethod: 'PERPETUAL_MOVING_AVERAGE',
      isDefault: false,
    });

    const mkItem = async (suffix: string, profileId: string) => {
      const it = await defaultItemService.createItem(companyId, { code: `${suffix}-${unique}`.slice(0, 20), nameAr: `صنف ${suffix}`, uom: 'قطعة' }, user.id);
      itemIds.push(it.id);
      await defaultInventoryValuationRepository.assignItemProfile(companyId, it.id, profileId, user.id);
      return it;
    };

    const itemFifo = await mkItem('FIFO', fifoProfile.id);
    const itemMa = await mkItem('MA', maProfile.id);
    const itemRetSales = await mkItem('RETS', fifoProfile.id);
    const itemRetPurch = await mkItem('RETP', fifoProfile.id);
    const itemCancel = await mkItem('CANC', fifoProfile.id);
    const itemFrac = await mkItem('FRAC', fifoProfile.id);
    const itemGuard = await mkItem('GARD', fifoProfile.id);
    const itemPeriod = await mkItem('PERD', fifoProfile.id);

    // =========================================================================
    // SCENARIO 1: FIFO — 5@10 + 5@20, Issue 6 => COGS=70 (5@10 + 1@20), Rem=4@20=80
    // =========================================================================
    const S1_EXPECTED = {
      grn1: { qty: '5.0000', unitCost: '10.0000', totalCost: '50.0000', gl: [{ accountId: invAcc.id, debit: '50.00', credit: '0.00' }, { accountId: clrAcc.id, debit: '0.00', credit: '50.00' }] },
      grn2: { qty: '5.0000', unitCost: '20.0000', totalCost: '100.0000', balQty: '10.0000', balTotal: '150.0000', balUnit: '15.0000', gl: [{ accountId: invAcc.id, debit: '100.00', credit: '0.00' }, { accountId: clrAcc.id, debit: '0.00', credit: '100.00' }] },
      del: {
        qty: '6.0000',
        totalCost: '70.0000',
        unitCost: '11.6667',
        alloc1: { qty: '5.0000', unitCost: '10.0000', cost: '50.0000' },
        alloc2: { qty: '1.0000', unitCost: '20.0000', cost: '20.0000' },
        remLayer1: { qty: '0.0000', totalCost: '0.0000', isExhausted: true },
        remLayer2: { qty: '4.0000', unitCost: '20.0000', totalCost: '80.0000', isExhausted: false },
        remBal: { qty: '4.0000', unitCost: '20.0000', totalCost: '80.0000' },
      },
      sinv: {
        subtotal: 180,
        taxAmount: 27,
        totalAmount: 207,
        cogsAmount: 70,
        arOpen: 207,
        gl: [
          { accountId: arAcc.id, debit: '207.00', credit: '0.00' },
          { accountId: revAcc.id, debit: '0.00', credit: '180.00' },
          { accountId: vatAcc.id, debit: '0.00', credit: '27.00' },
          { accountId: cogsAcc.id, debit: '70.00', credit: '0.00' },
          { accountId: invAcc.id, debit: '0.00', credit: '70.00' },
        ],
      },
    };

    const s1Grn1 = await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemFifo.id, qty: 5, unitCost: 10 }] }, user.id)).id,
      user.id
    );
    const s1Grn1Gl = await verifyJournalEntryExact(companyId, s1Grn1.journalEntryId!, S1_EXPECTED.grn1.gl);

    const s1Grn2 = await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemFifo.id, qty: 5, unitCost: 20 }] }, user.id)).id,
      user.id
    );
    const s1Grn2Gl = await verifyJournalEntryExact(companyId, s1Grn2.journalEntryId!, S1_EXPECTED.grn2.gl);
    const s1PreBal = await getStockAndValuationSql(companyId, wh1.id, itemFifo.id);

    const s1Del = await defaultSalesDeliveryService.postDelivery(
      companyId,
      (await defaultSalesDeliveryService.createDelivery(companyId, { customerId: customer.id, warehouseId: wh1.id, lines: [{ itemId: itemFifo.id, qty: 6, unitPrice: 30 }] }, user.id)).id,
      user.id
    );
    const s1DelLine = s1Del.lines![0];
    const s1PostBal = await getStockAndValuationSql(companyId, wh1.id, itemFifo.id);

    const s1SqlCheck = await withTenantTransaction(companyId, async (tx) => {
      const layersRes = await tx.query<{ remaining_qty: string; unit_cost: string; total_cost: string; is_exhausted: boolean; source_id: string }>(
        `SELECT remaining_qty::text, unit_cost::text, total_cost::text, is_exhausted, source_id
         FROM inv_cost_layers
         WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3
         ORDER BY created_at ASC, id ASC`,
        [companyId, wh1.id, itemFifo.id]
      );
      const allocRes = await tx.query<{ allocated_qty: string; unit_cost: string; allocated_cost: string; cost_layer_id: string }>(
        `SELECT a.allocated_qty::text, a.unit_cost::text, a.allocated_cost::text, a.cost_layer_id
         FROM inv_cost_allocations a
         JOIN inv_cost_layers l ON l.company_id = a.company_id AND l.id = a.cost_layer_id
         WHERE a.company_id = $1 AND a.valuation_movement_id = $2
         ORDER BY l.created_at ASC, l.id ASC`,
        [companyId, s1DelLine.valuationMovementId]
      );
      return { layers: layersRes.rows, allocs: allocRes.rows };
    });

    const s1Sinv = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id,
        deliveryId: s1Del.id,
        lines: [{ itemId: itemFifo.id, deliveryLineId: s1DelLine.id, qty: 6, unitPrice: 30, taxRate: 15 }],
      }, user.id)).id,
      user.id
    );
    const s1SinvGl = await verifyJournalEntryExact(companyId, s1Sinv.journalEntryId!, S1_EXPECTED.sinv.gl);
    const s1ArRows = await defaultSalesInvoiceService.listOutstandingInvoices(companyId, customer.id);
    const s1ArOpen = s1ArRows.find((r: any) => r.invoiceId === s1Sinv.id)?.remainingOpenAmount;

    await check(
      'Scenario 1 (FIFO): 5@10 + 5@20, issue 6 consumes (5@10 + 1@20 = 70), leaves 4@20 = 80 in SQL layers, balances & GL',
      s1Grn1Gl.ok &&
        s1Grn2Gl.ok &&
        s1PreBal.valQty === S1_EXPECTED.grn2.balQty &&
        s1PreBal.valTotalCost === S1_EXPECTED.grn2.balTotal &&
        s1PreBal.valUnitCost === S1_EXPECTED.grn2.balUnit &&
        normalizeCostStr(s1DelLine.frozenTotalCost) === S1_EXPECTED.del.totalCost &&
        normalizeCostStr(s1DelLine.unitCost) === S1_EXPECTED.del.unitCost &&
        s1SqlCheck.allocs.length === 2 &&
        normalizeQtyStr(s1SqlCheck.allocs[0].allocated_qty) === S1_EXPECTED.del.alloc1.qty &&
        normalizeCostStr(s1SqlCheck.allocs[0].unit_cost) === S1_EXPECTED.del.alloc1.unitCost &&
        normalizeCostStr(s1SqlCheck.allocs[0].allocated_cost) === S1_EXPECTED.del.alloc1.cost &&
        normalizeQtyStr(s1SqlCheck.allocs[1].allocated_qty) === S1_EXPECTED.del.alloc2.qty &&
        normalizeCostStr(s1SqlCheck.allocs[1].unit_cost) === S1_EXPECTED.del.alloc2.unitCost &&
        normalizeCostStr(s1SqlCheck.allocs[1].allocated_cost) === S1_EXPECTED.del.alloc2.cost &&
        s1SqlCheck.layers.length === 2 &&
        normalizeQtyStr(s1SqlCheck.layers[0].remaining_qty) === S1_EXPECTED.del.remLayer1.qty &&
        normalizeCostStr(s1SqlCheck.layers[0].total_cost) === S1_EXPECTED.del.remLayer1.totalCost &&
        s1SqlCheck.layers[0].is_exhausted === S1_EXPECTED.del.remLayer1.isExhausted &&
        normalizeQtyStr(s1SqlCheck.layers[1].remaining_qty) === S1_EXPECTED.del.remLayer2.qty &&
        normalizeCostStr(s1SqlCheck.layers[1].unit_cost) === S1_EXPECTED.del.remLayer2.unitCost &&
        normalizeCostStr(s1SqlCheck.layers[1].total_cost) === S1_EXPECTED.del.remLayer2.totalCost &&
        s1SqlCheck.layers[1].is_exhausted === S1_EXPECTED.del.remLayer2.isExhausted &&
        s1PostBal.stockQty === S1_EXPECTED.del.remBal.qty &&
        s1PostBal.valQty === S1_EXPECTED.del.remBal.qty &&
        s1PostBal.valTotalCost === S1_EXPECTED.del.remBal.totalCost &&
        s1PostBal.valUnitCost === S1_EXPECTED.del.remBal.unitCost &&
        s1Sinv.subtotal === S1_EXPECTED.sinv.subtotal &&
        s1Sinv.taxAmount === S1_EXPECTED.sinv.taxAmount &&
        s1Sinv.totalAmount === S1_EXPECTED.sinv.totalAmount &&
        s1Sinv.cogsAmount === S1_EXPECTED.sinv.cogsAmount &&
        s1ArOpen === S1_EXPECTED.sinv.arOpen &&
        s1SinvGl.ok
    );

    // =========================================================================
    // SCENARIO 2: PERPETUAL_MOVING_AVERAGE — PPV before consumption, after transfer & consumption
    // =========================================================================
    const S2_EXPECTED = {
      step1GrnA: { qty: '10.0000', unitCost: '10.0000', totalCost: '100.0000', gl: [{ accountId: invAcc.id, debit: '100.00', credit: '0.00' }, { accountId: clrAcc.id, debit: '0.00', credit: '100.00' }] },
      step2PpvPre: {
        qty: '10.0000',
        unitCost: '14.0000',
        totalCost: '140.0000',
        adjRem: '40.0000',
        adjCons: '0.0000',
        apOpen: 140,
        gl: [
          { accountId: clrAcc.id, debit: '100.00', credit: '0.00' },
          { accountId: invAcc.id, debit: '40.00', credit: '0.00' },
          { accountId: apAcc.id, debit: '0.00', credit: '140.00' },
        ],
      },
      step3GrnB: {
        wh1Qty: '20.0000',
        wh1UnitCost: '20.0000',
        wh1TotalCost: '400.0000',
        gl: [{ accountId: invAcc.id, debit: '260.00', credit: '0.00' }, { accountId: clrAcc.id, debit: '0.00', credit: '260.00' }],
      },
      step4Transfer: {
        transferCost: 120,
        transferUnitCost: 20,
        wh1Qty: '14.0000',
        wh1UnitCost: '20.0000',
        wh1TotalCost: '280.0000',
        wh2Qty: '6.0000',
        wh2UnitCost: '20.0000',
        wh2TotalCost: '120.0000',
      },
      step5Issue: {
        wh1Qty: '10.0000',
        wh1UnitCost: '20.0000',
        wh1TotalCost: '200.0000',
        gl: [{ accountId: adjAcc.id, debit: '80.00', credit: '0.00' }, { accountId: invAcc.id, debit: '0.00', credit: '80.00' }],
      },
      step6PpvPost: {
        wh1Qty: '10.0000',
        wh1UnitCost: '22.5000',
        wh1TotalCost: '225.0000',
        wh2Qty: '6.0000',
        wh2UnitCost: '22.5000',
        wh2TotalCost: '135.0000',
        adjTotalRem: '40.0000',
        adjTotalCons: '10.0000',
        apOpen: 310,
        gl: [
          { accountId: clrAcc.id, debit: '260.00', credit: '0.00' },
          { accountId: invAcc.id, debit: '40.00', credit: '0.00' },
          { accountId: cogsAcc.id, debit: '10.00', credit: '0.00' },
          { accountId: apAcc.id, debit: '0.00', credit: '310.00' },
        ],
      },
    };

    const s2GrnA = await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemMa.id, qty: 10, unitCost: 10 }] }, user.id)).id,
      user.id
    );
    const s2GrnAGl = await verifyJournalEntryExact(companyId, s2GrnA.journalEntryId!, S2_EXPECTED.step1GrnA.gl);
    const s2Bal1 = await getStockAndValuationSql(companyId, wh1.id, itemMa.id);

    // PPV BEFORE consumption on GRN A (10 -> 14, +40%)
    const s2PinvA = await defaultPurchInvoiceService.createInvoice(
      companyId,
      { supplierId: supplier.id, supplierInvoiceNo: `PINV-MA-A-${unique}`.slice(0, 30), lines: [{ grnLineId: s2GrnA.lines![0].id, qty: 10, unitCost: 14 }] },
      user.id
    );
    const s2ExcA = await defaultPriceVarianceExceptionService.requestException(companyId, s2PinvA.id, 'تعديل سعر قبل الصرف', user.id);
    await defaultPriceVarianceExceptionService.approveException(companyId, s2ExcA.id, 'موافقة مستقلة', approverUser.id);
    const s2PostedPinvA = await defaultPurchInvoiceService.postInvoice(companyId, s2PinvA.id, user.id);
    const s2PinvAGl = await verifyJournalEntryExact(companyId, s2PostedPinvA.journalEntryId!, S2_EXPECTED.step2PpvPre.gl);
    const s2Bal2 = await getStockAndValuationSql(companyId, wh1.id, itemMa.id);
    const s2ApA = (await defaultApOpenItemsService.listOpenItems(companyId, supplier.id)).find((r) => r.invoiceId === s2PinvA.id);

    // Second receipt GRN B: 10 @ 26 => pool = (140 + 260) / 20 = 20.0000
    const s2GrnB = await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemMa.id, qty: 10, unitCost: 26 }] }, user.id)).id,
      user.id
    );
    const s2GrnBGl = await verifyJournalEntryExact(companyId, s2GrnB.journalEntryId!, S2_EXPECTED.step3GrnB.gl);
    const s2Bal3 = await getStockAndValuationSql(companyId, wh1.id, itemMa.id);

    // Transfer 6 from WH1 -> WH2 (MA preserved at 20.0000 in both warehouses)
    const s2Transfer = await defaultStockService.transfer(
      companyId,
      { sourceWarehouseId: wh1.id, destWarehouseId: wh2.id, itemId: itemMa.id, qty: 6, memo: 'تحويل MA' },
      user.id
    );
    const s2Bal4Wh1 = await getStockAndValuationSql(companyId, wh1.id, itemMa.id);
    const s2Bal4Wh2 = await getStockAndValuationSql(companyId, wh2.id, itemMa.id);

    // Consume 4 from WH1 (4 @ 20 = 80)
    const s2Issue = await defaultStockService.issueStock(
      companyId,
      { warehouseId: wh1.id, itemId: itemMa.id, qty: 4, reason: 'صرف اختبار MA' },
      user.id
    );
    const s2IssueGl = await verifyJournalEntryExact(companyId, s2Issue.journalEntryId!, S2_EXPECTED.step5Issue.gl);
    const s2Bal5Wh1 = await getStockAndValuationSql(companyId, wh1.id, itemMa.id);

    // PPV AFTER consumption AND transfer on GRN B (26 -> 31, variance = +50: +40 remaining [25 wh1 + 15 wh2], +10 consumed COGS)
    const s2PinvB = await defaultPurchInvoiceService.createInvoice(
      companyId,
      { supplierId: supplier.id, supplierInvoiceNo: `PINV-MA-B-${unique}`.slice(0, 30), lines: [{ grnLineId: s2GrnB.lines![0].id, qty: 10, unitCost: 31 }] },
      user.id
    );
    const s2ExcB = await defaultPriceVarianceExceptionService.requestException(companyId, s2PinvB.id, 'تعديل سعر بعد الصرف والتحويل', user.id);
    await defaultPriceVarianceExceptionService.approveException(companyId, s2ExcB.id, 'موافقة مستقلة ب', approverUser.id);
    const s2PostedPinvB = await defaultPurchInvoiceService.postInvoice(companyId, s2PinvB.id, user.id);
    const s2PinvBGl = await verifyJournalEntryExact(companyId, s2PostedPinvB.journalEntryId!, S2_EXPECTED.step6PpvPost.gl);
    const s2Bal6Wh1 = await getStockAndValuationSql(companyId, wh1.id, itemMa.id);
    const s2Bal6Wh2 = await getStockAndValuationSql(companyId, wh2.id, itemMa.id);
    const s2ApB = (await defaultApOpenItemsService.listOpenItems(companyId, supplier.id)).find((r) => r.invoiceId === s2PinvB.id);

    const s2AdjSql = await withTenantTransaction(companyId, async (tx) => {
      const aRes = await tx.query<{ rem: string; cons: string }>(
        `SELECT COALESCE(SUM(remaining_allocation), 0)::text AS rem, COALESCE(SUM(consumed_allocation), 0)::text AS cons
         FROM inv_cost_adjustments WHERE company_id = $1 AND invoice_id = $2`,
        [companyId, s2PinvB.id]
      );
      const preRes = await tx.query<{ rem: string; cons: string }>(
        `SELECT COALESCE(SUM(remaining_allocation), 0)::text AS rem, COALESCE(SUM(consumed_allocation), 0)::text AS cons
         FROM inv_cost_adjustments WHERE company_id = $1 AND invoice_id = $2`,
        [companyId, s2PinvA.id]
      );
      return {
        preRem: normalizeCostStr(preRes.rows[0]?.rem),
        preCons: normalizeCostStr(preRes.rows[0]?.cons),
        postRem: normalizeCostStr(aRes.rows[0]?.rem),
        postCons: normalizeCostStr(aRes.rows[0]?.cons),
      };
    });

    await check(
      'Scenario 2 (MA): PPV before consumption (MA=14), pool (MA=20), transfer WH1->WH2, issue 4, PPV after transfer/issue (WH1=10@22.5=225, WH2=6@22.5=135, COGS=+10)',
      s2GrnAGl.ok &&
        s2Bal1.valUnitCost === S2_EXPECTED.step1GrnA.unitCost &&
        s2Bal1.valTotalCost === S2_EXPECTED.step1GrnA.totalCost &&
        s2PinvAGl.ok &&
        s2Bal2.valQty === S2_EXPECTED.step2PpvPre.qty &&
        s2Bal2.valUnitCost === S2_EXPECTED.step2PpvPre.unitCost &&
        s2Bal2.valTotalCost === S2_EXPECTED.step2PpvPre.totalCost &&
        s2AdjSql.preRem === S2_EXPECTED.step2PpvPre.adjRem &&
        s2AdjSql.preCons === S2_EXPECTED.step2PpvPre.adjCons &&
        s2ApA?.remainingOpenAmount === S2_EXPECTED.step2PpvPre.apOpen &&
        s2GrnBGl.ok &&
        s2Bal3.valQty === S2_EXPECTED.step3GrnB.wh1Qty &&
        s2Bal3.valUnitCost === S2_EXPECTED.step3GrnB.wh1UnitCost &&
        s2Bal3.valTotalCost === S2_EXPECTED.step3GrnB.wh1TotalCost &&
        s2Transfer.totalCost === S2_EXPECTED.step4Transfer.transferCost &&
        s2Transfer.unitCost === S2_EXPECTED.step4Transfer.transferUnitCost &&
        s2Bal4Wh1.valQty === S2_EXPECTED.step4Transfer.wh1Qty &&
        s2Bal4Wh1.valUnitCost === S2_EXPECTED.step4Transfer.wh1UnitCost &&
        s2Bal4Wh1.valTotalCost === S2_EXPECTED.step4Transfer.wh1TotalCost &&
        s2Bal4Wh2.valQty === S2_EXPECTED.step4Transfer.wh2Qty &&
        s2Bal4Wh2.valUnitCost === S2_EXPECTED.step4Transfer.wh2UnitCost &&
        s2Bal4Wh2.valTotalCost === S2_EXPECTED.step4Transfer.wh2TotalCost &&
        s2IssueGl.ok &&
        s2Bal5Wh1.valQty === S2_EXPECTED.step5Issue.wh1Qty &&
        s2Bal5Wh1.valUnitCost === S2_EXPECTED.step5Issue.wh1UnitCost &&
        s2Bal5Wh1.valTotalCost === S2_EXPECTED.step5Issue.wh1TotalCost &&
        s2PinvBGl.ok &&
        s2Bal6Wh1.valQty === S2_EXPECTED.step6PpvPost.wh1Qty &&
        s2Bal6Wh1.valUnitCost === S2_EXPECTED.step6PpvPost.wh1UnitCost &&
        s2Bal6Wh1.valTotalCost === S2_EXPECTED.step6PpvPost.wh1TotalCost &&
        s2Bal6Wh2.valQty === S2_EXPECTED.step6PpvPost.wh2Qty &&
        s2Bal6Wh2.valUnitCost === S2_EXPECTED.step6PpvPost.wh2UnitCost &&
        s2Bal6Wh2.valTotalCost === S2_EXPECTED.step6PpvPost.wh2TotalCost &&
        s2AdjSql.postRem === S2_EXPECTED.step6PpvPost.adjTotalRem &&
        s2AdjSql.postCons === S2_EXPECTED.step6PpvPost.adjTotalCons &&
        s2ApB?.remainingOpenAmount === S2_EXPECTED.step6PpvPost.apOpen
    );

    // =========================================================================
    // SCENARIO 3: Partial then Full Return (Sales + Purchase) + Over-Return Rejection
    // =========================================================================
    const S3_EXPECTED = {
      salesInit: { arOpen: 460, whQty: '6.0000', whTotal: '150.0000' },
      salesRet1: {
        subtotal: 100, taxAmount: 15, totalAmount: 115, cogsAmount: 25,
        cumReturnedQty: '1.0000', cumReturnedTotal: '115.00', arOpenAfter: 345, whQty: '7.0000', whTotal: '175.0000',
        gl: [
          { accountId: revAcc.id, debit: '100.00', credit: '0.00' },
          { accountId: vatAcc.id, debit: '15.00', credit: '0.00' },
          { accountId: arAcc.id, debit: '0.00', credit: '115.00' },
          { accountId: invAcc.id, debit: '25.00', credit: '0.00' },
          { accountId: cogsAcc.id, debit: '0.00', credit: '25.00' },
        ],
      },
      salesRet2: {
        subtotal: 300, taxAmount: 45, totalAmount: 345, cogsAmount: 75,
        cumReturnedQty: '4.0000', cumReturnedTotal: '460.00', whQty: '10.0000', whTotal: '250.0000',
        gl: [
          { accountId: revAcc.id, debit: '300.00', credit: '0.00' },
          { accountId: vatAcc.id, debit: '45.00', credit: '0.00' },
          { accountId: arAcc.id, debit: '0.00', credit: '345.00' },
          { accountId: invAcc.id, debit: '75.00', credit: '0.00' },
          { accountId: cogsAcc.id, debit: '0.00', credit: '75.00' },
        ],
      },
      purchRet1: {
        qty: 2, amount: '80.00', cumQty: '2.0000', apOpenAfter: 120, whQty: '3.0000', whTotal: '120.0000',
        gl: [{ accountId: apAcc.id, debit: '80.00', credit: '0.00' }, { accountId: invAcc.id, debit: '0.00', credit: '80.00' }],
      },
      purchRet2: {
        qty: 3, amount: '120.00', cumQty: '5.0000', apOpenAfter: 0, whQty: '0.0000', whTotal: '0.0000',
        gl: [{ accountId: apAcc.id, debit: '120.00', credit: '0.00' }, { accountId: invAcc.id, debit: '0.00', credit: '120.00' }],
      },
    };

    // 3A: Sales partial -> over-return rejected -> full -> over-return rejected
    await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemRetSales.id, qty: 10, unitCost: 25 }] }, user.id)).id,
      user.id
    );
    const s3Del = await defaultSalesDeliveryService.postDelivery(
      companyId,
      (await defaultSalesDeliveryService.createDelivery(companyId, { customerId: customer.id, warehouseId: wh1.id, lines: [{ itemId: itemRetSales.id, qty: 4, unitPrice: 100 }] }, user.id)).id,
      user.id
    );
    const s3Sinv = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id,
        deliveryId: s3Del.id,
        lines: [{ itemId: itemRetSales.id, deliveryLineId: s3Del.lines![0].id, qty: 4, unitPrice: 100, taxRate: 15 }],
      }, user.id)).id,
      user.id
    );
    const s3SinvLineId = s3Sinv.lines![0].id;
    const s3BalInit = await getStockAndValuationSql(companyId, wh1.id, itemRetSales.id);
    const s3ArInit = (await defaultSalesInvoiceService.listOutstandingInvoices(companyId, customer.id)).find((r: any) => r.invoiceId === s3Sinv.id)?.remainingOpenAmount;

    const s3Ret1 = await defaultSalesReturnService.postReturn(
      companyId,
      (await defaultSalesReturnService.createReturn(companyId, {
        customerId: customer.id, invoiceId: s3Sinv.id, warehouseId: wh1.id, reason: 'مرتجع جزئي أول', lines: [{ invoiceLineId: s3SinvLineId, qty: 1 }],
      }, user.id)).id,
      user.id
    );
    const s3Ret1Gl = await verifyJournalEntryExact(companyId, s3Ret1.journalEntryId!, S3_EXPECTED.salesRet1.gl);
    const s3Bal1 = await getStockAndValuationSql(companyId, wh1.id, itemRetSales.id);
    const s3Ar1 = (await defaultSalesInvoiceService.listOutstandingInvoices(companyId, customer.id)).find((r: any) => r.invoiceId === s3Sinv.id)?.remainingOpenAmount;

    const s3Over1 = await expectValidationError(() =>
      defaultSalesReturnService.createReturn(companyId, {
        customerId: customer.id, invoiceId: s3Sinv.id, warehouseId: wh1.id, lines: [{ invoiceLineId: s3SinvLineId, qty: 3.5 }],
      }, user.id)
    );

    const s3Ret2 = await defaultSalesReturnService.postReturn(
      companyId,
      (await defaultSalesReturnService.createReturn(companyId, {
        customerId: customer.id, invoiceId: s3Sinv.id, warehouseId: wh1.id, reason: 'استكمال المرتجع بالكامل', lines: [{ invoiceLineId: s3SinvLineId, qty: 3 }],
      }, user.id)).id,
      user.id
    );
    const s3Ret2Gl = await verifyJournalEntryExact(companyId, s3Ret2.journalEntryId!, S3_EXPECTED.salesRet2.gl);
    const s3Bal2 = await getStockAndValuationSql(companyId, wh1.id, itemRetSales.id);
    const s3Ar2 = (await defaultSalesInvoiceService.listOutstandingInvoices(companyId, customer.id)).find((r: any) => r.invoiceId === s3Sinv.id);

    const s3Over2 = await expectValidationError(() =>
      defaultSalesReturnService.createReturn(companyId, {
        customerId: customer.id, invoiceId: s3Sinv.id, warehouseId: wh1.id, lines: [{ invoiceLineId: s3SinvLineId, qty: 1 }],
      }, user.id)
    );

    const s3SalesCumSql = await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<{ qty: string; amt: string }>(
        `SELECT COALESCE(SUM(srl.qty), 0)::text AS qty, COALESCE(SUM(srl.line_total), 0)::text AS amt
         FROM sales_return_lines srl JOIN sales_returns sr ON sr.id = srl.return_id AND sr.company_id = srl.company_id
         WHERE sr.company_id = $1 AND sr.invoice_id = $2 AND sr.status = 'posted'`,
        [companyId, s3Sinv.id]
      );
      return { qty: normalizeQtyStr(r.rows[0]?.qty), amt: normalizeMoneyStr(r.rows[0]?.amt) };
    });

    // 3B: Purchasing partial -> over-return rejected -> full -> over-return rejected
    const s3PGrn = await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemRetPurch.id, qty: 5, unitCost: 40 }] }, user.id)).id,
      user.id
    );
    const s3PGrnLineId = s3PGrn.lines![0].id;
    const s3Pinv = await defaultPurchInvoiceService.postInvoice(
      companyId,
      (await defaultPurchInvoiceService.createInvoice(companyId, {
        supplierId: supplier.id, supplierInvoiceNo: `PINV-RET-${unique}`.slice(0, 30), lines: [{ grnLineId: s3PGrnLineId, qty: 5, unitCost: 40 }],
      }, user.id)).id,
      user.id
    );

    const s3Pret1 = await defaultPurchReturnService.postReturn(
      companyId,
      (await defaultPurchReturnService.createReturn(companyId, {
        supplierId: supplier.id, warehouseId: wh1.id, grnId: s3PGrn.id, invoiceId: s3Pinv.id, lines: [{ grnLineId: s3PGrnLineId, qty: 2, unitCost: 40 }],
      }, user.id)).id,
      user.id
    );
    const s3Pret1Gl = await verifyJournalEntryExact(companyId, s3Pret1.journalEntryId!, S3_EXPECTED.purchRet1.gl);
    const s3PBal1 = await getStockAndValuationSql(companyId, wh1.id, itemRetPurch.id);
    const s3Ap1 = (await defaultApOpenItemsService.listOpenItems(companyId, supplier.id)).find((r) => r.invoiceId === s3Pinv.id);

    const s3POver1 = await expectValidationError(() =>
      defaultPurchReturnService.createReturn(companyId, {
        supplierId: supplier.id, warehouseId: wh1.id, grnId: s3PGrn.id, invoiceId: s3Pinv.id, lines: [{ grnLineId: s3PGrnLineId, qty: 4, unitCost: 40 }],
      }, user.id)
    );

    const s3Pret2 = await defaultPurchReturnService.postReturn(
      companyId,
      (await defaultPurchReturnService.createReturn(companyId, {
        supplierId: supplier.id, warehouseId: wh1.id, grnId: s3PGrn.id, invoiceId: s3Pinv.id, lines: [{ grnLineId: s3PGrnLineId, qty: 3, unitCost: 40 }],
      }, user.id)).id,
      user.id
    );
    const s3Pret2Gl = await verifyJournalEntryExact(companyId, s3Pret2.journalEntryId!, S3_EXPECTED.purchRet2.gl);
    const s3PBal2 = await getStockAndValuationSql(companyId, wh1.id, itemRetPurch.id);
    const s3Ap2 = (await defaultApOpenItemsService.listOpenItems(companyId, supplier.id)).find((r) => r.invoiceId === s3Pinv.id);

    const s3POver2 = await expectValidationError(() =>
      defaultPurchReturnService.createReturn(companyId, {
        supplierId: supplier.id, warehouseId: wh1.id, grnId: s3PGrn.id, invoiceId: s3Pinv.id, lines: [{ grnLineId: s3PGrnLineId, qty: 1, unitCost: 40 }],
      }, user.id)
    );

    const s3PurchCumSql = await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<{ qty: string }>(
        `SELECT COALESCE(SUM(prl.qty), 0)::text AS qty
         FROM purch_return_lines prl JOIN purch_returns pr ON pr.id = prl.return_id AND pr.company_id = prl.company_id
         WHERE pr.company_id = $1 AND prl.grn_line_id = $2 AND pr.status = 'posted'`,
        [companyId, s3PGrnLineId]
      );
      return normalizeQtyStr(r.rows[0]?.qty);
    });

    await check(
      'Scenario 3 (Partial -> Full Returns & Over-Return Block): Cumulative Sales Return (1->4=460, AR 460->345->0) & Purchase Return (2->5=200, AP 200->120->0)',
      s3ArInit === S3_EXPECTED.salesInit.arOpen &&
        s3BalInit.valQty === S3_EXPECTED.salesInit.whQty &&
        s3BalInit.valTotalCost === S3_EXPECTED.salesInit.whTotal &&
        s3Ret1.subtotal === S3_EXPECTED.salesRet1.subtotal &&
        s3Ret1.taxAmount === S3_EXPECTED.salesRet1.taxAmount &&
        s3Ret1.totalAmount === S3_EXPECTED.salesRet1.totalAmount &&
        s3Ret1.cogsAmount === S3_EXPECTED.salesRet1.cogsAmount &&
        s3Ret1Gl.ok &&
        s3Ar1 === S3_EXPECTED.salesRet1.arOpenAfter &&
        s3Bal1.valQty === S3_EXPECTED.salesRet1.whQty &&
        s3Bal1.valTotalCost === S3_EXPECTED.salesRet1.whTotal &&
        s3Over1.rejected &&
        s3Ret2.subtotal === S3_EXPECTED.salesRet2.subtotal &&
        s3Ret2.taxAmount === S3_EXPECTED.salesRet2.taxAmount &&
        s3Ret2.totalAmount === S3_EXPECTED.salesRet2.totalAmount &&
        s3Ret2.cogsAmount === S3_EXPECTED.salesRet2.cogsAmount &&
        s3Ret2Gl.ok &&
        s3Ar2 === undefined &&
        s3Bal2.valQty === S3_EXPECTED.salesRet2.whQty &&
        s3Bal2.valTotalCost === S3_EXPECTED.salesRet2.whTotal &&
        s3Over2.rejected &&
        s3SalesCumSql.qty === S3_EXPECTED.salesRet2.cumReturnedQty &&
        s3SalesCumSql.amt === S3_EXPECTED.salesRet2.cumReturnedTotal &&
        s3Pret1Gl.ok &&
        s3PBal1.valQty === S3_EXPECTED.purchRet1.whQty &&
        s3PBal1.valTotalCost === S3_EXPECTED.purchRet1.whTotal &&
        s3Ap1?.remainingOpenAmount === S3_EXPECTED.purchRet1.apOpenAfter &&
        s3POver1.rejected &&
        s3Pret2Gl.ok &&
        s3PBal2.valQty === S3_EXPECTED.purchRet2.whQty &&
        s3PBal2.valTotalCost === S3_EXPECTED.purchRet2.whTotal &&
        s3Ap2?.remainingOpenAmount === S3_EXPECTED.purchRet2.apOpenAfter &&
        s3Ap2?.paymentStatus === 'paid' &&
        s3POver2.rejected &&
        s3PurchCumSql === S3_EXPECTED.purchRet2.cumQty
    );

    // =========================================================================
    // SCENARIO 4: Cancel Posted Sales Invoice + Re-invoice Same Delivery Line
    // =========================================================================
    const S4_EXPECTED = {
      inv1Gl: [
        { accountId: arAcc.id, debit: '345.00', credit: '0.00' },
        { accountId: revAcc.id, debit: '0.00', credit: '300.00' },
        { accountId: vatAcc.id, debit: '0.00', credit: '45.00' },
        { accountId: cogsAcc.id, debit: '90.00', credit: '0.00' },
        { accountId: invAcc.id, debit: '0.00', credit: '90.00' },
      ],
      revGl: [
        { accountId: arAcc.id, debit: '0.00', credit: '345.00' },
        { accountId: revAcc.id, debit: '300.00', credit: '0.00' },
        { accountId: vatAcc.id, debit: '45.00', credit: '0.00' },
        { accountId: cogsAcc.id, debit: '0.00', credit: '90.00' },
        { accountId: invAcc.id, debit: '90.00', credit: '0.00' },
      ],
      inv2Gl: [
        { accountId: arAcc.id, debit: '414.00', credit: '0.00' },
        { accountId: revAcc.id, debit: '0.00', credit: '360.00' },
        { accountId: vatAcc.id, debit: '0.00', credit: '54.00' },
        { accountId: cogsAcc.id, debit: '90.00', credit: '0.00' },
        { accountId: invAcc.id, debit: '0.00', credit: '90.00' },
      ],
      netByAccount: {
        arNetDr: '414.00',
        revNetCr: '360.00',
        vatNetCr: '54.00',
        cogsNetDr: '90.00',
        invNetCr: '90.00',
      },
      arOpen: 414,
      remQty: '2.0000',
      remTotal: '60.0000',
    };

    await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemCancel.id, qty: 5, unitCost: 30 }] }, user.id)).id,
      user.id
    );
    const s4Del = await defaultSalesDeliveryService.postDelivery(
      companyId,
      (await defaultSalesDeliveryService.createDelivery(companyId, { customerId: customer.id, warehouseId: wh1.id, lines: [{ itemId: itemCancel.id, qty: 3, unitPrice: 100 }] }, user.id)).id,
      user.id
    );
    const s4DelLineId = s4Del.lines![0].id;

    const s4Inv1 = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id, deliveryId: s4Del.id, lines: [{ itemId: itemCancel.id, deliveryLineId: s4DelLineId, qty: 3, unitPrice: 100, taxRate: 15 }],
      }, user.id)).id,
      user.id
    );
    const s4Inv1Gl = await verifyJournalEntryExact(companyId, s4Inv1.journalEntryId!, S4_EXPECTED.inv1Gl);

    const s4Cancelled = await defaultSalesInvoiceService.cancelPostedInvoice(companyId, s4Inv1.id, 'إلغاء لتصحيح السعر', user.id);
    const s4RevGl = await verifyJournalEntryExact(companyId, s4Cancelled.reversalJournalEntryId!, S4_EXPECTED.revGl);

    const s4Inv2 = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id, deliveryId: s4Del.id, lines: [{ itemId: itemCancel.id, deliveryLineId: s4DelLineId, qty: 3, unitPrice: 120, taxRate: 15 }],
      }, user.id)).id,
      user.id
    );
    const s4Inv2Gl = await verifyJournalEntryExact(companyId, s4Inv2.journalEntryId!, S4_EXPECTED.inv2Gl);

    const s4NetSql = await withTenantTransaction(companyId, async (tx) => {
      const jeIds = [s4Inv1.journalEntryId!, s4Cancelled.reversalJournalEntryId!, s4Inv2.journalEntryId!];
      const netRes = await tx.query<{ account_id: string; net_dr: string }>(
        `SELECT account_id, COALESCE(SUM(debit - credit), 0)::text AS net_dr
         FROM journal_lines
         WHERE company_id = $1 AND entry_id = ANY($2::uuid[])
         GROUP BY account_id`,
        [companyId, jeIds]
      );
      const revRes = await tx.query<{ reversed_qty: string; reversed_cogs_amount: string }>(
        `SELECT reversed_qty::text, reversed_cogs_amount::text
         FROM inv_sales_cogs_reversals
         WHERE company_id = $1 AND invoice_id = $2`,
        [companyId, s4Inv1.id]
      );
      const netMap = new Map<string, string>(netRes.rows.map((r) => [r.account_id, normalizeMoneyStr(r.net_dr)]));
      return { netMap, revRows: revRes.rows };
    });
    const s4ArOpen = (await defaultSalesInvoiceService.listOutstandingInvoices(companyId, customer.id)).find((r: any) => r.invoiceId === s4Inv2.id)?.remainingOpenAmount;
    const s4Bal = await getStockAndValuationSql(companyId, wh1.id, itemCancel.id);

    await check(
      'Scenario 4 (Cancel + Re-invoice): Full swapped reversal JE + inv_sales_cogs_reversals + clean re-invoice on same delivery line with exact net GL',
      s4Inv1Gl.ok &&
        s4Cancelled.status === 'cancelled' &&
        s4RevGl.ok &&
        s4NetSql.revRows.length === 1 &&
        normalizeQtyStr(s4NetSql.revRows[0].reversed_qty) === '3.0000' &&
        normalizeMoneyStr(s4NetSql.revRows[0].reversed_cogs_amount) === '90.00' &&
        s4Inv2Gl.ok &&
        s4NetSql.netMap.get(arAcc.id) === S4_EXPECTED.netByAccount.arNetDr &&
        s4NetSql.netMap.get(revAcc.id) === `-${S4_EXPECTED.netByAccount.revNetCr}` &&
        s4NetSql.netMap.get(vatAcc.id) === `-${S4_EXPECTED.netByAccount.vatNetCr}` &&
        s4NetSql.netMap.get(cogsAcc.id) === S4_EXPECTED.netByAccount.cogsNetDr &&
        s4NetSql.netMap.get(invAcc.id) === `-${S4_EXPECTED.netByAccount.invNetCr}` &&
        s4ArOpen === S4_EXPECTED.arOpen &&
        s4Bal.valQty === S4_EXPECTED.remQty &&
        s4Bal.valTotalCost === S4_EXPECTED.remTotal
    );

    // =========================================================================
    // SCENARIO 5: Fractions & Rounding (4-decimal qty/cost vs 2-decimal GL, ZERO drift)
    // =========================================================================
    const S5_EXPECTED = {
      grn1: { qty: 1.25, unitCost: 8.44, total: '10.55', gl: [{ accountId: invAcc.id, debit: '10.55', credit: '0.00' }, { accountId: clrAcc.id, debit: '0.00', credit: '10.55' }] },
      grn2: { qty: 0.75, unitCost: 10.04, total: '7.53', gl: [{ accountId: invAcc.id, debit: '7.53', credit: '0.00' }, { accountId: clrAcc.id, debit: '0.00', credit: '7.53' }] },
      del1: { qty: 0.3333, frozenCost: '2.8131', layer1RemQty: '0.9167', layer1RemCost: '7.7369' },
      del2: { qty: 0.9167, frozenCost: '7.7369', layer1RemQty: '0.0000', layer1RemCost: '0.0000' },
      sinv1: {
        subtotal: 6.68, taxAmount: 1.00, totalAmount: 7.68, cogsAmount: 2.81,
        gl: [
          { accountId: arAcc.id, debit: '7.68', credit: '0.00' },
          { accountId: revAcc.id, debit: '0.00', credit: '6.68' },
          { accountId: vatAcc.id, debit: '0.00', credit: '1.00' },
          { accountId: cogsAcc.id, debit: '2.81', credit: '0.00' },
          { accountId: invAcc.id, debit: '0.00', credit: '2.81' },
        ],
      },
      sinv2a: {
        qty: 0.3333, subtotal: 6.68, taxAmount: 1.00, totalAmount: 7.68, cogsAmount: 2.81,
        gl: [
          { accountId: arAcc.id, debit: '7.68', credit: '0.00' },
          { accountId: revAcc.id, debit: '0.00', credit: '6.68' },
          { accountId: vatAcc.id, debit: '0.00', credit: '1.00' },
          { accountId: cogsAcc.id, debit: '2.81', credit: '0.00' },
          { accountId: invAcc.id, debit: '0.00', credit: '2.81' },
        ],
      },
      sinv2b: {
        qty: 0.5834, subtotal: 11.69, taxAmount: 1.75, totalAmount: 13.44, cogsAmount: 4.93,
        gl: [
          { accountId: arAcc.id, debit: '13.44', credit: '0.00' },
          { accountId: revAcc.id, debit: '0.00', credit: '11.69' },
          { accountId: vatAcc.id, debit: '0.00', credit: '1.75' },
          { accountId: cogsAcc.id, debit: '4.93', credit: '0.00' },
          { accountId: invAcc.id, debit: '0.00', credit: '4.93' },
        ],
      },
      finalRemainingQty: '0.7500',
      finalRemainingCost: '7.5300',
      itemNetGlInventory: '7.53',
    };

    const s5Grn1 = await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemFrac.id, qty: S5_EXPECTED.grn1.qty, unitCost: S5_EXPECTED.grn1.unitCost }] }, user.id)).id,
      user.id
    );
    const s5Grn1Gl = await verifyJournalEntryExact(companyId, s5Grn1.journalEntryId!, S5_EXPECTED.grn1.gl);

    const s5Grn2 = await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemFrac.id, qty: S5_EXPECTED.grn2.qty, unitCost: S5_EXPECTED.grn2.unitCost }] }, user.id)).id,
      user.id
    );
    const s5Grn2Gl = await verifyJournalEntryExact(companyId, s5Grn2.journalEntryId!, S5_EXPECTED.grn2.gl);

    const s5Del1 = await defaultSalesDeliveryService.postDelivery(
      companyId,
      (await defaultSalesDeliveryService.createDelivery(companyId, { customerId: customer.id, warehouseId: wh1.id, lines: [{ itemId: itemFrac.id, qty: S5_EXPECTED.del1.qty, unitPrice: 20.03 }] }, user.id)).id,
      user.id
    );
    const s5Del2 = await defaultSalesDeliveryService.postDelivery(
      companyId,
      (await defaultSalesDeliveryService.createDelivery(companyId, { customerId: customer.id, warehouseId: wh1.id, lines: [{ itemId: itemFrac.id, qty: S5_EXPECTED.del2.qty, unitPrice: 20.03 }] }, user.id)).id,
      user.id
    );

    const s5Inv1 = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id, deliveryId: s5Del1.id, lines: [{ itemId: itemFrac.id, deliveryLineId: s5Del1.lines![0].id, qty: S5_EXPECTED.del1.qty, unitPrice: 20.03, taxRate: 15 }],
      }, user.id)).id,
      user.id
    );
    const s5Inv1Gl = await verifyJournalEntryExact(companyId, s5Inv1.journalEntryId!, S5_EXPECTED.sinv1.gl);

    const s5Inv2a = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id, deliveryId: s5Del2.id, lines: [{ itemId: itemFrac.id, deliveryLineId: s5Del2.lines![0].id, qty: S5_EXPECTED.sinv2a.qty, unitPrice: 20.03, taxRate: 15 }],
      }, user.id)).id,
      user.id
    );
    const s5Inv2aGl = await verifyJournalEntryExact(companyId, s5Inv2a.journalEntryId!, S5_EXPECTED.sinv2a.gl);

    const s5Inv2b = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id, deliveryId: s5Del2.id, lines: [{ itemId: itemFrac.id, deliveryLineId: s5Del2.lines![0].id, qty: S5_EXPECTED.sinv2b.qty, unitPrice: 20.03, taxRate: 15 }],
      }, user.id)).id,
      user.id
    );
    const s5Inv2bGl = await verifyJournalEntryExact(companyId, s5Inv2b.journalEntryId!, S5_EXPECTED.sinv2b.gl);

    const s5Sql = await withTenantTransaction(companyId, async (tx) => {
      const layerSumRes = await tx.query<{ rem_qty: string; rem_cost: string }>(
        `SELECT COALESCE(SUM(remaining_qty), 0)::text AS rem_qty, COALESCE(SUM(total_cost), 0)::text AS rem_cost
         FROM inv_cost_layers WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3`,
        [companyId, wh1.id, itemFrac.id]
      );
      const jeIds = [s5Grn1.journalEntryId!, s5Grn2.journalEntryId!, s5Inv1.journalEntryId!, s5Inv2a.journalEntryId!, s5Inv2b.journalEntryId!];
      const invGlRes = await tx.query<{ net_inv: string }>(
        `SELECT COALESCE(SUM(debit - credit), 0)::text AS net_inv
         FROM journal_lines WHERE company_id = $1 AND account_id = $2 AND entry_id = ANY($3::uuid[])`,
        [companyId, invAcc.id, jeIds]
      );
      return {
        layerRemQty: normalizeQtyStr(layerSumRes.rows[0]?.rem_qty),
        layerRemCost: normalizeCostStr(layerSumRes.rows[0]?.rem_cost),
        itemNetInvGl: normalizeMoneyStr(invGlRes.rows[0]?.net_inv),
      };
    });
    const s5Bal = await getStockAndValuationSql(companyId, wh1.id, itemFrac.id);

    await check(
      'Scenario 5 (Fractions & Rounding): Sub-unit 4-decimal FIFO splits (0.3333 + 0.9167) and split invoicing preserve SUM(layers) === SUM(GL) = 7.5300 with zero drift',
      s5Grn1Gl.ok &&
        s5Grn2Gl.ok &&
        normalizeCostStr(s5Del1.lines![0].frozenTotalCost) === S5_EXPECTED.del1.frozenCost &&
        normalizeCostStr(s5Del2.lines![0].frozenTotalCost) === S5_EXPECTED.del2.frozenCost &&
        s5Inv1Gl.ok &&
        s5Inv1.subtotal === S5_EXPECTED.sinv1.subtotal &&
        s5Inv1.taxAmount === S5_EXPECTED.sinv1.taxAmount &&
        s5Inv1.totalAmount === S5_EXPECTED.sinv1.totalAmount &&
        s5Inv1.cogsAmount === S5_EXPECTED.sinv1.cogsAmount &&
        s5Inv2aGl.ok &&
        s5Inv2a.subtotal === S5_EXPECTED.sinv2a.subtotal &&
        s5Inv2a.cogsAmount === S5_EXPECTED.sinv2a.cogsAmount &&
        s5Inv2bGl.ok &&
        s5Inv2b.subtotal === S5_EXPECTED.sinv2b.subtotal &&
        s5Inv2b.taxAmount === S5_EXPECTED.sinv2b.taxAmount &&
        s5Inv2b.totalAmount === S5_EXPECTED.sinv2b.totalAmount &&
        s5Inv2b.cogsAmount === S5_EXPECTED.sinv2b.cogsAmount &&
        s5Bal.valQty === S5_EXPECTED.finalRemainingQty &&
        s5Bal.valTotalCost === S5_EXPECTED.finalRemainingCost &&
        s5Sql.layerRemQty === S5_EXPECTED.finalRemainingQty &&
        s5Sql.layerRemCost === S5_EXPECTED.finalRemainingCost &&
        s5Sql.itemNetInvGl === S5_EXPECTED.itemNetGlInventory
    );

    // =========================================================================
    // SCENARIO 6: Negative / Zero / Idempotency Duplicate / Concurrent Stock Race
    // =========================================================================
    const S6_EXPECTED = {
      seedGrnGl: [{ accountId: invAcc.id, debit: '150.00', credit: '0.00' }, { accountId: clrAcc.id, debit: '0.00', credit: '150.00' }],
      race1IssueGl: [{ accountId: adjAcc.id, debit: '90.00', credit: '0.00' }, { accountId: invAcc.id, debit: '0.00', credit: '90.00' }],
      race2SinvGl: [
        { accountId: arAcc.id, debit: '150.00', credit: '0.00' },
        { accountId: revAcc.id, debit: '0.00', credit: '150.00' },
        { accountId: cogsAcc.id, debit: '45.00', credit: '0.00' },
        { accountId: invAcc.id, debit: '0.00', credit: '45.00' },
      ],
      afterRace1Qty: '4.0000',
      afterRace1Cost: '60.0000',
      finalQty: '1.0000',
      finalCost: '15.0000',
    };

    const s6Grn = await defaultGrnService.postGrn(
      companyId,
      (await defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemGuard.id, qty: 10, unitCost: 15 }] }, user.id)).id,
      user.id
    );
    const s6GrnGl = await verifyJournalEntryExact(companyId, s6Grn.journalEntryId!, S6_EXPECTED.seedGrnGl);

    // Negative & Zero checks across services
    const negChecks = await Promise.all([
      expectValidationError(() => defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemGuard.id, qty: 0, unitCost: 15 }] }, user.id)),
      expectValidationError(() => defaultGrnService.createGrn(companyId, { supplierId: supplier.id, warehouseId: wh1.id, lines: [{ itemId: itemGuard.id, qty: -2, unitCost: 15 }] }, user.id)),
      expectValidationError(() => defaultStockService.receiveStock(companyId, { warehouseId: wh1.id, itemId: itemGuard.id, qty: 0, unitCost: 15, costSource: 'MANUAL', reason: 'صفر' }, user.id)),
      expectValidationError(() => defaultStockService.receiveStock(companyId, { warehouseId: wh1.id, itemId: itemGuard.id, qty: -1, unitCost: 15, costSource: 'MANUAL', reason: 'سالب' }, user.id)),
      expectValidationError(() => defaultStockService.issueStock(companyId, { warehouseId: wh1.id, itemId: itemGuard.id, qty: 0, reason: 'صفر' }, user.id)),
      expectValidationError(() => defaultStockService.issueStock(companyId, { warehouseId: wh1.id, itemId: itemGuard.id, qty: -3, reason: 'سالب' }, user.id)),
      expectValidationError(() => defaultStockService.transfer(companyId, { sourceWarehouseId: wh1.id, destWarehouseId: wh2.id, itemId: itemGuard.id, qty: 0 }, user.id)),
      expectValidationError(() => defaultStockService.transfer(companyId, { sourceWarehouseId: wh1.id, destWarehouseId: wh2.id, itemId: itemGuard.id, qty: -1 }, user.id)),
      expectValidationError(() => defaultSalesDeliveryService.createDelivery(companyId, { customerId: customer.id, warehouseId: wh1.id, lines: [{ itemId: itemGuard.id, qty: 0, unitPrice: 50 }] }, user.id)),
      expectValidationError(() => defaultSalesDeliveryService.createDelivery(companyId, { customerId: customer.id, warehouseId: wh1.id, lines: [{ itemId: itemGuard.id, qty: -2, unitPrice: 50 }] }, user.id)),
      expectValidationError(() => defaultSalesInvoiceService.createInvoice(companyId, { customerId: customer.id, lines: [{ itemId: itemGuard.id, qty: 0, unitPrice: 50 }] }, user.id)),
      expectValidationError(() => defaultSalesInvoiceService.createInvoice(companyId, { customerId: customer.id, lines: [{ itemId: itemGuard.id, qty: -1, unitPrice: 50 }] }, user.id)),
    ]);

    // Idempotency / duplicate document posting checks
    const dupGrn = await expectValidationError(() => defaultGrnService.postGrn(companyId, s6Grn.id, user.id));
    const dupPinv = await defaultPurchInvoiceService.postInvoice(
      companyId,
      (await defaultPurchInvoiceService.createInvoice(companyId, {
        supplierId: supplier.id, supplierInvoiceNo: `PINV-IDEM-${unique}`.slice(0, 30), lines: [{ grnLineId: s6Grn.lines![0].id, qty: 10, unitCost: 15 }],
      }, user.id)).id,
      user.id
    );
    const dupPinvRepost = await expectValidationError(() => defaultPurchInvoiceService.postInvoice(companyId, dupPinv.id, user.id));
    const dupValReceipt = await expectValidationError(() =>
      defaultInventoryValuationService.processReceipt(companyId, {
        warehouseId: wh1.id, itemId: itemGuard.id, qty: 1, unitCost: 15, sourceType: 'GRN', sourceId: s6Grn.id, sourceLineId: s6Grn.lines![0].id, movementType: 'RECEIVE',
      }, user.id)
    );

    // Concurrent Race 1: Two simultaneous StockService.issueStock(qty=6) against 10 available -> strictly 1 succeeds, 1 rejected
    const race1Results = await Promise.allSettled([
      defaultStockService.issueStock(companyId, { warehouseId: wh1.id, itemId: itemGuard.id, qty: 6, reason: 'سباق صرف 1' }, user.id),
      defaultStockService.issueStock(companyId, { warehouseId: wh1.id, itemId: itemGuard.id, qty: 6, reason: 'سباق صرف 2' }, user.id),
    ]);
    const race1Success = race1Results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof defaultStockService.issueStock>>> => r.status === 'fulfilled');
    const race1Fail = race1Results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const s6BalAfterRace1 = await getStockAndValuationSql(companyId, wh1.id, itemGuard.id);
    const race1GlOk = race1Success.length === 1 && race1Success[0].value.journalEntryId
      ? (await verifyJournalEntryExact(companyId, race1Success[0].value.journalEntryId, S6_EXPECTED.race1IssueGl)).ok
      : false;

    // Concurrent Race 2: Two separate draft Sales Deliveries (qty=3 each) against remaining 4 -> strictly 1 succeeds, 1 fails
    const r2DelA = await defaultSalesDeliveryService.createDelivery(companyId, { customerId: customer.id, warehouseId: wh1.id, lines: [{ itemId: itemGuard.id, qty: 3, unitPrice: 50 }] }, user.id);
    const r2DelB = await defaultSalesDeliveryService.createDelivery(companyId, { customerId: customer.id, warehouseId: wh1.id, lines: [{ itemId: itemGuard.id, qty: 3, unitPrice: 50 }] }, user.id);
    const race2Results = await Promise.allSettled([
      defaultSalesDeliveryService.postDelivery(companyId, r2DelA.id, user.id),
      defaultSalesDeliveryService.postDelivery(companyId, r2DelB.id, user.id),
    ]);
    const race2Success = race2Results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof defaultSalesDeliveryService.postDelivery>>> => r.status === 'fulfilled');
    const race2Fail = race2Results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const winnerDel = race2Success[0]?.value;
    const dupDelRepost = winnerDel ? await expectValidationError(() => defaultSalesDeliveryService.postDelivery(companyId, winnerDel.id, user.id)) : { rejected: false, message: '' };

    const s6Sinv = winnerDel
      ? await defaultSalesInvoiceService.postInvoice(
          companyId,
          (await defaultSalesInvoiceService.createInvoice(companyId, {
            customerId: customer.id, deliveryId: winnerDel.id, lines: [{ itemId: itemGuard.id, deliveryLineId: winnerDel.lines![0].id, qty: 3, unitPrice: 50, taxRate: 0 }],
          }, user.id)).id,
          user.id
        )
      : null;
    const dupSinvRepost = s6Sinv ? await expectValidationError(() => defaultSalesInvoiceService.postInvoice(companyId, s6Sinv.id, user.id)) : { rejected: false, message: '' };
    const s6SinvGl = s6Sinv ? await verifyJournalEntryExact(companyId, s6Sinv.journalEntryId!, S6_EXPECTED.race2SinvGl) : { ok: false, detail: 'missing sinv' };
    const s6BalFinal = await getStockAndValuationSql(companyId, wh1.id, itemGuard.id);

    await check(
      'Scenario 6 (Negative/Zero/Idempotency/Concurrent Race): Zero & negative rejected, duplicates blocked, parallel races have 1 winner / 1 ValidationError loser with non-negative exact stock (1@15=15)',
      s6GrnGl.ok &&
        negChecks.every((c) => c.rejected) &&
        dupGrn.rejected &&
        dupPinvRepost.rejected &&
        dupValReceipt.rejected &&
        dupValReceipt.message.includes('IDEMPOTENT_DUPLICATE') &&
        race1Success.length === 1 &&
        race1Fail.length === 1 &&
        race1Fail[0].reason instanceof ValidationError &&
        race1GlOk &&
        s6BalAfterRace1.stockQty === S6_EXPECTED.afterRace1Qty &&
        s6BalAfterRace1.valTotalCost === S6_EXPECTED.afterRace1Cost &&
        race2Success.length === 1 &&
        race2Fail.length === 1 &&
        race2Fail[0].reason instanceof ValidationError &&
        dupDelRepost.rejected &&
        dupSinvRepost.rejected &&
        s6SinvGl.ok &&
        s6BalFinal.stockQty === S6_EXPECTED.finalQty &&
        s6BalFinal.valQty === S6_EXPECTED.finalQty &&
        s6BalFinal.valTotalCost === S6_EXPECTED.finalCost
    );

    // =========================================================================
    // SCENARIO 7: Closed Accounting Period Rejection + Open Period Acceptance
    // =========================================================================
    const S7_EXPECTED = {
      openReceiptGl: [{ accountId: invAcc.id, debit: '60.00', credit: '0.00' }, { accountId: adjAcc.id, debit: '0.00', credit: '60.00' }],
      openSinvGl: [
        { accountId: arAcc.id, debit: '100.00', credit: '0.00' },
        { accountId: revAcc.id, debit: '0.00', credit: '100.00' },
        { accountId: cogsAcc.id, debit: '24.00', credit: '0.00' },
        { accountId: invAcc.id, debit: '0.00', credit: '24.00' },
      ],
      afterReceiveQty: '5.0000',
      afterReceiveCost: '60.0000',
      finalQty: '3.0000',
      finalCost: '36.0000',
      arOpen: 100,
    };

    const closedReceiveRej = await expectValidationError(() =>
      defaultStockService.receiveStock(
        companyId,
        { warehouseId: wh1.id, itemId: itemPeriod.id, qty: 5, unitCost: 12, costSource: 'OPENING', reason: 'محاولة في فترة مغلقة', entryDate: closedDateStr },
        user.id
      )
    );
    const balAfterClosedRecv = await getStockAndValuationSql(companyId, wh1.id, itemPeriod.id);

    const closedDraftJe = await defaultJournalService.createDraftEntry(
      companyId,
      {
        entryDate: closedDateStr,
        memo: 'قيد اختبار فترة مغلقة',
        lines: [{ accountId: invAcc.id, debit: 10, credit: 0 }, { accountId: adjAcc.id, debit: 0, credit: 10 }],
      },
      user.id,
      false
    );
    const closedJeRej = await expectValidationError(() => defaultJournalService.postEntry(companyId, closedDraftJe.id, user.id, false));

    // Open period stock receive accepted
    const s7OpenRecv = await defaultStockService.receiveStock(
      companyId,
      { warehouseId: wh1.id, itemId: itemPeriod.id, qty: 5, unitCost: 12, costSource: 'APPROVED_COST', reason: 'استلام في فترة مفتوحة', entryDate: todayStr },
      user.id
    );
    const s7OpenRecvGl = await verifyJournalEntryExact(companyId, s7OpenRecv.journalEntryId, S7_EXPECTED.openReceiptGl);
    const s7BalMid = await getStockAndValuationSql(companyId, wh1.id, itemPeriod.id);

    // Closed period stock issue rejected without mutating 5@12 balance
    const closedIssueRej = await expectValidationError(() =>
      defaultStockService.issueStock(
        companyId,
        { warehouseId: wh1.id, itemId: itemPeriod.id, qty: 2, reason: 'صرف في فترة مغلقة', entryDate: closedDateStr },
        user.id
      )
    );
    const s7BalStillIntact = await getStockAndValuationSql(companyId, wh1.id, itemPeriod.id);

    // Sales delivery + Sales invoice inside closed period rejected -> then new invoice in open period accepted
    const s7Del = await defaultSalesDeliveryService.postDelivery(
      companyId,
      (await defaultSalesDeliveryService.createDelivery(companyId, { customerId: customer.id, warehouseId: wh1.id, deliveryDate: todayStr, lines: [{ itemId: itemPeriod.id, qty: 2, unitPrice: 50 }] }, user.id)).id,
      user.id
    );
    const s7ClosedSinvDraft = await defaultSalesInvoiceService.createInvoice(
      companyId,
      { customerId: customer.id, deliveryId: s7Del.id, invoiceDate: closedDateStr, lines: [{ itemId: itemPeriod.id, deliveryLineId: s7Del.lines![0].id, qty: 2, unitPrice: 50, taxRate: 0 }] },
      user.id
    );
    const closedSinvRej = await expectValidationError(() => defaultSalesInvoiceService.postInvoice(companyId, s7ClosedSinvDraft.id, user.id));
    await defaultSalesInvoiceService.deleteInvoice(companyId, s7ClosedSinvDraft.id, user.id);

    const s7OpenSinv = await defaultSalesInvoiceService.postInvoice(
      companyId,
      (await defaultSalesInvoiceService.createInvoice(companyId, {
        customerId: customer.id, deliveryId: s7Del.id, invoiceDate: todayStr, lines: [{ itemId: itemPeriod.id, deliveryLineId: s7Del.lines![0].id, qty: 2, unitPrice: 50, taxRate: 0 }],
      }, user.id)).id,
      user.id
    );
    const s7OpenSinvGl = await verifyJournalEntryExact(companyId, s7OpenSinv.journalEntryId!, S7_EXPECTED.openSinvGl);
    const s7BalFinal = await getStockAndValuationSql(companyId, wh1.id, itemPeriod.id);
    const s7ArOpen = (await defaultSalesInvoiceService.listOutstandingInvoices(companyId, customer.id)).find((r: any) => r.invoiceId === s7OpenSinv.id)?.remainingOpenAmount;

    await check(
      'Scenario 7 (Closed Period): Rejects posting in closed period with explicit period-closed error & zero mutation; accepts open period posting cleanly',
      closedReceiveRej.rejected &&
        closedReceiveRej.message.includes('مغلقة') &&
        closedReceiveRej.message.includes(closedPeriod.code) &&
        balAfterClosedRecv.valQty === '0.0000' &&
        closedJeRej.rejected &&
        closedJeRej.message.includes('مغلقة') &&
        s7OpenRecvGl.ok &&
        s7BalMid.valQty === S7_EXPECTED.afterReceiveQty &&
        s7BalMid.valTotalCost === S7_EXPECTED.afterReceiveCost &&
        closedIssueRej.rejected &&
        closedIssueRej.message.includes('مغلقة') &&
        s7BalStillIntact.valQty === S7_EXPECTED.afterReceiveQty &&
        s7BalStillIntact.valTotalCost === S7_EXPECTED.afterReceiveCost &&
        closedSinvRej.rejected &&
        closedSinvRej.message.includes('مغلقة') &&
        s7OpenSinvGl.ok &&
        s7BalFinal.valQty === S7_EXPECTED.finalQty &&
        s7BalFinal.valTotalCost === S7_EXPECTED.finalCost &&
        s7ArOpen === S7_EXPECTED.arOpen &&
        Boolean(openPeriod.id)
    );

    // =========================================================================
    // GLOBAL CROSS-SCENARIO RECONCILIATION: Subledger === GL Control Account 1130
    // Sum of remaining items:
    //   S1 FIFO (80.0000) + S2 MA WH1 (225.0000) + S2 MA WH2 (135.0000)
    // + S3 SalesRet (250.0000) + S3 PurchRet (0.0000) + S4 Cancel (60.0000)
    // + S5 Frac (7.5300) + S6 Guard (15.0000) + S7 Period (36.0000) = 808.5300
    // =========================================================================
    const EXPECTED_TOTAL_SUBLEDGER = '808.5300';
    const fullRec = await defaultInventoryValuationService.runReconciliation(companyId, {}, user.id);
    const glGlobalCheck = await withTenantTransaction(companyId, async (tx) => {
      const vbSum = await tx.query<{ s: string }>(
        `SELECT COALESCE(SUM(total_cost), 0)::text AS s FROM inv_valuation_balances WHERE company_id = $1`,
        [companyId]
      );
      const glSum = await tx.query<{ s: string }>(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS s
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
         WHERE l.company_id = $1 AND l.account_id = $2 AND e.status = 'posted'`,
        [companyId, invAcc.id]
      );
      return {
        vbTotal: normalizeCostStr(vbSum.rows[0]?.s),
        glTotal: normalizeCostStr(glSum.rows[0]?.s),
      };
    });

    await check(
      `Global Reconciliation: Combined subledger total (${EXPECTED_TOTAL_SUBLEDGER}) matches Inventory GL control account with 0.0000 variance`,
      fullRec.comparisonScope === 'COMPANY_GL' &&
        fullRec.status === 'reconciled' &&
        normalizeCostStr(fullRec.subledgerTotal) === EXPECTED_TOTAL_SUBLEDGER &&
        normalizeCostStr(fullRec.glControlTotal) === EXPECTED_TOTAL_SUBLEDGER &&
        normalizeCostStr(fullRec.variance) === '0.0000' &&
        glGlobalCheck.vbTotal === EXPECTED_TOTAL_SUBLEDGER &&
        glGlobalCheck.glTotal === EXPECTED_TOTAL_SUBLEDGER
    );
  } catch (err) {
    console.error('[verifyValuationNumericMatrix1] Live test error:', err);
    await check('Live WP-3 numeric matrix execution', false, err instanceof Error ? err.message : String(err));
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
        console.error('[cleanup] Failed cleaning up verifyValuationNumericMatrix1:', cleanupErr);
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
  console.error('[verifyValuationNumericMatrix1] Fatal error:', err);
  process.exit(1);
});
