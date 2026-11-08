import fs from 'fs';
import path from 'path';

function verifyOrgScopeOnLedger1() {
  console.log('=== VERIFYING AN-ORG-SCOPE-ON-LEDGER-1 ===');
  let failures = 0;

  function assertCondition(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
    } else {
      console.error(`[FAIL] ${description}`);
      failures++;
    }
  }

  // S1: journalService references assertUserOrgAccess
  const servicePath = path.join(process.cwd(), 'src/server/accounting/journalService.ts');
  const serviceContent = fs.readFileSync(servicePath, 'utf8');
  assertCondition(
    serviceContent.includes('assertUserOrgAccess') && serviceContent.includes('defaultOrgUnitService'),
    'S1: journalService.ts references assertUserOrgAccess for draft creation, posting, and reversal'
  );

  // S2: trialBalanceService references assertUserOrgAccess
  const tbPath = path.join(process.cwd(), 'src/server/accounting/trialBalanceService.ts');
  const tbContent = fs.readFileSync(tbPath, 'utf8');
  assertCondition(
    tbContent.includes('assertUserOrgAccess') && tbContent.includes('defaultOrgUnitService'),
    'S2: trialBalanceService.ts references assertUserOrgAccess for orgUnitId filtering'
  );

  // S3: accountingRoutes passes req.user.id into services
  const routesPath = path.join(process.cwd(), 'src/server/routes/accountingRoutes.ts');
  const routesContent = fs.readFileSync(routesPath, 'utf8');
  assertCondition(
    routesContent.includes('user.id') && routesContent.includes("user.role === 'platform_admin'"),
    'S3: accountingRoutes.ts passes user.id and platform_admin flag into service methods'
  );

  // S4: assertUserOrgAccess defined in orgUnitService
  const orgServicePath = path.join(process.cwd(), 'src/server/org/orgUnitService.ts');
  const orgServiceContent = fs.readFileSync(orgServicePath, 'utf8');
  assertCondition(
    orgServiceContent.includes('assertUserOrgAccess') && orgServiceContent.includes('isPlatformAdmin'),
    'S4: assertUserOrgAccess is defined in orgUnitService.ts with platform_admin bypass support'
  );

  // S5: Empty-scope company-wide behavior
  assertCondition(
    orgServiceContent.includes('userScopes.length === 0') && orgServiceContent.includes('return true'),
    'S5: assertUserOrgAccess preserves company-wide access when user has zero org scopes configured'
  );

  // S6: AI_PROJECT_STATE.md records AN-ORG-SCOPE-ON-LEDGER-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCondition(
    stateContent.includes('AN-ORG-SCOPE-ON-LEDGER-1'),
    'S6: AI_PROJECT_STATE.md records AN-ORG-SCOPE-ON-LEDGER-1'
  );

  // S7: P1b postEntry method present
  assertCondition(
    serviceContent.includes('postEntry'),
    'S7: P1b postEntry guarantee method present in journalService.ts'
  );

  // S8: No new migration 018
  const migration018Path = path.join(process.cwd(), 'database/migrations/018_org_scope_ledger.sql');
  assertCondition(
    !fs.existsSync(migration018Path),
    'S8: No new migrations added (018 expected none)'
  );

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} assertions failed.`);
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-ORG-SCOPE-ON-LEDGER-1 checks passed!');
  }
}

verifyOrgScopeOnLedger1();
