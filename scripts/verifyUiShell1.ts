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

async function verifyUiShell() {
  console.log('=== Running verifyUiShell1 Verification ===\n');

  // S1: AppSidebar.tsx exists
  const sidebarPath = path.resolve('src/components/shell/AppSidebar.tsx');
  assertCheck('S1', 'AppSidebar.tsx exists', fs.existsSync(sidebarPath));

  // S2: App.tsx imports AppSidebar
  const appPath = path.resolve('src/App.tsx');
  const appContent = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  assertCheck('S2', 'App.tsx imports AppSidebar', appContent.includes('AppSidebar'));

  // S3: Sidebar has overflow-y-auto
  const sidebarContent = fs.existsSync(sidebarPath) ? fs.readFileSync(sidebarPath, 'utf8') : '';
  assertCheck('S3', 'AppSidebar contains overflow-y-auto', sidebarContent.includes('overflow-y-auto'));

  // S4: App.tsx does not contain forbidden user-visible jargon strings
  const forbiddenJargon = ['Firebase', 'Foundation Repair', 'RBAC + Tenant'];
  let jargonFree = true;
  for (const f of forbiddenJargon) {
    if (appContent.includes(f)) {
      jargonFree = false;
      console.error(`Forbidden jargon found in App.tsx: ${f}`);
    }
  }
  assertCheck('S4', 'App.tsx is free of Firebase, Foundation Repair, and RBAC+Tenant strings', jargonFree);

  // S5: CompaniesPanel does not contain P04 or Org RBAC
  const companiesPath = path.resolve('src/components/CompaniesPanel.tsx');
  const companiesContent = fs.existsSync(companiesPath) ? fs.readFileSync(companiesPath, 'utf8') : '';
  const companiesClean = !companiesContent.includes('P04') && !companiesContent.includes('Org RBAC');
  assertCheck('S5', 'CompaniesPanel is free of P04 and Org RBAC jargon', companiesClean);

  // S6: LoginForm does not contain Firebase
  const loginPath = path.resolve('src/components/LoginForm.tsx');
  const loginContent = fs.existsSync(loginPath) ? fs.readFileSync(loginPath, 'utf8') : '';
  assertCheck('S6', 'LoginForm does not contain Firebase', !loginContent.includes('Firebase'));

  // S7: roleLabels maps platform_admin to مدير المنصة
  const roleLabelsPath = path.resolve('src/components/shell/roleLabels.ts');
  const roleLabelsContent = fs.existsSync(roleLabelsPath) ? fs.readFileSync(roleLabelsPath, 'utf8') : '';
  assertCheck('S7', 'roleLabels.ts maps platform_admin to مدير المنصة', roleLabelsContent.includes('مدير المنصة'));

  // S8: App references AccountingWorkspace and CompaniesPanel
  assertCheck('S8', 'App.tsx references AccountingWorkspace and CompaniesPanel', appContent.includes('AccountingWorkspace') && appContent.includes('CompaniesPanel'));

  // S9: Nav labels الشركات and المحاسبة present in AppSidebar
  assertCheck('S9', 'AppSidebar contains الشركات and المحاسبة labels', sidebarContent.includes('الشركات') && sidebarContent.includes('المحاسبة'));

  // S10: AI_PROJECT_STATE marks AN-UI-SHELL-1 IMPLEMENTED
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCheck('S10', 'AI_PROJECT_STATE.md marks AN-UI-SHELL-1 IMPLEMENTED', stateContent.includes('AN-UI-SHELL-1'));

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

verifyUiShell().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
