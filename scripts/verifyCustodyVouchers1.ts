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
import { defaultCustodyVoucherService } from '../src/server/cash/custodyVoucherService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-ERP-R08-P1 (Custody running vouchers)            ===');
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
    blocked('DATABASE_URL is not set. Live DB checks V1..V14 are BLOCKED.');
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
    blocked('Unable to connect to database executor. Live DB checks V1..V14 are BLOCKED.');
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

    const custody = await newOpenCustody(1000);

    // V1
    const v1 = await defaultCustodyVoucherService.submitVoucher(compA.id, custody.id, { lines: [lineOf(300)] }, requester.id);
    const mvAfterSubmit = await defaultCustodyService.listCustodyMovements(compA.id, custody.id);
    await check('V1: submit voucher -> status=submitted, no journal entry, no settlement movement',
      v1.status === 'submitted' && v1.journalEntryId === null && v1.totalAmount === 300 && v1.voucherNo.endsWith('-V01') &&
      !mvAfterSubmit.some((m) => m.movementType === 'settle_expense'));

    // V2
    await check('V2: submitter cannot approve own voucher (SoD)',
      await rejects(() => defaultCustodyVoucherService.approveVoucher(compA.id, v1.id, requester.id, false), ForbiddenError));

    // V3
    const v1a = await defaultCustodyVoucherService.approveVoucher(compA.id, v1.id, approver.id, false);
    const cAfter1 = await defaultCustodyService.getCustody(compA.id, custody.id);
    await check('V3: approve posts own JE, custody stays open, remaining=700',
      v1a.status === 'approved' && Boolean(v1a.journalEntryId) && cAfter1.status === 'open' && (await remainingOf(custody.id)) === 700);

    // V4
    const v2 = await defaultCustodyVoucherService.submitVoucher(compA.id, custody.id, { lines: [lineOf(120), lineOf(80)] }, requester.id);
    const v2a = await defaultCustodyVoucherService.approveVoucher(compA.id, v2.id, approver.id, false);
    await check('V4: second voucher (2 lines) approved independently, seq V02, remaining=500',
      v2a.voucherNo.endsWith('-V02') && v2a.lines.length === 2 && v2a.journalEntryId !== v1a.journalEntryId && (await remainingOf(custody.id)) === 500);

    // V5
    await check('V5: voucher above remaining balance is rejected',
      await rejects(() => defaultCustodyVoucherService.submitVoucher(compA.id, custody.id, { lines: [lineOf(500.01)] }, requester.id), ValidationError));

    // V6
    const v3 = await defaultCustodyVoucherService.submitVoucher(compA.id, custody.id, { lines: [lineOf(50)] }, requester.id);
    const noReason = await rejects(() => defaultCustodyVoucherService.rejectVoucher(compA.id, v3.id, '  ', approver.id), ValidationError);
    const v3r = await defaultCustodyVoucherService.rejectVoucher(compA.id, v3.id, 'فاتورة غير واضحة', approver.id);
    await check('V6: reject needs a reason; rejected voucher has no JE and does not change balance',
      noReason && v3r.status === 'rejected' && v3r.journalEntryId === null && (await remainingOf(custody.id)) === 500);

    // V7
    const v4 = await defaultCustodyVoucherService.submitVoucher(compA.id, custody.id, { lines: [lineOf(10)] }, requester.id);
    await check('V7: final settlement is blocked while a voucher is pending',
      await rejects(() => defaultCustodyService.settleCustody(compA.id, custody.id, { lines: [lineOf(300)], cashReturn: 200 }, approver.id, false), ValidationError));
    await defaultCustodyVoucherService.rejectVoucher(compA.id, v4.id, 'غير مطلوب', approver.id);

    // V8
    const wrong = await rejects(() => defaultCustodyService.settleCustody(compA.id, custody.id, { lines: [lineOf(300)], cashReturn: 100 }, approver.id, false), ValidationError);
    const settled = await defaultCustodyService.settleCustody(compA.id, custody.id, { lines: [lineOf(300)], cashReturn: 200 }, approver.id, false);
    await check('V8: final settle must equal REMAINING (500); cumulative totals recorded (expense 800, return 200)',
      wrong && settled.status === 'settled' && settled.settledExpenseTotal === 800 && settled.settledCashReturn === 200);

    // V9
    const gl = await executor.query<{ net: string }>(
      `SELECT COALESCE(SUM(jl.debit - jl.credit),0)::text AS net FROM journal_lines jl
       WHERE jl.company_id = $1 AND jl.account_id = $2`,
      [compA.id, custodyReceivable.id]
    ).catch(() => null);
    let v9 = false;
    if (gl) {
      v9 = Number(gl.rows[0].net) === 0;
    } else {
      const c = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
      await c.connect();
      const r = await c.query(`SELECT COALESCE(SUM(debit - credit),0)::text AS net FROM journal_lines WHERE company_id=$1 AND account_id=$2`, [compA.id, custodyReceivable.id]);
      await c.end();
      v9 = Number(r.rows[0].net) === 0;
    }
    await check('V9: custody receivable account nets to zero after vouchers + final settle (1000 out, 1000 cleared)', v9);

    // V10
    const small = await newOpenCustody(100);
    const sv = await defaultCustodyVoucherService.submitVoucher(compA.id, small.id, { lines: [lineOf(100)] }, requester.id);
    await defaultCustodyVoucherService.approveVoucher(compA.id, sv.id, approver.id, false);
    const smallAfter = await defaultCustodyService.getCustody(compA.id, small.id);
    await check('V10: voucher that clears the remaining balance auto-settles the custody', smallAfter.status === 'settled');

    // V11
    await check('V11: voucher on a settled custody is rejected',
      await rejects(() => defaultCustodyVoucherService.submitVoucher(compA.id, small.id, { lines: [lineOf(1)] }, requester.id), ValidationError));

    // V12
    const otherList = await defaultCustodyVoucherService.listVouchers(compB.id, custody.id);
    await check('V12: tenant isolation - company B sees no vouchers and cannot approve company A voucher',
      otherList.length === 0 && (await rejects(() => defaultCustodyVoucherService.approveVoucher(compB.id, v3.id, userB.id, false), NotFoundError)));

    // V13
    let v13 = false;
    let v13b = false;
    try {
      await withTenantTransaction(compA.id, (tx) => tx.query('DELETE FROM custody_vouchers WHERE company_id = $1', [compA.id]));
    } catch {
      v13 = true;
    }
    try {
      await withTenantTransaction(compA.id, (tx) => tx.query("UPDATE custody_vouchers SET memo = 'x' WHERE company_id = $1 AND status = 'approved'", [compA.id]));
    } catch {
      v13b = true;
    }
    await check('V13: vouchers cannot be deleted and decided vouchers cannot be edited (DB trigger, history is kept)', v13 && v13b);

    // V14
    const c3 = await newOpenCustody(400);
    const pv = await defaultCustodyVoucherService.submitVoucher(compA.id, c3.id, { lines: [lineOf(150)] }, requester.id);
    await periodService.closePeriod(compA.id, openPeriod.id, approver.id);
    const closedRejected = await rejects(() => defaultCustodyVoucherService.approveVoucher(compA.id, pv.id, approver.id, false), ValidationError);
    const pvAfter = (await defaultCustodyVoucherService.listVouchers(compA.id, c3.id))[0];
    await check('V14: approval in a closed period fails and rolls back (voucher stays submitted, no movement)',
      closedRejected && pvAfter.status === 'submitted' && (await remainingOf(c3.id)) === 400);
  } catch (err) {
    await check('Custody vouchers verification unexpected error', false, err instanceof Error ? err.message : String(err));
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
        console.error('[cleanup] Failed cleaning up verifyCustodyVouchers1:', cleanupErr);
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
  console.error('[verifyCustodyVouchers1] Fatal error:', err);
  process.exit(1);
});
