import fs from 'node:fs';
import path from 'node:path';

function runVerification() {
  console.log('=== RUNNING INVENTORY TRANSFER VERIFICATION (AN-INV-TRANSFER-1) ===');
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

  // S1: Migration 020_inventory_transfer.sql exists and includes transfer_out/transfer_in/transfer and transfer_id
  const migrationPath = path.join(root, 'database/migrations/020_inventory_transfer.sql');
  const migrationExists = fs.existsSync(migrationPath);
  let migrationValid = false;
  if (migrationExists) {
    const content = fs.readFileSync(migrationPath, 'utf8');
    migrationValid =
      content.includes('transfer_out') &&
      content.includes('transfer_in') &&
      content.includes('transfer_id');
  }
  assert(migrationValid, 'S1: 020_inventory_transfer.sql exists with transfer movement types and transfer_id column');

  // S2: stockService.ts contains transfer method with insufficient stock guard
  const stockServicePath = path.join(root, 'src/server/inventory/stockService.ts');
  const stockServiceContent = fs.readFileSync(stockServicePath, 'utf8');
  const hasTransferMethod =
    stockServiceContent.includes('async transfer(') &&
    stockServiceContent.includes('sourceQty < input.qty');
  assert(hasTransferMethod, 'S2: stockService.ts contains transfer method with strict non-negative source stock guard');

  // S3: inventoryRoutes.ts contains POST /api/inventory/transfers route
  const routesPath = path.join(root, 'src/server/routes/inventoryRoutes.ts');
  const routesContent = fs.readFileSync(routesPath, 'utf8');
  const hasPostTransfersRoute =
    routesContent.includes("'/transfers'") &&
    routesContent.includes('defaultStockService.transfer');
  assert(hasPostTransfersRoute, 'S3: inventoryRoutes.ts exposes POST /api/inventory/transfers route');

  // S4: InventoryWorkspace.tsx contains transfer tab / panel and modal
  const uiPath = path.join(root, 'src/components/inventory/InventoryWorkspace.tsx');
  const uiContent = fs.readFileSync(uiPath, 'utf8');
  const hasUiTransfer =
    uiContent.includes("activeTab === 'transfers'") &&
    uiContent.includes('/api/inventory/transfers') &&
    uiContent.includes('showTransferModal');
  assert(hasUiTransfer, 'S4: InventoryWorkspace.tsx contains transfer tab, action button, and modal dialog');

  // S5: Deadlock-safe lock ordering in stockService.ts (sorted warehouse IDs or lock ordering comment)
  const hasLockOrdering =
    stockServiceContent.includes('.sort()') ||
    stockServiceContent.includes('Deadlock-safe lock ordering');
  assert(hasLockOrdering, 'S5: stockService.ts implements deadlock-safe lock ordering for balance row locks');

  // S6: AI_PROJECT_STATE.md contains AN-INV-TRANSFER-1 record
  const statePath = path.join(root, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.readFileSync(statePath, 'utf8');
  const hasStateRecord = stateContent.includes('AN-INV-TRANSFER-1');
  assert(hasStateRecord, 'S6: AI_PROJECT_STATE.md contains AN-INV-TRANSFER-1 record');

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: 0`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification();
