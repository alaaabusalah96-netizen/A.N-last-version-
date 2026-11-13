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
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultPurchaseOrderService } from '../src/server/purchasing/purchaseOrderService.js';
import { NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-PURCH-PO-15 (Purchase Orders Lifecycle & RLS Proof) ===');
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

  // P7: Registration in runFoundationBattery.ts + package.json (test:purch-po-1)
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const p7Ok =
    batterySrc.includes('scripts/verifyPurchPo1.ts') &&
    pkgJson?.scripts?.['test:purch-po-1'] === 'tsx scripts/verifyPurchPo1.ts';
  await check('P7: verifyPurchPo1.ts registered in runFoundationBattery.ts and package.json (test:purch-po-1)', p7Ok);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. P1-P6 loopback PostgreSQL Purchase Order proofs are BLOCKED.');
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
    blocked('Unable to connect to database executor. P1-P6 Purchase Order proofs are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  const poIds: string[] = [];

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();

    const userA = await userRepo.createUser({
      username: `po_verify_a_${unique}`,
      passwordHash: 'dummy_po_hash_15',
      role: 'platform_admin',
    });
    const userB = await userRepo.createUser({
      username: `po_verify_b_${unique}`,
      passwordHash: 'dummy_po_hash_15',
      role: 'platform_admin',
    });
    userIds.push(userA.id, userB.id);

    const compA = await companyRepo.create({
      code: `POA-${unique}`.slice(0, 20),
      nameAr: `شركة أوامر شراء أ ${unique}`,
      createdBy: userA.id,
    });
    const compB = await companyRepo.create({
      code: `POB-${unique}`.slice(0, 20),
      nameAr: `شركة أوامر شراء ب ${unique}`,
      createdBy: userB.id,
    });
    companyIds.push(compA.id, compB.id);

    const supplierA = await defaultSupplierService.createSupplier(
      compA.id,
      { code: `SUP-A-${unique}`, nameAr: 'مورد اختبار PO' },
      userA.id
    );
    const itemA1 = await defaultItemService.createItem(
      compA.id,
      { code: `ITM-A1-${unique}`, nameAr: 'صنف اختبار PO 1', uom: 'قطعة' },
      userA.id
    );
    const itemA2 = await defaultItemService.createItem(
      compA.id,
      { code: `ITM-A2-${unique}`, nameAr: 'صنف اختبار PO 2', uom: 'كجم' },
      userA.id
    );

    // P1: Create 2 draft POs with lines -> verify persisted rows
    const po1 = await defaultPurchaseOrderService.createPurchaseOrder(
      compA.id,
      {
        supplierId: supplierA.id,
        expectedDate: '2026-12-15',
        memo: 'PO Verify Draft 1',
        lines: [
          { itemId: itemA1.id, qty: 10, unitCost: 25.5 },
          { itemId: itemA2.id, qty: 4, unitCost: 12 },
        ],
      },
      userA.id
    );
    const po2 = await defaultPurchaseOrderService.createPurchaseOrder(
      compA.id,
      {
        supplierId: supplierA.id,
        memo: 'PO Verify Draft 2',
        lines: [{ itemId: itemA1.id, qty: 5, unitCost: 30 }],
      },
      userA.id
    );
    const po3 = await defaultPurchaseOrderService.createPurchaseOrder(
      compA.id,
      {
        supplierId: supplierA.id,
        memo: 'PO Verify Draft 3',
        lines: [{ itemId: itemA2.id, qty: 3 }],
      },
      userA.id
    );
    poIds.push(po1.id, po2.id, po3.id);

    const p1Ok =
      po1.status === 'draft' &&
      po2.status === 'draft' &&
      Array.isArray(po1.lines) &&
      po1.lines.length === 2 &&
      po1.lines[0].qty === 10 &&
      po1.lines[0].unitCost === 25.5 &&
      po1.lines[0].receivedQty === 0 &&
      po1.expectedDate === '2026-12-15' &&
      Array.isArray(po2.lines) &&
      po2.lines.length === 1;
    await check('P1: Created draft POs with lines return valid header + line rows (receivedQty=0)', p1Ok);

    // P2: Approve draft -> approved succeeds, approving non-draft rejected
    const approvedPo1 = await defaultPurchaseOrderService.approvePurchaseOrder(compA.id, po1.id, userA.id);
    let nonDraftApproveRejected = false;
    try {
      await defaultPurchaseOrderService.approvePurchaseOrder(compA.id, po1.id, userA.id);
    } catch (err) {
      if (err instanceof ValidationError) {
        nonDraftApproveRejected = true;
      }
    }
    const p2Ok =
      approvedPo1.status === 'approved' &&
      typeof approvedPo1.poNo === 'string' &&
      approvedPo1.poNo.startsWith('PO-') &&
      Boolean(approvedPo1.approvedAt) &&
      approvedPo1.approvedBy === userA.id &&
      nonDraftApproveRejected;
    await check('P2: approvePurchaseOrder transitions draft->approved with poNo/approvedAt/approvedBy and rejects non-draft', p2Ok);

    // P3: Cancel / Close valid vs invalid transitions
    let closeDraftRejected = false;
    try {
      await defaultPurchaseOrderService.closePurchaseOrder(compA.id, po2.id, userA.id);
    } catch (err) {
      if (err instanceof ValidationError) {
        closeDraftRejected = true;
      }
    }

    const closedPo1 = await defaultPurchaseOrderService.closePurchaseOrder(compA.id, po1.id, userA.id);

    let cancelClosedRejected = false;
    try {
      await defaultPurchaseOrderService.cancelPurchaseOrder(compA.id, po1.id, userA.id);
    } catch (err) {
      if (err instanceof ValidationError) {
        cancelClosedRejected = true;
      }
    }

    const cancelledPo2 = await defaultPurchaseOrderService.cancelPurchaseOrder(compA.id, po2.id, userA.id);
    const approvedPo3 = await defaultPurchaseOrderService.approvePurchaseOrder(compA.id, po3.id, userA.id);
    const cancelledPo3 = await defaultPurchaseOrderService.cancelPurchaseOrder(compA.id, po3.id, userA.id);

    const p3Ok =
      closeDraftRejected &&
      closedPo1.status === 'closed' &&
      Boolean(closedPo1.closedAt) &&
      closedPo1.closedBy === userA.id &&
      cancelClosedRejected &&
      cancelledPo2.status === 'cancelled' &&
      approvedPo3.status === 'approved' &&
      cancelledPo3.status === 'cancelled';
    await check('P3: cancel/close allow only valid transitions (approved->closed, draft|approved->cancelled) and reject invalid ones', p3Ok);

    // P4: Tenant isolation (Company B cannot see or mutate Company A POs)
    let crossCompanyGetRejected = false;
    try {
      await defaultPurchaseOrderService.getPurchaseOrder(compB.id, po1.id);
    } catch (err) {
      if (err instanceof NotFoundError) {
        crossCompanyGetRejected = true;
      }
    }
    const compBList = await defaultPurchaseOrderService.listPurchaseOrders(compB.id);
    const p4Ok = crossCompanyGetRejected && compBList.length === 0;
    await check('P4: Cross-tenant PO read returns NotFoundError and Company B list returns 0 rows', p4Ok);

    // P5: RLS direct query as an_app without app.current_tenant_id returns 0 rows
    let rlsNoCtxHeaderCount = -1;
    let rlsNoCtxLinesCount = -1;
    await executor.query('BEGIN');
    try {
      await executor.query("SELECT set_config('app.current_tenant_id', '', true);");
      const hRes = await executor.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM purch_purchase_orders;');
      const lRes = await executor.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM purch_po_lines;');
      rlsNoCtxHeaderCount = hRes.rows[0]?.cnt ?? -1;
      rlsNoCtxLinesCount = lRes.rows[0]?.cnt ?? -1;
    } finally {
      await executor.query('ROLLBACK');
    }

    const compAPosInTenant = await withTenantTransaction(compA.id, async (tx) => {
      const res = await tx.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM purch_purchase_orders;');
      return res.rows[0]?.cnt ?? 0;
    });
    const p5Ok = rlsNoCtxHeaderCount === 0 && rlsNoCtxLinesCount === 0 && compAPosInTenant === 3;
    await check('P5: RLS as an_app without set_config returns 0 rows on purch_purchase_orders and purch_po_lines while 3 rows exist in tenant', p5Ok);

    // P6: Audit rows recorded inside transaction (mode: 'required') for every transition
    const poServiceSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/purchaseOrderService.ts'), 'utf8');
    const usesRequiredAuditInTx =
      poServiceSrc.includes("mode: 'required'") &&
      poServiceSrc.includes('executor: tx') &&
      !poServiceSrc.includes('best_effort');

    const auditActions = await withTenantTransaction(compA.id, async (tx) => {
      const res = await tx.query<{ action: string }>(
        `SELECT action
         FROM audit_logs
         WHERE company_id = $1
           AND entity_type = 'purch_purchase_orders'
           AND entity_id = ANY($2::uuid[])`,
        [compA.id, poIds]
      );
      return res.rows.map((r) => r.action);
    });

    const p6Ok =
      usesRequiredAuditInTx &&
      auditActions.includes('PO_CREATE') &&
      auditActions.includes('PO_APPROVE') &&
      auditActions.includes('PO_CLOSE') &&
      auditActions.includes('PO_CANCEL');
    await check('P6: Audit rows exist for PO_CREATE, PO_APPROVE, PO_CLOSE, PO_CANCEL with mode=required inside tx', p6Ok);
  } catch (err) {
    await check('PO verification unexpected error', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && (companyIds.length > 0 || userIds.length > 0)) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        if (companyIds.length > 0) {
          await client.query('DELETE FROM purch_po_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
          await client.query('DELETE FROM purch_purchase_orders WHERE company_id = ANY($1::uuid[])', [companyIds]);
          await client.query('DELETE FROM accounting_sequences WHERE company_id = ANY($1::uuid[])', [companyIds]);
          await client.query('DELETE FROM inv_items WHERE company_id = ANY($1::uuid[])', [companyIds]);
          await client.query('DELETE FROM purch_suppliers WHERE company_id = ANY($1::uuid[])', [companyIds]);
          await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
          await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        }
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('COMMIT');
        console.log(`[cleanup] Test companies/POs/users purged cleanly (${companyIds.length} companies, ${poIds.length} POs).`);
      } catch (cleanupErr) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('[cleanup] Rollback error:', rollbackErr);
        }
        console.error('[cleanup] Failed cleaning up verifyPurchPo1 artifacts:', cleanupErr);
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
  console.error('[verifyPurchPo1] Fatal error:', err);
  process.exit(1);
});
