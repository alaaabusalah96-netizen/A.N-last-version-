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
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';
import { defaultCustodyService } from '../src/server/cash/custodyService.js';
import { defaultVoucherService } from '../src/server/cash/voucherService.js';
import { defaultVoucherRepository } from '../src/server/cash/voucherRepository.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';

console.log('==================================================================================');
console.log('=== VERIFYING AN-CASH-REPORT-PERIOD-1 (Period-Aware Register Movement Report)  ===');
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

function addDaysUtc(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live DB checks P1..P5 are BLOCKED.');
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
    blocked('Unable to connect to database executor. Live DB checks P1..P5 are BLOCKED.');
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

    const actor = await userRepo.createUser({
      username: `rep_adm_${unique}`,
      passwordHash: 'dummy_period_hash_1',
      role: 'user',
    });
    const emp = await userRepo.createUser({
      username: `rep_emp_${unique}`,
      passwordHash: 'dummy_period_hash_1',
      role: 'user',
    });
    userIds.push(actor.id, emp.id);

    const company = await companyRepo.create({
      code: `RPER-${unique}`.slice(0, 20),
      nameAr: `شركة تقرير الفترة ${unique}`,
      createdBy: actor.id,
    });
    companyIds.push(company.id);

    await defaultMembershipStore.addMember(actor.id, company.id, 'company_admin', true);
    await defaultMembershipStore.addMember(emp.id, company.id, 'company_user', true);

    const { accounts } = await accountService.seedDefaultCoa(company.id);
    const headerAsset = accounts.find((a) => a.code === '1000')!;
    const cashAccount = accounts.find((a) => a.code === '1100')!;
    const revenueAccount = accounts.find((a) => a.code === '4100')!;
    const expenseAccount = accounts.find((a) => a.code === '5100')!;
    const custodyReceivable = await accountService.createAccount(company.id, {
      code: '1255',
      nameAr: 'ذمة عهد الموظفين',
      accountType: 'asset',
      parentId: headerAsset.id,
      isPostable: true,
    });

    await defaultCompanySettingsService.upsertSettings(actor.id, company.id, {
      custodyReceivableAccountId: custodyReceivable.id,
    });

    const todayStr = new Date().toISOString().slice(0, 10);
    const periodStart = addDaysUtc(todayStr, -30);
    const periodEnd = addDaysUtc(todayStr, 30);

    await periodService.createPeriod(
      company.id,
      {
        code: `P-${unique}`.slice(0, 20),
        startDate: periodStart,
        endDate: periodEnd,
      },
      actor.id
    );

    // P1: Create register with known opening_balance = 2500
    const register = await defaultCashRegisterService.createRegister(
      company.id,
      {
        code: `CR-P-${unique}`.slice(0, 30),
        nameAr: 'صندوق اختبار تقارير الفترة',
        glAccountId: cashAccount.id,
        openingBalance: 2500,
      },
      actor.id
    );
    await check(
      'P1: Created company & register with known openingBalance = 2500',
      register.openingBalance === 2500 && register.companyId === company.id
    );

    const dateBefore = addDaysUtc(todayStr, -20);
    const fromDate = addDaysUtc(todayStr, -10);
    const toDate = addDaysUtc(todayStr, 2);
    const dateAfter = addDaysUtc(todayStr, 5);

    const postVoucher = async (kind: 'receipt' | 'payment', voucherDate: string, amount: number, memo: string) => {
      const draft =
        kind === 'receipt'
          ? await defaultVoucherService.createReceiptVoucher(
              company.id,
              {
                registerId: register.id,
                voucherDate,
                amount,
                contraAccountId: revenueAccount.id,
                memo,
              },
              actor.id
            )
          : await defaultVoucherService.createPaymentVoucher(
              company.id,
              {
                registerId: register.id,
                voucherDate,
                amount,
                contraAccountId: expenseAccount.id,
                memo,
              },
              actor.id
            );
      return kind === 'receipt'
        ? await defaultVoucherService.postReceiptVoucher(company.id, draft.id, actor.id, false)
        : await defaultVoucherService.postPaymentVoucher(company.id, draft.id, actor.id, false);
    };

    // Movements strictly BEFORE period (< fromDate): +400 +200 -150 => +450 net
    await postVoucher('receipt', dateBefore, 400, 'قبل الفترة 1');
    await postVoucher('receipt', dateBefore, 200, 'قبل الفترة 2');
    await postVoucher('payment', dateBefore, 150, 'قبل الفترة 3');

    // Movements INSIDE [fromDate, toDate] (>10 movements across vouchers & custody):
    // Receipts: 100 + 120 + 80 + 150 + 200 + 50 = 700
    for (const [idx, amt] of [100, 120, 80, 150, 200, 50].entries()) {
      await postVoucher('receipt', addDaysUtc(fromDate, idx), amt, `قبض داخل الفترة ${idx + 1}`);
    }
    // Payments: 60 + 40 + 100 = 200
    for (const [idx, amt] of [60, 40, 100].entries()) {
      await postVoucher('payment', addDaysUtc(fromDate, idx + 1), amt, `صرف داخل الفترة ${idx + 1}`);
    }
    // Custody disburse 300 (out) + settle return 120 (in) on todayStr (inside [fromDate, toDate])
    const cus = await defaultCustodyService.requestCustody(
      company.id,
      {
        employeeUserId: emp.id,
        registerId: register.id,
        amount: 300,
        purpose: 'عهدة لاختبار تقرير الفترة',
        requestDate: todayStr,
      },
      emp.id
    );
    await defaultCustodyService.approveCustody(company.id, cus.id, actor.id, false);
    await defaultCustodyService.disburseCustody(company.id, cus.id, actor.id, false);
    await defaultCustodyService.settleCustody(
      company.id,
      cus.id,
      {
        lines: [{ expenseAccountId: expenseAccount.id, amount: 180, memo: 'مصروف عهدة' }],
        cashReturn: 120,
      },
      actor.id,
      false
    );

    // Movements strictly AFTER period (> toDate): +900 -100 => +800 net
    await postVoucher('receipt', dateAfter, 900, 'بعد الفترة 1');
    await postVoucher('payment', dateAfter, 100, 'بعد الفترة 2');

    // Independent unlimited SQL helper
    const queryIndependentSql = async (qFrom?: string, qTo?: string) => {
      return await withTenantTransaction(company.id, async (tx) => {
        const res = await tx.query<{ openingNetBefore: string; totalIn: string; totalOut: string }>(
          `
          SELECT
            COALESCE(SUM(
              CASE WHEN $3::date IS NOT NULL AND m.movement_date < $3::date
              THEN m.in_amt - m.out_amt ELSE 0 END
            ), 0)::text as "openingNetBefore",
            COALESCE(SUM(
              CASE WHEN ($3::date IS NULL OR m.movement_date >= $3::date)
                    AND ($4::date IS NULL OR m.movement_date <= $4::date)
              THEN m.in_amt ELSE 0 END
            ), 0)::text as "totalIn",
            COALESCE(SUM(
              CASE WHEN ($3::date IS NULL OR m.movement_date >= $3::date)
                    AND ($4::date IS NULL OR m.movement_date <= $4::date)
              THEN m.out_amt ELSE 0 END
            ), 0)::text as "totalOut"
          FROM (
            SELECT (cm.created_at AT TIME ZONE 'UTC')::date as movement_date,
                   CASE WHEN cm.direction = 'in' THEN cm.amount ELSE 0 END as in_amt,
                   CASE WHEN cm.direction = 'out' THEN cm.amount ELSE 0 END as out_amt
            FROM custody_movements cm
            WHERE cm.company_id = $1 AND cm.register_id = $2 AND cm.direction IN ('in', 'out')
            UNION ALL
            SELECT rv.voucher_date as movement_date, rv.amount as in_amt, 0::numeric as out_amt
            FROM cash_receipt_vouchers rv
            WHERE rv.company_id = $1 AND rv.register_id = $2 AND rv.status = 'posted'
            UNION ALL
            SELECT pv.voucher_date as movement_date, 0::numeric as in_amt, pv.amount as out_amt
            FROM cash_payment_vouchers pv
            WHERE pv.company_id = $1 AND pv.register_id = $2 AND pv.status = 'posted'
          ) m;
          `,
          [company.id, register.id, qFrom || null, qTo || null]
        );
        return {
          openingNetBefore: Number(res.rows[0]?.openingNetBefore || 0),
          totalIn: Number(res.rows[0]?.totalIn || 0),
          totalOut: Number(res.rows[0]?.totalOut || 0),
        };
      });
    };

    // P2: Full-history totals match unlimited SQL across >10 movements and match repository aggregate directly
    const fullTotals = await defaultVoucherRepository.listRegisterPeriodTotals(company.id, register.id);
    const fullReport = await defaultVoucherService.getRegisterMovementsReport(company.id, {
      registerId: register.id,
    });
    const sqlFull = await queryIndependentSql();
    const p2Ok =
      fullReport.rows.length === 16 &&
      fullTotals.openingNetBefore === 0 &&
      fullTotals.totalIn === sqlFull.totalIn &&
      fullTotals.totalOut === sqlFull.totalOut &&
      fullReport.totalIn === sqlFull.totalIn &&
      fullReport.totalOut === sqlFull.totalOut &&
      fullReport.totalIn === 2320 &&
      fullReport.totalOut === 750 &&
      fullReport.openingBalance === 2500 &&
      fullReport.closingBalance === 4070;
    await check(
      'P2: Full-history aggregate totals match independent unlimited SQL across 16 movements (in=2320, out=750, closing=4070)',
      p2Ok
    );

    // P3: Period filter [fromDate, toDate] -> openingBalance and closingBalance reflect period bounds (not register.opening / balance.currentBalance)
    const periodReport = await defaultVoucherService.getRegisterMovementsReport(company.id, {
      registerId: register.id,
      from: fromDate,
      to: toDate,
    });
    const sqlPeriod = await queryIndependentSql(fromDate, toDate);
    const currentFullBal = await defaultCashRegisterService.getBalance(company.id, register.id);
    const expectedPeriodOpening = 2500 + sqlPeriod.openingNetBefore; // 2950
    const expectedPeriodClosing = expectedPeriodOpening + sqlPeriod.totalIn - sqlPeriod.totalOut; // 2950 + 820 - 500 = 3270
    const p3Ok =
      periodReport.rows.length === 11 &&
      periodReport.openingBalance === expectedPeriodOpening &&
      periodReport.openingBalance === 2950 &&
      periodReport.totalIn === sqlPeriod.totalIn &&
      periodReport.totalIn === 820 &&
      periodReport.totalOut === sqlPeriod.totalOut &&
      periodReport.totalOut === 500 &&
      periodReport.closingBalance === expectedPeriodClosing &&
      periodReport.closingBalance === 3270 &&
      periodReport.closingBalance !== currentFullBal.currentBalance;
    await check(
      'P3: Period filter [from, to] computes openingBalance (2950) & closingBalance (3270) independently from currentBalance (4070)',
      p3Ok
    );

    // P4: Empty periods (before all movements & after all movements) -> totalIn=0, totalOut=0, closingBalance=openingBalance
    const emptyPast = await defaultVoucherService.getRegisterMovementsReport(company.id, {
      registerId: register.id,
      from: '1990-01-01',
      to: '1990-01-31',
    });
    const emptyFuture = await defaultVoucherService.getRegisterMovementsReport(company.id, {
      registerId: register.id,
      from: '2099-01-01',
      to: '2099-01-31',
    });
    const p4Ok =
      emptyPast.rows.length === 0 &&
      emptyPast.totalIn === 0 &&
      emptyPast.totalOut === 0 &&
      emptyPast.openingBalance === 2500 &&
      emptyPast.closingBalance === emptyPast.openingBalance &&
      emptyFuture.rows.length === 0 &&
      emptyFuture.totalIn === 0 &&
      emptyFuture.totalOut === 0 &&
      emptyFuture.openingBalance === 4070 &&
      emptyFuture.closingBalance === emptyFuture.openingBalance;
    await check(
      'P4: Empty periods return totalIn=0, totalOut=0, and closingBalance === openingBalance',
      p4Ok
    );
  } catch (err) {
    await check(
      'Period report verification unexpected error',
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

        const remRes = await client.query<{ remaining: string }>(
          `
          SELECT (
            (SELECT COUNT(*) FROM cash_receipt_vouchers WHERE company_id = ANY($1::uuid[])) +
            (SELECT COUNT(*) FROM cash_payment_vouchers WHERE company_id = ANY($1::uuid[])) +
            (SELECT COUNT(*) FROM custody_movements WHERE company_id = ANY($1::uuid[])) +
            (SELECT COUNT(*) FROM custody_records WHERE company_id = ANY($1::uuid[])) +
            (SELECT COUNT(*) FROM cash_registers WHERE company_id = ANY($1::uuid[])) +
            (SELECT COUNT(*) FROM companies WHERE id = ANY($1::uuid[]))
          )::text as remaining;
          `,
          [companyIds]
        );
        const remaining = Number(remRes.rows[0]?.remaining ?? -1);
        await client.query('COMMIT');
        await check('P5: Cleanup removes all test data (remaining = 0)', remaining === 0, `remaining=${remaining}`);
        console.log('[cleanup] Test company, register, vouchers, and custodies purged cleanly (remaining=0).');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          console.error('[cleanup] Rollback error:', rbErr);
        }
        console.error('[cleanup] Failed cleaning up verifyCashPeriodReport1:', cleanupErr);
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
  console.error('[verifyCashPeriodReport1] Fatal error:', err);
  process.exit(1);
});
