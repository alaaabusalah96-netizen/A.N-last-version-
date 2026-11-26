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
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-ERP-D2 (per-employee custody ceiling)      ===');
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
    blocked('DATABASE_URL is not set. Live DB checks S1..S10 are BLOCKED.');
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
    blocked('Unable to connect to database executor. Live DB checks S1..S10 are BLOCKED.');
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

    const newOpenCustody = async (amount: number) => {
      const c = await defaultCustodyService.requestCustody(
        compA.id, { employeeUserId: requester.id, registerId: register.id, amount, purpose: 'اختبار حوافظ العهدة' }, requester.id
      );
      await defaultCustodyService.approveCustody(compA.id, c.id, approver.id, false);
      return await defaultCustodyService.disburseCustody(compA.id, c.id, approver.id, false);
    };
    const remainingOf = async (custodyId: string) => {
      const c = await defaultCustodyService.getCustody(compA.id, custodyId);
      const mv = await defaultCustodyService.listCustodyMovements(compA.id, custodyId);
      const done = mv.filter((m) => m.movementType === 'settle_expense' || m.movementType === 'settle_return')
        .reduce((s, m) => s + m.amount, 0);
      return Math.round((c.amount - done) * 100) / 100;
    };
    const lineOf = (amount: number) => ({ expenseAccountId: expenseAccount.id, amount, memo: 'مصروف' });
    const rejects = async (fn: () => Promise<unknown>, cls: any) => {
      try { await fn(); return false; } catch (e) { return e instanceof cls; }
    };

    const jeCount = async () => {
      const c = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
      await c.connect();
      const r = await c.query('SELECT COUNT(*)::int AS n FROM journal_entries WHERE company_id=$1', [compA.id]);
      await c.end();
      return r.rows[0].n as number;
    };
    const receivableNet = async () => {
      const c = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
      await c.connect();
      const r = await c.query(`SELECT COALESCE(SUM(debit - credit),0)::text AS net FROM journal_lines WHERE company_id=$1 AND account_id=$2`, [compA.id, custodyReceivable.id]);
      await c.end();
      return Number(r.rows[0].net);
    };
    const regBalance = async () => {
      const b = await defaultCashRegisterService.getBalance(compA.id, register.id);
      return b.currentBalance;
    };

    const { defaultCustodyLimitService } = await import('../src/server/cash/custodyLimitService.js');
    const req = (amount: number) => defaultCustodyService.requestCustody(
      compA.id, { employeeUserId: requester.id, registerId: register.id, amount, purpose: 'اختبار سقف العهدة' }, requester.id);

    // L1: nothing enforced until a policy is published
    const big = await req(5000);
    await check('L1: with no policy a custody of 5000 is accepted (nothing enforced by default)', big.status === 'pending');
    await defaultCustodyService.cancelCustody(compA.id, big.id, requester.id).catch(() => undefined);

    // L2: company default 3000 counts pending + approved + open together
    await defaultCustodyLimitService.setPolicy(compA.id, { enabled: true, limitAmount: 3000, reason: 'سقف افتراضي' }, approver.id);
    const r1 = await req(2000);
    const over = await rejects(() => req(1500), ValidationError);
    const r2 = await req(1000);
    const overExact = await rejects(() => req(0.01), ValidationError);
    await check('L2: default ceiling 3000: 2000 ok, +1500 rejected, +1000 ok (exactly 3000), +0.01 rejected',
      r1.status === 'pending' && over && r2.status === 'pending' && overExact);

    // L3: a per-employee row overrides the default
    await defaultCustodyLimitService.setPolicy(compA.id, { employeeUserId: requester.id, enabled: true, limitAmount: 10000 }, approver.id);
    const r3 = await req(1500);
    await check('L3: per-employee ceiling 10000 overrides the company default, so +1500 is now accepted', r3.status === 'pending');

    // L4: top-up of an open custody is checked too
    await defaultCustodyLimitService.setPolicy(compA.id, { employeeUserId: requester.id, enabled: true, limitAmount: 4500 }, approver.id);
    await defaultCustodyService.approveCustody(compA.id, r1.id, approver.id, false);
    await defaultCustodyService.disburseCustody(compA.id, r1.id, approver.id, false);
    const topRej = await rejects(() => defaultCustodyExtrasService.topUpCustody(compA.id, r1.id, { amount: 100 }, approver.id, false), ValidationError);
    await check('L4: exposure is 4500 (2000 open + 1000 + 1500 pending) so a top-up of 100 is rejected at ceiling 4500', topRej);

    // L5: an employee row with enabled=false EXEMPTS that employee even though the company default (3000) is still on
    await defaultCustodyLimitService.setPolicy(compA.id, { employeeUserId: requester.id, enabled: false }, approver.id);
    const exempt = await req(1);
    await defaultCustodyLimitService.setPolicy(compA.id, { enabled: false }, approver.id);
    await check('L5: employee row disabled exempts that employee although the company default (3000) is still on and exceeded', exempt.status === 'pending');
    const lifted = await req(1);
    await check('L5b: after the default is disabled too a new request is accepted', lifted.status === 'pending');

    // L6: validation
    await check('L6: enabled without amount, zero, negative and 3-decimal ceilings are rejected',
      (await rejects(() => defaultCustodyLimitService.setPolicy(compA.id, { enabled: true }, approver.id), ValidationError)) &&
      (await rejects(() => defaultCustodyLimitService.setPolicy(compA.id, { enabled: true, limitAmount: 0 }, approver.id), ValidationError)) &&
      (await rejects(() => defaultCustodyLimitService.setPolicy(compA.id, { enabled: true, limitAmount: -5 }, approver.id), ValidationError)) &&
      (await rejects(() => defaultCustodyLimitService.setPolicy(compA.id, { enabled: true, limitAmount: '10.555' }, approver.id), ValidationError)));

    // L7: history is immutable (app role) and versions are kept
    let l7a = false, l7b = false;
    try { await withTenantTransaction(compA.id, (tx) => tx.query('DELETE FROM custody_limit_policies WHERE company_id = $1', [compA.id])); } catch { l7a = true; }
    try { await withTenantTransaction(compA.id, (tx) => tx.query('UPDATE custody_limit_policies SET limit_amount = 1 WHERE company_id = $1', [compA.id])); } catch { l7b = true; }
    const cl = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
    await cl.connect();
    const vc = await cl.query('SELECT COUNT(*)::int AS n FROM custody_limit_policies WHERE company_id = $1', [compA.id]);
    await cl.end();
    await check('L7: policy rows cannot be edited or deleted and every version is kept (5 versions)', l7a && l7b && vc.rows[0].n === 5);

    // L8: tenant isolation
    const listB = await defaultCustodyLimitService.listPolicies(compB.id);
    const listA = await defaultCustodyLimitService.listPolicies(compA.id);
    await check('L8: company B sees no policies of company A; A lists the latest version per scope (default + employee)',
      listB.length === 0 && listA.length === 2 && listA.every((p) => p.enabled === false));
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
