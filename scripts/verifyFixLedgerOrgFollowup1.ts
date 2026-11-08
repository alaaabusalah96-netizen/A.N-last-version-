import fs from 'fs';
import path from 'path';

function verifyFixLedgerOrgFollowup1() {
  console.log('=== VERIFYING AN-FIX-LEDGER-ORG-FOLLOWUP-1 ===');
  let failures = 0;

  function assertCondition(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
    } else {
      console.error(`[FAIL] ${description}`);
      failures++;
    }
  }

  // S1: Migration 017 file exists
  const migration017Path = path.join(process.cwd(), 'database/migrations/017_ledger_org_followup.sql');
  assertCondition(fs.existsSync(migration017Path), 'S1: 017_ledger_org_followup.sql migration file exists');

  const migration017Content = fs.existsSync(migration017Path) ? fs.readFileSync(migration017Path, 'utf8') : '';

  // S2: 017 drops or replaces SET NULL composite delete behavior (mentions RESTRICT or DROP CONSTRAINT)
  assertCondition(
    (migration017Content.includes('DROP CONSTRAINT') || migration017Content.includes('ALTER TABLE')) &&
      migration017Content.includes('ON DELETE RESTRICT'),
    'S2: 017_ledger_org_followup.sql replaces ON DELETE SET NULL with ON DELETE RESTRICT on composite FKs'
  );

  // S3: 017 journal_lines function checks TG_OP branches (INSERT, UPDATE OLD+NEW, DELETE)
  assertCondition(
    migration017Content.includes("TG_OP = 'INSERT'") &&
      migration017Content.includes("TG_OP = 'DELETE'") &&
      migration017Content.includes("TG_OP = 'UPDATE'") &&
      migration017Content.includes('IS DISTINCT FROM OLD.entry_id'),
    'S3: 017_ledger_org_followup.sql checks TG_OP branches and validates BOTH OLD and NEW parent entries'
  );

  // S4: trialBalanceService SQL subquery pattern joining posted entries
  const tbServicePath = path.join(process.cwd(), 'src/server/accounting/trialBalanceService.ts');
  const tbServiceContent = fs.readFileSync(tbServicePath, 'utf8');
  assertCondition(
    tbServiceContent.includes('INNER JOIN journal_entries') &&
      tbServiceContent.includes("e.status = 'posted'"),
    'S4: trialBalanceService.ts uses subquery with INNER JOIN journal_entries filtering posted entries'
  );

  // S5: 015 file still present
  const migration015Path = path.join(process.cwd(), 'database/migrations/015_ledger_hardening.sql');
  assertCondition(fs.existsSync(migration015Path), 'S5: 015_ledger_hardening.sql remains present');

  // S6: 016 file still present
  const migration016Path = path.join(process.cwd(), 'database/migrations/016_org_integrity.sql');
  assertCondition(fs.existsSync(migration016Path), 'S6: 016_org_integrity.sql remains present');

  // S7: AI_PROJECT_STATE.md records AN-FIX-LEDGER-ORG-FOLLOWUP-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCondition(
    stateContent.includes('AN-FIX-LEDGER-ORG-FOLLOWUP-1'),
    'S7: AI_PROJECT_STATE.md records AN-FIX-LEDGER-ORG-FOLLOWUP-1'
  );

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} assertions failed.`);
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-FIX-LEDGER-ORG-FOLLOWUP-1 checks passed!');
  }
}

verifyFixLedgerOrgFollowup1();
