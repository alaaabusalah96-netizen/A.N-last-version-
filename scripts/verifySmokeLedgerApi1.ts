import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Server } from 'http';
import pg from 'pg';
import { check, blocked, summary, CookieJarFetch, loginAs, resetLoopbackRateLimits } from './lib/testkit.js';
import { createApp } from '../src/server/app.js';
import { defaultUserRepository } from '../src/server/auth/userRepository.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { DEFAULT_ARABIC_COA } from '../src/server/accounting/accountService.js';

console.log('=== VERIFYING AN-BOOT-FIRST-RUN-1: LEDGER API FIRST-RUN SMOKE ===\n');

function isLoopbackDbUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

async function runSmoke() {
  const rootDir = process.cwd();

  // ==========================================
  // Section 1: Static API Contract Verification
  // ==========================================
  const companyRoutesSrc = fs.readFileSync(path.join(rootDir, 'src/server/routes/companyRoutes.ts'), 'utf8');
  const accountingRoutesSrc = fs.readFileSync(path.join(rootDir, 'src/server/routes/accountingRoutes.ts'), 'utf8');

  await check(
    'S1: companyRoutes mounts authenticated platform_admin POST /api/companies',
    companyRoutesSrc.includes("requirePlatformAdmin") && companyRoutesSrc.includes("createCompanyWithAdmin")
  );

  await check(
    'S2: accountingRoutes mounts periods, seed-default, journals, post, trial-balance, and financial reports',
    accountingRoutesSrc.includes("'/periods'") &&
      accountingRoutesSrc.includes("'/accounts/seed-default'") &&
      accountingRoutesSrc.includes("'/journals'") &&
      accountingRoutesSrc.includes("'/journals/:id/post'") &&
      accountingRoutesSrc.includes("'/trial-balance'") &&
      accountingRoutesSrc.includes("'/reports/balance-sheet'") &&
      accountingRoutesSrc.includes("'/reports/income-statement'")
  );

  const hasCashCoa = DEFAULT_ARABIC_COA.some((a) => a.code === '1100' && a.isPostable);
  const hasCapitalCoa = DEFAULT_ARABIC_COA.some((a) => a.code === '3100' && a.isPostable);
  await check('S3: DEFAULT_ARABIC_COA provides postable Cash (1100) and Capital (3100) accounts', hasCashCoa && hasCapitalCoa);

  await check(
    'S4: Loopback database host guard rejects remote hosts',
    isLoopbackDbUrl('postgresql://an_app:pass@127.0.0.1:5432/an_foundation') &&
      !isLoopbackDbUrl('postgresql://postgres:pass@db.example.supabase.co:5432/postgres')
  );

  // ==========================================
  // Section 2: Live Loopback HTTP + DB Smoke Flow
  // ==========================================
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('Live Ledger API smoke skipped — DATABASE_URL not configured');
    const { exitCode } = summary();
    process.exit(exitCode);
  }

  if (!isLoopbackDbUrl(dbUrl)) {
    console.error('[verifySmokeLedgerApi1] FATAL: Refusing to execute mutating smoke test against non-loopback DATABASE_URL.');
    process.exit(1);
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Live Ledger API smoke skipped — executor unavailable');
    const { exitCode } = summary();
    process.exit(exitCode);
  }

  const app = createApp();
  let server: Server | undefined;
  let baseUrl = '';
  const createdCompanyIds: string[] = [];
  const createdUserIds: string[] = [];

  await new Promise<void>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const addr = s.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
    server = s;
  });

  try {
    const suffix = Date.now();
    const adminUsername = `smoke_ledger_admin_${suffix}@erp.local`;
    const adminPass = 'SmokeLedgerAdmin123!';
    const passwordHash = await hashPassword(adminPass);

    const adminUser = await defaultUserRepository.createUser({
      username: adminUsername,
      passwordHash,
      role: 'platform_admin',
    });
    createdUserIds.push(adminUser.id);

    await resetLoopbackRateLimits(executor, [`user:${adminUsername.toLowerCase()}`]);

    // Step 1: Login via /api/auth/csrf + /api/auth/login
    const jar = new CookieJarFetch();
    const { csrfToken } = await loginAs(jar, baseUrl, adminUsername, adminPass);
    await check('T1: Platform admin authenticated with CSRF rotation', Boolean(csrfToken));

    // Step 2: Create company via POST /api/companies
    const compRes = await jar.fetch(`${baseUrl}/api/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({
        code: `SMK_${suffix}`,
        nameAr: `شركة دخان التشغيل الأول ${suffix}`,
        nameEn: `First Run Smoke ${suffix}`,
      }),
    });
    const compData = await compRes.json();
    const companyId = compData.company?.id;
    if (companyId) createdCompanyIds.push(companyId);

    await check(
      'T2: POST /api/companies creates isolated test company',
      compRes.status === 201 && Boolean(companyId)
    );

    if (!companyId) {
      throw new Error(`Company creation failed with status ${compRes.status}: ${JSON.stringify(compData)}`);
    }

    // Step 3: Create open accounting period covering current UTC month
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = String(new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate()).padStart(2, '0');
    const startDate = `${year}-${month}-01`;
    const endDate = `${year}-${month}-${lastDay}`;
    const entryDate = `${year}-${month}-15`;

    const periodRes = await jar.fetch(`${baseUrl}/api/accounting/periods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({
        companyId,
        code: `${year}-${month}`,
        startDate,
        endDate,
      }),
    });
    const periodData = await periodRes.json();
    await check(
      'T3: POST /api/accounting/periods opens accounting period for smoke entry date',
      periodRes.status === 201 && periodData.period?.isClosed === false
    );

    // Step 4: Seed default COA via POST /api/accounting/accounts/seed-default
    const seedRes = await jar.fetch(`${baseUrl}/api/accounting/accounts/seed-default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ companyId }),
    });
    const seedData = await seedRes.json();
    const accounts: any[] = seedData.accounts || [];
    const cashAcc = accounts.find((a) => a.code === '1100' && a.isPostable);
    const capitalAcc = accounts.find((a) => a.code === '3100' && a.isPostable);

    await check(
      'T4: POST /api/accounting/accounts/seed-default creates required postable accounts',
      seedRes.status === 200 && Boolean(cashAcc?.id) && Boolean(capitalAcc?.id)
    );

    // Step 5: Create balanced draft journal entry via POST /api/accounting/journals
    const journalRes = await jar.fetch(`${baseUrl}/api/accounting/journals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({
        companyId,
        entryDate,
        memo: 'First-run ledger smoke capital injection',
        lines: [
          { accountId: cashAcc.id, debit: 1500, credit: 0, memo: 'Cash debit' },
          { accountId: capitalAcc.id, debit: 0, credit: 1500, memo: 'Capital credit' },
        ],
      }),
    });
    const journalData = await journalRes.json();
    const journalId = journalData.journal?.id;
    await check(
      'T5: POST /api/accounting/journals creates balanced draft journal entry',
      journalRes.status === 201 && journalData.journal?.status === 'draft' && Boolean(journalId)
    );

    // Step 6: Post journal entry via POST /api/accounting/journals/:id/post
    const postRes = await jar.fetch(`${baseUrl}/api/accounting/journals/${journalId}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ companyId }),
    });
    const postData = await postRes.json();
    await check(
      'T6: POST /api/accounting/journals/:id/post transitions entry to posted with sequence number',
      postRes.status === 200 && postData.journal?.status === 'posted' && Boolean(postData.journal?.entryNo)
    );

    // Step 7: Read Trial Balance & Financial Statements
    const tbRes = await jar.fetch(`${baseUrl}/api/accounting/trial-balance?companyId=${companyId}`);
    const tbData = await tbRes.json();

    const bsRes = await jar.fetch(`${baseUrl}/api/accounting/reports/balance-sheet?companyId=${companyId}`);
    const bsData = await bsRes.json();

    const isRes = await jar.fetch(`${baseUrl}/api/accounting/reports/income-statement?companyId=${companyId}`);
    const isData = await isRes.json();

    await check(
      'T7: Trial balance & financial statements reflect posted 1500.00 balanced entry',
      tbRes.status === 200 &&
        tbData.summary?.isBalanced === true &&
        Number(tbData.summary?.grandTotalDebit) === 1500 &&
        Number(tbData.summary?.grandTotalCredit) === 1500 &&
        bsRes.status === 200 &&
        bsData.report?.isBalanced === true &&
        bsData.report?.totalAssets === '1500.00' &&
        isRes.status === 200
    );
  } finally {
    if (server) {
      server.close();
    }

    const migUrl = process.env.MIGRATION_DATABASE_URL;
    if (migUrl && isLoopbackDbUrl(migUrl) && (createdCompanyIds.length > 0 || createdUserIds.length > 0)) {
      const client = new pg.Client(buildPgConfig(migUrl, process.env));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines DISABLE TRIGGER trg_journal_lines_immutability');

        if (createdCompanyIds.length > 0) {
          await client.query('DELETE FROM journal_lines WHERE company_id = ANY($1::uuid[])', [createdCompanyIds]);
          await client.query('DELETE FROM journal_entries WHERE company_id = ANY($1::uuid[])', [createdCompanyIds]);
          await client.query('DELETE FROM accounting_periods WHERE company_id = ANY($1::uuid[])', [createdCompanyIds]);
          await client.query('DELETE FROM accounting_sequences WHERE company_id = ANY($1::uuid[])', [createdCompanyIds]);
          await client.query('DELETE FROM accounts WHERE company_id = ANY($1::uuid[])', [createdCompanyIds]);
          await client.query('DELETE FROM company_memberships WHERE company_id = ANY($1::uuid[])', [createdCompanyIds]);
          await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [createdCompanyIds]);
          await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [createdCompanyIds]);
        }
        if (createdUserIds.length > 0) {
          await client.query('DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])', [createdUserIds]);
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [createdUserIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [createdUserIds]);
        }

        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        await client.query('COMMIT');
        console.log('[verifySmokeLedgerApi1] Cleaned up smoke company and user test data.');
      } catch (cleanupErr) {
        await client.query('ROLLBACK').catch(() => {});
        console.warn('[verifySmokeLedgerApi1] Cleanup warning:', cleanupErr);
      } finally {
        await client.end().catch(() => {});
      }
    } else if (createdUserIds.length > 0) {
      await executor.query('DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])', [createdUserIds]).catch(() => {});
    }

    await closeAllExecutors();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runSmoke().catch(async (err) => {
  console.error('[verifySmokeLedgerApi1] Unhandled error:', err);
  await closeAllExecutors().catch(() => {});
  process.exit(1);
});
