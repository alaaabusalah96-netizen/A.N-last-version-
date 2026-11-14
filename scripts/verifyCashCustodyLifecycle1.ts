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
import { defaultCustodyService } from '../src/server/cash/custodyService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-CASH-CUSTODY-LIFECYCLE-21 (Custody Full Lifecycle)   ===');
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
    blocked('DATABASE_URL is not set. Live DB checks L1..L17 are BLOCKED.');
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
    blocked('Unable to connect to database executor. Live DB checks L1..L17 are BLOCKED.');
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

    const requesterA = await userRepo.createUser({
      username: `cus_req_a_${unique}`,
      passwordHash: 'dummy_custody_hash_21',
      role: 'user',
    });
    const approverA = await userRepo.createUser({
      username: `cus_app_a_${unique}`,
      passwordHash: 'dummy_custody_hash_21',
      role: 'user',
    });
    const revokedUserA = await userRepo.createUser({
      username: `cus_rev_a_${unique}`,
      passwordHash: 'dummy_custody_hash_21',
      role: 'user',
    });
    const userB = await userRepo.createUser({
      username: `cus_usr_b_${unique}`,
      passwordHash: 'dummy_custody_hash_21',
      role: 'user',
    });
    userIds.push(requesterA.id, approverA.id, revokedUserA.id, userB.id);

    const compA = await companyRepo.create({
      code: `CUSA-${unique}`.slice(0, 20),
      nameAr: `شركة العهد أ ${unique}`,
      createdBy: requesterA.id,
    });
    const compB = await companyRepo.create({
      code: `CUSB-${unique}`.slice(0, 20),
      nameAr: `شركة العهد ب ${unique}`,
      createdBy: userB.id,
    });
    companyIds.push(compA.id, compB.id);

    await defaultMembershipStore.addMember(requesterA.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(approverA.id, compA.id, 'company_admin', true);
    const revokedMembership = await defaultMembershipStore.addMember(revokedUserA.id, compA.id, 'company_user', true);
    await defaultMembershipStore.setStatusById(revokedMembership.id, compA.id, false, revokedUserA.id);
    await defaultMembershipStore.addMember(userB.id, compB.id, 'company_admin', true);

    const { accounts: accountsA } = await accountService.seedDefaultCoa(compA.id);
    await accountService.seedDefaultCoa(compB.id);

    const headerAssetA = accountsA.find((a) => a.code === '1000')!;
    const cashAccountA = accountsA.find((a) => a.code === '1100')!;
    const liabilityAccountA = accountsA.find((a) => a.code === '2100')!;
    const expenseAccountA = accountsA.find((a) => a.code === '5100')!;

    const secondCashAccountA = await accountService.createAccount(compA.id, {
      code: '1150',
      nameAr: 'صندوق مصروفات نثرية صغير',
      accountType: 'asset',
      parentId: headerAssetA.id,
      isPostable: true,
    });
    const custodyReceivableA = await accountService.createAccount(compA.id, {
      code: '1250',
      nameAr: 'ذمة عهد الموظفين',
      accountType: 'asset',
      parentId: headerAssetA.id,
      isPostable: true,
    });

    // Open accounting period covering today
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();
    const openPeriodA = await periodService.createPeriod(
      compA.id,
      {
        code: `${year}-${month}`,
        startDate: `${year}-${month}-01`,
        endDate: `${year}-${month}-${String(lastDay).padStart(2, '0')}`,
      },
      requesterA.id
    );

    const mainRegister = await defaultCashRegisterService.createRegister(
      compA.id,
      {
        code: `REG-MAIN-${unique}`.slice(0, 30),
        nameAr: 'الخزينة الرئيسية',
        glAccountId: cashAccountA.id,
        openingBalance: 5000,
      },
      requesterA.id
    );

    const smallRegister = await defaultCashRegisterService.createRegister(
      compA.id,
      {
        code: `REG-SM-${unique}`.slice(0, 30),
        nameAr: 'صندوق صغير',
        glAccountId: secondCashAccountA.id,
        openingBalance: 50,
      },
      requesterA.id
    );

    // L11: Missing custody_receivable_account_id -> clear Arabic ValidationError
    await defaultCompanySettingsService.upsertSettings(requesterA.id, compA.id, {
      custodyReceivableAccountId: null,
    });

    const missingGlCustody = await defaultCustodyService.requestCustody(
      compA.id,
      {
        employeeUserId: requesterA.id,
        registerId: mainRegister.id,
        amount: 200,
        purpose: 'اختبار التحقق من غياب حساب ذمة العهد',
      },
      requesterA.id
    );
    await defaultCustodyService.approveCustody(compA.id, missingGlCustody.id, approverA.id, false);
    let l11Rejected = false;
    try {
      await defaultCustodyService.disburseCustody(compA.id, missingGlCustody.id, approverA.id, false);
    } catch (err) {
      if (err instanceof ValidationError && err.message.includes('ذمة عهد الموظفين')) {
        l11Rejected = true;
      }
    }
    await check('L11: Missing custody_receivable_account_id raises clear Arabic ValidationError pointing to Settings', l11Rejected);

    // Configure custody receivable account in company_settings
    await defaultCompanySettingsService.upsertSettings(requesterA.id, compA.id, {
      custodyReceivableAccountId: custodyReceivableA.id,
    });

    // L1: requestCustody -> status='pending' and non-empty custodyNo
    const custody = await defaultCustodyService.requestCustody(
      compA.id,
      {
        employeeUserId: requesterA.id,
        registerId: mainRegister.id,
        amount: 1000,
        purpose: 'شراء مستلزمات مكتبية وتشغيلية',
      },
      requesterA.id
    );
    const l1Ok = custody.status === 'pending' && Boolean(custody.custodyNo && custody.custodyNo.startsWith('CUS-'));
    await check('L1: requestCustody creates custody with status=pending and sequential custodyNo', l1Ok);

    // L13: Same requester approving without platform_admin -> ForbiddenError
    let l13Rejected = false;
    try {
      await defaultCustodyService.approveCustody(compA.id, custody.id, requesterA.id, false);
    } catch (err) {
      if (err instanceof ForbiddenError) l13Rejected = true;
    }
    await check('L13: Approving own request without platform_admin throws ForbiddenError (SoD)', l13Rejected);

    // L2: approveCustody -> 'approved' and 0 movements, disburse_journal_entry_id IS NULL
    const approvedCustody = await defaultCustodyService.approveCustody(compA.id, custody.id, approverA.id, false);
    const movementsAfterApprove = await defaultCustodyService.listCustodyMovements(compA.id, custody.id);
    const l2Ok =
      approvedCustody.status === 'approved' &&
      approvedCustody.disburseJournalEntryId === null &&
      movementsAfterApprove.length === 0;
    await check('L2: approveCustody moves to approved with 0 custody_movements and NULL journal entry', l2Ok);

    // L3: disburseCustody -> 'open' + out movement + posted balanced JE (Dr Custody Receivable, Cr Register Cash)
    const disbursedCustody = await defaultCustodyService.disburseCustody(compA.id, custody.id, approverA.id, false);
    const movementsAfterDisburse = await defaultCustodyService.listCustodyMovements(compA.id, custody.id);
    const disburseJe = disbursedCustody.disburseJournalEntryId
      ? await defaultJournalRepository.findById(compA.id, disbursedCustody.disburseJournalEntryId)
      : null;
    const l3Ok =
      disbursedCustody.status === 'open' &&
      movementsAfterDisburse.length === 1 &&
      movementsAfterDisburse[0].movementType === 'disburse' &&
      movementsAfterDisburse[0].direction === 'out' &&
      movementsAfterDisburse[0].amount === 1000 &&
      disburseJe !== null &&
      disburseJe.status === 'posted' &&
      disburseJe.lines?.some((l) => l.accountId === custodyReceivableA.id && l.debit === 1000 && l.credit === 0) === true &&
      disburseJe.lines?.some((l) => l.accountId === cashAccountA.id && l.credit === 1000 && l.debit === 0) === true;
    await check('L3: disburseCustody transitions to open, records out movement, and posts balanced GL entry', l3Ok);

    // L4: Duplicate disburse -> ValidationError
    let l4Rejected = false;
    try {
      await defaultCustodyService.disburseCustody(compA.id, custody.id, approverA.id, false);
    } catch (err) {
      if (err instanceof ValidationError) l4Rejected = true;
    }
    await check('L4: Duplicate disburseCustody throws ValidationError', l4Rejected);

    // L14: Settling onto a liability account -> ValidationError
    let l14Rejected = false;
    try {
      await defaultCustodyService.settleCustody(
        compA.id,
        custody.id,
        {
          lines: [{ expenseAccountId: liabilityAccountA.id, amount: 700 }],
          cashReturn: 300,
        },
        approverA.id,
        false
      );
    } catch (err) {
      if (err instanceof ValidationError) l14Rejected = true;
    }
    await check('L14: Settling custody onto a liability account throws ValidationError', l14Rejected);

    // L5: Invalid settlement sum (701 + 300 on 1000) -> ValidationError
    let l5Rejected = false;
    try {
      await defaultCustodyService.settleCustody(
        compA.id,
        custody.id,
        {
          lines: [{ expenseAccountId: expenseAccountA.id, amount: 701 }],
          cashReturn: 300,
        },
        approverA.id,
        false
      );
    } catch (err) {
      if (err instanceof ValidationError) l5Rejected = true;
    }
    await check('L5: Invalid settlement sum (701 + 300 on 1000) throws ValidationError', l5Rejected);

    // L6: Valid settlement (700 + 300 on 1000) -> 'settled' + posted balanced JE (Dr Exp 700, Dr Cash 300, Cr Custody 1000)
    const settledCustody = await defaultCustodyService.settleCustody(
      compA.id,
      custody.id,
      {
        lines: [{ expenseAccountId: expenseAccountA.id, amount: 700, memo: 'فواتير مكتبية' }],
        cashReturn: 300,
      },
      approverA.id,
      false
    );
    const movementsAfterSettle = await defaultCustodyService.listCustodyMovements(compA.id, custody.id);
    const settleJe = settledCustody.settleJournalEntryId
      ? await defaultJournalRepository.findById(compA.id, settledCustody.settleJournalEntryId)
      : null;
    const expenseMov = movementsAfterSettle.find((m) => m.movementType === 'settle_expense');
    const returnMov = movementsAfterSettle.find((m) => m.movementType === 'settle_return');
    const l6Ok =
      settledCustody.status === 'settled' &&
      settledCustody.settledExpenseTotal === 700 &&
      settledCustody.settledCashReturn === 300 &&
      expenseMov?.direction === 'none' &&
      expenseMov?.amount === 700 &&
      returnMov?.direction === 'in' &&
      returnMov?.amount === 300 &&
      settleJe !== null &&
      settleJe.status === 'posted' &&
      settleJe.lines?.some((l) => l.accountId === expenseAccountA.id && l.debit === 700) === true &&
      settleJe.lines?.some((l) => l.accountId === cashAccountA.id && l.debit === 300) === true &&
      settleJe.lines?.some((l) => l.accountId === custodyReceivableA.id && l.credit === 1000) === true;
    await check('L6: Valid settlement (700 + 300) settles custody, logs movements (none/in), and posts balanced GL entry', l6Ok);

    // L7: Duplicate settle -> ValidationError
    let l7Rejected = false;
    try {
      await defaultCustodyService.settleCustody(
        compA.id,
        custody.id,
        {
          lines: [{ expenseAccountId: expenseAccountA.id, amount: 700 }],
          cashReturn: 300,
        },
        approverA.id,
        false
      );
    } catch (err) {
      if (err instanceof ValidationError) l7Rejected = true;
    }
    await check('L7: Duplicate settleCustody throws ValidationError', l7Rejected);

    // L8: Cash register balance matches opening (5000) + 0 - 1000 + 300 = 4300
    const balanceAfterCycle = await defaultCashRegisterService.getBalance(compA.id, mainRegister.id);
    const l8Ok =
      balanceAfterCycle.openingBalance === 5000 &&
      balanceAfterCycle.totalOut === 1000 &&
      balanceAfterCycle.totalIn === 300 &&
      balanceAfterCycle.currentBalance === 4300;
    await check('L8: Register getBalance matches 5000 - 1000 + 300 = 4300 after disburse and settle', l8Ok);

    // L9: Cross-company isolation: getCustody(compB, custody.id) -> NotFoundError
    let l9Rejected = false;
    try {
      await defaultCustodyService.getCustody(compB.id, custody.id);
    } catch (err) {
      if (err instanceof NotFoundError) l9Rejected = true;
    }
    await check('L9: getCustody(companyB, custodyOfA) throws NotFoundError (company isolation)', l9Rejected);

    // L10: Insufficient register balance (balance 50, custody 100) -> ValidationError
    const insufficientCustody = await defaultCustodyService.requestCustody(
      compA.id,
      {
        employeeUserId: requesterA.id,
        registerId: smallRegister.id,
        amount: 100,
        purpose: 'اختبار رفض الرصيد غير الكافي',
      },
      requesterA.id
    );
    await defaultCustodyService.approveCustody(compA.id, insufficientCustody.id, approverA.id, false);
    let l10Rejected = false;
    try {
      await defaultCustodyService.disburseCustody(compA.id, insufficientCustody.id, approverA.id, false);
    } catch (err) {
      if (err instanceof ValidationError) l10Rejected = true;
    }
    await check('L10: Disbursing custody (100) from register with balance (50) throws ValidationError', l10Rejected);

    // L16: Enriched response contract check on getCustody & listCustodies
    const listedAllA = await defaultCustodyService.listCustodies(compA.id);
    const fetchedSettled = await defaultCustodyService.getCustody(compA.id, custody.id);
    const listedSettled = listedAllA.find((c) => c.id === custody.id);
    const l16Ok =
      Boolean(fetchedSettled.employeeUsername) &&
      Boolean(fetchedSettled.registerCode) &&
      Boolean(fetchedSettled.registerNameAr) &&
      Boolean(fetchedSettled.disburseJournalEntryNo) &&
      Boolean(fetchedSettled.settleJournalEntryNo) &&
      Boolean(listedSettled?.employeeUsername) &&
      Boolean(listedSettled?.registerCode) &&
      Boolean(listedSettled?.disburseJournalEntryNo) &&
      Boolean(listedSettled?.settleJournalEntryNo);
    await check('L16: getCustody and listCustodies return non-empty employeeUsername, registerCode, disburseJournalEntryNo, and settleJournalEntryNo', l16Ok);

    // L15: listEligibleEmployees(compA) excludes userB and revokedUserA
    const employeesA = await defaultCustodyService.listEligibleEmployees(compA.id);
    const empIdsA = employeesA.map((e) => e.userId);
    const l15Ok =
      empIdsA.includes(requesterA.id) &&
      empIdsA.includes(approverA.id) &&
      !empIdsA.includes(userB.id) &&
      !empIdsA.includes(revokedUserA.id);
    await check('L15: listEligibleEmployees excludes users from other companies and revoked memberships', l15Ok);

    // L17: List filters (status / employeeUserId / registerId) and company isolation
    const filteredSettled = await defaultCustodyService.listCustodies(compA.id, {
      status: 'settled',
      employeeUserId: requesterA.id,
      registerId: mainRegister.id,
    });
    const filteredSmallReg = await defaultCustodyService.listCustodies(compA.id, {
      registerId: smallRegister.id,
    });
    const listCompB = await defaultCustodyService.listCustodies(compB.id);
    const l17Ok =
      filteredSettled.length === 1 &&
      filteredSettled[0].id === custody.id &&
      filteredSmallReg.every((c) => c.registerId === smallRegister.id) &&
      listCompB.length === 0;
    await check('L17: listCustodies respects status/employeeUserId/registerId filters and isolates companies', l17Ok);

    // L12: Closed accounting period -> disburseCustody fails with ValidationError from postEntry
    const closedPeriodCustody = await defaultCustodyService.requestCustody(
      compA.id,
      {
        employeeUserId: requesterA.id,
        registerId: mainRegister.id,
        amount: 100,
        purpose: 'اختبار الفترة المحاسبية المغلقة',
      },
      requesterA.id
    );
    await defaultCustodyService.approveCustody(compA.id, closedPeriodCustody.id, approverA.id, false);
    await periodService.closePeriod(compA.id, openPeriodA.id, approverA.id);
    let l12Rejected = false;
    try {
      await defaultCustodyService.disburseCustody(compA.id, closedPeriodCustody.id, approverA.id, false);
    } catch (err) {
      if (err instanceof ValidationError) l12Rejected = true;
    }
    await check('L12: Disbursing custody in a closed accounting period throws ValidationError from JournalService.postEntry', l12Rejected);
  } catch (err) {
    await check('Cash & Custody Lifecycle verification unexpected error', false, err instanceof Error ? err.message : String(err));
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
        console.log('[cleanup] Test companies, journal entries, and custody lifecycle records purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('[cleanup] Failed cleaning up verifyCashCustodyLifecycle1:', cleanupErr);
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
  console.error('[verifyCashCustodyLifecycle1] Fatal error:', err);
  process.exit(1);
});
