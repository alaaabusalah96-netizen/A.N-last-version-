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

async function runVerification() {
  console.log('=== RUNNING LEDGER COMPOSITE FOREIGN KEY VERIFICATION (AN-FIX-N2-COMPOSITE-FK-LEDGER-1) ===');
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  function reportSkipped(message: string) {
    console.log(`[SKIPPED] ${message}`);
    skipped++;
  }

  const root = process.cwd();

  // S1: Migration 022 file exists
  const migrationPath = path.join(root, 'database/migrations/022_ledger_composite_fk.sql');
  const migrationExists = fs.existsSync(migrationPath);
  assert(migrationExists, 'S1: 022_ledger_composite_fk.sql migration file exists');

  let migrationContent = '';
  if (migrationExists) {
    migrationContent = fs.readFileSync(migrationPath, 'utf8');
  }

  // S2: File contains UNIQUE (company_id, id) for accounts and journal_entries
  const hasUniqueAccounts = migrationContent.includes('uq_accounts_company_id_id') && migrationContent.includes('UNIQUE (company_id, id)');
  const hasUniqueJournalEntries = migrationContent.includes('uq_journal_entries_company_id_id') && migrationContent.includes('UNIQUE (company_id, id)');
  assert(hasUniqueAccounts && hasUniqueJournalEntries, 'S2: Migration 022 defines composite UNIQUE (company_id, id) for accounts and journal_entries');

  // S3: File contains composite FOREIGN KEYs for (entry_id, company_id) and (account_id, company_id)
  const hasEntryFk = migrationContent.includes('fk_journal_lines_entry_company') && migrationContent.includes('(entry_id, company_id)');
  const hasAccountFk = migrationContent.includes('fk_journal_lines_account_company') && migrationContent.includes('(account_id, company_id)');
  assert(hasEntryFk && hasAccountFk, 'S3: Migration 022 defines composite FOREIGN KEYs on journal_lines');

  // S4: Orphan check / RAISE present before FK add
  const hasOrphanCheck = migrationContent.includes('RAISE EXCEPTION') && migrationContent.includes('orphan_count');
  assert(hasOrphanCheck, 'S4: Migration 022 includes pre-migration orphan & cross-company mismatch check with RAISE EXCEPTION');

  // S5: AI_PROJECT_STATE.md records package
  const statePath = path.join(root, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const hasStateRecord = stateContent.includes('AN-FIX-N2-COMPOSITE-FK-LEDGER-1');
  assert(hasStateRecord, 'S5: AI_PROJECT_STATE.md records AN-FIX-N2-COMPOSITE-FK-LEDGER-1');

  // Live Database Proof (T1, T2) if disposable DB provided and N2_ALLOW_DISPOSABLE=1
  const dbUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    reportSkipped('Live FK rejection proof skipped: No DATABASE_URL or MIGRATION_DATABASE_URL configured');
  } else if (isProductionOrSupabaseDb(dbUrl) && process.env.N2_ALLOW_DISPOSABLE !== '1') {
    reportSkipped('Live FK rejection proof skipped: Protected database URL detected and N2_ALLOW_DISPOSABLE is not set to 1');
  } else {
    console.log('[Live Proof] Connecting to test database to verify composite FK cross-tenant rejection...');
    const pgConfig = buildPgConfig(dbUrl, process.env);
    const client = new pg.Client(pgConfig);
    try {
      await client.connect();
      await client.query('BEGIN;');

      // Create two temporary test companies
      const comp1Res = await client.query("INSERT INTO companies (code, name_ar) VALUES ('N2-COMP-A', 'شركة أ') RETURNING id;");
      const comp1Id = comp1Res.rows[0].id;

      const comp2Res = await client.query("INSERT INTO companies (code, name_ar) VALUES ('N2-COMP-B', 'شركة ب') RETURNING id;");
      const comp2Id = comp2Res.rows[0].id;

      // Create account in Company 1
      const acc1Res = await client.query(
        "INSERT INTO accounts (company_id, code, name_ar, account_type) VALUES ($1, '101', 'صندوق أ', 'asset') RETURNING id;",
        [comp1Id]
      );
      const acc1Id = acc1Res.rows[0].id;

      // Create journal entry in Company 1
      const entry1Res = await client.query(
        "INSERT INTO journal_entries (company_id, memo) VALUES ($1, 'قيد أ') RETURNING id;",
        [comp1Id]
      );
      const entry1Id = entry1Res.rows[0].id;

      // T1: Try inserting journal_line in Company 2 pointing to entry in Company 1 -> must fail with SQLSTATE 23503 on fk_journal_lines_entry_company
      let t1Failed = false;
      await client.query('SAVEPOINT sp_t1;');
      try {
        await client.query(
          "INSERT INTO journal_lines (company_id, entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 100, 0);",
          [comp2Id, entry1Id, acc1Id]
        );
      } catch (err: any) {
        if (err.code === '23503' && err.constraint === 'fk_journal_lines_entry_company') {
          t1Failed = true;
        } else {
          throw err;
        }
      }
      await client.query('ROLLBACK TO SAVEPOINT sp_t1;');
      await client.query('RELEASE SAVEPOINT sp_t1;');
      assert(t1Failed, 'T1: Inserting journal_line with cross-company entry_id rejected strictly by SQLSTATE 23503 and constraint fk_journal_lines_entry_company');

      // Prove transaction is still usable after T1 savepoint rollback
      const isoRes = await client.query('SELECT 1 as alive;');
      assert(isoRes.rows[0]?.alive === 1, 'T1 Isolation: Transaction remains valid after T1 SAVEPOINT rollback (no 25P02 abort)');

      // Create account in Company 2 (runs AFTER T1 savepoint rollback so txn is usable)
      const acc2Res = await client.query(
        "INSERT INTO accounts (company_id, code, name_ar, account_type) VALUES ($1, '102', 'صندوق ب', 'asset') RETURNING id;",
        [comp2Id]
      );
      const acc2Id = acc2Res.rows[0].id;

      // T2: Try inserting journal_line in Company 1 pointing to account in Company 2 -> must fail with SQLSTATE 23503 on fk_journal_lines_account_company
      let t2Failed = false;
      await client.query('SAVEPOINT sp_t2;');
      try {
        await client.query(
          "INSERT INTO journal_lines (company_id, entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 100, 0);",
          [comp1Id, entry1Id, acc2Id]
        );
      } catch (err: any) {
        if (err.code === '23503' && err.constraint === 'fk_journal_lines_account_company') {
          t2Failed = true;
        } else {
          throw err;
        }
      }
      await client.query('ROLLBACK TO SAVEPOINT sp_t2;');
      await client.query('RELEASE SAVEPOINT sp_t2;');
      assert(t2Failed, 'T2: Inserting journal_line with cross-company account_id rejected strictly by SQLSTATE 23503 and constraint fk_journal_lines_account_company');

      // T3: Positive same-company insert succeeds and is verified by read
      let t3Success = false;
      await client.query('SAVEPOINT sp_t3;');
      const testLineId = '44444444-0000-0000-0000-000000000001';
      try {
        await client.query(
          "INSERT INTO journal_lines (id, company_id, entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4, 100, 0);",
          [testLineId, comp1Id, entry1Id, acc1Id]
        );
        const readRes = await client.query(
          "SELECT id, company_id, entry_id, account_id, debit FROM journal_lines WHERE id = $1 AND company_id = $2;",
          [testLineId, comp1Id]
        );
        if (readRes.rows.length === 1 && readRes.rows[0].id === testLineId && Number(readRes.rows[0].debit) === 100) {
          t3Success = true;
        }
      } catch (err: any) {
        console.error('Positive insert/read error:', err);
      }
      await client.query('ROLLBACK TO SAVEPOINT sp_t3;');
      await client.query('RELEASE SAVEPOINT sp_t3;');
      assert(t3Success, 'T3: Valid same-company insert succeeded and verified via SELECT read within transaction');

      await client.query('ROLLBACK;');
    } catch (err) {
      try {
        await client.query('ROLLBACK;');
      } catch {}
      console.error('[Live Proof Error]:', err);
      assert(false, `Live FK rejection proof encountered unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      try {
        await client.end();
      } catch {}
    }
  }

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped} | Blocked: 0`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
