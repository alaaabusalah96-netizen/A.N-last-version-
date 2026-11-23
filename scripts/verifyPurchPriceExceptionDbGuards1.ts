import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import crypto from 'crypto';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultSupplierService } from '../src/server/purchasing/supplierService.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultGrnService } from '../src/server/purchasing/grnService.js';
import { defaultInvoiceService } from '../src/server/purchasing/invoiceService.js';
import { ensureTestCostingProfile } from './helpers/ensureTestCostingProfile.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';

console.log('==================================================================================');
console.log('=== VERIFYING AN-ERP-R04-DB-GUARDS: EXCEPTION STATE MACHINE, RELATIONS & WP-4  ===');
console.log('==================================================================================');

async function expectSqlReject(
  client: pg.Client,
  savepointName: string,
  sql: string,
  params: any[],
  expectedCode: string,
  expectedConstraint?: string
): Promise<{ rejected: boolean; code?: string; constraint?: string; message?: string }> {
  await client.query(`SAVEPOINT ${savepointName}`);
  try {
    await client.query(sql, params);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    await client.query(`RELEASE SAVEPOINT ${savepointName}`);
    return { rejected: false };
  } catch (err: any) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    await client.query(`RELEASE SAVEPOINT ${savepointName}`);
    const code = err?.code ? String(err.code) : undefined;
    const constraint = err?.constraint ? String(err.constraint) : undefined;
    const message = err?.message ? String(err.message) : String(err);
    const codeMatches = code === expectedCode;
    const constraintMatches = !expectedConstraint || constraint === expectedConstraint;
    return {
      rejected: codeMatches && constraintMatches,
      code,
      constraint,
      message,
    };
  }
}

async function run() {
  const rootDir = process.cwd();

  // S0: Registration checks
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  await check(
    'R04-S0: verifyPurchPriceExceptionDbGuards1.ts registered in runFoundationBattery.ts and package.json',
    batterySrc.includes('scripts/verifyPurchPriceExceptionDbGuards1.ts') &&
      pkgJson?.scripts?.['test:purch-price-exception-guards-1'] === 'tsx scripts/verifyPurchPriceExceptionDbGuards1.ts'
  );

  // S1: Static contract checks for Migration 057 (and non-modification of 055/056)
  const mig055Path = path.join(rootDir, 'database/migrations/055_purch_price_variance_exception.sql');
  const mig056Path = path.join(rootDir, 'database/migrations/056_purch_price_variance_exception_harden.sql');
  const mig057Path = path.join(rootDir, 'database/migrations/057_purch_price_variance_exception_guards.sql');

  const mig055 = fs.existsSync(mig055Path) ? fs.readFileSync(mig055Path, 'utf8') : '';
  const mig056 = fs.existsSync(mig056Path) ? fs.readFileSync(mig056Path, 'utf8') : '';
  const mig057 = fs.existsSync(mig057Path) ? fs.readFileSync(mig057Path, 'utf8') : '';
  const mig057Stripped = mig057.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');

  await check(
    'R04-S1: Migrations 055 and 056 remain intact and 057 exists as forward-only corrective migration',
    Boolean(mig055) &&
      Boolean(mig056) &&
      Boolean(mig057) &&
      mig056.includes('BEFORE UPDATE OR DELETE ON public.purch_price_variance_exceptions') &&
      mig057.includes('ADD COLUMN IF NOT EXISTS supersede_reason TEXT NULL')
  );

  await check(
    'R04-S2: Migration 057 prechecks corrupt legacy data loudly (zero silent repair, zero fabricated actors/reasons)',
    mig057.includes('MIGRATION 057 ABORTED') &&
      mig057.includes('mismatched_supplier') &&
      mig057.includes('missing_requested_by') &&
      mig057.includes('bad_superseded') &&
      mig057.includes('ALTER COLUMN requested_by SET NOT NULL') &&
      !/UPDATE\s+public\.purch_price_variance_exceptions/i.test(mig057Stripped)
  );

  await check(
    'R04-S3: Migration 057 enforces ON DELETE RESTRICT on all 7 FKs, CHECK invariants, search_path, BEFORE INSERT OR UPDATE OR DELETE trigger & DB SoD',
    mig057.includes('fk_purch_price_variance_exceptions_company') &&
      mig057.includes('fk_purch_price_variance_exceptions_invoice_composite') &&
      mig057.includes('fk_purch_price_variance_exceptions_supplier_composite') &&
      mig057.includes('fk_purch_price_variance_exceptions_requested_by') &&
      mig057.includes('fk_purch_price_variance_exceptions_approved_by') &&
      mig057.includes('fk_purch_price_variance_exceptions_rejected_by') &&
      mig057.includes('fk_purch_price_variance_exceptions_superseded_by') &&
      !/ON\s+DELETE\s+(CASCADE|SET\s+NULL)/i.test(mig057Stripped) &&
      mig057.includes('chk_purch_price_exc_state_invariants') &&
      mig057.includes('BEFORE INSERT OR UPDATE OR DELETE ON public.purch_price_variance_exceptions') &&
      mig057.includes('SET search_path = pg_catalog, public') &&
      mig057.includes('NEW.approved_by = OLD.requested_by') &&
      mig057.includes('NEW.rejected_by = OLD.requested_by') &&
      mig057.includes('NEW.decision_reason IS DISTINCT FROM OLD.decision_reason') &&
      !/\bEXCEPTION\s+WHEN\s+OTHERS\b/i.test(mig057Stripped)
  );

  const repoSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/priceVarianceExceptionRepository.ts'), 'utf8');
  const invSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/invoiceService.ts'), 'utf8');
  await check(
    'R04-S4: Repository separates supersede_reason from decision_reason and InvoiceService blocks draft delete with exception history',
    repoSrc.includes('supersede_reason as "supersedeReason"') &&
      repoSrc.includes("supersede_reason = 'تم استبدال الطلب بطلب استثناء جديد'") &&
      repoSrc.includes("WHEN $3::text IN ('approved', 'rejected') THEN COALESCE($5::text, decision_reason)") &&
      repoSrc.includes("WHEN $3::text = 'superseded' THEN COALESCE($5::text, supersede_reason)") &&
      repoSrc.includes('hasAnyForInvoice') &&
      invSvcSrc.includes('hasAnyForInvoice') &&
      invSvcSrc.includes("err?.code === '23503'")
  );

  // Live PostgreSQL Verification (Loopback ONLY; never remote)
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live R04 DB-Guards SQL & upgrade tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const isLoopback = ['localhost', '127.0.0.1', '::1'].some((h) => dbUrl.includes(h));
  if (!isLoopback && process.env.ALLOW_REMOTE_TEST !== 'true') {
    blocked('DATABASE_URL is not loopback. Refusing live destructive R04 SQL attack & upgrade tests.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const appClient = new pg.Client(buildPgConfig(dbUrl, process.env));
  await appClient.connect();

  const migrationDbUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
  const adminClient = new pg.Client(buildPgConfig(migrationDbUrl, process.env));
  await adminClient.connect();

  const unique = crypto.randomBytes(4).toString('hex');
  const companyRepo = new CompanyRepository();
  const userRepo = new UserRepository();

  let companyId1 = '';
  let companyId2 = '';
  let userReq: any = null;
  let userApp: any = null;
  let userIsolatedApprover: any = null;

  try {
    // Verify appClient role is an_app (or test under an_app)
    const appRoleRes = await appClient.query<{ cur: string }>('SELECT current_user as cur');
    await check(
      'R04-L0: App client connects as least-privilege an_app role',
      appRoleRes.rows[0]?.cur === (process.env.APP_DB_USER || 'an_app')
    );

    // Seed two isolated tenants and users
    userReq = await userRepo.createUser({
      username: `r04_req_${unique}`,
      passwordHash: 'dummy_hash_req',
      role: 'platform_admin',
    });
    userApp = await userRepo.createUser({
      username: `r04_app_${unique}`,
      passwordHash: 'dummy_hash_app',
      role: 'platform_admin',
    });
    userIsolatedApprover = await userRepo.createUser({
      username: `r04_iso_${unique}`,
      passwordHash: 'dummy_hash_iso',
      role: 'user',
    });

    const company1 = await companyRepo.create({
      code: `R04A-${unique}`.slice(0, 20),
      nameAr: `شركة حراسة 1 ${unique}`,
      createdBy: userReq.id,
    });
    companyId1 = company1.id;

    const company2 = await companyRepo.create({
      code: `R04B-${unique}`.slice(0, 20),
      nameAr: `شركة حراسة 2 ${unique}`,
      createdBy: userReq.id,
    });
    companyId2 = company2.id;

    // Minimal purchasing setup for Tenant 1 (with 2 suppliers) & Tenant 2 (1 supplier)
    const setupTenant = async (cid: string, tag: string) => {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, '0');
      const lastDay = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
      await defaultPeriodService.createPeriod(
        cid,
        { code: `${y}-${m}-${tag}-${unique}`, startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}` },
        userReq.id
      );
      const invAcc = await defaultAccountService.createAccount(
        cid,
        { code: `INV-${tag}-${unique}`.slice(0, 20), nameAr: 'المخزون', accountType: 'asset', isPostable: true },
        userReq.id
      );
      const clrAcc = await defaultAccountService.createAccount(
        cid,
        { code: `CLR-${tag}-${unique}`.slice(0, 20), nameAr: 'المشتريات المعلقة', accountType: 'liability', isPostable: true },
        userReq.id
      );
      const apAcc = await defaultAccountService.createAccount(
        cid,
        { code: `AP-${tag}-${unique}`.slice(0, 20), nameAr: 'الدائنين', accountType: 'liability', isPostable: true },
        userReq.id
      );
      await defaultCompanySettingsRepository.upsert(
        cid,
        { inventoryAccountId: invAcc.id, purchasesClearingAccountId: clrAcc.id, accountsPayableAccountId: apAcc.id },
        userReq.id
      );
      const supplier = await defaultSupplierService.createSupplier(
        cid,
        { code: `SUP-${tag}-${unique}`.slice(0, 20), nameAr: `مورد ${tag}` },
        userReq.id
      );
      const warehouse = await defaultWarehouseService.createWarehouse(
        cid,
        { code: `WH-${tag}-${unique}`.slice(0, 20), nameAr: `مستودع ${tag}` },
        userReq.id
      );
      const item = await defaultItemService.createItem(
        cid,
        { code: `ITM-${tag}-${unique}`.slice(0, 20), nameAr: `صنف ${tag}`, uom: 'قطعة' },
        userReq.id
      );
      await ensureTestCostingProfile(cid, [item.id], userReq.id);
      const grn = await defaultGrnService.createGrn(
        cid,
        { supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ itemId: item.id, qty: 10, unitCost: 100 }] },
        userReq.id
      );
      await defaultGrnService.postGrn(cid, grn.id, userReq.id);
      const postedGrn = await defaultGrnService.getGrn(cid, grn.id);
      const inv = await defaultInvoiceService.createInvoice(
        cid,
        {
          supplierId: supplier.id,
          supplierInvoiceNo: `SINV-${tag}-${unique}`,
          lines: [{ grnLineId: postedGrn.lines![0].id, qty: 10, unitCost: 120 }],
        },
        userReq.id
      );
      return { supplier, invoice: inv, grnLineId: postedGrn.lines![0].id };
    };

    const t1 = await setupTenant(companyId1, 'T1');
    const t2 = await setupTenant(companyId2, 'T2');
    const sup1Other = await defaultSupplierService.createSupplier(
      companyId1,
      { code: `SUP-T1B-${unique}`.slice(0, 20), nameAr: 'مورد ثاني بنفس الشركة' },
      userReq.id
    );
    const inv1b = await defaultInvoiceService.createInvoice(
      companyId1,
      {
        supplierId: t1.supplier.id,
        supplierInvoiceNo: `SINV-T1B-${unique}`,
        lines: [{ grnLineId: t1.grnLineId, qty: 5, unitCost: 120 }],
      },
      userReq.id
    );

    // =========================================================================
    // PART A: Migration 057 Upgrade Precheck Tests (Transactional Rollback)
    // =========================================================================
    // A1: Valid pre-057 legacy data upgrades cleanly without fabricating actors/reasons
    await adminClient.query('BEGIN');
    try {
      await adminClient.query('DROP TRIGGER IF EXISTS trg_guard_purch_price_variance_exceptions ON public.purch_price_variance_exceptions');
      await adminClient.query('ALTER TABLE public.purch_price_variance_exceptions DROP CONSTRAINT IF EXISTS chk_purch_price_exc_state_invariants');
      await adminClient.query('ALTER TABLE public.purch_price_variance_exceptions DROP CONSTRAINT IF EXISTS chk_purch_price_exc_reason_nonblank');
      await adminClient.query('ALTER TABLE public.purch_price_variance_exceptions DROP COLUMN IF EXISTS supersede_reason');
      await adminClient.query('ALTER TABLE public.purch_price_variance_exceptions ALTER COLUMN requested_by DROP NOT NULL');

      const legacySupId = crypto.randomUUID();
      await adminClient.query(
        `INSERT INTO public.purch_price_variance_exceptions
           (id, company_id, invoice_id, supplier_id, status, requested_by, approved_by, superseded_by, reason, decision_reason, fingerprint, snapshot, decided_at, superseded_at)
         VALUES ($1, $2, $3, $4, 'superseded', $5, $6, $5, 'طلب قديم', 'سبب استبدال قديم من 056', 'fp-legacy', '{}'::jsonb, NOW() - interval '2 hours', NOW() - interval '1 hour')`,
        [legacySupId, companyId1, t1.invoice.id, t1.supplier.id, userReq.id, userApp.id]
      );

      await adminClient.query(mig057);

      const legacyRes = await adminClient.query<{
        approved_by: string;
        decision_reason: string;
        supersede_reason: string | null;
      }>(
        `SELECT approved_by, decision_reason, supersede_reason FROM public.purch_price_variance_exceptions WHERE id = $1`,
        [legacySupId]
      );
      await check(
        'R04-L1: Migration 057 upgrades valid pre-057 superseded rows cleanly without fabricating supersede_reason or actors',
        legacyRes.rows[0]?.approved_by === userApp.id &&
          legacyRes.rows[0]?.decision_reason === 'سبب استبدال قديم من 056' &&
          legacyRes.rows[0]?.supersede_reason === null
      );
    } finally {
      await adminClient.query('ROLLBACK');
    }

    // A2: Corrupt pre-057 legacy data MUST abort Migration 057 with SQLSTATE 23514
    const testUpgradeAbort = async (label: string, setupSql: string, setupParams: any[]) => {
      await adminClient.query('BEGIN');
      let abortedCorrectly = false;
      try {
        await adminClient.query('DROP TRIGGER IF EXISTS trg_guard_purch_price_variance_exceptions ON public.purch_price_variance_exceptions');
        await adminClient.query('ALTER TABLE public.purch_price_variance_exceptions DROP CONSTRAINT IF EXISTS chk_purch_price_exc_state_invariants');
        await adminClient.query('ALTER TABLE public.purch_price_variance_exceptions DROP CONSTRAINT IF EXISTS chk_purch_price_exc_reason_nonblank');
        await adminClient.query('ALTER TABLE public.purch_price_variance_exceptions DROP COLUMN IF EXISTS supersede_reason');
        await adminClient.query('ALTER TABLE public.purch_price_variance_exceptions ALTER COLUMN requested_by DROP NOT NULL');
        await adminClient.query(setupSql, setupParams);
        try {
          await adminClient.query(mig057);
        } catch (err: any) {
          abortedCorrectly = err?.code === '23514' && String(err?.message || '').includes('MIGRATION 057 ABORTED');
        }
      } finally {
        await adminClient.query('ROLLBACK');
      }
      await check(label, abortedCorrectly);
    };

    await testUpgradeAbort(
      'R04-L2a: Migration 057 aborts loudly when legacy row has missing requested_by',
      `INSERT INTO public.purch_price_variance_exceptions (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'pending', NULL, 'no requester', 'fp-bad-1', '{}'::jsonb)`,
      [companyId1, t1.invoice.id, t1.supplier.id]
    );

    await testUpgradeAbort(
      'R04-L2b: Migration 057 aborts loudly when legacy approved row violates SoD (approved_by = requested_by)',
      `INSERT INTO public.purch_price_variance_exceptions (company_id, invoice_id, supplier_id, status, requested_by, approved_by, decided_at, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'approved', $4, $4, NOW(), 'self approved', 'fp-bad-2', '{}'::jsonb)`,
      [companyId1, t1.invoice.id, t1.supplier.id, userReq.id]
    );

    await testUpgradeAbort(
      'R04-L2c: Migration 057 aborts loudly when legacy exception supplier_id mismatches invoice supplier_id',
      `INSERT INTO public.purch_price_variance_exceptions (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'pending', $4, 'wrong supplier', 'fp-bad-3', '{}'::jsonb)`,
      [companyId1, t1.invoice.id, sup1Other.id, userReq.id]
    );

    // =========================================================================
    // PART B: WP-4 Direct SQL Attack Matrix using an_app across 2 tenants
    // =========================================================================
    // Seed Tenant 1 and Tenant 2 pending exceptions legitimately under Tenant context
    await appClient.query('BEGIN');
    await appClient.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [companyId1]);
    const ins1 = await appClient.query<{ id: string }>(
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot, max_variance_pct)
       VALUES ($1, $2, $3, 'pending', $4, 'طلب شركة 1', 'fp-t1', '{}'::jsonb, 20)
       RETURNING id`,
      [companyId1, t1.invoice.id, t1.supplier.id, userReq.id]
    );
    const exc1Id = ins1.rows[0].id;
    await appClient.query('COMMIT');

    await appClient.query('BEGIN');
    await appClient.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [companyId2]);
    const ins2 = await appClient.query<{ id: string }>(
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot, max_variance_pct)
       VALUES ($1, $2, $3, 'pending', $4, 'طلب شركة 2', 'fp-t2', '{}'::jsonb, 20)
       RETURNING id`,
      [companyId2, t2.invoice.id, t2.supplier.id, userReq.id]
    );
    const exc2Id = ins2.rows[0].id;
    await appClient.query('COMMIT');

    // Run attacks in Tenant 2 session against Tenant 1 & own rows using SAVEPOINTs
    await appClient.query('BEGIN');
    await appClient.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [companyId2]);

    const crossSelect = await appClient.query(
      `SELECT id FROM public.purch_price_variance_exceptions WHERE id = $1`,
      [exc1Id]
    );
    await check('R04-L3: WP-4 Cross-tenant SELECT by an_app returns 0 rows', crossSelect.rows.length === 0);

    const crossInsert = await expectSqlReject(
      appClient,
      'sp_cross_ins',
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'pending', $4, 'cross insert', 'fp-x', '{}'::jsonb)`,
      [companyId1, t1.invoice.id, t1.supplier.id, userReq.id],
      '42501'
    );
    await check('R04-L4: WP-4 Cross-tenant INSERT by an_app rejected with SQLSTATE 42501', crossInsert.rejected, crossInsert.code);

    const crossUpdateForeign = await appClient.query(
      `UPDATE public.purch_price_variance_exceptions SET status = 'rejected', rejected_by = $2 WHERE id = $1`,
      [exc1Id, userApp.id]
    );
    await check('R04-L5a: WP-4 Cross-tenant UPDATE on foreign row affects 0 rows', crossUpdateForeign.rowCount === 0);

    const crossUpdateCompanyId = await expectSqlReject(
      appClient,
      'sp_cross_upd_cid',
      `UPDATE public.purch_price_variance_exceptions SET company_id = $2 WHERE id = $1`,
      [exc2Id, companyId1],
      '23514'
    );
    await check(
      'R04-L5b: WP-4 Mutating company_id on own row rejected with SQLSTATE 23514',
      crossUpdateCompanyId.rejected,
      crossUpdateCompanyId.code
    );

    await appClient.query('COMMIT');

    // Now run Tenant 1 SQL attacks
    await appClient.query('BEGIN');
    await appClient.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [companyId1]);

    const spoofCrossInv = await expectSqlReject(
      appClient,
      'sp_spoof_inv',
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'pending', $4, 'spoof inv', 'fp-s1', '{}'::jsonb)`,
      [companyId1, t2.invoice.id, t1.supplier.id, userReq.id],
      '23503',
      'fk_purch_price_variance_exceptions_invoice_composite'
    );
    await check(
      'R04-L6a: WP-4 Cross-company invoice_id spoofing rejected with SQLSTATE 23503 (fk_purch_price_variance_exceptions_invoice_composite)',
      spoofCrossInv.rejected,
      `${spoofCrossInv.code}/${spoofCrossInv.constraint}`
    );

    const spoofCrossSup = await expectSqlReject(
      appClient,
      'sp_spoof_sup',
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'pending', $4, 'spoof sup', 'fp-s2', '{}'::jsonb)`,
      [companyId1, t1.invoice.id, t2.supplier.id, userReq.id],
      '23514'
    );
    await check(
      'R04-L6b: WP-4 Cross-company supplier_id spoofing rejected with SQLSTATE 23514 (guard trigger supplier/invoice match fires first by design; supplier composite FK verified statically in R04-S3 and delete-side in R04-L14a)',
      spoofCrossSup.rejected,
      `${spoofCrossSup.code}/${spoofCrossSup.constraint}`
    );

    const spoofSameCoWrongSup = await expectSqlReject(
      appClient,
      'sp_wrong_sup',
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'pending', $4, 'same-company wrong supplier', 'fp-s3', '{}'::jsonb)`,
      [companyId1, t1.invoice.id, sup1Other.id, userReq.id],
      '23514'
    );
    await check(
      'R04-L6c: WP-4 Same-company mismatched supplier_id rejected with SQLSTATE 23514',
      spoofSameCoWrongSup.rejected,
      spoofSameCoWrongSup.code
    );

    const insertApprovedDirect = await expectSqlReject(
      appClient,
      'sp_ins_app',
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'approved', $4, 'bypass', 'fp-t1', '{}'::jsonb)`,
      [companyId1, t1.invoice.id, t1.supplier.id, userReq.id],
      '23514'
    );
    const insertPendingFakeMeta = await expectSqlReject(
      appClient,
      'sp_ins_fake',
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, approved_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'pending', $4, $5, 'fake meta', 'fp-t1', '{}'::jsonb)`,
      [companyId1, t1.invoice.id, t1.supplier.id, userReq.id, userApp.id],
      '23514'
    );
    await check(
      'R04-L7: WP-4 Direct INSERT of terminal state or pending-with-decision-metadata rejected with SQLSTATE 23514',
      insertApprovedDirect.rejected && insertPendingFakeMeta.rejected,
      `${insertApprovedDirect.code}/${insertPendingFakeMeta.code}`
    );

    const pendingToPending = await expectSqlReject(
      appClient,
      'sp_p2p',
      `UPDATE public.purch_price_variance_exceptions SET decision_reason = 'tamper', updated_at = NOW() WHERE id = $1`,
      [exc1Id],
      '23514'
    );
    await check(
      'R04-L8: WP-4 pending -> pending metadata mutation rejected with SQLSTATE 23514',
      pendingToPending.rejected,
      pendingToPending.code
    );

    const sodApproveAttack = await expectSqlReject(
      appClient,
      'sp_sod_app',
      `UPDATE public.purch_price_variance_exceptions SET status = 'approved', approved_by = $2, decided_at = NOW() WHERE id = $1`,
      [exc1Id, userReq.id],
      '23514'
    );
    const sodRejectAttack = await expectSqlReject(
      appClient,
      'sp_sod_rej',
      `UPDATE public.purch_price_variance_exceptions SET status = 'rejected', rejected_by = $2, decided_at = NOW() WHERE id = $1`,
      [exc1Id, userReq.id],
      '23514'
    );
    await check(
      'R04-L9: WP-4 Direct SQL SoD bypass on approve & reject rejected with SQLSTATE 23514',
      sodApproveAttack.rejected && sodRejectAttack.rejected,
      `${sodApproveAttack.code}/${sodRejectAttack.code}`
    );

    // Valid approve by isolated approver userIsolatedApprover
    await appClient.query(
      `UPDATE public.purch_price_variance_exceptions
       SET status = 'approved', approved_by = $2, decided_at = NOW(), decision_reason = 'اعتماد مالي أصلي'
       WHERE id = $1`,
      [exc1Id, userIsolatedApprover.id]
    );

    const mutateApprovedReason = await expectSqlReject(
      appClient,
      'sp_mut_app_reason',
      `UPDATE public.purch_price_variance_exceptions SET decision_reason = 'tampered' WHERE id = $1`,
      [exc1Id],
      '23514'
    );
    const approvedToRejected = await expectSqlReject(
      appClient,
      'sp_app_rej',
      `UPDATE public.purch_price_variance_exceptions SET status = 'rejected', rejected_by = $2 WHERE id = $1`,
      [exc1Id, userApp.id],
      '23514'
    );
    const supersedeOverwriteDecision = await expectSqlReject(
      appClient,
      'sp_sup_overwrite',
      `UPDATE public.purch_price_variance_exceptions
       SET status = 'superseded', superseded_by = $2, supersede_reason = 'replace', decision_reason = 'overwritten'
       WHERE id = $1`,
      [exc1Id, userReq.id],
      '23514'
    );
    await check(
      'R04-L10: WP-4 Mutating approved row or overwriting decision_reason on supersede rejected with SQLSTATE 23514',
      mutateApprovedReason.rejected && approvedToRejected.rejected && supersedeOverwriteDecision.rejected,
      `${mutateApprovedReason.code}/${approvedToRejected.code}/${supersedeOverwriteDecision.code}`
    );

    // Valid approved -> superseded preserves approval metadata & writes supersede_reason
    await appClient.query(
      `UPDATE public.purch_price_variance_exceptions
       SET status = 'superseded', superseded_by = $2, superseded_at = NOW(), supersede_reason = 'تم الاستبدال لتحديث الفاتورة'
       WHERE id = $1`,
      [exc1Id, userReq.id]
    );
    const afterSup = await appClient.query<{
      approved_by: string;
      decision_reason: string;
      supersede_reason: string;
      superseded_by: string;
    }>(
      `SELECT approved_by, decision_reason, supersede_reason, superseded_by FROM public.purch_price_variance_exceptions WHERE id = $1`,
      [exc1Id]
    );
    await check(
      'R04-L11: Valid approved -> superseded preserves approved_by & decision_reason while setting supersede_reason',
      afterSup.rows[0]?.approved_by === userIsolatedApprover.id &&
        afterSup.rows[0]?.decision_reason === 'اعتماد مالي أصلي' &&
        afterSup.rows[0]?.supersede_reason === 'تم الاستبدال لتحديث الفاتورة' &&
        afterSup.rows[0]?.superseded_by === userReq.id
    );

    // Mutating terminal superseded row & rejected row
    const mutateSuperseded = await expectSqlReject(
      appClient,
      'sp_mut_sup',
      `UPDATE public.purch_price_variance_exceptions SET supersede_reason = 'tampered' WHERE id = $1`,
      [exc1Id],
      '23514'
    );
    const excRejIns = await appClient.query<{ id: string }>(
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'pending', $4, 'will reject', 'fp-rej', '{}'::jsonb)
       RETURNING id`,
      [companyId1, inv1b.id, t1.supplier.id, userReq.id]
    );
    const excRejId = excRejIns.rows[0].id;
    await appClient.query(
      `UPDATE public.purch_price_variance_exceptions
       SET status = 'rejected', rejected_by = $2, decided_at = NOW(), decision_reason = 'مرفوض'
       WHERE id = $1`,
      [excRejId, userApp.id]
    );
    const mutateRejected = await expectSqlReject(
      appClient,
      'sp_mut_rej',
      `UPDATE public.purch_price_variance_exceptions SET status = 'approved', approved_by = $2 WHERE id = $1`,
      [excRejId, userApp.id],
      '23514'
    );
    await check(
      'R04-L12: WP-4 Terminal superseded and rejected rows are completely immutable (SQLSTATE 23514)',
      mutateSuperseded.rejected && mutateRejected.rejected,
      `${mutateSuperseded.code}/${mutateRejected.code}`
    );

    // Direct DELETE on exception blocked
    const deleteExc = await expectSqlReject(
      appClient,
      'sp_del_exc',
      `DELETE FROM public.purch_price_variance_exceptions WHERE id = $1`,
      [exc1Id],
      '23514'
    );
    await check('R04-L13: WP-4 Direct DELETE on exception rejected with SQLSTATE 23514', deleteExc.rejected, deleteExc.code);

    // Parent DELETEs blocked by ON DELETE RESTRICT (invoice, supplier, company, user)
    const delInvoice = await expectSqlReject(
      appClient,
      'sp_del_inv',
      `DELETE FROM public.purch_supplier_invoices WHERE id = $1`,
      [t1.invoice.id],
      '23503',
      'fk_purch_price_variance_exceptions_invoice_composite'
    );
    const delSupplier = await expectSqlReject(
      appClient,
      'sp_del_sup',
      `DELETE FROM public.purch_suppliers WHERE id = $1`,
      [t1.supplier.id],
      '23503'
    );
    await check(
      'R04-L14a: WP-4 Parent DELETE on invoice & supplier rejected with SQLSTATE 23503',
      delInvoice.rejected && delSupplier.rejected,
      `${delInvoice.code}(${delInvoice.constraint})/${delSupplier.code}(${delSupplier.constraint})`
    );

    // Partial unique index idx_purch_price_exc_active_approved
    const dupP1 = await appClient.query<{ id: string }>(
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'pending', $4, 'req 1', 'fp-dup', '{}'::jsonb) RETURNING id`,
      [companyId1, inv1b.id, t1.supplier.id, userReq.id]
    );
    const dupP2 = await appClient.query<{ id: string }>(
      `INSERT INTO public.purch_price_variance_exceptions
         (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot)
       VALUES ($1, $2, $3, 'pending', $4, 'req 2', 'fp-dup', '{}'::jsonb) RETURNING id`,
      [companyId1, inv1b.id, t1.supplier.id, userReq.id]
    );
    await appClient.query(
      `UPDATE public.purch_price_variance_exceptions SET status = 'approved', approved_by = $2, decided_at = NOW() WHERE id = $1`,
      [dupP1.rows[0].id, userApp.id]
    );
    const dupApprove = await expectSqlReject(
      appClient,
      'sp_dup_app',
      `UPDATE public.purch_price_variance_exceptions SET status = 'approved', approved_by = $2, decided_at = NOW() WHERE id = $1`,
      [dupP2.rows[0].id, userApp.id],
      '23505',
      'idx_purch_price_exc_active_approved'
    );
    await check(
      'R04-L15: WP-4 Partial unique index idx_purch_price_exc_active_approved rejects second active approval with SQLSTATE 23505',
      dupApprove.rejected,
      `${dupApprove.code}/${dupApprove.constraint}`
    );

    await appClient.query('COMMIT');

    // Admin checks for parent user & company DELETE ON DELETE RESTRICT
    await adminClient.query('BEGIN');
    const delUser = await expectSqlReject(
      adminClient,
      'sp_del_usr',
      `DELETE FROM public.platform_users WHERE id = $1`,
      [userIsolatedApprover.id],
      '23503',
      'fk_purch_price_variance_exceptions_approved_by'
    );
    const delCompany = await expectSqlReject(
      adminClient,
      'sp_del_co',
      `DELETE FROM public.companies WHERE id = $1`,
      [companyId1],
      '23503'
    );
    await adminClient.query('ROLLBACK');
    await check(
      'R04-L14b: WP-4 Parent DELETE on platform_users (approved_by) & companies rejected with SQLSTATE 23503',
      delUser.rejected && delCompany.rejected,
      `${delUser.code}(${delUser.constraint})/${delCompany.code}(${delCompany.constraint})`
    );
  } finally {
    const companyIds = [companyId1, companyId2].filter(Boolean);
    const userIds = [userReq?.id, userApp?.id, userIsolatedApprover?.id].filter(Boolean);
    if (companyIds.length > 0) {
      try {
        await adminClient.query('BEGIN');
        await adminClient.query('ALTER TABLE public.purch_price_variance_exceptions DISABLE TRIGGER trg_guard_purch_price_variance_exceptions');
        await adminClient.query('ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_immutable');
        await adminClient.query('ALTER TABLE public.journal_entries DISABLE TRIGGER trg_journal_entries_immutability');
        await adminClient.query('ALTER TABLE public.journal_lines DISABLE TRIGGER trg_journal_lines_immutability');

        await adminClient.query('DELETE FROM public.purch_price_variance_exceptions WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.inv_cost_adjustments WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.purch_supplier_invoice_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.purch_supplier_invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query(
          `DELETE FROM public.inv_cost_allocations
           WHERE company_id = ANY($1::uuid[])
             AND (
               cost_layer_id IN (SELECT id FROM public.inv_cost_layers WHERE company_id = ANY($1::uuid[]))
               OR valuation_movement_id IN (SELECT id FROM public.inv_valuation_movements WHERE company_id = ANY($1::uuid[]))
             )`,
          [companyIds]
        );
        await adminClient.query('DELETE FROM public.inv_cost_layers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.inv_valuation_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.inv_valuation_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.inv_item_costing_profiles WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.inv_costing_profiles WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.purch_grn_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.purch_grn WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.purch_suppliers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.journal_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.journal_entries WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.inv_stock_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.inv_stock_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.company_settings WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.accounting_periods WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.accounting_sequences WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.accounts WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.inv_items WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.inv_warehouses WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await adminClient.query('DELETE FROM public.companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await adminClient.query('DELETE FROM public.audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await adminClient.query('DELETE FROM public.platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }

        await adminClient.query('ALTER TABLE public.purch_price_variance_exceptions ENABLE TRIGGER trg_guard_purch_price_variance_exceptions');
        await adminClient.query('ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_immutable');
        await adminClient.query('ALTER TABLE public.journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await adminClient.query('ALTER TABLE public.journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        await adminClient.query('COMMIT');
      } catch (cleanupErr) {
        await adminClient.query('ROLLBACK').catch((rbErr) => console.error('Cleanup rollback failed:', rbErr));
        console.error('[verifyPurchPriceExceptionDbGuards1] Cleanup failed:', cleanupErr);
      }
    }
    await appClient.end().catch((err) => console.error('appClient close error:', err));
    await adminClient.end().catch((err) => console.error('adminClient close error:', err));
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyPurchPriceExceptionDbGuards1] Fatal execution error:', err);
  process.exit(1);
});
