import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function assertCheck(id: string, description: string, condition: boolean) {
  if (condition) {
    console.log(`[PASS] ${id}: ${description}`);
    passed++;
  } else {
    console.error(`[FAIL] ${id}: ${description}`);
    failed++;
  }
}

async function verifyFixAccountingUiGates() {
  console.log('=== Running verifyFixAccountingUiGates1 Verification ===\n');

  // S1: AccountsPanel props include canCreate and canSeed
  const panelPath = path.resolve('src/components/accounting/AccountsPanel.tsx');
  const panelContent = fs.existsSync(panelPath) ? fs.readFileSync(panelPath, 'utf8') : '';
  assertCheck(
    'S1',
    'AccountsPanel props include canCreate and canSeed',
    panelContent.includes('canCreate') && panelContent.includes('canSeed')
  );

  // S2: Write buttons / seed controls are conditionally rendered based on those flags
  assertCheck(
    'S2',
    'AccountsPanel conditionally renders seed and create buttons using canSeed and canCreate',
    panelContent.includes('canSeed &&') && panelContent.includes('canCreate &&')
  );

  // S3: Default fail-closed: canCreate and canSeed default to false
  assertCheck(
    'S3',
    'AccountsPanel defaults canCreate and canSeed to false (fail-closed UI)',
    panelContent.includes('canCreate = false') && panelContent.includes('canSeed = false')
  );

  // S4: App or AccountingWorkspace passes role or capability props into accounting tree
  const wsPath = path.resolve('src/components/accounting/AccountingWorkspace.tsx');
  const wsContent = fs.existsSync(wsPath) ? fs.readFileSync(wsPath, 'utf8') : '';
  const appPath = path.resolve('src/App.tsx');
  const appContent = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  assertCheck(
    'S4',
    'AccountingWorkspace and App pass userRole / capability props down to AccountsPanel',
    wsContent.includes('canCreate={canWrite}') && wsContent.includes('canSeed={canWrite}') && appContent.includes('userRole={currentUser.role}')
  );

  // S5: Server accountingRoutes still references ACCOUNTING_ACCOUNTS_CREATE and SEED (regression guard)
  const routesPath = path.resolve('src/server/routes/accountingRoutes.ts');
  const routesContent = fs.existsSync(routesPath) ? fs.readFileSync(routesPath, 'utf8') : '';
  assertCheck(
    'S5',
    'Server accountingRoutes still enforces ACCOUNTING_ACCOUNTS_CREATE and SEED',
    routesContent.includes('ACCOUNTING_ACCOUNTS_CREATE') && routesContent.includes('ACCOUNTING_ACCOUNTS_SEED')
  );

  // S6: AI_PROJECT_STATE contains AN-FIX-ACCOUNTING-UI-GATES-1
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCheck(
    'S6',
    'AI_PROJECT_STATE.md documents AN-FIX-ACCOUNTING-UI-GATES-1',
    stateContent.includes('AN-FIX-ACCOUNTING-UI-GATES-1')
  );

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

verifyFixAccountingUiGates().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
