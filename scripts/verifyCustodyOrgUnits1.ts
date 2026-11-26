import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultMembershipStore } from '../src/server/org/membershipStore.js';
import { AccountService } from '../src/server/accounting/accountService.js';
import { PeriodService } from '../src/server/accounting/periodService.js';
import { defaultJournalRepository } from '../src/server/accounting/journalRepository.js';
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { defaultCustodyService } from '../src/server/cash/custodyService.js';
import { defaultCustodyExtrasService } from '../src/server/cash/custodyExtrasService.js';
import { defaultCustodyVoucherService } from '../src/server/cash/custodyVoucherService.js';
import { defaultOrgUnitService } from '../src/server/org/orgUnitService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-ERP-E (custody belongs to org units + scope)===');
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
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live DB checks E are BLOCKED.');
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
    blocked('Unable to connect to database executor. Live DB checks E are BLOCKED.');
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
    const accountService = new AccountService();
    const periodService = new PeriodService();

    const requester = await userRepo.createUser({ username: `cv_req_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    const approver = await userRepo.createUser({ username: `cv_app_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    const userB = await userRepo.createUser({ username: `cv_b_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    userIds.push(requester.id, approver.id, userB.id);

    const compA = await companyRepo.create({ code: `CVA-${unique}`.slice(0, 20), nameAr: `شركة حوافظ أ ${unique}`, createdBy: requester.id });
    const compB = await companyRepo.create({ code: `CVB-${unique}`.slice(0, 20), nameAr: `شركة حوافظ ب ${unique}`, createdBy: userB.id });
    companyIds.push(compA.id, compB.id);
    await defaultMembershipStore.addMember(requester.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(approver.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(userB.id, compB.id, 'company_admin', true);

    const { accounts } = await accountService.seedDefaultCoa(compA.id);
    await accountService.seedDefaultCoa(compB.id);
    const headerAsset = accounts.find((a) => a.code === '1000')!;
    const cashAccount = accounts.find((a) => a.code === '1100')!;
    const expenseAccount = accounts.find((a) => a.code === '5100')!;
    const custodyReceivable = await accountService.createAccount(compA.id, {
      code: '1250', nameAr: 'ذمة عهد الموظفين', accountType: 'asset', parentId: headerAsset.id, isPostable: true,
    });

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();
    const openPeriod = await periodService.createPeriod(
      compA.id,
      { code: `${year}-${month}`, startDate: `${year}-${month}-01`, endDate: `${year}-${month}-${String(lastDay).padStart(2, '0')}` },
      requester.id
    );
    const register = await defaultCashRegisterService.createRegister(
      compA.id,
      { code: `REG-CV-${unique}`.slice(0, 30), nameAr: 'خزينة الحوافظ', glAccountId: cashAccount.id, openingBalance: 100000 },
      requester.id
    );
    await defaultCompanySettingsService.upsertSettings(requester.id, compA.id, { custodyReceivableAccountId: custodyReceivable.id });


    const orgSvc = defaultOrgUnitService;
    const branch = await orgSvc.createUnit(compA.id, { code: `BR-${unique}`.slice(0, 20), nameAr: 'فرع القاهرة', unitType: 'branch' }, requester.id);
    const deptA = await orgSvc.createUnit(compA.id, { code: `DA-${unique}`.slice(0, 20), nameAr: 'قسم المشتريات', unitType: 'department', parentId: branch.id }, requester.id);
    const deptB = await orgSvc.createUnit(compA.id, { code: `DB-${unique}`.slice(0, 20), nameAr: 'قسم المبيعات', unitType: 'department', parentId: branch.id }, requester.id);
    const other = await orgSvc.createUnit(compA.id, { code: `OT-${unique}`.slice(0, 20), nameAr: 'فرع الإسكندرية', unitType: 'branch' }, requester.id);
    const foreign = await orgSvc.createUnit(compB.id, { code: `FB-${unique}`.slice(0, 20), nameAr: 'وحدة شركة أخرى', unitType: 'branch' }, userB.id);
    const dormant = await orgSvc.createUnit(compA.id, { code: `DM-${unique}`.slice(0, 20), nameAr: 'وحدة معطلة', unitType: 'department', parentId: other.id }, requester.id);
    await orgSvc.updateUnit(compA.id, dormant.id, { isActive: false }, requester.id);

    const rq = (orgUnitId: string | null | undefined, amount = 100) => defaultCustodyService.requestCustody(
      compA.id, { employeeUserId: requester.id, registerId: register.id, amount, purpose: 'عهدة اختبار الوحدات', orgUnitId }, requester.id
    );
    const rejects = async (fn: () => Promise<unknown>, cls: any) => { try { await fn(); return false; } catch (e) { return e instanceof cls; } };

    const cA = await rq(deptA.id);
    const cB = await rq(deptB.id);
    const cO = await rq(other.id);
    const cLegacy = await rq(null);
    await check('E1: custody stores its org unit and a request without a unit stays company-level (null)', cA.orgUnitId === deptA.id && cLegacy.orgUnitId === null);
    await check('E2: a unit of another company is refused (not found) and an inactive unit is refused (validation)',
      (await rejects(() => rq(foreign.id), NotFoundError)) && (await rejects(() => rq(dormant.id), ValidationError)));
    const lst = await defaultCustodyService.listCustodies(compA.id, { orgUnitId: deptA.id });
    await check('E3: list filter by unit returns only that unit', lst.length === 1 && lst[0].id === cA.id);

    // user scopes: scopedWriter = write on the branch (descendants), scopedApprover = approve on deptA only (no descendants)
    const writer = await userRepo.createUser({ username: `cv_w_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    const appr2 = await userRepo.createUser({ username: `cv_a2_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    userIds.push(writer.id, appr2.id);
    await defaultMembershipStore.addMember(writer.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(appr2.id, compA.id, 'company_admin', true);
    await orgSvc.setUserScopes(compA.id, writer.id, [{ orgUnitId: branch.id, includeDescendants: true, accessLevel: 'write' }], requester.id, 'platform_admin');
    await orgSvc.setUserScopes(compA.id, appr2.id, [{ orgUnitId: deptA.id, includeDescendants: false, accessLevel: 'approve' }], requester.id, 'platform_admin');
    const acc = (u: string, unit: string | null, lvl: any) => orgSvc.assertUserOrgAccess(compA.id, u, unit, lvl, false);
    await check('E4: write scope on a branch covers its departments (descendants) but not a sibling branch',
      (await acc(writer.id, deptA.id, 'write')) && (await acc(writer.id, deptB.id, 'write')) && !(await acc(writer.id, other.id, 'write')));
    await check('E5: a write scope cannot approve; an approve scope can approve its own unit but not a sibling department',
      !(await acc(writer.id, deptA.id, 'approve')) && (await acc(appr2.id, deptA.id, 'approve')) && !(await acc(appr2.id, deptB.id, 'approve')));
    await check('E6: a scoped user cannot write or approve a company-level (null unit) custody, an unscoped user can',
      !(await acc(writer.id, null, 'write')) && !(await acc(appr2.id, null, 'approve')) && (await acc(requester.id, null, 'write')) && (await acc(requester.id, null, 'approve')));
    const fs = await import('fs');
    const routes = fs.readFileSync('src/server/routes/cashRoutes.ts', 'utf8');
    const guards = (routes.match(/assertCustodyUnitAccess\(user, companyId/g) || []).length;
    await check('E7: routes guard get, approve, reject, disburse, settle, topup, cancel by unit and the request route checks unit write', guards >= 7 && routes.includes("req.body?.orgUnitId || null, 'write'"), `guards=${guards}`);
    const lifecycle = await defaultCustodyService.approveCustody(compA.id, cA.id, approver.id, false);
    await check('E8: the unit survives the lifecycle (approve keeps org_unit_id)', lifecycle.orgUnitId === deptA.id && lifecycle.status === 'approved');
    void cB; void cO;
  } catch (err) {
    await check('Custody P2a2 verification unexpected error', false, err instanceof Error ? err.message : String(err));
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

        await client.query('ALTER TABLE custody_limit_policies DISABLE TRIGGER trg_custody_limit_policies_guard');
        await client.query('DELETE FROM custody_limit_policies WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('ALTER TABLE custody_limit_policies ENABLE TRIGGER trg_custody_limit_policies_guard');
        await client.query('ALTER TABLE custody_shortage_repayments DISABLE TRIGGER trg_custody_shortage_repayments_guard');
        await client.query('ALTER TABLE custody_shortage_claims DISABLE TRIGGER trg_custody_shortage_claims_guard');
        await client.query('DELETE FROM custody_shortage_repayments WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_shortage_claims WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('ALTER TABLE custody_cash_counts DISABLE TRIGGER trg_custody_cash_counts_guard');
        await client.query('DELETE FROM custody_cash_counts WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('ALTER TABLE custody_vouchers DISABLE TRIGGER trg_custody_vouchers_guard');
        await client.query('ALTER TABLE custody_voucher_lines DISABLE TRIGGER trg_custody_voucher_lines_guard');
        await client.query('DELETE FROM custody_voucher_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_vouchers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_records WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM cash_registers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM journal_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query(
          'UPDATE journal_entries SET reversed_by_entry_id = NULL WHERE company_id = ANY($1::uuid[])',
          [companyIds]
        );
        await client.query('DELETE FROM journal_entries WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM company_settings WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_periods WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_sequences WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounts WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM company_memberships WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM user_org_scope WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM org_units WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }

        await client.query('ALTER TABLE custody_shortage_repayments ENABLE TRIGGER trg_custody_shortage_repayments_guard');
        await client.query('ALTER TABLE custody_shortage_claims ENABLE TRIGGER trg_custody_shortage_claims_guard');
        await client.query('ALTER TABLE custody_cash_counts ENABLE TRIGGER trg_custody_cash_counts_guard');
        await client.query('ALTER TABLE custody_vouchers ENABLE TRIGGER trg_custody_vouchers_guard');
        await client.query('ALTER TABLE custody_voucher_lines ENABLE TRIGGER trg_custody_voucher_lines_guard');
        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        await client.query('COMMIT');
        console.log('[cleanup] Test companies, journal entries, and custody lifecycle records purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('[cleanup] Failed cleaning up verifyCustodyP2a2_1:', cleanupErr);
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
  console.error('[verifyCustodyP2a2_1] Fatal error:', err);
  process.exit(1);
});
