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
import { defaultStockRepository } from '../src/server/inventory/stockRepository.js';
import { ValidationError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-INT-PURCH-1 WP-B: Purchase Return Rules & GL/Stock  ===');
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
    'S0: verifyPurchReturn1.ts registered in runFoundationBattery.ts and package.json',
    batterySrc.includes('scripts/verifyPurchReturn1.ts') &&
      pkgJson?.scripts?.['test:purch-return-1'] === 'tsx scripts/verifyPurchReturn1.ts'
  );

  // S1-S2: Service hardening checks
  const returnSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/purchReturnService.ts'), 'utf8');
  await check(
    'S1: purchReturnService enforces GRN-line membership, posted invoice check, and BigInt minor-unit qty limit',
    returnSvcSrc.includes('out.grnId !== input.grnId') &&
      returnSvcSrc.includes("inv.status !== 'posted'") &&
      returnSvcSrc.includes('toMinorUnits(alreadyReturned, 4) + toMinorUnits(line.qty, 4) > toMinorUnits(gQty, 4)')
  );
  await check(
    'S2: purchReturnService checks decrementBalance return value and emits purchase_return stock movement',
    returnSvcSrc.includes('const updatedBalance = await this.stockRepo.decrementBalance') &&
      returnSvcSrc.includes('if (!updatedBalance)') &&
      returnSvcSrc.includes("'purchase_return'")
  );

  // Live DB verification
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live purchase return verification is BLOCKED.');
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
    blocked('Unable to connect to database executor. Live purchase return verification is BLOCKED.');
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
      username: `ret_usr_a_${unique}`,
      passwordHash: 'dummy_hash_ret_1',
      role: 'platform_admin',
    });
    userIds.push(userA.id);

    const compA = await companyRepo.create({
      code: `RTA-${unique}`.slice(0, 20),
      nameAr: `شركة اختبار مرتجع المشتريات ${unique}`,
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
      { code: `${y}-${m}-RET-${unique}`, startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}` },
      userId
    );

    const supplier = await defaultSupplierService.createSupplier(
      companyAId,
      { code: `SUP-${unique}`.slice(0, 20), nameAr: 'مورد المرتجعات' },
      userId
    );
    const warehouse = await defaultWarehouseService.createWarehouse(
      companyAId,
      { code: `WH-${unique}`.slice(0, 20), nameAr: 'مستودع المرتجعات' },
      userId
    );
    const item = await defaultItemService.createItem(
      companyAId,
      { code: `ITM-${unique}`.slice(0, 20), nameAr: 'صنف مرتجع', uom: 'قطعة' },
      userId
    );

    // Post GRN 1 (qty=10, unitCost=50 -> stock=10) & GRN 2 (qty=3, unitCost=50)
    const grn1 = await defaultGrnService.createGrn(
      companyAId,
      { supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ itemId: item.id, qty: 10, unitCost: 50 }] },
      userId
    );
    await defaultGrnService.postGrn(companyAId, grn1.id, userId);
    const postedGrn1 = await defaultGrnService.getGrn(companyAId, grn1.id);
    const grn1LineId = postedGrn1.lines![0].id;

    const grn2 = await defaultGrnService.createGrn(
      companyAId,
      { supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ itemId: item.id, qty: 3, unitCost: 50 }] },
      userId
    );
    await defaultGrnService.postGrn(companyAId, grn2.id, userId);
    const postedGrn2 = await defaultGrnService.getGrn(companyAId, grn2.id);
    const grn2LineId = postedGrn2.lines![0].id;

    // Create draft & posted invoices against GRN 1
    const draftInv = await defaultInvoiceService.createInvoice(
      companyAId,
      { supplierId: supplier.id, supplierInvoiceNo: `RET-DRF-INV-${unique}`, lines: [{ grnLineId: grn1LineId, qty: 2, unitCost: 50 }] },
      userId
    );
    const postedInvDraft = await defaultInvoiceService.createInvoice(
      companyAId,
      { supplierId: supplier.id, supplierInvoiceNo: `RET-PST-INV-${unique}`, lines: [{ grnLineId: grn1LineId, qty: 8, unitCost: 50 }] },
      userId
    );
    const postedInv = await defaultInvoiceService.postInvoice(companyAId, postedInvDraft.id, userId);

    // R1: Returnable lines reflect GRN qty
    const retLinesInitial = await defaultPurchReturnService.listReturnableLines(companyAId, supplier.id);
    const g1RetRow = retLinesInitial.find((r) => r.grnLineId === grn1LineId);
    await check(
      'R1: Returnable qty starts equal to posted GRN qty (10)',
      Boolean(g1RetRow && g1RetRow.returnableQty === 10 && g1RetRow.alreadyReturnedQty === 0)
    );

    // R2: Create & post partial return (qty=4) linked to posted invoice
    const ret1Draft = await defaultPurchReturnService.createReturn(
      companyAId,
      {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        grnId: grn1.id,
        invoiceId: postedInv.id,
        lines: [{ grnLineId: grn1LineId, qty: 4, unitCost: 50 }],
      },
      userId
    );
    const ret1Posted = await defaultPurchReturnService.postReturn(companyAId, ret1Draft.id, userId);

    const balancesAfterR2 = await defaultStockRepository.listBalancesByItem(companyAId, item.id);
    const balR2 = balancesAfterR2.find((b) => b.warehouseId === warehouse.id)?.qty ?? -1;
    const retMovements = await defaultStockRepository.listMovementsByItem(companyAId, item.id, {
      warehouseId: warehouse.id,
      movementType: 'purchase_return',
    });
    const retLinesAfterR2 = await defaultPurchReturnService.listReturnableLines(companyAId, supplier.id);
    const g1AfterR2 = retLinesAfterR2.find((r) => r.grnLineId === grn1LineId);

    // Verify balanced GL journal entry: Dr AP 200 / Cr Inventory 200
    const jeRes = await executor.query<any>(
      `SELECT account_id, debit::numeric as debit, credit::numeric as credit
       FROM journal_lines WHERE company_id = $1 AND journal_entry_id = $2`,
      [companyAId, ret1Posted.journalEntryId]
    );
    const drApOk = jeRes.rows.some((r: any) => r.account_id === apAcc.id && Number(r.debit) === 200 && Number(r.credit) === 0);
    const crInvOk = jeRes.rows.some((r: any) => r.account_id === invAcc.id && Number(r.debit) === 0 && Number(r.credit) === 200);

    await check(
      'R2: Posting return decrements stock (13-4=9), records purchase_return (-4), posts balanced GL (Dr AP/Cr Inv 200), updates returnable=6',
      ret1Posted.status === 'posted' &&
        balR2 === 9 &&
        retMovements.some((mv) => mv.movementType === 'purchase_return' && mv.qty === -4) &&
        drApOk &&
        crInvOk &&
        g1AfterR2?.returnableQty === 6 &&
        g1AfterR2?.alreadyReturnedQty === 4
    );

    // R3: Draft returns do NOT reduce returnable qty; exceeding returnable on create is rejected
    const retDraftOnly = await defaultPurchReturnService.createReturn(
      companyAId,
      {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        grnId: grn1.id,
        lines: [{ grnLineId: grn1LineId, qty: 4, unitCost: 50 }],
      },
      userId
    );
    const retLinesWithDraft = await defaultPurchReturnService.listReturnableLines(companyAId, supplier.id);
    const g1WithDraft = retLinesWithDraft.find((r) => r.grnLineId === grn1LineId);

    let exceedCreateRejected = false;
    try {
      await defaultPurchReturnService.createReturn(
        companyAId,
        {
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          grnId: grn1.id,
          lines: [{ grnLineId: grn1LineId, qty: 7, unitCost: 50 }],
        },
        userId
      );
    } catch (err) {
      if (err instanceof ValidationError) exceedCreateRejected = true;
    }
    await check(
      'R3: Draft return does not reduce returnable (still 6) and exceeding returnable (7 > 6) is rejected',
      g1WithDraft?.returnableQty === 6 && exceedCreateRejected
    );

    // R4: Two competing draft returns (4 and 4 when returnable=6): first posts (rem=2), second over-posts and must fail
    const retCompete = await defaultPurchReturnService.createReturn(
      companyAId,
      {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        grnId: grn1.id,
        lines: [{ grnLineId: grn1LineId, qty: 4, unitCost: 50 }],
      },
      userId
    );
    await defaultPurchReturnService.postReturn(companyAId, retDraftOnly.id, userId);
    let secondPostRejected = false;
    try {
      await defaultPurchReturnService.postReturn(companyAId, retCompete.id, userId);
    } catch (err) {
      if (err instanceof ValidationError) secondPostRejected = true;
    }
    const balAfterR4 = (await defaultStockRepository.listBalancesByItem(companyAId, item.id)).find(
      (b) => b.warehouseId === warehouse.id
    )?.qty;
    await check(
      'R4: Competing second return post exceeding returnable (4 > 2) is rejected cleanly leaving stock=5',
      secondPostRejected && balAfterR4 === 5
    );

    // R5: Reject cross-GRN line mismatch and unposted draft invoice linkage
    let crossGrnRejected = false;
    try {
      await defaultPurchReturnService.createReturn(
        companyAId,
        {
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          grnId: grn1.id,
          lines: [{ grnLineId: grn2LineId, qty: 1, unitCost: 50 }],
        },
        userId
      );
    } catch (err) {
      if (err instanceof ValidationError) crossGrnRejected = true;
    }

    let draftInvRejected = false;
    try {
      await defaultPurchReturnService.createReturn(
        companyAId,
        {
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          grnId: grn1.id,
          invoiceId: draftInv.id,
          lines: [{ grnLineId: grn1LineId, qty: 1, unitCost: 50 }],
        },
        userId
      );
    } catch (err) {
      if (err instanceof ValidationError) draftInvRejected = true;
    }
    await check(
      'R5: Rejects grnLineId from wrong GRN and unposted draft invoiceId',
      crossGrnRejected && draftInvRejected
    );

    // R6: Reject return post when physical warehouse stock is below return qty
    const retStockTest = await defaultPurchReturnService.createReturn(
      companyAId,
      {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        grnId: grn2.id,
        lines: [{ grnLineId: grn2LineId, qty: 3, unitCost: 50 }],
      },
      userId
    );
    // Reduce physical stock below 3 (from 5 down to 1) via stock adjustment test
    await defaultStockRepository.decrementBalance(companyAId, warehouse.id, item.id, 4, executor);
    let insufficientStockRejected = false;
    try {
      await defaultPurchReturnService.postReturn(companyAId, retStockTest.id, userId);
    } catch (err) {
      if (err instanceof ValidationError) insufficientStockRejected = true;
    }
    const balAfterR6 = (await defaultStockRepository.listBalancesByItem(companyAId, item.id)).find(
      (b) => b.warehouseId === warehouse.id
    )?.qty;
    await check(
      'R6: Post return fails cleanly without movement/GL drift when physical stock < return qty',
      insufficientStockRejected && balAfterR6 === 1
    );
  } catch (err) {
    console.error('[verifyPurchReturn1] Fatal test error:', err);
    await check('Live purchase return suite execution', false, err instanceof Error ? err.message : String(err));
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

        await client.query('DELETE FROM purch_return_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_returns WHERE company_id = ANY($1::uuid[])', [companyIds]);
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
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('[cleanup] Failed cleaning up verifyPurchReturn1:', cleanupErr);
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
  console.error('[verifyPurchReturn1] Fatal error:', err);
  process.exit(1);
});
