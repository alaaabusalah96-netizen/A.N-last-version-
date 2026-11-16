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
import { defaultPurchaseOrderService } from '../src/server/purchasing/purchaseOrderService.js';
import { defaultGrnService } from '../src/server/purchasing/grnService.js';
import { defaultInvoiceService } from '../src/server/purchasing/invoiceService.js';
import {
  DEFAULT_THREE_WAY_POLICY,
  defaultThreeWayMatchService,
  evaluateThreeWayLineMatch,
} from '../src/server/purchasing/threeWayMatchService.js';
import { ValidationError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-INT-PURCH-1 WP-A: 3-Way Match & Tolerance Policy    ===');
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
    'S0: verifyPurch3Way1.ts registered in runFoundationBattery.ts and package.json',
    batterySrc.includes('scripts/verifyPurch3Way1.ts') &&
      pkgJson?.scripts?.['test:purch-3way-1'] === 'tsx scripts/verifyPurch3Way1.ts'
  );

  // S1: SQL join tenant predicate sanity check (gl.company_id = sil.company_id)
  const svcSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/threeWayMatchService.ts'), 'utf8');
  await check(
    'S1: threeWayMatchService SQL joins purch_grn_lines & purch_po_lines on sil.company_id',
    svcSrc.includes('gl.company_id = sil.company_id') &&
      !svcSrc.includes('gl.company_id = gl.company_id')
  );

  // S2: Pure policy checks (qtyTolerancePct=0, priceTolerancePct=5, priceRoundingAbs=0.01)
  await check(
    'S2: DEFAULT_THREE_WAY_POLICY specifies qtyTol=0, priceTol=5%, rounding=0.01',
    DEFAULT_THREE_WAY_POLICY.qtyTolerancePct === 0 &&
      DEFAULT_THREE_WAY_POLICY.priceTolerancePct === 5 &&
      DEFAULT_THREE_WAY_POLICY.priceRoundingAbs === 0.01
  );

  const exactRes = evaluateThreeWayLineMatch({
    grnLineId: 'g1',
    itemId: 'i1',
    poLineId: 'p1',
    poQty: 10,
    poUnitCost: 100,
    grnQty: 10,
    grnUnitCost: 100,
    invoiceQty: 10,
    invoiceUnitCost: 100,
  });
  await check(
    'S3: Exact PO/GRN/Invoice match returns status=matched',
    exactRes.status === 'matched' && exactRes.qtyVariance === 0 && exactRes.priceVariancePct === 0
  );

  const withinTolRes = evaluateThreeWayLineMatch({
    grnLineId: 'g1',
    itemId: 'i1',
    poLineId: 'p1',
    poQty: 10,
    poUnitCost: 100,
    grnQty: 10,
    grnUnitCost: 100,
    invoiceQty: 10,
    invoiceUnitCost: 104, // +4% <= 5%
  });
  await check(
    'S4: Price +4% within 5% tolerance returns status=within_tolerance',
    withinTolRes.status === 'within_tolerance' && withinTolRes.priceVariancePct === 4
  );

  const priceExceededRes = evaluateThreeWayLineMatch({
    grnLineId: 'g1',
    itemId: 'i1',
    poLineId: 'p1',
    poQty: 10,
    poUnitCost: 100,
    grnQty: 10,
    grnUnitCost: 100,
    invoiceQty: 10,
    invoiceUnitCost: 112, // +12% > 5%
  });
  await check(
    'S5: Price +12% > 5% returns status=variance_exceeded',
    priceExceededRes.status === 'variance_exceeded' && priceExceededRes.priceVariancePct === 12
  );

  const qtyExceededRes = evaluateThreeWayLineMatch({
    grnLineId: 'g1',
    itemId: 'i1',
    poLineId: 'p1',
    poQty: 10,
    poUnitCost: 100,
    grnQty: 10,
    grnUnitCost: 100,
    invoiceQty: 8, // qtyVariance = 2 !== 0 under strict qtyTol=0
    invoiceUnitCost: 100,
  });
  await check(
    'S6: Quantity mismatch under strict qtyTolerancePct=0 returns status=variance_exceeded',
    qtyExceededRes.status === 'variance_exceeded' && qtyExceededRes.qtyVariance === 2
  );

  const grnOnlyMatched = evaluateThreeWayLineMatch({
    grnLineId: 'g1',
    itemId: 'i1',
    poLineId: null,
    poQty: null,
    poUnitCost: null,
    grnQty: 5,
    grnUnitCost: 200,
    invoiceQty: 5,
    invoiceUnitCost: 200,
  });
  const grnOnlyExceeded = evaluateThreeWayLineMatch({
    grnLineId: 'g1',
    itemId: 'i1',
    poLineId: null,
    poQty: null,
    poUnitCost: null,
    grnQty: 5,
    grnUnitCost: 200,
    invoiceQty: 5,
    invoiceUnitCost: 230, // +15%
  });
  await check(
    'S7: Direct GRN without PO reports grn_only when matching and variance_exceeded when price exceeds tolerance',
    grnOnlyMatched.status === 'grn_only' && grnOnlyExceeded.status === 'variance_exceeded'
  );

  // Live DB verification
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live 3-way match DB verification is BLOCKED.');
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
    blocked('Unable to connect to database executor. Live 3-way match verification is BLOCKED.');
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
      username: `twm_usr_a_${unique}`,
      passwordHash: 'dummy_hash_twm_1',
      role: 'platform_admin',
    });
    const userB = await userRepo.createUser({
      username: `twm_usr_b_${unique}`,
      passwordHash: 'dummy_hash_twm_1',
      role: 'platform_admin',
    });
    userIds.push(userA.id, userB.id);

    const compA = await companyRepo.create({
      code: `TWA-${unique}`.slice(0, 20),
      nameAr: `شركة اختبار المطابقة الثلاثية أ ${unique}`,
      createdBy: userA.id,
    });
    const compB = await companyRepo.create({
      code: `TWB-${unique}`.slice(0, 20),
      nameAr: `شركة عزل المطابقة ب ${unique}`,
      createdBy: userB.id,
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
      { code: `AP-${unique}`.slice(0, 20), nameAr: 'الموردون', accountType: 'liability', isPostable: true },
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
      { code: `${y}-${m}-TWM-${unique}`, startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}` },
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
      { code: `ITM-${unique}`.slice(0, 20), nameAr: 'صنف مطابقة', uom: 'وحدة' },
      userId
    );

    // Helper: create PO -> approve -> create GRN linked to PO -> post GRN
    const createPoLinkedGrn = async (qty: number, unitCost: number) => {
      const po = await defaultPurchaseOrderService.createPurchaseOrder(
        companyAId,
        { supplierId: supplier.id, lines: [{ itemId: item.id, qty, unitCost }] },
        userId
      );
      await defaultPurchaseOrderService.approvePurchaseOrder(companyAId, po.id, userId);
      const poLineId = po.lines![0].id;
      const grn = await (defaultGrnService as any).createGrn(
        companyAId,
        {
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          poId: po.id,
          lines: [{ itemId: item.id, qty, unitCost, poLineId }],
        },
        userId
      );
      await defaultGrnService.postGrn(companyAId, grn.id, userId);
      const fullGrn = await defaultGrnService.getGrn(companyAId, grn.id);
      return { po, poLineId, grnLineId: fullGrn.lines![0].id };
    };

    // L1: Exact PO <-> GRN <-> Invoice match
    const case1 = await createPoLinkedGrn(10, 100);
    const inv1 = await defaultInvoiceService.createInvoice(
      companyAId,
      { supplierId: supplier.id, supplierInvoiceNo: `TWM-01-${unique}`, lines: [{ grnLineId: case1.grnLineId, qty: 10, unitCost: 100 }] },
      userId
    );
    const report1 = await defaultThreeWayMatchService.evaluateInvoice(companyAId, inv1.id);
    await check(
      'L1: Live PO->GRN->Invoice exact match yields overallStatus=matched with real poLineId & poQty/poUnitCost',
      report1.overallStatus === 'matched' &&
        report1.lines.length === 1 &&
        report1.lines[0].poLineId === case1.poLineId &&
        report1.lines[0].poQty === 10 &&
        report1.lines[0].poUnitCost === 100 &&
        report1.lines[0].qtyVariance === 0 &&
        report1.lines[0].priceVariancePct === 0
    );

    // L2: Within price tolerance (+4% <= 5%)
    const case2 = await createPoLinkedGrn(10, 100);
    const inv2 = await defaultInvoiceService.createInvoice(
      companyAId,
      { supplierId: supplier.id, supplierInvoiceNo: `TWM-02-${unique}`, lines: [{ grnLineId: case2.grnLineId, qty: 10, unitCost: 104 }] },
      userId
    );
    const report2 = await defaultThreeWayMatchService.evaluateInvoice(companyAId, inv2.id);
    await check(
      'L2: Live price +4% yields overallStatus=within_tolerance',
      report2.overallStatus === 'within_tolerance' && report2.lines[0]?.priceVariancePct === 4
    );

    // L3: Exceeded price tolerance (+12% > 5%)
    const case3 = await createPoLinkedGrn(10, 100);
    const inv3 = await defaultInvoiceService.createInvoice(
      companyAId,
      { supplierId: supplier.id, supplierInvoiceNo: `TWM-03-${unique}`, lines: [{ grnLineId: case3.grnLineId, qty: 10, unitCost: 112 }] },
      userId
    );
    const report3 = await defaultThreeWayMatchService.evaluateInvoice(companyAId, inv3.id);
    await check(
      'L3: Live price +12% yields overallStatus=variance_exceeded',
      report3.overallStatus === 'variance_exceeded' && report3.lines[0]?.priceVariancePct === 12
    );

    // L4: Strict qty tolerance (qtyTolerancePct=0): partial qty=6 vs GRN qty=10 yields variance_exceeded
    const case4 = await createPoLinkedGrn(10, 100);
    const inv4 = await defaultInvoiceService.createInvoice(
      companyAId,
      { supplierId: supplier.id, supplierInvoiceNo: `TWM-04-${unique}`, lines: [{ grnLineId: case4.grnLineId, qty: 6, unitCost: 100 }] },
      userId
    );
    const report4 = await defaultThreeWayMatchService.evaluateInvoice(companyAId, inv4.id);
    await check(
      'L4: Live qty discrepancy (6 vs 10) yields overallStatus=variance_exceeded under qtyTolerancePct=0',
      report4.overallStatus === 'variance_exceeded' && report4.lines[0]?.qtyVariance === 4
    );

    // L5: Tenant isolation on evaluateInvoice
    let crossTenantRejected = false;
    try {
      await defaultThreeWayMatchService.evaluateInvoice(companyBId, inv1.id);
    } catch (err) {
      if (err instanceof ValidationError) {
        crossTenantRejected = true;
      }
    }
    await check('L5: Cross-company evaluateInvoice rejects cleanly with ValidationError', crossTenantRejected);
  } catch (err) {
    console.error('[verifyPurch3Way1] Fatal test error:', err);
    await check('Live 3-way match suite execution', false, err instanceof Error ? err.message : String(err));
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
        await client.query('DELETE FROM purch_po_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_purchase_orders WHERE company_id = ANY($1::uuid[])', [companyIds]);
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
        console.error('[cleanup] Failed cleaning up verifyPurch3Way1:', cleanupErr);
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
  console.error('[verifyPurch3Way1] Fatal error:', err);
  process.exit(1);
});
