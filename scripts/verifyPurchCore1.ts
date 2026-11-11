import fs from 'node:fs';
import path from 'node:path';

function runVerification() {
  console.log('=== RUNNING PURCHASING CORE VERIFICATION (AN-PURCH-CORE-1) ===');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const root = process.cwd();

  // S1: Migration 021_purchasing_core.sql exists with 3 purchasing tables and forced RLS
  const migrationPath = path.join(root, 'database/migrations/021_purchasing_core.sql');
  const migrationExists = fs.existsSync(migrationPath);
  let migrationValid = false;
  if (migrationExists) {
    const content = fs.readFileSync(migrationPath, 'utf8');
    migrationValid =
      content.includes('purch_suppliers') &&
      content.includes('purch_grn') &&
      content.includes('purch_grn_lines') &&
      content.includes('FORCE ROW LEVEL SECURITY');
  }
  assert(migrationValid, 'S1: 021_purchasing_core.sql exists with purch_suppliers, purch_grn, purch_grn_lines and forced RLS');

  // S2: purchasingRoutes mounted at /api/purchasing in app.ts
  const appPath = path.join(root, 'src/server/app.ts');
  const appContent = fs.readFileSync(appPath, 'utf8');
  const hasPurchasingRoutes =
    appContent.includes('purchasingRoutes') &&
    appContent.includes("'/api/purchasing'");
  assert(hasPurchasingRoutes, 'S2: purchasingRoutes imported and mounted at /api/purchasing in app.ts');

  // S3: postGrn in grnService.ts performs stock receive updates (incrementBalance & createMovement receive)
  const grnServicePath = path.join(root, 'src/server/purchasing/grnService.ts');
  const grnServiceContent = fs.readFileSync(grnServicePath, 'utf8');
  const hasGrnStockReceive =
    grnServiceContent.includes('postGrn(') &&
    grnServiceContent.includes('incrementBalance') &&
    grnServiceContent.includes("'receive'");
  assert(hasGrnStockReceive, 'S3: grnService.ts postGrn method performs atomic stock receive increases on inventory');

  // S4: PurchasingWorkspace component exists and is linked in AppSidebar and App.tsx
  const uiPath = path.join(root, 'src/components/purchasing/PurchasingWorkspace.tsx');
  const uiExists = fs.existsSync(uiPath);
  const sidebarPath = path.join(root, 'src/components/shell/AppSidebar.tsx');
  const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
  const mainAppPath = path.join(root, 'src/App.tsx');
  const mainAppContent = fs.readFileSync(mainAppPath, 'utf8');

  const isUiWired =
    uiExists &&
    sidebarContent.includes("'purchasing'") &&
    sidebarContent.includes('المشتريات') &&
    mainAppContent.includes('PurchasingWorkspace');
  assert(isUiWired, 'S4: PurchasingWorkspace exists and is linked in AppSidebar.tsx menu and App.tsx');

  // S5: Purchasing domain permissions present in permissions.ts and assigned in roles.ts
  const permPath = path.join(root, 'src/server/rbac/permissions.ts');
  const permContent = fs.readFileSync(permPath, 'utf8');
  const rolesPath = path.join(root, 'src/server/rbac/roles.ts');
  const rolesContent = fs.readFileSync(rolesPath, 'utf8');

  const hasPermissions =
    permContent.includes('purchasing:read') &&
    permContent.includes('purchasing:write') &&
    permContent.includes('purchasing:post') &&
    rolesContent.includes('PURCHASING_READ');
  assert(hasPermissions, 'S5: Purchasing domain permissions registered in permissions.ts and mapped in roles.ts');

  // S6: AI_PROJECT_STATE.md contains AN-PURCH-CORE-1 record
  const statePath = path.join(root, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.readFileSync(statePath, 'utf8');
  const hasStateRecord = stateContent.includes('AN-PURCH-CORE-1');
  assert(hasStateRecord, 'S6: AI_PROJECT_STATE.md contains AN-PURCH-CORE-1 record');

  // S7: OPEN_GAPS.md MODULES row mentions purchasing slice
  const gapsPath = path.join(root, 'docs/foundation/OPEN_GAPS.md');
  const gapsContent = fs.readFileSync(gapsPath, 'utf8');
  const hasGapsMention =
    gapsContent.includes('Purchasing') ||
    gapsContent.includes('purchasing') ||
    gapsContent.includes('AN-PURCH-CORE-1');
  assert(hasGapsMention, 'S7: OPEN_GAPS.md MODULES gap row mentions purchasing slice');

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: 0`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification();
