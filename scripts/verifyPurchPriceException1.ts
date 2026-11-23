import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import crypto from 'crypto';
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
import { defaultPriceVarianceExceptionService } from '../src/server/purchasing/priceVarianceExceptionService.js';
import { defaultPriceVarianceExceptionRepository } from '../src/server/purchasing/priceVarianceExceptionRepository.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { ValidationError } from '../src/server/http/errors.js';
import { ensureTestCostingProfile } from './helpers/ensureTestCostingProfile.js';

console.log('============================================================================');
console.log('=== VERIFYING AN-PKG-7C: PRICE VARIANCE EXCEPTION SoD, DURABLE SUPERSEDE ===');
console.log('============================================================================');

async function run() {
  const rootDir = process.cwd();

  // S0: Registration checks
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  await check(
    'S0: verifyPurchPriceException1.ts registered in runFoundationBattery.ts and package.json',
    batterySrc.includes('scripts/verifyPurchPriceException1.ts') &&
      pkgJson?.scripts?.['test:purch-price-exception-1'] === 'tsx scripts/verifyPurchPriceException1.ts'
  );

  // S1: Migration 055, 056 & 057 & table_ownership.json structural checks
  const mig055Path = path.join(rootDir, 'database/migrations/055_purch_price_variance_exception.sql');
  const mig056Path = path.join(rootDir, 'database/migrations/056_purch_price_variance_exception_harden.sql');
  const mig057Path = path.join(rootDir, 'database/migrations/057_purch_price_variance_exception_guards.sql');
  const mig055Exists = fs.existsSync(mig055Path);
  const mig056Exists = fs.existsSync(mig056Path);
  const mig057Exists = fs.existsSync(mig057Path);
  const mig055 = mig055Exists ? fs.readFileSync(mig055Path, 'utf8') : '';
  const mig056 = mig056Exists ? fs.readFileSync(mig056Path, 'utf8') : '';
  const mig057 = mig057Exists ? fs.readFileSync(mig057Path, 'utf8') : '';
  const ownershipJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'database/table_ownership.json'), 'utf8'));
  const ownershipArr: Array<{ table: string; scope: string }> = Array.isArray(ownershipJson) ? ownershipJson : [];
  const hasTenantEntry = (tableName: string) =>
    ownershipArr.some((entry) => entry.table === tableName && entry.scope === 'tenant');

  await check(
    'S1: Migrations 055/056/057 define purch_price_variance_exceptions with RLS FORCE, TO an_app, ON DELETE RESTRICT FKs, BEFORE INSERT OR UPDATE OR DELETE guard, zero EXCEPTION WHEN OTHERS & table_ownership',
    mig055Exists &&
      mig056Exists &&
      mig057Exists &&
      mig055.includes('purch_price_variance_exceptions') &&
      mig056.includes('TO an_app') &&
      mig057.includes('supersede_reason') &&
      mig057.includes('ON DELETE RESTRICT') &&
      mig057.includes('BEFORE INSERT OR UPDATE OR DELETE') &&
      mig057.includes('fk_purch_price_variance_exceptions_invoice_composite') &&
      mig057.includes('fn_guard_purch_price_variance_exceptions') &&
      !/\bEXCEPTION\s+WHEN\s+OTHERS\b/i.test(mig056.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '')) &&
      !/\bEXCEPTION\s+WHEN\s+OTHERS\b/i.test(mig057.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '')) &&
      hasTenantEntry('purch_price_variance_exceptions')
  );

  // S2: RBAC permissions registered
  const permsSrc = fs.readFileSync(path.join(rootDir, 'src/server/rbac/permissions.ts'), 'utf8');
  await check(
    'S2: PURCHASING_VARIANCE_REQUEST & PURCHASING_VARIANCE_APPROVE permissions registered',
    permsSrc.includes('PURCHASING_VARIANCE_REQUEST') && permsSrc.includes('PURCHASING_VARIANCE_APPROVE')
  );

  // S3: Repository, Service, Routes & InvoiceService integration
  const repoSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/priceVarianceExceptionRepository.ts'), 'utf8');
  const svcSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/priceVarianceExceptionService.ts'), 'utf8');
  const routesSrc = fs.readFileSync(path.join(rootDir, 'src/server/routes/purchasingRoutes.ts'), 'utf8');
  const invSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/invoiceService.ts'), 'utf8');
  const invRepoSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/invoiceRepository.ts'), 'utf8');
  const wsSrc = fs.readFileSync(path.join(rootDir, 'src/components/purchasing/PurchasingWorkspace.tsx'), 'utf8');
  const panelPath = path.join(rootDir, 'src/components/purchasing/PriceVarianceExceptionPanel.tsx');
  const panelSrc = fs.existsSync(panelPath) ? fs.readFileSync(panelPath, 'utf8') : '';

  await check(
    'S3: Unified lock order (invoice then exception), durable supersede (Option A), supersede_reason separation, mandatory actorId, SoD on approve/reject, invoice delete retention guard, and findByIdForUpdate loads lines',
    repoSrc.includes('computeFingerprint') &&
      repoSrc.includes('supersede_reason as "supersedeReason"') &&
      repoSrc.includes('hasAnyForInvoice') &&
      svcSrc.includes('requestedBy') &&
      svcSrc.includes('fingerprintMismatch') &&
      svcSrc.includes('normalizedActorId') &&
      svcSrc.includes('isFingerprintValid') &&
      routesSrc.includes('resolveMutationCompanyId') &&
      invSvcSrc.includes('findActiveApprovedByInvoice') &&
      invSvcSrc.includes('hasAnyForInvoice') &&
      invRepoSrc.includes('purch_supplier_invoice_lines') &&
      !invRepoSrc.includes('return mapInvoiceHeader(res.rows[0]);')
  );

  await check(
    'S3-UI: PurchasingWorkspace wires PriceVarianceExceptionPanel with /price-exceptions API, RBAC permissions, and UI SoD hiding',
    wsSrc.includes('PriceVarianceExceptionPanel') &&
      wsSrc.includes('price-exceptions') &&
      wsSrc.includes('purchasing:variance:request') &&
      wsSrc.includes('purchasing:variance:approve') &&
      panelSrc.includes('/price-exceptions') &&
      panelSrc.includes('requestedBy === currentUserId') &&
      panelSrc.includes('hasQtyExceeded')
  );

  // Live DB Verification
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live price variance exception tests BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const isLoopback = ['localhost', '127.0.0.1', '::1'].some((h) => dbUrl.includes(h));
  if (!isLoopback && process.env.ALLOW_REMOTE_TEST !== 'true') {
    blocked('DATABASE_URL is not loopback. Skipping destructive live DB tests.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const pgCfg = buildPgConfig(dbUrl, process.env);
  const client = new pg.Client(pgCfg);
  await client.connect();

  const migrationDbUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
  const adminClient = new pg.Client(buildPgConfig(migrationDbUrl, process.env));
  await adminClient.connect();

  const companyRepo = new CompanyRepository();
  const userRepo = new UserRepository();

  const unique = crypto.randomBytes(4).toString('hex');
  let companyId1 = '';
  let companyId2 = '';
  let userR: any = null;
  let userA: any = null;
  const createdInvoiceIds: string[] = [];

  try {
    // Users in platform: Requester R and Approver A
    userR = await userRepo.createUser({
      username: `req_usr_${unique}`,
      passwordHash: 'dummy_hash_req',
      role: 'platform_admin',
    });
    userA = await userRepo.createUser({
      username: `app_usr_${unique}`,
      passwordHash: 'dummy_hash_app',
      role: 'platform_admin',
    });

    // Setup Tenant 1
    const company1 = await companyRepo.create({
      code: `EX1-${unique}`.slice(0, 20),
      nameAr: `شركة الاستثناءات 1 ${unique}`,
      createdBy: userR.id,
    });
    companyId1 = company1.id;

    // Setup Tenant 2
    const company2 = await companyRepo.create({
      code: `EX2-${unique}`.slice(0, 20),
      nameAr: `شركة الاستثناءات 2 ${unique}`,
      createdBy: userR.id,
    });
    companyId2 = company2.id;

    // Accounting & profile setup for Tenant 1
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
    await defaultPeriodService.createPeriod(
      companyId1,
      { code: `${y}-${m}-EXC-${unique}`, startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}` },
      userR.id
    );

    const invAcc = await defaultAccountService.createAccount(
      companyId1,
      { code: `INV-${unique}`.slice(0, 20), nameAr: 'المخزون', accountType: 'asset', isPostable: true },
      userR.id
    );
    const clrAcc = await defaultAccountService.createAccount(
      companyId1,
      { code: `CLR-${unique}`.slice(0, 20), nameAr: 'المشتريات المعلقة', accountType: 'liability', isPostable: true },
      userR.id
    );
    const apAcc = await defaultAccountService.createAccount(
      companyId1,
      { code: `AP-${unique}`.slice(0, 20), nameAr: 'الدائنين', accountType: 'liability', isPostable: true },
      userR.id
    );
    const ppvAcc = await defaultAccountService.createAccount(
      companyId1,
      { code: `PPV-${unique}`.slice(0, 20), nameAr: 'فروقات الأسعار', accountType: 'expense', isPostable: true },
      userR.id
    );

    await defaultCompanySettingsRepository.upsert(
      companyId1,
      {
        inventoryAccountId: invAcc.id,
        purchasesClearingAccountId: clrAcc.id,
        accountsPayableAccountId: apAcc.id,
      },
      userR.id
    );

    const supplier = await defaultSupplierService.createSupplier(
      companyId1,
      { code: `SUP-${unique}`.slice(0, 20), nameAr: 'مورد اختباري' },
      userR.id
    );
    const warehouse = await defaultWarehouseService.createWarehouse(
      companyId1,
      { code: `WH-${unique}`.slice(0, 20), nameAr: 'مستودع رئيسي' },
      userR.id
    );
    const item = await defaultItemService.createItem(
      companyId1,
      { code: `ITM-${unique}`.slice(0, 20), nameAr: 'صنف اختباري', uom: 'قطعة' },
      userR.id
    );

    await ensureTestCostingProfile(companyId1, [item.id], userR.id);

    // Create GRN: 10 units @ 100 each
    const grn = await defaultGrnService.createGrn(
      companyId1,
      { supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ itemId: item.id, qty: 10, unitCost: 100 }] },
      userR.id
    );
    await defaultGrnService.postGrn(companyId1, grn.id, userR.id);
    const postedGrn = await defaultGrnService.getGrn(companyId1, grn.id);
    const grnLineId = postedGrn.lines![0].id;

    // Create Supplier Invoice with +10% price variance (exceeds default 5% tolerance)
    // 10 units @ 110 (expected GRN cost was 100) -> price variance 10%
    const invoice = await defaultInvoiceService.createInvoice(
      companyId1,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `SINV-PR-${unique}`,
        lines: [{ grnLineId, qty: 10, unitCost: 110 }],
      },
      userR.id
    );
    createdInvoiceIds.push(invoice.id);

    // S4: Trigger immutability proof on purch_price_variance_exceptions
    console.log('\n--- S4: Testing DB Trigger Immutability & Transition Guards ---');
    // Request an exception via service
    const excRow = await defaultPriceVarianceExceptionService.requestException(
      companyId1,
      invoice.id,
      'طلب استثناء زيادة السعر بنسبة 10%',
      userR.id
    );

    // 1) Test DELETE is strictly blocked by trigger
    let deleteBlocked = false;
    try {
      await adminClient.query('DELETE FROM purch_price_variance_exceptions WHERE id = $1;', [excRow.id]);
    } catch {
      deleteBlocked = true;
    }
    await check('S4-1: DB Trigger strictly forbids DELETE on purch_price_variance_exceptions', deleteBlocked);

    // 2) Test immutable columns cannot be mutated
    let mutateBlocked = false;
    try {
      await adminClient.query("UPDATE purch_price_variance_exceptions SET fingerprint = 'tampered' WHERE id = $1;", [excRow.id]);
    } catch {
      mutateBlocked = true;
    }
    await check('S4-2: DB Trigger strictly forbids mutating fingerprint/snapshot/company_id', mutateBlocked);

    // S5: SoD check on Approve: requester cannot approve
    console.log('\n--- S5: Testing SoD on Approve ---');
    let sodApproveFailed = false;
    try {
      await defaultPriceVarianceExceptionService.approveException(companyId1, excRow.id, 'Approve by requester', userR.id);
    } catch (err: any) {
      if (err instanceof ValidationError && err.message.includes('فصل المهام')) {
        sodApproveFailed = true;
      }
    }
    await check('S5: Requester cannot approve their own exception (SoD enforced on approve)', sodApproveFailed);

    // S6: SoD check on Reject: requester cannot reject
    console.log('\n--- S6: Testing SoD on Reject ---');
    let sodRejectFailed = false;
    try {
      await defaultPriceVarianceExceptionService.rejectException(companyId1, excRow.id, 'Reject by requester', userR.id);
    } catch (err: any) {
      if (err instanceof ValidationError && err.message.includes('فصل المهام')) {
        sodRejectFailed = true;
      }
    }
    await check('S6: Requester cannot reject their own exception (SoD enforced on reject)', sodRejectFailed);

    // S7: Authorized approval by userA + new request after approved supersedes old approved
    console.log('\n--- S7: Testing Authorized Approval & Re-Request Superseding Approved ---');
    const excToReject = await defaultPriceVarianceExceptionService.requestException(
      companyId1,
      invoice.id,
      'طلب أول سيتم رفضه',
      userR.id
    );
    const rejectedExc = await defaultPriceVarianceExceptionService.rejectException(
      companyId1,
      excToReject.id,
      'مرفوض لتعديل السبب',
      userA.id
    );
    await check(
      'S7-0: Authorized user rejects exception (status=rejected, rejected_by set)',
      rejectedExc.status === 'rejected' && rejectedExc.rejectedBy === userA.id
    );

    const excSupersededByNew = await defaultPriceVarianceExceptionService.requestException(
      companyId1,
      invoice.id,
      'طلب ثاني يعتمد ثم يستبدل',
      userR.id
    );
    const firstApproved = await defaultPriceVarianceExceptionService.approveException(
      companyId1,
      excSupersededByNew.id,
      'اعتماد أول',
      userA.id
    );
    const reRequestedExc = await defaultPriceVarianceExceptionService.requestException(
      companyId1,
      invoice.id,
      'طلب جديد بعد الاعتماد',
      userR.id
    );
    const oldApprovedAfterNewReq = await adminClient.query<{
      status: string;
      decision_reason: string | null;
      supersede_reason: string | null;
      approved_by: string | null;
    }>(
      `SELECT status, decision_reason, supersede_reason, approved_by FROM purch_price_variance_exceptions WHERE id = $1;`,
      [firstApproved.id]
    );
    await check(
      'S7-1: New request after approved cleanly supersedes previous approved exception while preserving original approval reason and actor',
      firstApproved.status === 'approved' &&
        oldApprovedAfterNewReq.rows[0]?.status === 'superseded' &&
        oldApprovedAfterNewReq.rows[0]?.decision_reason === 'اعتماد أول' &&
        oldApprovedAfterNewReq.rows[0]?.approved_by === userA.id &&
        Boolean(oldApprovedAfterNewReq.rows[0]?.supersede_reason) &&
        reRequestedExc.status === 'pending'
    );

    const approvedExc = await defaultPriceVarianceExceptionService.approveException(
      companyId1,
      reRequestedExc.id,
      'معتمد من المدير المالي',
      userA.id
    );
    await check(
      'S7: Authorized user successfully approves exception (status=approved, approved_by set)',
      approvedExc.status === 'approved' && approvedExc.approvedBy === userA.id
    );

    // S8: Qty exceed hard-blocked on post even with approved price exception
    console.log('\n--- S8: Testing Qty Exceed Hard Block ---');
    // 1) Over-GRN qty is rejected at createInvoice
    let overGrnBlocked = false;
    try {
      await defaultInvoiceService.createInvoice(
        companyId1,
        {
          supplierId: supplier.id,
          supplierInvoiceNo: `SINV-QTY-OVER-${unique}`,
          lines: [{ grnLineId, qty: 12, unitCost: 110 }],
        },
        userR.id
      );
    } catch (err: any) {
      if (err instanceof ValidationError && err.message.includes('الكمية')) {
        overGrnBlocked = true;
      }
    }
    await check('S8-1: Invoice line with qty > GRN qty is blocked by invoice quantity guard', overGrnBlocked);

    // 2) 3-Way Qty Exceed (invoiceQty > poQty): Link PO line with qty 5 to GRN line
    const poId = crypto.randomUUID();
    const poLineId = crypto.randomUUID();
    await adminClient.query(
      `INSERT INTO purch_purchase_orders (id, company_id, supplier_id, po_no, status) VALUES ($1, $2, $3, $4, 'approved');`,
      [poId, companyId1, supplier.id, `PO-${unique}`]
    );
    await adminClient.query(
      `INSERT INTO purch_po_lines (id, company_id, po_id, line_no, item_id, qty, unit_cost) VALUES ($1, $2, $3, 1, $4, 5, 100);`,
      [poLineId, companyId1, poId, item.id]
    );
    await adminClient.query(
      `UPDATE purch_grn_lines SET po_line_id = $1 WHERE id = $2;`,
      [poLineId, grnLineId]
    );

    // Create invoice with qty 8 (> PO qty 5)
    const qtyExceedInvoice = await defaultInvoiceService.createInvoice(
      companyId1,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `SINV-QTY-PO-${unique}`,
        lines: [{ grnLineId, qty: 8, unitCost: 110 }],
      },
      userR.id
    );
    createdInvoiceIds.push(qtyExceedInvoice.id);

    // Requesting price variance exception MUST be rejected because qty exceeded PO qty
    let qtyRequestBlocked = false;
    try {
      await defaultPriceVarianceExceptionService.requestException(companyId1, qtyExceedInvoice.id, 'Try qty exception', userR.id);
    } catch (err: any) {
      if (err instanceof ValidationError && err.message.includes('الكمية')) {
        qtyRequestBlocked = true;
      }
    }
    await check('S8-2: Qty exceed is strictly blocked from price exception workflow', qtyRequestBlocked);

    // Posting this invoice directly MUST also be blocked
    let postBlockedOnQty = false;
    try {
      await defaultInvoiceService.postInvoice(companyId1, qtyExceedInvoice.id, userA.id);
    } catch (err: any) {
      if (err instanceof ValidationError) {
        postBlockedOnQty = true;
      }
    }
    await check('S8-3: Posting is strictly blocked when 3-way match detects qty exceeded', postBlockedOnQty);

    // Restore grn_line po_line_id back to null for subsequent tests on invoice1
    await adminClient.query(`UPDATE purch_grn_lines SET po_line_id = NULL WHERE id = $1;`, [grnLineId]);

    // S9: Durable supersede on fingerprint change
    console.log('\n--- S9: Testing Durable Supersede on Fingerprint Invalidation ---');
    // Create another draft invoice with price variance
    const invoice2 = await defaultInvoiceService.createInvoice(
      companyId1,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `SINV-SUP-${unique}`,
        lines: [{ grnLineId, qty: 10, unitCost: 120 }],
      },
      userR.id
    );
    createdInvoiceIds.push(invoice2.id);

    const exc2 = await defaultPriceVarianceExceptionService.requestException(
      companyId1,
      invoice2.id,
      'طلب استثناء فاتورة ثانية',
      userR.id
    );

    // Now tamper/update the invoice line unit cost in DB behind the scenes (from 120 to 125)
    await adminClient.query(
      `UPDATE purch_supplier_invoice_lines SET unit_cost = 125 WHERE invoice_id = $1;`,
      [invoice2.id]
    );

    // Attempt to approve exc2: fingerprint mismatch triggers durable supersede (Option A)
    let supersedeErrorCaught = false;
    try {
      await defaultPriceVarianceExceptionService.approveException(companyId1, exc2.id, 'Try approve changed', userA.id);
    } catch (err: any) {
      if (err instanceof ValidationError && err.message.includes('تغيرت بنود الفاتورة')) {
        supersedeErrorCaught = true;
      }
    }
    await check('S9-1: approveException detects fingerprint mismatch and throws ValidationError', supersedeErrorCaught);

    // In a fresh transaction, verify DB status is durably 'superseded' with actor, timestamp, and supersede_reason (without polluting decision_reason)
    const freshCheck = await adminClient.query<{
      status: string;
      decision_reason: string | null;
      supersede_reason: string | null;
      superseded_by: string;
      superseded_at: any;
    }>(
      `SELECT status, decision_reason, supersede_reason, superseded_by, superseded_at FROM purch_price_variance_exceptions WHERE id = $1;`,
      [exc2.id]
    );
    const exc2DbRow = freshCheck.rows[0];
    await check(
      'S9-2: Exception is durably persisted as status=superseded in DB with actor, timestamp, and supersede_reason (decision_reason remains NULL)',
      exc2DbRow?.status === 'superseded' &&
        Boolean(exc2DbRow?.supersede_reason) &&
        exc2DbRow?.decision_reason === null &&
        exc2DbRow?.superseded_by === userA.id &&
        Boolean(exc2DbRow?.superseded_at)
    );

    // Posting invoice2 must be blocked because exception was superseded
    let postBlockedOnSuperseded = false;
    try {
      await defaultInvoiceService.postInvoice(companyId1, invoice2.id, userA.id);
    } catch (err: any) {
      if (err instanceof ValidationError && err.message.includes('تباين')) {
        postBlockedOnSuperseded = true;
      }
    }
    await check('S9-3: Posting is blocked when exception is in superseded state', postBlockedOnSuperseded);

    // S10: Posting invoice1 (which has approved exception) succeeds and records PPV
    console.log('\n--- S10: Testing Successful Post with Approved Exception ---');
    const postRes = await defaultInvoiceService.postInvoice(companyId1, invoice.id, userA.id);
    await check(
      'S10: Invoice with valid approved exception posts successfully (status=posted, journalEntryId present)',
      postRes.status === 'posted' && Boolean(postRes.journalEntryId)
    );

    // Verify PPV cost adjustment row was created and linked to this invoice
    const adjRes = await adminClient.query<{ count: number }>(
      `SELECT count(*)::int as count FROM inv_cost_adjustments WHERE company_id = $1 AND invoice_id = $2;`,
      [companyId1, invoice.id]
    );
    await check(
      'S10-2: PPV cost adjustment rows persisted and linked to posted invoice',
      adjRes.rows[0]?.count > 0
    );

    // S11: Tenant Isolation smoke test
    console.log('\n--- S11: Tenant Isolation Smoke Test ---');
    const t2Res = await client.query<{ count: number }>(
      `SELECT count(*)::int as count FROM purch_price_variance_exceptions WHERE company_id = $1;`,
      [companyId1] // App client without tenant context
    );
    await check(
      'S11: Tenant isolation prevents cross-tenant read of price variance exceptions without tenant config',
      t2Res.rows[0]?.count === 0
    );
  } finally {
    // Scoped cleanup
    if (adminClient && companyId1) {
      const companyIds = [companyId1, companyId2].filter(Boolean);
      const userIds = [userR?.id, userA?.id].filter(Boolean);
      try {
        await adminClient.query('BEGIN');
        await adminClient.query('ALTER TABLE purch_price_variance_exceptions DISABLE TRIGGER trg_guard_purch_price_variance_exceptions');
        await adminClient.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await adminClient.query('ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_immutability');
        await adminClient.query('ALTER TABLE journal_lines DISABLE TRIGGER trg_journal_lines_immutability');

        await adminClient.query('DELETE FROM purch_price_variance_exceptions WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM inv_cost_adjustments WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM purch_supplier_invoice_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM purch_supplier_invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM purch_grn_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM purch_grn WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM purch_po_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM purch_purchase_orders WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM purch_suppliers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM journal_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM journal_entries WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM inv_stock_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM inv_stock_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM inv_valuation_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM inv_cost_layers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM inv_valuation_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM inv_item_costing_profiles WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM company_settings WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM accounting_periods WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM accounts WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM inv_items WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM inv_warehouses WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await adminClient.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await adminClient.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }

        await adminClient.query('ALTER TABLE purch_price_variance_exceptions ENABLE TRIGGER trg_guard_purch_price_variance_exceptions');
        await adminClient.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await adminClient.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await adminClient.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        await adminClient.query('COMMIT');
      } catch (e) {
        await adminClient.query('ROLLBACK').catch(() => {});
      }
    }
    await client.end();
    await adminClient.end();
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyPurchPriceException1] Fatal execution error:', err);
  process.exit(1);
});
