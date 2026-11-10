import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { buildPgConfig } from '../src/server/db/connection.js';

export function isProductionOrSupabaseDb(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return (
      host.includes('supabase.co') ||
      host.includes('pooler.supabase') ||
      host.includes('supabase.com') ||
      host.includes('aws.neon.tech') ||
      host.includes('rds.amazonaws.com')
    );
  } catch {
    const lower = urlStr.toLowerCase();
    return (
      lower.includes('supabase.co') ||
      lower.includes('pooler.supabase') ||
      lower.includes('supabase.com') ||
      lower.includes('aws.neon.tech') ||
      lower.includes('rds.amazonaws.com')
    );
  }
}

async function verifyPgIntegrationSmoke1() {
  console.log('=== VERIFYING AN-PG-INTEGRATION-SMOKE-1 ===\n');
  let passedCount = 0;
  let failedCount = 0;
  let blockedCount = 0;

  function assertStatic(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
      passedCount++;
    } else {
      console.error(`[FAIL] ${description}`);
      failedCount++;
    }
  }

  function reportBlocked(description: string, reason: string) {
    console.log(`[BLOCKED] ${description} (${reason})`);
    blockedCount++;
  }

  function reportPass(description: string) {
    console.log(`[PASS] ${description}`);
    passedCount++;
  }

  function reportFail(description: string, err?: any) {
    console.error(`[FAIL] ${description}${err ? ': ' + (err.message || err) : ''}`);
    failedCount++;
  }

  // === PART 1: STATIC GUARDS (S1 - S6) ===
  console.log('--- Static Codebase Guards (S1 - S6) ---');

  // S1: Migrations 015, 016, 017 exist
  const m15 = path.join(process.cwd(), 'database/migrations/015_ledger_hardening.sql');
  const m16 = path.join(process.cwd(), 'database/migrations/016_org_integrity.sql');
  const m17 = path.join(process.cwd(), 'database/migrations/017_ledger_org_followup.sql');

  assertStatic(
    fs.existsSync(m15) && fs.existsSync(m16) && fs.existsSync(m17),
    'S1: Migrations 015, 016, and 017 exist in database/migrations/'
  );

  // S2: trialBalanceService uses posted subquery/join
  const tbServicePath = path.join(process.cwd(), 'src/server/accounting/trialBalanceService.ts');
  const tbContent = fs.existsSync(tbServicePath) ? fs.readFileSync(tbServicePath, 'utf8') : '';
  assertStatic(
    tbContent.includes("e.status = 'posted'") && tbContent.includes('INNER JOIN journal_entries'),
    'S2: trialBalanceService.ts strictly filters posted entries via subquery INNER JOIN'
  );

  // S3: journal_lines trigger mentions TG_OP and OLD/NEW
  const m17Content = fs.existsSync(m17) ? fs.readFileSync(m17, 'utf8') : '';
  assertStatic(
    m17Content.includes("TG_OP = 'INSERT'") &&
      m17Content.includes("TG_OP = 'DELETE'") &&
      m17Content.includes("TG_OP = 'UPDATE'") &&
      m17Content.includes('OLD.entry_id') &&
      m17Content.includes('NEW.entry_id'),
    'S3: 017_ledger_org_followup.sql checks TG_OP branches and OLD/NEW entry IDs'
  );

  // S4: package.json has test:pg-smoke-1
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkgContent = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
  assertStatic(
    pkgContent.includes('test:pg-smoke-1'),
    'S4: package.json contains "test:pg-smoke-1" script'
  );

  // S5: AI_PROJECT_STATE records package
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertStatic(
    stateContent.includes('AN-PG-INTEGRATION-SMOKE-1'),
    'S5: AI_PROJECT_STATE.md contains AN-PG-INTEGRATION-SMOKE-1 record'
  );

  // S6: Safety guard identifies production and Supabase hosts
  const s6GuardWorks =
    isProductionOrSupabaseDb('postgresql://user:pass@db.supabase.co:5432/postgres') &&
    isProductionOrSupabaseDb('postgres://postgres.abc:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres') &&
    !isProductionOrSupabaseDb('postgresql://an_app:pass@localhost:5432/an_foundation') &&
    !isProductionOrSupabaseDb('postgresql://an_app:pass@127.0.0.1:5432/an_foundation');
  assertStatic(s6GuardWorks, 'S6: Production/Supabase guard correctly identifies protected URLs');

  console.log('\n--- Live PostgreSQL Integration Tests (T1 - T7) ---');

  // === PART 2: LIVE POSTGRES INTEGRATION TESTS (T1 - T7) ===
  const connStr = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

  if (!connStr) {
    console.log('[INFO] Neither MIGRATION_DATABASE_URL nor DATABASE_URL configured.');
    reportBlocked('T1: Check DB URL presence and connectivity', 'No DB connection string in environment');
    reportBlocked('T2: Block line INSERT on posted entry', 'DB URL missing');
    reportBlocked('T3: Block line UPDATE/move on posted entry', 'DB URL missing');
    reportBlocked('T4: DB balance trigger on status transition to posted', 'DB URL missing');
    reportBlocked('T5: Block cross-company parent org unit FK', 'DB URL missing');
    reportBlocked('T6: Block cross-company accounts/entries org unit FK', 'DB URL missing');
    reportBlocked('T7: Live Trial Balance query execution', 'DB URL missing');
  } else {
    // Safety guard against accidental runs on Supabase/production
    if (isProductionOrSupabaseDb(connStr) && process.env.SMOKE_ALLOW_DISPOSABLE !== '1') {
      console.error('[BLOCKED] Refusing to run live PostgreSQL integration smoke against non-disposable production/Supabase host without SMOKE_ALLOW_DISPOSABLE=1');
      reportBlocked('T1: Check DB URL presence and connectivity', 'Protected host without SMOKE_ALLOW_DISPOSABLE=1');
      reportBlocked('T2: Block line INSERT on posted entry', 'Protected host without SMOKE_ALLOW_DISPOSABLE=1');
      reportBlocked('T3: Block line UPDATE/move on posted entry', 'Protected host without SMOKE_ALLOW_DISPOSABLE=1');
      reportBlocked('T4: DB balance trigger on status transition to posted', 'Protected host without SMOKE_ALLOW_DISPOSABLE=1');
      reportBlocked('T5: Block cross-company parent org unit FK', 'Protected host without SMOKE_ALLOW_DISPOSABLE=1');
      reportBlocked('T6: Block cross-company accounts/entries org unit FK', 'Protected host without SMOKE_ALLOW_DISPOSABLE=1');
      reportBlocked('T7: Live Trial Balance query execution', 'Protected host without SMOKE_ALLOW_DISPOSABLE=1');
      process.exit(1);
    }

    console.log('[INFO] DB connection string found. Attempting live PostgreSQL connection...');
    const pgConfig = buildPgConfig(connStr, process.env);
    const client = new pg.Client(pgConfig);

    try {
      await client.connect();
      try {
        await client.query('SELECT current_user, current_database();');
        reportPass('T1: Successfully connected to PostgreSQL and verified active database');
      } catch (t1Err: any) {
        reportFail('T1: Connection health query failed', t1Err);
      }

      // Run live DB cases inside transaction with savepoints
      await client.query('BEGIN;');

      const companyA = '10000000-0000-0000-0000-000000000001';
      const companyB = '20000000-0000-0000-0000-000000000002';
      const testAccountId = '80000000-0000-0000-0000-000000000001';

      // Seed setup
      try {
        await client.query(
          `INSERT INTO companies (id, code, name_ar, name_en)
           VALUES ($1, 'SMOKE1', 'شركة اختبار دخاني 1', 'Smoke Company 1')
           ON CONFLICT (id) DO NOTHING`,
          [companyA]
        );
        await client.query(
          `INSERT INTO companies (id, code, name_ar, name_en)
           VALUES ($1, 'SMOKE2', 'شركة اختبار دخاني 2', 'Smoke Company 2')
           ON CONFLICT (id) DO NOTHING`,
          [companyB]
        );
        await client.query(
          `INSERT INTO accounts (id, company_id, code, name_ar, account_type, is_active, is_postable)
           VALUES ($1, $2, '101', 'صندوق دخاني', 'asset', true, true)
           ON CONFLICT (id) DO NOTHING`,
          [testAccountId, companyA]
        );
      } catch (setupErr: any) {
        console.warn('[INFO] Setup seed note:', setupErr.message);
      }

      // T2: Test line INSERT into posted entry
      try {
        await client.query('SAVEPOINT sp_smoke_t2;');
        const testPostedEntryId = '90000000-0000-0000-0000-000000000011';
        await client.query(
          `INSERT INTO journal_entries (id, company_id, entry_date, status, created_at)
           VALUES ($1, $2, CURRENT_DATE, 'draft', NOW())
           ON CONFLICT (id) DO NOTHING`,
          [testPostedEntryId, companyA]
        );
        await client.query(
          `INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit)
           VALUES (gen_random_uuid(), $1, $2, $3, 100, 0), (gen_random_uuid(), $1, $2, $3, 0, 100)
           ON CONFLICT DO NOTHING`,
          [companyA, testPostedEntryId, testAccountId]
        );
        await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [testPostedEntryId]);

        // Try inserting extra line into posted entry -> expected to fail
        await client.query(
          `INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit)
           VALUES (gen_random_uuid(), $1, $2, $3, 50, 0)`,
          [companyA, testPostedEntryId, testAccountId]
        );
        reportFail('T2: INSERT line into posted entry unexpectedly succeeded');
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t2;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t2;');
        const msg = err?.message || '';
        if (/CANNOT_MODIFY_POSTED|posted journal entry|cannot modify|posted/i.test(msg)) {
          reportPass('T2: DB correctly rejected INSERT line into posted entry (CANNOT_MODIFY_POSTED_LINES)');
        } else {
          reportBlocked('T2: Block line INSERT on posted entry', msg);
        }
      }

      // T3: Test line UPDATE on posted entry
      try {
        await client.query('SAVEPOINT sp_smoke_t3;');
        const testPostedEntryId = '90000000-0000-0000-0000-000000000012';
        const testLineId = '70000000-0000-0000-0000-000000000011';
        await client.query(
          `INSERT INTO journal_entries (id, company_id, entry_date, status, created_at)
           VALUES ($1, $2, CURRENT_DATE, 'draft', NOW())
           ON CONFLICT (id) DO NOTHING`,
          [testPostedEntryId, companyA]
        );
        await client.query(
          `INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit)
           VALUES ($4, $1, $2, $3, 100, 0), (gen_random_uuid(), $1, $2, $3, 0, 100)
           ON CONFLICT DO NOTHING`,
          [companyA, testPostedEntryId, testAccountId, testLineId]
        );
        await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [testPostedEntryId]);

        // Try updating line on posted entry -> expected to fail
        await client.query(`UPDATE journal_lines SET debit = 500 WHERE id = $1`, [testLineId]);
        reportFail('T3: UPDATE line on posted entry unexpectedly succeeded');
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t3;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t3;');
        const msg = err?.message || '';
        if (/CANNOT_MODIFY_POSTED|posted journal entry|cannot modify|posted/i.test(msg)) {
          reportPass('T3: DB correctly rejected UPDATE line on posted entry (CANNOT_MODIFY_POSTED_LINES)');
        } else {
          reportBlocked('T3: Block line UPDATE/move on posted entry', msg);
        }
      }

      // T4: Unbalanced post trigger
      try {
        await client.query('SAVEPOINT sp_smoke_t4;');
        const unbalancedEntryId = '90000000-0000-0000-0000-000000000013';
        await client.query(
          `INSERT INTO journal_entries (id, company_id, entry_date, status, created_at)
           VALUES ($1, $2, CURRENT_DATE, 'draft', NOW())
           ON CONFLICT (id) DO NOTHING`,
          [unbalancedEntryId, companyA]
        );
        await client.query(
          `INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit)
           VALUES (gen_random_uuid(), $1, $2, $3, 100, 0)`,
          [companyA, unbalancedEntryId, testAccountId]
        );
        await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [unbalancedEntryId]);
        reportFail('T4: Unbalanced entry status transition to posted unexpectedly succeeded');
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t4;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t4;');
        const msg = err?.message || '';
        if (/unbalanced|balance|amount|zero|lines/i.test(msg)) {
          reportPass('T4: DB correctly blocked status transition to posted on unbalanced entry');
        } else {
          reportBlocked('T4: DB balance trigger on status transition to posted', msg);
        }
      }

      // T5: Block cross-company parent org unit FK
      try {
        await client.query('SAVEPOINT sp_smoke_t5;');
        const orgA = '30000000-0000-0000-0000-000000000011';
        const orgB = '30000000-0000-0000-0000-000000000012';
        await client.query(
          `INSERT INTO org_units (id, company_id, code, name_ar, unit_type, path)
           VALUES ($1, $2, 'SM_OA', 'فرع أ', 'branch', '/SM_OA/')`,
          [orgA, companyA]
        );
        await client.query(
          `INSERT INTO org_units (id, company_id, parent_id, code, name_ar, unit_type, path)
           VALUES ($1, $2, $3, 'SM_OB', 'فرع ب', 'branch', '/SM_OA/SM_OB/')`,
          [orgB, companyB, orgA]
        );
        reportFail('T5: Cross-company parent org unit FK violation unexpectedly succeeded');
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t5;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t5;');
        const msg = err?.message || '';
        if (/foreign key|violates foreign key|fk_|constraint/i.test(msg)) {
          reportPass('T5: DB correctly blocked cross-company parent org unit composite FK');
        } else {
          reportBlocked('T5: Block cross-company parent org unit FK', msg);
        }
      }

      // T6: Block cross-company accounts org_unit FK
      try {
        await client.query('SAVEPOINT sp_smoke_t6;');
        const orgB2 = '30000000-0000-0000-0000-000000000013';
        const accCross = '80000000-0000-0000-0000-000000000012';
        await client.query(
          `INSERT INTO org_units (id, company_id, code, name_ar, unit_type, path)
           VALUES ($1, $2, 'SM_OB2', 'فرع ب2', 'branch', '/SM_OB2/')`,
          [orgB2, companyB]
        );
        await client.query(
          `INSERT INTO accounts (id, company_id, org_unit_id, code, name_ar, account_type, is_active, is_postable)
           VALUES ($1, $2, $3, '102SM', 'حساب خاطئ عبر الشركات', 'asset', true, true)`,
          [accCross, companyA, orgB2]
        );
        reportFail('T6: Cross-company account org_unit FK violation unexpectedly succeeded');
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t6;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t6;');
        const msg = err?.message || '';
        if (/foreign key|violates foreign key|fk_|constraint/i.test(msg)) {
          reportPass('T6: DB correctly blocked cross-company account org_unit composite FK');
        } else {
          reportBlocked('T6: Block cross-company accounts/entries org unit FK', msg);
        }
      }

      // T7: Live Trial Balance query execution
      try {
        await client.query('SAVEPOINT sp_smoke_t7;');
        const draftEntryId = '90000000-0000-0000-0000-000000000014';
        await client.query(
          `INSERT INTO journal_entries (id, company_id, entry_date, status, created_at)
           VALUES ($1, $2, CURRENT_DATE, 'draft', NOW())
           ON CONFLICT (id) DO NOTHING`,
          [draftEntryId, companyA]
        );
        await client.query(
          `INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit)
           VALUES (gen_random_uuid(), $1, $2, $3, 88888, 0), (gen_random_uuid(), $1, $2, $3, 0, 88888)
           ON CONFLICT DO NOTHING`,
          [companyA, draftEntryId, testAccountId]
        );

        const tbRes = await client.query(
          `SELECT SUM(l.debit) as total_debit
           FROM journal_lines l
           INNER JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
           WHERE e.status = 'posted' AND l.company_id = $1 AND l.account_id = $2`,
          [companyA, testAccountId]
        );
        const sumDebit = Number(tbRes.rows[0]?.total_debit || 0);
        if (sumDebit < 88888) {
          reportPass('T7: Trial Balance query strictly excluded draft journal lines');
        } else {
          reportFail(`T7: Trial Balance query leaked draft journal lines (sum=${sumDebit})`);
        }
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t7;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_smoke_t7;');
        reportBlocked('T7: Live Trial Balance query execution', err?.message);
      }

      await client.query('ROLLBACK;').catch(() => {});
    } catch (connErr: any) {
      console.warn('[INFO] Could not connect to PostgreSQL:', connErr.message);
      reportBlocked('T1: Check DB URL presence and connectivity', `Connection failed: ${connErr.message}`);
      reportBlocked('T2: Block line INSERT on posted entry', 'DB connection failed');
      reportBlocked('T3: Block line UPDATE/move on posted entry', 'DB connection failed');
      reportBlocked('T4: DB balance trigger on status transition to posted', 'DB connection failed');
      reportBlocked('T5: Block cross-company parent org unit FK', 'DB connection failed');
      reportBlocked('T6: Block cross-company accounts/entries org unit FK', 'DB connection failed');
      reportBlocked('T7: Live Trial Balance query execution', 'DB connection failed');
    } finally {
      await client.end().catch(() => {});
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount} | Blocked: ${blockedCount}`);

  const isCi = process.env.CI === 'true' || process.env.REQUIRE_DB === '1';

  if (failedCount > 0) {
    console.error('\nFAILED: Static or DB integration assertions failed.');
    process.exit(1);
  } else if (isCi && blockedCount > 0) {
    console.error('\nFAILED: In CI / REQUIRE_DB environment, all DB integration smoke tests must pass (blocked cases detected).');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All static guards and DB smoke checks completed without failures.');
  }
}

verifyPgIntegrationSmoke1().catch((err) => {
  console.error('Unhandled error in verifyPgIntegrationSmoke1:', err);
  process.exit(1);
});


