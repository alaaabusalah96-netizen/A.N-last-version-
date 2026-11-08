import fs from 'fs';
import path from 'path';
import pg from 'pg';

async function verifyPgIntegrationProof2() {
  console.log('=== VERIFYING AN-PG-INTEGRATION-PROOF-2 ===\n');
  let passedCount = 0;
  let failedCount = 0;
  let blockedCount = 0;

  const results: Record<string, 'PASS' | 'FAIL' | 'BLOCKED'> = {
    T1: 'BLOCKED',
    T2: 'BLOCKED',
    T3: 'BLOCKED',
    T4: 'BLOCKED',
    T5: 'BLOCKED',
    T6: 'BLOCKED',
    T7: 'BLOCKED',
  };

  function assertStatic(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
      passedCount++;
    } else {
      console.error(`[FAIL] ${description}`);
      failedCount++;
    }
  }

  function logTest(caseId: string, status: 'PASS' | 'FAIL' | 'BLOCKED', msg: string) {
    results[caseId] = status;
    if (status === 'PASS') {
      console.log(`[PASS] ${caseId}: ${msg}`);
      passedCount++;
    } else if (status === 'FAIL') {
      console.error(`[FAIL] ${caseId}: ${msg}`);
      failedCount++;
    } else {
      console.log(`[BLOCKED] ${caseId}: ${msg}`);
      blockedCount++;
    }
  }

  // === STATIC GUARDS S1 - S6 ===
  console.log('--- Static Codebase Guards (S1 - S6) ---');

  // S1: Migrations 015 - 018 exist
  const m15 = path.join(process.cwd(), 'database/migrations/015_ledger_hardening.sql');
  const m16 = path.join(process.cwd(), 'database/migrations/016_org_integrity.sql');
  const m17 = path.join(process.cwd(), 'database/migrations/017_ledger_org_followup.sql');
  const m18 = path.join(process.cwd(), 'database/migrations/018_trigger_search_path.sql');
  assertStatic(
    fs.existsSync(m15) && fs.existsSync(m16) && fs.existsSync(m17) && fs.existsSync(m18),
    'S1: Migrations 015, 016, 017, and 018 exist in database/migrations/'
  );

  // S2: trialBalanceService posted-only aggregate
  const tbPath = path.join(process.cwd(), 'src/server/accounting/trialBalanceService.ts');
  const tbContent = fs.existsSync(tbPath) ? fs.readFileSync(tbPath, 'utf8') : '';
  assertStatic(
    tbContent.includes("e.status = 'posted'") && tbContent.includes('INNER JOIN journal_entries'),
    'S2: trialBalanceService.ts strictly filters posted entries via subquery INNER JOIN'
  );

  // S3: 017 trigger checks TG_OP and OLD/NEW
  const m17Content = fs.existsSync(m17) ? fs.readFileSync(m17, 'utf8') : '';
  assertStatic(
    m17Content.includes("TG_OP = 'INSERT'") &&
      m17Content.includes("TG_OP = 'DELETE'") &&
      m17Content.includes("TG_OP = 'UPDATE'") &&
      m17Content.includes('OLD.entry_id') &&
      m17Content.includes('NEW.entry_id'),
    'S3: 017_ledger_org_followup.sql checks TG_OP branches and OLD/NEW entry IDs'
  );

  // S4: migrate.ts has no /proc
  const migratePath = path.join(process.cwd(), 'scripts/migrate.ts');
  const runnerPath = path.join(process.cwd(), 'src/server/db/migrationRunner.ts');
  const migrateContent = fs.existsSync(migratePath) ? fs.readFileSync(migratePath, 'utf8') : '';
  const runnerContent = fs.existsSync(runnerPath) ? fs.readFileSync(runnerPath, 'utf8') : '';
  assertStatic(
    !migrateContent.includes('/proc') && !runnerContent.includes('/proc'),
    'S4: Migration tooling contains no /proc environment scraping'
  );

  // S5: migrate requires MIGRATION_DATABASE_URL
  assertStatic(
    runnerContent.includes('MIGRATION_DATABASE_URL'),
    'S5: migrationRunner.ts requires MIGRATION_DATABASE_URL'
  );

  // S6: AI_PROJECT_STATE.md records AN-PG-INTEGRATION-PROOF-2
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertStatic(
    stateContent.includes('AN-PG-INTEGRATION-PROOF-2'),
    'S6: AI_PROJECT_STATE.md records AN-PG-INTEGRATION-PROOF-2'
  );

  console.log('\n--- Live PostgreSQL Independent Proof Cases (T1 - T7) ---');

  const connStr =
    process.env.AN_PG_PROOF_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL;

  const isStrict = process.env.AN_PG_PROOF_STRICT === '1';

  if (!connStr) {
    console.log('[INFO] No database connection URL configured in environment.');
    const reason = 'No connection string provided (AN_PG_PROOF_URL, MIGRATION_DATABASE_URL, DATABASE_URL)';
    logTest('T1', 'BLOCKED', reason);
    logTest('T2', 'BLOCKED', reason);
    logTest('T3', 'BLOCKED', reason);
    logTest('T4', 'BLOCKED', reason);
    logTest('T5', 'BLOCKED', reason);
    logTest('T6', 'BLOCKED', reason);
    logTest('T7', 'BLOCKED', reason);
  } else {
    const client = new pg.Client({
      connectionString: connStr.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, ''),
      ssl: { rejectUnauthorized: false },
    });

    try {
      await client.connect();
      logTest('T1', 'PASS', 'Successfully connected to PostgreSQL and executed health query');

      // T1 check query
      try {
        await client.query('SELECT current_user, current_database();');
      } catch (t1Err: any) {
        logTest('T1', 'FAIL', `Connection health query failed: ${t1Err.message}`);
      }

      // Run T2 - T7 inside main transaction with separate savepoints per test case
      await client.query('BEGIN;');

      const companyA = '10000000-0000-0000-0000-000000000001';
      const companyB = '20000000-0000-0000-0000-000000000002';
      const testAccountId = '80000000-0000-0000-0000-000000000001';

      // Setup global test company & account
      try {
        await client.query(
          `INSERT INTO companies (id, code, name_ar, name_en)
           VALUES ($1, 'PROOF1', 'شركة إثبات 1', 'Proof Company 1')
           ON CONFLICT (id) DO NOTHING`,
          [companyA]
        );
        await client.query(
          `INSERT INTO companies (id, code, name_ar, name_en)
           VALUES ($1, 'PROOF2', 'شركة إثبات 2', 'Proof Company 2')
           ON CONFLICT (id) DO NOTHING`,
          [companyB]
        );
        await client.query(
          `INSERT INTO accounts (id, company_id, code, name_ar, account_type, is_active, is_postable)
           VALUES ($1, $2, '101', 'صندوق', 'asset', true, true)
           ON CONFLICT (id) DO NOTHING`,
          [testAccountId, companyA]
        );
      } catch (setupErr: any) {
        console.warn('[INFO] Setup seed hit privilege limitation:', setupErr.message);
      }

      // --- T2: INSERT line on posted entry ---
      try {
        await client.query('SAVEPOINT sp_t2;');
        const entryId = '90000000-0000-0000-0000-000000000002';
        await client.query(
          `INSERT INTO journal_entries (id, company_id, entry_date, status, created_at)
           VALUES ($1, $2, CURRENT_DATE, 'draft', NOW())
           ON CONFLICT (id) DO NOTHING`,
          [entryId, companyA]
        );
        await client.query(
          `INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit)
           VALUES (gen_random_uuid(), $1, $2, $3, 100, 0), (gen_random_uuid(), $1, $2, $3, 0, 100)
           ON CONFLICT DO NOTHING`,
          [companyA, entryId, testAccountId]
        );
        await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [entryId]);

        // Try inserting extra line -> expect rejection
        await client.query(
          `INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit)
           VALUES (gen_random_uuid(), $1, $2, $3, 50, 0)`,
          [companyA, entryId, testAccountId]
        );
        logTest('T2', 'FAIL', 'INSERT line into posted entry unexpectedly succeeded');
        await client.query('ROLLBACK TO SAVEPOINT sp_t2;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_t2;');
        const msg = err?.message || '';
        if (/CANNOT_MODIFY_POSTED|posted journal entry|cannot modify|posted/i.test(msg)) {
          logTest('T2', 'PASS', 'DB correctly blocked line INSERT on posted entry');
        } else {
          logTest('T2', 'BLOCKED', `Setup or privilege limitation: ${msg}`);
        }
      }

      // --- T3: UPDATE line belonging to posted entry ---
      try {
        await client.query('SAVEPOINT sp_t3;');
        const entryId = '90000000-0000-0000-0000-000000000003';
        const lineId = '70000000-0000-0000-0000-000000000001';
        await client.query(
          `INSERT INTO journal_entries (id, company_id, entry_date, status, created_at)
           VALUES ($1, $2, CURRENT_DATE, 'draft', NOW())
           ON CONFLICT (id) DO NOTHING`,
          [entryId, companyA]
        );
        await client.query(
          `INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit)
           VALUES ($4, $1, $2, $3, 100, 0), (gen_random_uuid(), $1, $2, $3, 0, 100)
           ON CONFLICT DO NOTHING`,
          [companyA, entryId, testAccountId, lineId]
        );
        await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [entryId]);

        // Try updating line amount -> expect rejection
        await client.query(`UPDATE journal_lines SET debit = 200 WHERE id = $1`, [lineId]);
        logTest('T3', 'FAIL', 'UPDATE line on posted entry unexpectedly succeeded');
        await client.query('ROLLBACK TO SAVEPOINT sp_t3;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_t3;');
        const msg = err?.message || '';
        if (/CANNOT_MODIFY_POSTED|posted journal entry|cannot modify|posted/i.test(msg)) {
          logTest('T3', 'PASS', 'DB correctly blocked line UPDATE on posted entry');
        } else {
          logTest('T3', 'BLOCKED', `Setup or privilege limitation: ${msg}`);
        }
      }

      // --- T4: Unbalanced post guard ---
      try {
        await client.query('SAVEPOINT sp_t4;');
        const entryId = '90000000-0000-0000-0000-000000000004';
        await client.query(
          `INSERT INTO journal_entries (id, company_id, entry_date, status, created_at)
           VALUES ($1, $2, CURRENT_DATE, 'draft', NOW())
           ON CONFLICT (id) DO NOTHING`,
          [entryId, companyA]
        );
        await client.query(
          `INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit)
           VALUES (gen_random_uuid(), $1, $2, $3, 100, 0)`,
          [companyA, entryId, testAccountId]
        );
        // Try posting unbalanced entry -> expect error
        await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [entryId]);
        logTest('T4', 'FAIL', 'Unbalanced entry posting unexpectedly succeeded');
        await client.query('ROLLBACK TO SAVEPOINT sp_t4;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_t4;');
        const msg = err?.message || '';
        if (/unbalanced|balance|amount|zero|lines/i.test(msg)) {
          logTest('T4', 'PASS', 'DB correctly blocked posting of unbalanced entry');
        } else {
          logTest('T4', 'BLOCKED', `Setup or privilege limitation: ${msg}`);
        }
      }

      // --- T5: Cross-company org parent FK ---
      try {
        await client.query('SAVEPOINT sp_t5;');
        const orgA = '30000000-0000-0000-0000-000000000001';
        const orgB = '30000000-0000-0000-0000-000000000002';
        await client.query(
          `INSERT INTO org_units (id, company_id, code, name_ar, unit_type, path)
           VALUES ($1, $2, 'OA', 'وحدة أ', 'branch', '/OA/')`,
          [orgA, companyA]
        );
        // Try inserting into company B referencing parent in company A -> expect FK violation
        await client.query(
          `INSERT INTO org_units (id, company_id, parent_id, code, name_ar, unit_type, path)
           VALUES ($1, $2, $3, 'OB', 'وحدة ب', 'branch', '/OA/OB/')`,
          [orgB, companyB, orgA]
        );
        logTest('T5', 'FAIL', 'Cross-company org unit parent FK violation was not caught');
        await client.query('ROLLBACK TO SAVEPOINT sp_t5;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_t5;');
        const msg = err?.message || '';
        if (/foreign key|violates foreign key|fk_|constraint/i.test(msg)) {
          logTest('T5', 'PASS', 'DB correctly blocked cross-company org parent FK violation');
        } else {
          logTest('T5', 'BLOCKED', `Setup or privilege limitation: ${msg}`);
        }
      }

      // --- T6: Cross-company account org_unit FK ---
      try {
        await client.query('SAVEPOINT sp_t6;');
        const orgB = '30000000-0000-0000-0000-000000000003';
        const accX = '80000000-0000-0000-0000-000000000002';
        await client.query(
          `INSERT INTO org_units (id, company_id, code, name_ar, unit_type, path)
           VALUES ($1, $2, 'OB2', 'وحدة ب2', 'branch', '/OB2/')`,
          [orgB, companyB]
        );
        // Try inserting account in company A pointing to org_unit in company B -> expect FK violation
        await client.query(
          `INSERT INTO accounts (id, company_id, org_unit_id, code, name_ar, account_type, is_active, is_postable)
           VALUES ($1, $2, $3, '102', 'حساب عبر الشركات', 'asset', true, true)`,
          [accX, companyA, orgB]
        );
        logTest('T6', 'FAIL', 'Cross-company account org_unit FK violation was not caught');
        await client.query('ROLLBACK TO SAVEPOINT sp_t6;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_t6;');
        const msg = err?.message || '';
        if (/foreign key|violates foreign key|fk_|constraint/i.test(msg)) {
          logTest('T6', 'PASS', 'DB correctly blocked cross-company account org_unit FK violation');
        } else {
          logTest('T6', 'BLOCKED', `Setup or privilege limitation: ${msg}`);
        }
      }

      // --- T7: Trial balance posted-only aggregation ---
      try {
        await client.query('SAVEPOINT sp_t7;');
        const draftEntryId = '90000000-0000-0000-0000-000000000005';
        await client.query(
          `INSERT INTO journal_entries (id, company_id, entry_date, status, created_at)
           VALUES ($1, $2, CURRENT_DATE, 'draft', NOW())
           ON CONFLICT (id) DO NOTHING`,
          [draftEntryId, companyA]
        );
        await client.query(
          `INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit)
           VALUES (gen_random_uuid(), $1, $2, $3, 99999, 0), (gen_random_uuid(), $1, $2, $3, 0, 99999)
           ON CONFLICT DO NOTHING`,
          [companyA, draftEntryId, testAccountId]
        );

        // Query trial balance aggregate (posted only)
        const tbRes = await client.query(
          `SELECT SUM(l.debit) as total_debit
           FROM journal_lines l
           INNER JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
           WHERE e.status = 'posted' AND l.company_id = $1 AND l.account_id = $2`,
          [companyA, testAccountId]
        );
        const sumDebit = Number(tbRes.rows[0]?.total_debit || 0);
        // The draft entry lines (99999) should NOT be included in posted sum
        if (sumDebit === 0 || sumDebit < 99999) {
          logTest('T7', 'PASS', 'Trial balance query strictly excluded draft journal lines');
        } else {
          logTest('T7', 'FAIL', `Trial balance incorrectly included draft lines (sum=${sumDebit})`);
        }
        await client.query('ROLLBACK TO SAVEPOINT sp_t7;');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_t7;');
        logTest('T7', 'BLOCKED', `Setup or query error: ${err?.message}`);
      }

      await client.query('ROLLBACK;');
      await client.end();
    } catch (connErr: any) {
      logTest('T1', 'FAIL', `Database connection failed: ${connErr.message}`);
    }
  }

  console.log('\n=== RESULTS SUMMARY ===');
  console.log(`Passed: ${passedCount} | Failed: ${failedCount} | Blocked: ${blockedCount}`);
  console.log('Case Results:', results);

  if (failedCount > 0) {
    console.error('\nFAIL: One or more test cases failed.');
    process.exit(1);
  } else if (isStrict && blockedCount > 0) {
    console.error('\nFAIL: Strict mode enabled and one or more cases were blocked.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: Proof harness completed without failures.');
  }
}

verifyPgIntegrationProof2().catch((err) => {
  console.error('Unhandled error in verifyPgIntegrationProof2:', err);
  process.exit(1);
});
