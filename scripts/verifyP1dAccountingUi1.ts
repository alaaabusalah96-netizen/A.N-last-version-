import fs from 'fs';
import path from 'path';

function verifyP1dAccountingUi1() {
  console.log('=== VERIFYING AN-P1D-ACCOUNTING-UI-EXPANSION-1 ===');
  let failures = 0;

  function assertCondition(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
    } else {
      console.error(`[FAIL] ${description}`);
      failures++;
    }
  }

  // S1: Trial Balance Endpoint
  const routesPath = path.join(process.cwd(), 'src/server/routes/accountingRoutes.ts');
  const routesContent = fs.readFileSync(routesPath, 'utf8');
  assertCondition(
    routesContent.includes('/api/accounting/trial-balance') && routesContent.includes('getTrialBalance'),
    'S1: accountingRoutes.ts contains GET /api/accounting/trial-balance route'
  );

  // S2: Posted Filter in trialBalanceService
  const tbServicePath = path.join(process.cwd(), 'src/server/accounting/trialBalanceService.ts');
  const tbServiceContent = fs.readFileSync(tbServicePath, 'utf8');
  assertCondition(
    tbServiceContent.includes("status = 'posted'") || tbServiceContent.includes('status = $'),
    'S2: trialBalanceService.ts filters movements by posted status'
  );

  // S3: TrialBalancePanel component existence & integration in AccountingWorkspace
  const tbPanelPath = path.join(process.cwd(), 'src/components/accounting/TrialBalancePanel.tsx');
  assertCondition(fs.existsSync(tbPanelPath), 'S3a: TrialBalancePanel.tsx exists');

  const workspacePath = path.join(process.cwd(), 'src/components/accounting/AccountingWorkspace.tsx');
  const workspaceContent = fs.readFileSync(workspacePath, 'utf8');
  assertCondition(
    workspaceContent.includes('TrialBalancePanel') && workspaceContent.includes("activeTab === 'tb'"),
    'S3b: AccountingWorkspace.tsx imports and renders TrialBalancePanel under tb tab'
  );

  // S4: orgUnitId in journalTypes & journalService
  const typesPath = path.join(process.cwd(), 'src/server/accounting/journalTypes.ts');
  const typesContent = fs.readFileSync(typesPath, 'utf8');
  assertCondition(
    typesContent.includes('orgUnitId?:') || typesContent.includes('org_unit_id'),
    'S4a: journalTypes.ts contains orgUnitId'
  );

  const jServicePath = path.join(process.cwd(), 'src/server/accounting/journalService.ts');
  const jServiceContent = fs.readFileSync(jServicePath, 'utf8');
  assertCondition(
    jServiceContent.includes('orgUnitId') || jServiceContent.includes('org_unit_id'),
    'S4b: journalService.ts validates/handles orgUnitId'
  );

  // S5: JournalWorkspace UI Org Unit Integration
  const jWorkspacePath = path.join(process.cwd(), 'src/components/accounting/JournalWorkspace.tsx');
  const jWorkspaceContent = fs.readFileSync(jWorkspacePath, 'utf8');
  assertCondition(
    jWorkspaceContent.includes('orgUnitId') || jWorkspaceContent.includes('orgUnits'),
    'S5: JournalWorkspace.tsx includes Org Unit filter and creation input'
  );

  // S6: P1b postEntry method present
  assertCondition(
    jServiceContent.includes('postEntry'),
    'S6: P1b postEntry guarantee method present in journalService.ts'
  );

  // S7: P1c ORG_UNITS_READ permission
  const permPath = path.join(process.cwd(), 'src/server/rbac/permissions.ts');
  const permContent = fs.existsSync(permPath) ? fs.readFileSync(permPath, 'utf8') : '';
  assertCondition(
    permContent.includes('ORG_UNITS_READ'),
    'S7: P1c ORG_UNITS_READ permission present in rbac/permissions.ts'
  );

  // S8: AI_PROJECT_STATE documentation update
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCondition(
    stateContent.includes('AN-P1D-ACCOUNTING-UI-EXPANSION-1'),
    'S8: AI_PROJECT_STATE.md records AN-P1D-ACCOUNTING-UI-EXPANSION-1'
  );

  // S9: Tenant RLS Context in Trial Balance
  assertCondition(
    tbServiceContent.includes('withTenantTransaction'),
    'S9: trialBalanceService.ts wraps query execution in withTenantTransaction'
  );

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} assertions failed.`);
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-P1D-ACCOUNTING-UI-EXPANSION-1 checks passed!');
  }
}

verifyP1dAccountingUi1();
