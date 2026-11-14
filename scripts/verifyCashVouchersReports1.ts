import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultMembershipStore } from '../src/server/org/membershipStore.js';
import { AccountService } from '../src/server/accounting/accountService.js';
import { PeriodService } from '../src/server/accounting/periodService.js';
import { defaultJournalRepository } from '../src/server/accounting/journalRepository.js';
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';
import { defaultCustodyService } from '../src/server/cash/custodyService.js';
import { defaultVoucherService } from '../src/server/cash/voucherService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('==================================================================================');
console.log('=== VERIFYING AN-CASH-CUSTODY-VOUCHERS-REPORTS-23 (Vouchers & Reports V1..V11) ===');
console.log('==================================================================================');

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
    blocked('DATABASE_URL is not set. Live DB checks V1..V11 are BLOCKED.');
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
    blocked('Unable to connect to database executor. Live DB checks V1..V11 are BLOCKED.');
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

    const actorA = await userRepo.createUser({
      username: `vch_adm_a_${unique}`,
      passwordHash: 'dummy_voucher_hash_23',
      role: 'user',
    });
    const empA = await userRepo.createUser({
      username: `vch_emp_a_${unique}`,
      passwordHash: 'dummy_voucher_hash_23',
      role: 'user',
    });
    const actorB = await userRepo.createUser({
      username: `vch_adm_b_${unique}`,
      passwordHash: 'dummy_voucher_hash_23',
      role: 'user',
    });
    userIds.push(actorA.id, empA.id, actorB.id);

    const compA = await companyRepo.create({
      code: `VCHA-${unique}`.slice(0, 20),
      nameAr: `شركة السندات أ ${unique}`,
      createdBy: actorA.id,
    });
    const compB = await companyRepo.create({
      code: `VCHB-${unique}`.slice(0, 20),
      nameAr: `شركة السندات ب ${unique}`,
      createdBy: actorB.id,
    });
    companyIds.push(compA.id, compB.id);

    await defaultMembershipStore.addMember(actorA.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(empA.id, compA.id, 'company_user', true);
    await defaultMembershipStore.addMember(actorB.id, compB.id, 'company_admin', true);

    const { accounts: accountsA } = await accountService.seedDefaultCoa(compA.id);
    await accountService.seedDefaultCoa(compB.id);

    const headerAssetA = accountsA.find((a) => a.code === '1000')!; // non-postable
    const cashAccountA = accountsA.find((a) => a.code === '1100')!; // postable asset
    const revenueAccountA = accountsA.find((a) => a.code === '4100')!; // postable revenue
    const expenseAccountA = accountsA.find((a) => a.code === '5100')!; // postable expense

    const inactiveExpenseA = await accountService.createAccount(compA.id, {
      code: '5999',
      nameAr: 'مصروف موقوف',
      accountType: 'expense',
      parentId: accountsA.find((a) => a.code === '5000')!.id,
      isPostable: true,
    });
    await withTenantTransaction(compA.id, async (tx) => {
      await tx.query('UPDATE accounts SET is_active = false WHERE company_id = $1 AND id = $2', [
        compA.id,
        inactiveExpenseA.id,
      ]);
    });

    const custodyReceivableA = await accountService.createAccount(compA.id, {
      code: '1255',
      nameAr: 'ذمة عهد الموظفين',
      accountType: 'asset',
      parentId: headerAssetA.id,
      isPostable: true,
    });

    // Open accounting period covering today + full current month
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();
    const todayStr = now.toISOString().slice(0, 10);
    const startOfMonth = `${year}-${month}-01`;
    const endOfMonth = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

    await periodService.createPeriod(
      compA.id,
      {
        code: `${year}-${month}`,
        startDate: startOfMonth,
        endDate: endOfMonth,
      },
      actorA.id
    );

    const registerA = await defaultCashRegisterService.createRegister(
      compA.id,
      {
        code: `CASH-V-${unique}`.slice(0, 30),
        nameAr: 'صندوق السندات الرئيسي',
        glAccountId: cashAccountA.id,
        openingBalance: 1000,
      },
      actorA.id
    );

    // V11 (run before setting custody_receivable_account_id): Missing custody mapping on disburseCustody -> clear Arabic error
    await defaultCompanySettingsService.upsertSettings(actorA.id, compA.id, {
      custodyReceivableAccountId: null,
    });
    const missingMapCus = await defaultCustodyService.requestCustody(
      compA.id,
      {
        employeeUserId: empA.id,
        registerId: registerA.id,
        amount: 100,
        purpose: 'فحص غياب ربط ذمة العهد',
      },
      empA.id
    );
    await defaultCustodyService.approveCustody(compA.id, missingMapCus.id, actorA.id, false);
    let v11Rejected = false;
    try {
      await defaultCustodyService.disburseCustody(compA.id, missingMapCus.id, actorA.id, false);
    } catch (err) {
      if (err instanceof ValidationError && err.message.includes('ذمة عهد الموظفين')) {
        v11Rejected = true;
      }
    }
    await check('V11: Missing custody GL mapping raises clear Arabic ValidationError on disburseCustody', v11Rejected);

    // Configure custody receivable account
    await defaultCompanySettingsService.upsertSettings(actorA.id, compA.id, {
      custodyReceivableAccountId: custodyReceivableA.id,
    });

    // V1: Receipt voucher posted -> balanced JE (Dr cash GL, Cr contra), CRV- number, unified getBalance increased
    const draftRcv = await defaultVoucherService.createReceiptVoucher(
      compA.id,
      {
        registerId: registerA.id,
        voucherDate: todayStr,
        amount: 500,
        contraAccountId: revenueAccountA.id,
        reference: 'REC-101',
        memo: 'قبض نقدي اختبار V1',
      },
      actorA.id
    );
    const postedRcv = await defaultVoucherService.postReceiptVoucher(compA.id, draftRcv.id, actorA.id, false);
    const rcvJe = postedRcv.journalEntryId
      ? await defaultJournalRepository.findById(compA.id, postedRcv.journalEntryId)
      : null;
    const balAfterV1 = await defaultCashRegisterService.getBalance(compA.id, registerA.id);
    const v1Ok =
      draftRcv.status === 'draft' &&
      postedRcv.status === 'posted' &&
      Boolean(postedRcv.voucherNo && postedRcv.voucherNo.startsWith('CRV-')) &&
      rcvJe !== null &&
      rcvJe.status === 'posted' &&
      rcvJe.lines?.some((l) => l.accountId === cashAccountA.id && l.debit === 500 && l.credit === 0) === true &&
      rcvJe.lines?.some((l) => l.accountId === revenueAccountA.id && l.debit === 0 && l.credit === 500) === true &&
      balAfterV1.openingBalance === 1000 &&
      balAfterV1.totalIn === 500 &&
      balAfterV1.totalOut === 0 &&
      balAfterV1.currentBalance === 1500;
    await check('V1: Posted receipt voucher creates balanced GL entry (Dr Cash / Cr Contra) & increases getBalance', v1Ok);

    // V2: Payment voucher posted -> balanced JE (Dr contra, Cr cash GL), CPV- number, unified getBalance decreased
    const draftPay = await defaultVoucherService.createPaymentVoucher(
      compA.id,
      {
        registerId: registerA.id,
        voucherDate: todayStr,
        amount: 200,
        contraAccountId: expenseAccountA.id,
        reference: 'PAY-202',
        memo: 'صرف مصروف اختبار V2',
      },
      actorA.id
    );
    const postedPay = await defaultVoucherService.postPaymentVoucher(compA.id, draftPay.id, actorA.id, false);
    const payJe = postedPay.journalEntryId
      ? await defaultJournalRepository.findById(compA.id, postedPay.journalEntryId)
      : null;
    const balAfterV2 = await defaultCashRegisterService.getBalance(compA.id, registerA.id);
    const v2Ok =
      postedPay.status === 'posted' &&
      Boolean(postedPay.voucherNo && postedPay.voucherNo.startsWith('CPV-')) &&
      payJe !== null &&
      payJe.status === 'posted' &&
      payJe.lines?.some((l) => l.accountId === expenseAccountA.id && l.debit === 200 && l.credit === 0) === true &&
      payJe.lines?.some((l) => l.accountId === cashAccountA.id && l.debit === 0 && l.credit === 200) === true &&
      balAfterV2.totalIn === 500 &&
      balAfterV2.totalOut === 200 &&
      balAfterV2.currentBalance === 1300;
    await check('V2: Posted payment voucher creates balanced GL entry (Dr Contra / Cr Cash) & decreases getBalance', v2Ok);

    // Regression setup: also disburse open custody (amount 300) so register has 1000 + 500 - 200 - 300 = 1000
    const openCus = await defaultCustodyService.requestCustody(
      compA.id,
      {
        employeeUserId: empA.id,
        registerId: registerA.id,
        amount: 300,
        purpose: 'عهدة مفتوحة لاختبار الرصيد والتقارير',
        requestDate: todayStr,
      },
      empA.id
    );
    await defaultCustodyService.approveCustody(compA.id, openCus.id, actorA.id, false);
    await defaultCustodyService.disburseCustody(compA.id, openCus.id, actorA.id, false);
    const balWithCustodyAndVouchers = await defaultCashRegisterService.getBalance(compA.id, registerA.id);

    // V3: Payment voucher > current balance (1000) -> ValidationError
    const overPay = await defaultVoucherService.createPaymentVoucher(
      compA.id,
      {
        registerId: registerA.id,
        voucherDate: todayStr,
        amount: 1001,
        contraAccountId: expenseAccountA.id,
        memo: 'اختبار تجاوز الرصيد',
      },
      actorA.id
    );
    let v3Rejected = false;
    try {
      await defaultVoucherService.postPaymentVoucher(compA.id, overPay.id, actorA.id, false);
    } catch (err) {
      if (err instanceof ValidationError && err.message.includes('غير كافٍ')) {
        v3Rejected = true;
      }
    }
    await check(
      'V3: Payment voucher exceeding unified balance (custody + vouchers) throws ValidationError',
      v3Rejected && balWithCustodyAndVouchers.currentBalance === 1000
    );

    // V4: Duplicate post on receipt & payment -> ValidationError
    let v4RcvDup = false;
    try {
      await defaultVoucherService.postReceiptVoucher(compA.id, postedRcv.id, actorA.id, false);
    } catch (err) {
      if (err instanceof ValidationError) v4RcvDup = true;
    }
    let v4PayDup = false;
    try {
      await defaultVoucherService.postPaymentVoucher(compA.id, postedPay.id, actorA.id, false);
    } catch (err) {
      if (err instanceof ValidationError) v4PayDup = true;
    }
    await check('V4: Duplicate postReceiptVoucher / postPaymentVoucher throws ValidationError', v4RcvDup && v4PayDup);

    // V5: contraAccountId === register.glAccountId -> ValidationError
    let v5Rejected = false;
    try {
      await defaultVoucherService.createReceiptVoucher(
        compA.id,
        {
          registerId: registerA.id,
          voucherDate: todayStr,
          amount: 50,
          contraAccountId: cashAccountA.id,
        },
        actorA.id
      );
    } catch (err) {
      if (err instanceof ValidationError) v5Rejected = true;
    }
    await check('V5: contraAccountId equal to register glAccountId throws ValidationError', v5Rejected);

    // V6: Non-postable header or inactive account -> ValidationError
    let v6HeaderRejected = false;
    try {
      await defaultVoucherService.createPaymentVoucher(
        compA.id,
        {
          registerId: registerA.id,
          voucherDate: todayStr,
          amount: 50,
          contraAccountId: headerAssetA.id,
        },
        actorA.id
      );
    } catch (err) {
      if (err instanceof ValidationError) v6HeaderRejected = true;
    }
    let v6InactiveRejected = false;
    try {
      await defaultVoucherService.createPaymentVoucher(
        compA.id,
        {
          registerId: registerA.id,
          voucherDate: todayStr,
          amount: 50,
          contraAccountId: inactiveExpenseA.id,
        },
        actorA.id
      );
    } catch (err) {
      if (err instanceof ValidationError) v6InactiveRejected = true;
    }
    await check(
      'V6: Non-postable or inactive contraAccountId throws ValidationError',
      v6HeaderRejected && v6InactiveRejected
    );

    // V7: Cross-company isolation: getVoucher(compB, voucherOfA) -> NotFoundError
    let v7RcvIso = false;
    try {
      await defaultVoucherService.getVoucher('receipt', compB.id, postedRcv.id);
    } catch (err) {
      if (err instanceof NotFoundError) v7RcvIso = true;
    }
    let v7PayIso = false;
    try {
      await defaultVoucherService.getVoucher('payment', compB.id, postedPay.id);
    } catch (err) {
      if (err instanceof NotFoundError) v7PayIso = true;
    }
    await check('V7: getVoucher(companyB, voucherOfA) throws NotFoundError (company isolation)', v7RcvIso && v7PayIso);

    // V8: Cancel posted voucher -> ValidationError pointing to reverseEntry; draft cancel succeeds
    let v8PostedCancelRejected = false;
    try {
      await defaultVoucherService.cancelVoucher('receipt', compA.id, postedRcv.id, actorA.id, 'اختبار منع');
    } catch (err) {
      if (err instanceof ValidationError && err.message.includes('reverseEntry')) {
        v8PostedCancelRejected = true;
      }
    }
    const cancelledDraft = await defaultVoucherService.cancelVoucher('payment', compA.id, overPay.id, actorA.id, 'ملغى قبل الترحيل');
    await check(
      'V8: Cancelling posted voucher raises ValidationError directing to reverseEntry while draft cancel succeeds',
      v8PostedCancelRejected && cancelledDraft.status === 'cancelled'
    );

    // V9: Register movements report matches real SQL SUM(in/out) over [from, to] across custody_movements + vouchers
    const report = await defaultVoucherService.getRegisterMovementsReport(compA.id, {
      registerId: registerA.id,
      from: startOfMonth,
      to: endOfMonth,
    });
    const sqlReportSums = await withTenantTransaction(compA.id, async (tx) => {
      const r = await tx.query<{ sumIn: string; sumOut: string }>(
        `
        SELECT
          COALESCE(SUM(in_amt), 0)::text as "sumIn",
          COALESCE(SUM(out_amt), 0)::text as "sumOut"
        FROM (
          SELECT
            CASE WHEN cm.direction = 'in' THEN cm.amount ELSE 0 END as in_amt,
            CASE WHEN cm.direction = 'out' THEN cm.amount ELSE 0 END as out_amt
          FROM custody_movements cm
          WHERE cm.company_id = $1 AND cm.register_id = $2
            AND (cm.created_at AT TIME ZONE 'UTC')::date >= $3::date
            AND (cm.created_at AT TIME ZONE 'UTC')::date <= $4::date
          UNION ALL
          SELECT rv.amount as in_amt, 0::numeric as out_amt
          FROM cash_receipt_vouchers rv
          WHERE rv.company_id = $1 AND rv.register_id = $2 AND rv.status = 'posted'
            AND rv.voucher_date >= $3::date AND rv.voucher_date <= $4::date
          UNION ALL
          SELECT 0::numeric as in_amt, pv.amount as out_amt
          FROM cash_payment_vouchers pv
          WHERE pv.company_id = $1 AND pv.register_id = $2 AND pv.status = 'posted'
            AND pv.voucher_date >= $3::date AND pv.voucher_date <= $4::date
        ) t;
        `,
        [compA.id, registerA.id, startOfMonth, endOfMonth]
      );
      return {
        sumIn: Number(r.rows[0]?.sumIn || 0),
        sumOut: Number(r.rows[0]?.sumOut || 0),
      };
    });
    const v9RowsComplete =
      report.rows.length === 3 &&
      report.rows.every(
        (row) =>
          Boolean(row.movementDate) &&
          Boolean(row.movementLabelAr) &&
          Boolean(row.reference) &&
          Boolean(row.actorUsername) &&
          Boolean(row.journalEntryNo && row.journalEntryNo !== '—')
      );
    await check(
      'V9: getRegisterMovementsReport sums (in=500, out=500) match real SQL across custody + vouchers with full row contract',
      report.totalIn === sqlReportSums.sumIn &&
        report.totalOut === sqlReportSums.sumOut &&
        report.totalIn === 500 &&
        report.totalOut === 500 &&
        report.closingBalance === 1000 &&
        v9RowsComplete
    );

    // V10: Open custodies summary matches direct SQL SUM(amount) WHERE status = 'open'
    const openSummary = await defaultCustodyService.getOpenBalancesByEmployee(compA.id);
    const sqlOpenSum = await withTenantTransaction(compA.id, async (tx) => {
      const r = await tx.query<{ cnt: string; total: string }>(
        `SELECT COUNT(*)::text as cnt, COALESCE(SUM(amount), 0)::text as total
         FROM custody_records
         WHERE company_id = $1 AND status = 'open'`,
        [compA.id]
      );
      return {
        cnt: Number(r.rows[0]?.cnt || 0),
        total: Number(r.rows[0]?.total || 0),
      };
    });
    const empRow = openSummary.find((s) => s.employeeUserId === empA.id);
    await check(
      'V10: Open custodies summary matches direct SQL COUNT/SUM(amount) on custody_records WHERE status=open',
      Boolean(empRow) && empRow!.openCount === sqlOpenSum.cnt && empRow!.totalAmount === sqlOpenSum.total && empRow!.totalAmount === 300
    );
  } catch (err) {
    await check(
      'Vouchers & Reports verification unexpected error',
      false,
      err instanceof Error ? err.message : String(err)
    );
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

        await client.query('DELETE FROM cash_receipt_vouchers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM cash_payment_vouchers WHERE company_id = ANY($1::uuid[])', [companyIds]);
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

        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        await client.query('COMMIT');
        console.log('[cleanup] Test companies, vouchers, custodies, and journal entries purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          console.error('[cleanup] Rollback error:', rbErr);
        }
        console.error('[cleanup] Failed cleaning up verifyCashVouchersReports1:', cleanupErr);
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
  console.error('[verifyCashVouchersReports1] Fatal error:', err);
  process.exit(1);
});
