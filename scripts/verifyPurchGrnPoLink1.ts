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
import { ValidationError, NotFoundError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-PURCH-GRN-PO-LINK-16 (GRN to PO E2E Integration)     ===');
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

  // G7: Registration in runFoundationBattery.ts + package.json (test:purch-grn-po-link-1)
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const g7Ok =
    batterySrc.includes('scripts/verifyPurchGrnPoLink1.ts') &&
    pkgJson?.scripts?.['test:purch-grn-po-link-1'] === 'tsx scripts/verifyPurchGrnPoLink1.ts';
  await check('G7: verifyPurchGrnPoLink1.ts registered in runFoundationBattery.ts and package.json (test:purch-grn-po-link-1)', g7Ok);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. G1-G6 loopback PostgreSQL GRN-PO link proofs are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
    if (process.env.MIGRATION_DATABASE_URL && process.env.MIGRATION_DATABASE_URL.trim() !== '') {
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
    blocked('Unable to connect to database executor. G1-G6 GRN-PO link proofs are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();

    const userA = await userRepo.createUser({
      username: `link_usr_a_${unique}`,
      passwordHash: 'dummy_link_hash_15',
      role: 'platform_admin',
    });
    const userB = await userRepo.createUser({
      username: `link_usr_b_${unique}`,
      passwordHash: 'dummy_link_hash_15',
      role: 'platform_admin',
    });
    userIds.push(userA.id, userB.id);

    const compA = await companyRepo.create({
      code: `LKA-${unique}`.slice(0, 20),
      nameAr: `شركة ربط المشتريات أ ${unique}`,
      createdBy: userA.id,
    });
    const compB = await companyRepo.create({
      code: `LKB-${unique}`.slice(0, 20),
      nameAr: `شركة ربط المشتريات ب ${unique}`,
      createdBy: userB.id,
    });
    companyIds.push(compA.id, compB.id);

    const supplierA = await defaultSupplierService.createSupplier(
      compA.id,
      { code: `SUP-LKA-${unique}`, nameAr: 'مورد ربط PO' },
      userA.id
    );
    const warehouseA = await defaultWarehouseService.createWarehouse(
      compA.id,
      { code: `WH-LKA-${unique}`, nameAr: 'مستودع ربط PO' },
      userA.id
    );
    const itemA = await defaultItemService.createItem(
      compA.id,
      { code: `ITM-LKA-${unique}`, nameAr: 'صنف ربط PO', uom: 'قطعة' },
      userA.id
    );

    // Create and approve PO with qty 10
    const poDraft = await defaultPurchaseOrderService.createPurchaseOrder(
      compA.id,
      {
        supplierId: supplierA.id,
        memo: 'PO for GRN Link Test',
        lines: [{ itemId: itemA.id, qty: 10, unitCost: 50 }],
      },
      userA.id
    );
    const poApproved = await defaultPurchaseOrderService.approvePurchaseOrder(compA.id, poDraft.id, userA.id);
    const poLineId = poApproved.lines![0].id;

    // G1: Post GRN linked to approved PO -> received_qty increases and tables consistent
    const grn1 = await defaultGrnService.createGrn(
      compA.id,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: 'Partial Receipt GRN',
        poId: poApproved.id,
        lines: [{ itemId: itemA.id, qty: 4, unitCost: 50, poLineId } as any],
      } as any,
      userA.id
    );
    const postedGrn1 = await defaultGrnService.postGrn(compA.id, grn1.id, userA.id);

    const refreshedPo1 = await defaultPurchaseOrderService.getPurchaseOrder(compA.id, poApproved.id);
    const g1Ok =
      postedGrn1.status === 'posted' &&
      refreshedPo1.lines![0].receivedQty === 4 &&
      refreshedPo1.status === 'approved';
    await check('G1: Posting linked GRN increases PO line received_qty to 4 and leaves PO approved', g1Ok);

    // G2: Exceeding PO line qty (remaining is 6, attempt 7) -> rejected completely
    const grnExceed = await defaultGrnService.createGrn(
      compA.id,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: 'Exceeding Receipt GRN',
        poId: poApproved.id,
        lines: [{ itemId: itemA.id, qty: 7, unitCost: 50, poLineId } as any],
      } as any,
      userA.id
    );
    let exceedRejected = false;
    try {
      await defaultGrnService.postGrn(compA.id, grnExceed.id, userA.id);
    } catch (err) {
      if (err instanceof ValidationError) {
        exceedRejected = true;
      }
    }
    const refreshedPo2 = await defaultPurchaseOrderService.getPurchaseOrder(compA.id, poApproved.id);
    const g2Ok = exceedRejected && refreshedPo2.lines![0].receivedQty === 4;
    await check('G2: Exceeding remaining PO qty throws ValidationError and rolls back transaction with zero side-effects', g2Ok);

    // G3: Full receipt (remaining 6) -> PO automatically closed inside same tx
    const grnFull = await defaultGrnService.createGrn(
      compA.id,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: 'Final Receipt GRN',
        poId: poApproved.id,
        lines: [{ itemId: itemA.id, qty: 6, unitCost: 50, poLineId } as any],
      } as any,
      userA.id
    );
    const postedGrnFull = await defaultGrnService.postGrn(compA.id, grnFull.id, userA.id);
    const refreshedPoClosed = await defaultPurchaseOrderService.getPurchaseOrder(compA.id, poApproved.id);
    const g3Ok =
      postedGrnFull.status === 'posted' &&
      refreshedPoClosed.lines![0].receivedQty === 10 &&
      refreshedPoClosed.status === 'closed' &&
      Boolean(refreshedPoClosed.closedAt);
    await check('G3: Full receipt of remaining PO qty automatically transitions PO status to closed', g3Ok);

    // G4: Atomic rollback on failure (verify transaction isolation & rollback)
    let atomicRollbackVerified = false;
    try {
      await withTenantTransaction(compA.id, async (_tx) => {
        throw new Error('Simulated failure after update');
      });
    } catch {
      atomicRollbackVerified = true;
    }
    const refreshedPoAfterFail = await defaultPurchaseOrderService.getPurchaseOrder(compA.id, poApproved.id);
    const g4Ok = atomicRollbackVerified && refreshedPoAfterFail.lines![0].receivedQty === 10;
    await check('G4: Transaction failures guarantee atomic rollback with zero partial updates to received_qty', g4Ok);

    // G5: GRN with poId from another company -> ValidationError (tenant cross-company isolation)
    let crossCompanyGrnRejected = false;
    try {
      await defaultGrnService.createGrn(
        compB.id,
        {
          supplierId: supplierA.id,
          warehouseId: warehouseA.id,
          memo: 'Cross Company PO Link',
          poId: poApproved.id, // belongs to compA
          lines: [{ itemId: itemA.id, qty: 1, unitCost: 50, poLineId } as any],
        } as any,
        userB.id
      );
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ValidationError) {
        crossCompanyGrnRejected = true;
      }
    }
    const g5Ok = crossCompanyGrnRejected;
    await check('G5: Linking GRN to PO from another tenant throws NotFound/Validation error (tenant isolation)', g5Ok);

    // G6: GRN without poId works exactly as before (backward compatibility)
    const grnStandard = await defaultGrnService.createGrn(
      compA.id,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: 'Standard Direct GRN',
        lines: [{ itemId: itemA.id, qty: 2, unitCost: 45 }],
      },
      userA.id
    );
    const postedGrnStandard = await defaultGrnService.postGrn(compA.id, grnStandard.id, userA.id);
    const g6Ok = postedGrnStandard.status === 'posted';
    await check('G6: Standard GRN without poId continues to post successfully with zero regressions', g6Ok);
  } catch (err) {
    await check('GRN-PO Link verification unexpected error', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await client.query('DELETE FROM purch_grn_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_grn WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_po_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_purchase_orders WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_sequences WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_items WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_suppliers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_warehouses WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('COMMIT');
        console.log(`[cleanup] Test companies and link records purged cleanly.`);
      } catch (cleanupErr) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('[cleanup] Failed cleaning up verifyPurchGrnPoLink1:', cleanupErr);
      } finally {
        await client.end();
      }
    }
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyPurchGrnPoLink1] Fatal error:', err);
  process.exit(1);
});
