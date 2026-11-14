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
import { defaultPurchaseOrderService } from '../src/server/purchasing/purchaseOrderService.js';
import { defaultSupplierService } from '../src/server/purchasing/supplierService.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { ValidationError, NotFoundError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-PURCH-INVOICE-1 (Supplier Purchase Invoices Cycle) ===');
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

  // Registration check
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const regOk =
    batterySrc.includes('scripts/verifyPurchInvoice1.ts') &&
    pkgJson?.scripts?.['test:purch-invoice-1'] === 'tsx scripts/verifyPurchInvoice1.ts';
  await check('I0: verifyPurchInvoice1.ts registered in runFoundationBattery.ts and package.json', regOk);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. AN-PURCH-INVOICE-1 tests are BLOCKED.');
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
    blocked('Unable to connect to database executor. AN-PURCH-INVOICE-1 tests are BLOCKED.');
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
      username: `inv_usr_a_${unique}`,
      passwordHash: 'dummy_hash_inv_1',
      role: 'platform_admin',
    });
    const userB = await userRepo.createUser({
      username: `inv_usr_b_${unique}`,
      passwordHash: 'dummy_hash_inv_1',
      role: 'platform_admin',
    });
    userIds.push(userA.id, userB.id);

    const compA = await companyRepo.create({
      code: `INA-${unique}`.slice(0, 20),
      nameAr: `شركة المشتريات والفوترة أ ${unique}`,
      createdBy: userA.id,
    });
    const compB = await companyRepo.create({
      code: `INB-${unique}`.slice(0, 20),
      nameAr: `شركة العزل ب ${unique}`,
      createdBy: userB.id,
    });
    companyIds.push(compA.id, compB.id);

    const companyAId = compA.id;
    const companyBId = compB.id;
    const userId = userA.id;

    // 1. Setup GL Accounts and Settings for Company A
    const invAcc = await defaultAccountService.createAccount(
      companyAId,
      { code: `INV-${unique}`.slice(0, 20), nameAr: 'حساب المخزون (اختبار)', accountType: 'asset', isPostable: true },
      userId
    );
    const clrAcc = await defaultAccountService.createAccount(
      companyAId,
      { code: `CLR-${unique}`.slice(0, 20), nameAr: 'المشتريات المعلقة (اختبار)', accountType: 'liability', isPostable: true },
      userId
    );
    const apAcc = await defaultAccountService.createAccount(
      companyAId,
      { code: `AP-${unique}`.slice(0, 20), nameAr: 'حساب الدائنين والموردين (اختبار)', accountType: 'liability', isPostable: true },
      userId
    );

    await defaultCompanySettingsRepository.upsert(
      companyAId,
      {
        inventoryAccountId: invAcc.id,
        purchasesClearingAccountId: clrAcc.id,
        accountsPayableAccountId: apAcc.id,
      },
      userId
    );

    // Setup Supplier, Warehouse, Item for Company A
    const supplier = await defaultSupplierService.createSupplier(
      companyAId,
      { code: `SUP-${unique}`.slice(0, 20), nameAr: 'مورد التوريدات الرئيسي' },
      userId
    );
    const warehouse = await defaultWarehouseService.createWarehouse(
      companyAId,
      { code: `WH-${unique}`.slice(0, 20), nameAr: 'المستودع الرئيسي' },
      userId
    );
    const item = await defaultItemService.createItem(
      companyAId,
      { code: `ITM-${unique}`.slice(0, 20), nameAr: 'صنف حديد تسليح', uom: 'طن' },
      userId
    );

    // I1: PO -> GRN Link & Post
    console.log('[Test I1] Creating PO and posting GRN...');
    const po = await defaultPurchaseOrderService.createPurchaseOrder(
      companyAId,
      {
        supplierId: supplier.id,
        lines: [{ itemId: item.id, qty: 10, unitCost: 1000 }],
      },
      userId
    );
    await defaultPurchaseOrderService.approvePurchaseOrder(companyAId, po.id, userId);

    const grn = await defaultGrnService.createGrn(
      companyAId,
      {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        lines: [{ itemId: item.id, qty: 10, unitCost: 1000 }],
      },
      userId
    );
    await defaultGrnService.postGrn(companyAId, grn.id, userId);

    const postedGrn = await defaultGrnService.getGrn(companyAId, grn.id);
    await check('I1: GRN posted successfully with lines', Boolean(postedGrn && postedGrn.status === 'posted' && postedGrn.lines?.length === 1));

    // I2: Outstanding remainingQty calculation
    console.log('[Test I2] Checking outstanding lines...');
    const outstanding = await defaultInvoiceService.getOutstandingLines(companyAId, supplier.id);
    await check('I2: Outstanding lines returns correct remaining quantity (10)', Boolean(outstanding.length === 1 && Number(outstanding[0].remainingQty) === 10));

    // I3: Create supplier invoice draft from GRN lines
    console.log('[Test I3] Creating supplier invoice draft...');
    const grnLineId = postedGrn.lines![0].id;
    const invoiceDraft = await defaultInvoiceService.createInvoice(
      companyAId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `SUP-INV-001`,
        invoiceDate: '2026-03-01',
        lines: [{ grnLineId, qty: 6, unitCost: 1000 }],
      },
      userId
    );
    await check('I3: Supplier invoice draft created with status draft', Boolean(invoiceDraft.status === 'draft' && invoiceDraft.lines?.length === 1));

    // I4: Post supplier invoice -> balanced JE Dr clearing / Cr AP
    console.log('[Test I4] Posting supplier invoice...');
    const postedInvoice = await defaultInvoiceService.postInvoice(companyAId, invoiceDraft.id, userId);
    await check('I4: Supplier invoice posted successfully with journal entry', Boolean(postedInvoice.status === 'posted' && postedInvoice.journalEntryId));

    // Verify outstanding qty updated correctly (10 - 6 = 4)
    const outstandingAfter = await defaultInvoiceService.getOutstandingLines(companyAId, supplier.id);
    await check('I4b: Remaining quantity updated to 4 after partial invoice posting', Boolean(outstandingAfter.length === 1 && Number(outstandingAfter[0].remainingQty) === 4));

    // I5: Prevent reposting already posted invoice
    console.log('[Test I5] Testing reposting prevention...');
    let repostError = false;
    try {
      await defaultInvoiceService.postInvoice(companyAId, postedInvoice.id, userId);
    } catch (err: any) {
      if (err instanceof ValidationError || err.message?.includes('already posted')) {
        repostError = true;
      }
    }
    await check('I5: Cannot repost already posted invoice', repostError);

    // I6: Prevent over-invoicing GRN qty (exceeding remainingQty = 4)
    console.log('[Test I6] Testing over-invoicing prevention...');
    let overInvoiceError = false;
    try {
      const draft2 = await defaultInvoiceService.createInvoice(
        companyAId,
        {
          supplierId: supplier.id,
          supplierInvoiceNo: `SUP-INV-002`,
          lines: [{ grnLineId, qty: 5, unitCost: 1000 }], // remaining is 4
        },
        userId
      );
      await defaultInvoiceService.postInvoice(companyAId, draft2.id, userId);
    } catch (err: any) {
      if (err instanceof ValidationError || err.message?.includes('exceeds remaining')) {
        overInvoiceError = true;
      }
    }
    await check('I6: Over-invoicing exceeding remaining quantity rejected', overInvoiceError);

    // I7: Prevent invoicing unposted GRN lines
    console.log('[Test I7] Testing unposted GRN line invoicing prevention...');
    const grnUnposted = await defaultGrnService.createGrn(
      companyAId,
      {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        lines: [{ itemId: item.id, qty: 2, unitCost: 1000 }],
      },
      userId
    );
    const unpostedLineId = grnUnposted.lines![0].id;
    let unpostedError = false;
    try {
      await defaultInvoiceService.createInvoice(
        companyAId,
        {
          supplierId: supplier.id,
          supplierInvoiceNo: `SUP-INV-003`,
          lines: [{ grnLineId: unpostedLineId, qty: 2, unitCost: 1000 }],
        },
        userId
      );
    } catch (err: any) {
      if (err instanceof ValidationError || err.message?.includes('posted GRN')) {
        unpostedError = true;
      }
    }
    await check('I7: Invoicing unposted GRN line rejected', unpostedError);

    // I8: Prevent duplicate supplier invoice number per supplier
    console.log('[Test I8] Testing duplicate supplier invoice number rejection...');
    let dupError = false;
    try {
      await defaultInvoiceService.createInvoice(
        companyAId,
        {
          supplierId: supplier.id,
          supplierInvoiceNo: `SUP-INV-001`, // already used
          lines: [{ grnLineId, qty: 2, unitCost: 1000 }],
        },
        userId
      );
    } catch (err: any) {
      if (err instanceof ValidationError || err.message?.includes('duplicate') || err.message?.includes('already exists')) {
        dupError = true;
      }
    }
    await check('I8: Duplicate supplier invoice number per supplier rejected', dupError);

    // I9: Delete draft invoice allowed, delete posted invoice rejected
    console.log('[Test I9] Testing draft vs posted invoice deletion rules...');
    const draftForDel = await defaultInvoiceService.createInvoice(
      companyAId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `SUP-INV-DEL`,
        lines: [{ grnLineId, qty: 1, unitCost: 1000 }],
      },
      userId
    );
    await defaultInvoiceService.deleteInvoice(companyAId, draftForDel.id, userId);
    let deletedSuccessfully = false;
    try {
      await defaultInvoiceService.getInvoice(companyAId, draftForDel.id);
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        deletedSuccessfully = true;
      }
    }
    await check('I9a: Draft invoice successfully deleted', deletedSuccessfully);

    let deletePostedError = false;
    try {
      await defaultInvoiceService.deleteInvoice(companyAId, postedInvoice.id, userId);
    } catch (err: any) {
      if (err instanceof ValidationError || err.message?.includes('posted')) {
        deletePostedError = true;
      }
    }
    await check('I9b: Cannot delete posted invoice', deletePostedError);

    // I10: Tenant isolation
    console.log('[Test I10] Testing tenant isolation...');
    let isolationError = false;
    try {
      await defaultInvoiceService.getInvoice(companyBId, postedInvoice.id);
    } catch (err: any) {
      if (err instanceof NotFoundError || err.message?.includes('not found')) {
        isolationError = true;
      }
    }
    await check('I10: Tenant isolation prevents cross-company access', isolationError);

    console.log('[Test Suite] AN-PURCH-INVOICE-1 verification completed successfully.');
  } catch (err) {
    console.error('[verifyPurchInvoice1] Test failed with error:', err);
    blocked(err instanceof Error ? err.message : String(err));
  } finally {
    // Cleanup
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      console.log('[cleanup] Cleaning up test records...');
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
        await client.query('DELETE FROM purch_grn_headers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_po_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_purchase_orders WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM journal_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM journal_entries WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounts WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_items WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_warehouses WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_suppliers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM company_settings WHERE company_id = ANY($1::uuid[])', [companyIds]);
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
        console.log('[cleanup] Cleanup completed successfully.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('[cleanup] Failed cleaning up verifyPurchInvoice1:', cleanupErr);
      } finally {
        await client.end();
      }
    }
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  if (cleanupFailed) {
    console.error('[cleanup] Cleanup failed. Failing test.');
    process.exit(1);
  }
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyPurchInvoice1] Fatal error:', err);
  process.exit(1);
});
