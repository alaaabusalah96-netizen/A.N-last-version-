import fs from 'fs';
import path from 'path';

function verifyP1FoundationClose1() {
  console.log('=== VERIFYING AN-P1-FOUNDATION-CLOSE-1 ===');
  let failures = 0;

  function assertCondition(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
    } else {
      console.error(`[FAIL] ${description}`);
      failures++;
    }
  }

  // S1: OPEN_GAPS.md exists and mentions PG-SMOKE-LIVE
  const openGapsPath = path.join(process.cwd(), 'docs/foundation/OPEN_GAPS.md');
  assertCondition(fs.existsSync(openGapsPath), 'S1a: docs/foundation/OPEN_GAPS.md exists');
  const openGapsContent = fs.existsSync(openGapsPath) ? fs.readFileSync(openGapsPath, 'utf8') : '';
  assertCondition(
    openGapsContent.includes('PG-SMOKE-LIVE'),
    'S1b: OPEN_GAPS.md records PG-SMOKE-LIVE gap'
  );

  // S2: P1_FOUNDATION_CLOSE.md exists
  const closePath = path.join(process.cwd(), 'docs/foundation/P1_FOUNDATION_CLOSE.md');
  assertCondition(fs.existsSync(closePath), 'S2: docs/foundation/P1_FOUNDATION_CLOSE.md exists');

  // S3: app.ts mounts accounting routes
  const appPath = path.join(process.cwd(), 'src/server/app.ts');
  const appContent = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  assertCondition(
    appContent.includes('/api/accounting') || appContent.includes('accountingRoutes'),
    'S3: src/server/app.ts mounts accounting routes'
  );

  // S4: Migration files 015, 016, 017 exist
  const m15 = path.join(process.cwd(), 'database/migrations/015_ledger_hardening.sql');
  const m16 = path.join(process.cwd(), 'database/migrations/016_org_integrity.sql');
  const m17 = path.join(process.cwd(), 'database/migrations/017_ledger_org_followup.sql');
  assertCondition(
    fs.existsSync(m15) && fs.existsSync(m16) && fs.existsSync(m17),
    'S4: Migrations 015, 016, and 017 exist in database/migrations/'
  );

  // S5: journalService.ts mentions assertUserOrgAccess
  const servicePath = path.join(process.cwd(), 'src/server/accounting/journalService.ts');
  const serviceContent = fs.existsSync(servicePath) ? fs.readFileSync(servicePath, 'utf8') : '';
  assertCondition(
    serviceContent.includes('assertUserOrgAccess'),
    'S5: journalService.ts references assertUserOrgAccess'
  );

  // S6: trialBalanceService.ts posted-only marker
  const tbPath = path.join(process.cwd(), 'src/server/accounting/trialBalanceService.ts');
  const tbContent = fs.existsSync(tbPath) ? fs.readFileSync(tbPath, 'utf8') : '';
  assertCondition(
    tbContent.includes("status = 'posted'"),
    "S6: trialBalanceService.ts filters posted entries via status = 'posted'"
  );

  // S7: AI_PROJECT_STATE.md records AN-P1-FOUNDATION-CLOSE-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCondition(
    stateContent.includes('AN-P1-FOUNDATION-CLOSE-1'),
    'S7: AI_PROJECT_STATE.md records AN-P1-FOUNDATION-CLOSE-1'
  );

  // S8: No claim that business MODULES are complete
  assertCondition(
    !stateContent.includes('INVENTORY_MODULE: IMPLEMENTED') &&
      !stateContent.includes('SALES_MODULE: IMPLEMENTED'),
    'S8: Correctly preserves non-claim that external business modules remain unstarted'
  );

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} assertions failed.`);
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-P1-FOUNDATION-CLOSE-1 checks passed!');
  }
}

verifyP1FoundationClose1();
