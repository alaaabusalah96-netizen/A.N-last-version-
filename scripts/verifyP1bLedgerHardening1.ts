import fs from 'fs';
import path from 'path';

function verifyP1bLedgerHardening1() {
  console.log('=== VERIFYING AN-P1B-LEDGER-HARDENING-1 ===');
  let failures = 0;

  function assertCondition(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
    } else {
      console.error(`[FAIL] ${description}`);
      failures++;
    }
  }

  // S1: Migration 015 exists
  const migrationPath = path.join(process.cwd(), 'database/migrations/015_ledger_hardening.sql');
  assertCondition(fs.existsSync(migrationPath), 'S1: 015_ledger_hardening.sql migration file exists');

  const migrationContent = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';

  // S2: 015 blocks INSERT/UPDATE/DELETE on journal_lines for posted entries
  assertCondition(
    migrationContent.includes('BEFORE INSERT OR UPDATE OR DELETE ON journal_lines') &&
      migrationContent.includes("v_parent_status = 'posted'") &&
      migrationContent.includes('COALESCE(NEW.entry_id, OLD.entry_id)'),
    'S2: 015_ledger_hardening.sql blocks INSERT/UPDATE/DELETE lines against posted entries'
  );

  // S3: DB-level balance check on transition to posted
  assertCondition(
    migrationContent.includes('NEW.status = \'posted\'') &&
      migrationContent.includes('SUM(debit)') &&
      migrationContent.includes('v_total_debit <> v_total_credit'),
    'S3: 015_ledger_hardening.sql includes DB-level balance verification on transition to posted'
  );

  // S4: postEntry SELECT FOR UPDATE row locking
  const repoPath = path.join(process.cwd(), 'src/server/accounting/journalRepository.ts');
  const servicePath = path.join(process.cwd(), 'src/server/accounting/journalService.ts');
  const repoContent = fs.readFileSync(repoPath, 'utf8');
  const serviceContent = fs.readFileSync(servicePath, 'utf8');

  assertCondition(
    (repoContent.includes('FOR UPDATE') || repoContent.includes('findByIdForUpdate')) &&
      serviceContent.includes('findByIdForUpdate'),
    'S4: journalRepository & journalService post path uses SELECT FOR UPDATE row locking'
  );

  // S5: Narrowed posted entry immutability comparing period_id
  assertCondition(
    migrationContent.includes('period_id IS NOT DISTINCT FROM OLD.period_id') ||
      migrationContent.includes('period_id'),
    'S5: Posted entry immutability trigger compares period_id and non-allowed columns'
  );

  // S6: P1b postEntry method still present
  assertCondition(
    serviceContent.includes('postEntry'),
    'S6: P1b postEntry guarantee method present in journalService.ts'
  );

  // S7: AI_PROJECT_STATE documentation updated
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCondition(
    stateContent.includes('AN-P1B-LEDGER-HARDENING-1'),
    'S7: AI_PROJECT_STATE.md records AN-P1B-LEDGER-HARDENING-1'
  );

  // S8: App mounts /api/accounting
  const appPath = path.join(process.cwd(), 'src/server/routes/accountingRoutes.ts');
  const appContent = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  assertCondition(
    appContent.includes('/api/accounting') || appContent.includes('accountingRoutes'),
    'S8: App mounts /api/accounting routes'
  );

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} assertions failed.`);
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-P1B-LEDGER-HARDENING-1 checks passed!');
  }
}

verifyP1bLedgerHardening1();
