import fs from 'fs';
import path from 'path';
import { check, summary } from './lib/testkit.js';

console.log('=== RUNNING INVENTORY CORE VERIFICATION (AN-INV-CORE-1) ===\n');

async function runVerification() {
  const rootDir = process.cwd();

  // S1: Migration 019_inventory_core.sql exists with four tables and RLS policies
  const m19Path = path.join(rootDir, 'database/migrations/019_inventory_core.sql');
  const m19Exists = fs.existsSync(m19Path);
  const m19Content = m19Exists ? fs.readFileSync(m19Path, 'utf8') : '';

  const s1MigrationValid =
    m19Exists &&
    m19Content.includes('inv_warehouses') &&
    m19Content.includes('inv_items') &&
    m19Content.includes('inv_stock_balances') &&
    m19Content.includes('inv_stock_movements') &&
    m19Content.includes('ENABLE ROW LEVEL SECURITY') &&
    m19Content.includes('FORCE ROW LEVEL SECURITY') &&
    m19Content.includes('an_app');
  await check('S1: 019_inventory_core.sql exists with 4 inventory tables and forced RLS for an_app', s1MigrationValid);

  // S2: Inventory router mounted at /api/inventory in app.ts
  const appPath = path.join(rootDir, 'src/server/app.ts');
  const appContent = fs.readFileSync(appPath, 'utf8');
  const s2RouterMounted =
    appContent.includes("import { inventoryRoutes }") &&
    appContent.includes("app.use('/api/inventory', inventoryRoutes);");
  await check('S2: inventoryRoutes is imported and mounted at /api/inventory in app.ts', s2RouterMounted);

  // S3: Stock service contains strict issue non-negative stock guard
  const stockServicePath = path.join(rootDir, 'src/server/inventory/stockService.ts');
  const stockServiceContent = fs.existsSync(stockServicePath) ? fs.readFileSync(stockServicePath, 'utf8') : '';
  const s3IssueNonNegativeGuard =
    stockServiceContent.includes('issueStock') &&
    stockServiceContent.includes('currentQty < input.qty') &&
    stockServiceContent.includes('رصيد غير كافٍ');
  await check('S3: stockService.ts issueStock contains strict non-negative stock validation guard', s3IssueNonNegativeGuard);

  // S4: InventoryWorkspace and AppSidebar link exist
  const workspacePath = path.join(rootDir, 'src/components/inventory/InventoryWorkspace.tsx');
  const sidebarPath = path.join(rootDir, 'src/components/shell/AppSidebar.tsx');
  const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
  const s4UiPresent =
    fs.existsSync(workspacePath) &&
    sidebarContent.includes("'inventory'") &&
    sidebarContent.includes('المخزون');
  await check('S4: InventoryWorkspace.tsx exists and is linked in AppSidebar.tsx menu', s4UiPresent);

  // S5: Permissions for inventory registered in permissions.ts and roles.ts
  const permsPath = path.join(rootDir, 'src/server/rbac/permissions.ts');
  const rolesPath = path.join(rootDir, 'src/server/rbac/roles.ts');
  const permsContent = fs.readFileSync(permsPath, 'utf8');
  const rolesContent = fs.readFileSync(rolesPath, 'utf8');

  const s5PermissionsValid =
    permsContent.includes("INVENTORY_READ: 'inventory:read'") &&
    permsContent.includes("INVENTORY_WRITE: 'inventory:write'") &&
    permsContent.includes("INVENTORY_MOVEMENT: 'inventory:movement'") &&
    rolesContent.includes('PERMISSIONS.INVENTORY_READ');
  await check('S5: Inventory domain permissions registered in permissions.ts and assigned in roles.ts', s5PermissionsValid);

  // S6: AI_PROJECT_STATE.md records AN-INV-CORE-1
  const projectStatePath = path.join(rootDir, 'docs/foundation/AI_PROJECT_STATE.md');
  const projectStateContent = fs.readFileSync(projectStatePath, 'utf8');
  const s6DocsRecorded = projectStateContent.includes('AN-INV-CORE-1');
  await check('S6: AI_PROJECT_STATE.md contains AN-INV-CORE-1 record', s6DocsRecorded);

  // S7: OPEN_GAPS.md documents Inventory Core slice
  const openGapsPath = path.join(rootDir, 'docs/foundation/OPEN_GAPS.md');
  const openGapsContent = fs.readFileSync(openGapsPath, 'utf8');
  const s7GapsUpdated = openGapsContent.includes('AN-INV-CORE-1') || openGapsContent.includes('Inventory');
  await check('S7: OPEN_GAPS.md records Inventory Core slice initiation', s7GapsUpdated);

  // S8: Table ownership registry includes inventory tables
  const ownershipPath = path.join(rootDir, 'database/table_ownership.json');
  const ownershipContent = fs.readFileSync(ownershipPath, 'utf8');
  const s8OwnershipRegistered =
    ownershipContent.includes('inv_warehouses') &&
    ownershipContent.includes('inv_items') &&
    ownershipContent.includes('inv_stock_balances') &&
    ownershipContent.includes('inv_stock_movements');
  await check('S8: database/table_ownership.json registers all 4 inventory tables with tenant scope', s8OwnershipRegistered);

  const { exitCode } = summary();
  process.exit(exitCode);
}

runVerification().catch((err) => {
  console.error('Unhandled error in verifyInvCore1:', err);
  process.exit(1);
});
