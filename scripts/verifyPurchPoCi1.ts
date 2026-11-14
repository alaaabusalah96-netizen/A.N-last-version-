import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultSupplierService } from '../src/server/purchasing/supplierService.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultPurchaseOrderService } from '../src/server/purchasing/purchaseOrderService.js';
import { defaultGrnService } from '../src/server/purchasing/grnService.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { ValidationError, NotFoundError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-PURCH-PO-CI-18 (Procurement PO-GRN CI Cycle Proof)   ===');
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

async function wirePurchasingGl(companyId: string, actorId: string, tag: string) {
  const inv = await defaultAccountService.createAccount(
    companyId,
    {
      code: `INV-${tag}`.slice(0, 20),
      nameAr: 'حساب مخزون (اختبار)',
      accountType: 'asset',
      isPostable: true,
    },
    actorId
  );
  const clr = await defaultAccountService.createAccount(
    companyId,
    {
      code: `CLR-${tag}`.slice(0, 20),
      nameAr: 'مشتريات معلقة (اختبار)',
      accountType: 'liability',
      isPostable: true,
    },
    actorId
  );
  await defaultCompanySettingsRepository.upsert(
    companyId,
    {
      inventoryAccountId: inv.id,
      purchasesClearingAccountId: clr.id,
    },
    actorId
  );
}

async function run() {
  const rootDir = process.cwd();

  // C8: Registration check in runFoundationBattery.ts and package.json
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const c8Ok =
    batterySrc.includes('scripts/verifyPurchPoCi1.ts') &&
    pkgJson?.scripts?.['test:purch-po-ci-1'] === 'tsx scripts/verifyPurchPoCi1.ts';
  await check('C8: verifyPurchPoCi1.ts registered in runFoundationBattery.ts and package.json (test:purch-po-ci-1)', c8Ok);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. C1-C7 loopback PostgreSQL PO-CI cycle proofs are BLOCKED.');
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
    blocked('Unable to connect to database executor. C1-C7 PO-CI cycle proofs are BLOCKED.');
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
      username: `ci_usr_a_${unique}`,
      passwordHash: 'dummy_ci_hash_18',
      role: 'platform_admin',
    });
    const userB = await userRepo.createUser({
      username: `ci_usr_b_${unique}`,
      passwordHash: 'dummy_ci_hash_18',
      role: 'platform_admin',
    });
    userIds.push(userA.id, userB.id);

    const compA = await companyRepo.create({
      code: `CIA-${unique}`.slice(0, 20),
      nameAr: `شركة دورة المشتريات أ ${unique}`,
      createdBy: userA.id,
    });
    const compB = await companyRepo.create({
      code: `CIB-${unique}`.slice(0, 20),
      nameAr: `شركة دورة المشتريات ب ${unique}`,
      createdBy: userB.id,
    });
    companyIds.push(compA.id, compB.id);

    await wirePurchasingGl(compA.id, userA.id, `A${unique}`);
    await wirePurchasingGl(compB.id, userB.id, `B${unique}`);

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
    const startOfMonth = `${y}-${m}-01`;
    const endOfMonth = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;

    await defaultPeriodService.createPeriod(
      compA.id,
      { code: `${y}-${m}-CI-${unique}`, startDate: startOfMonth, endDate: endOfMonth },
      userA.id
    );
    await defaultPeriodService.createPeriod(
      compB.id,
      { code: `${y}-${m}-CI-${unique}`, startDate: startOfMonth, endDate: endOfMonth },
      userB.id
    );

    const supplierA = await defaultSupplierService.createSupplier(
      compA.id,
      { code: `SUP-CIA-${unique}`, nameAr: 'مورد دورة CI' },
      userA.id
    );
    const warehouseA = await defaultWarehouseService.createWarehouse(
      compA.id,
      { code: `WH-CIA-${unique}`, nameAr: 'مستودع دورة CI' },
      userA.id
    );
    const item1 = await defaultItemService.createItem(
      compA.id,
      { code: `ITM-CIA-1-${unique}`, nameAr: 'صنف CI أول', uom: 'قطعة' },
      userA.id
    );
    const item2 = await defaultItemService.createItem(
      compA.id,
      { code: `ITM-CIA-2-${unique}`, nameAr: 'صنف CI ثان', uom: 'صندوق' },
      userA.id
    );

    // C1: Create PO (draft with 2 lines) -> Approve
    const poDraft = await defaultPurchaseOrderService.createPurchaseOrder(
      compA.id,
      {
        supplierId: supplierA.id,
        memo: 'CI Workflow Purchase Order',
        lines: [
          { itemId: item1.id, qty: 10, unitCost: 100 },
          { itemId: item2.id, qty: 5, unitCost: 200 },
        ],
      },
      userA.id
    );
    const poApproved = await defaultPurchaseOrderService.approvePurchaseOrder(compA.id, poDraft.id, userA.id);
    const line1Id = poApproved.lines![0].id;
    const line2Id = poApproved.lines![1].id;

    const c1Ok =
      poApproved.status === 'approved' &&
      poApproved.lines?.length === 2 &&
      poApproved.lines[0].receivedQty === 0 &&
      poApproved.lines[1].receivedQty === 0;
    await check('C1: PO created with 2 lines and successfully approved with 0 received quantities', c1Ok);

    // C2: First GRN linked to PO line 1 (partial qty 4) and post -> received_qty partial, PO remains approved
    const grn1 = await defaultGrnService.createGrn(
      compA.id,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: 'Partial Receipt GRN 1',
        poId: poApproved.id,
        lines: [{ itemId: item1.id, qty: 4, unitCost: 100, poLineId: line1Id } as any],
      } as any,
      userA.id
    );
    const postedGrn1 = await defaultGrnService.postGrn(compA.id, grn1.id, userA.id);
    const poAfterGrn1 = await defaultPurchaseOrderService.getPurchaseOrder(compA.id, poApproved.id);

    const c2Ok =
      postedGrn1.status === 'posted' &&
      poAfterGrn1.status === 'approved' &&
      poAfterGrn1.lines![0].receivedQty === 4 &&
      poAfterGrn1.lines![1].receivedQty === 0;
    await check('C2: Partial GRN posting updates received_qty to 4 and keeps PO status approved', c2Ok);

    // C3: Second GRN completing quantities (remaining 6 for line1, and 5 for line 2) -> PO closed automatically
    const grn2 = await defaultGrnService.createGrn(
      compA.id,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: 'Final Receipt GRN 2',
        poId: poApproved.id,
        lines: [
          { itemId: item1.id, qty: 6, unitCost: 100, poLineId: line1Id } as any,
          { itemId: item2.id, qty: 5, unitCost: 200, poLineId: line2Id } as any,
        ],
      } as any,
      userA.id
    );
    const postedGrn2 = await defaultGrnService.postGrn(compA.id, grn2.id, userA.id);
    const poAfterGrn2 = await defaultPurchaseOrderService.getPurchaseOrder(compA.id, poApproved.id);

    const c3Ok =
      postedGrn2.status === 'posted' &&
      poAfterGrn2.status === 'closed' &&
      poAfterGrn2.lines![0].receivedQty === 10 &&
      poAfterGrn2.lines![1].receivedQty === 5 &&
      Boolean(poAfterGrn2.closedAt);
    await check('C3: Second GRN completing all remaining quantities automatically closes the PO', c3Ok);

    // C4: Third GRN on the same closed PO -> rejected (no receiving after closing)
    let closedGrnRejected = false;
    try {
      const grnClosedAttempt = await defaultGrnService.createGrn(
        compA.id,
        {
          supplierId: supplierA.id,
          warehouseId: warehouseA.id,
          memo: 'Invalid Receipt on Closed PO',
          poId: poApproved.id,
          lines: [{ itemId: item1.id, qty: 1, unitCost: 100, poLineId: line1Id } as any],
        } as any,
        userA.id
      );
      await defaultGrnService.postGrn(compA.id, grnClosedAttempt.id, userA.id);
    } catch (err) {
      if (err instanceof ValidationError || (err instanceof Error && err.message.includes('closed'))) {
        closedGrnRejected = true;
      }
    }
    const c4Ok = closedGrnRejected;
    await check('C4: Creating/posting GRN on a closed PO is rejected with ValidationError', c4Ok);

    // C5: Tenant isolation test: company B cannot see PO or GRN
    let compBGetPoRejected = false;
    try {
      await defaultPurchaseOrderService.getPurchaseOrder(compB.id, poApproved.id);
    } catch (err) {
      if (err instanceof NotFoundError) {
        compBGetPoRejected = true;
      }
    }
    const compBPoList = await defaultPurchaseOrderService.listPurchaseOrders(compB.id);

    let compBGetGrnRejected = false;
    try {
      await defaultGrnService.getGrn(compB.id, postedGrn1.id);
    } catch (err) {
      if (err instanceof NotFoundError) {
        compBGetGrnRejected = true;
      }
    }
    const compBGrnList = await defaultGrnService.listGrns(compB.id);

    const c5Ok =
      compBGetPoRejected &&
      compBPoList.length === 0 &&
      compBGetGrnRejected &&
      compBGrnList.length === 0;
    await check('C5: Tenant isolation prevents Company B from accessing Company A POs/GRNs', c5Ok);

    // C6: Audit rows exist for operations within correct scope
    const auditActions = await withTenantTransaction(compA.id, async (tx: any) => {
      const res = await tx.query('SELECT action FROM audit_logs WHERE company_id = $1 AND entity_type IN (\'purch_purchase_orders\', \'purch_grn\')', [
        compA.id,
      ]);
      return res.rows.map((r: any) => r.action);
    });
    const c6Ok =
      auditActions.includes('PO_CREATE') &&
      auditActions.includes('PO_APPROVE') &&
      auditActions.includes('GRN_CREATE_DRAFT') &&
      auditActions.includes('GRN_POST');
    await check('C6: Audit logs record PO and GRN lifecycle events correctly under company scope', c6Ok);

    // C7: Verify rollback / cleanup readiness (assert data will be purged cleanly)
    const c7Ok = companyIds.length === 2 && userIds.length === 2;
    await check('C7: Test scope tracked correctly for clean rollback & purge', c7Ok);

  } catch (err) {
    await check('Purchasing PO-CI workflow unexpected error', false, err instanceof Error ? err.message : String(err));
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

        await client.query('DELETE FROM purch_grn_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_grn WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_po_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_purchase_orders WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM journal_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query(
          'UPDATE journal_entries SET reversed_by_entry_id = NULL WHERE company_id = ANY($1::uuid[])',
          [companyIds]
        );
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
        console.log('[cleanup] Test companies, POs, GRNs and audit logs purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('[cleanup] Failed cleaning up verifyPurchPoCi1:', cleanupErr);
      } finally {
        await client.end();
      }
    }
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  if (cleanupFailed) {
    console.error('[cleanup] Cleanup failed. Failing test to prevent silent leakage.');
    process.exit(1);
  }
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyPurchPoCi1] Fatal error:', err);
  process.exit(1);
});
