import fs from 'node:fs';
import path from 'node:path';

function runVerification() {
  console.log('=== RUNNING INVENTORY ITEM CARD VERIFICATION (AN-INV-ITEM-CARD-1) ===');
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

  // S1: GET item by id route exists in inventoryRoutes.ts
  const routesPath = path.join(root, 'src/server/routes/inventoryRoutes.ts');
  const routesContent = fs.readFileSync(routesPath, 'utf8');
  const hasGetItemByIdRoute =
    routesContent.includes("'/items/:id'") &&
    routesContent.includes('defaultItemService.getItem');
  assert(hasGetItemByIdRoute, 'S1: GET /api/inventory/items/:id route exists in inventoryRoutes.ts');

  // S2: GET stock-by-item route exists in inventoryRoutes.ts
  const hasGetStockByItemRoute =
    routesContent.includes("'/items/:id/stock'") &&
    routesContent.includes('listStockBalancesByItem');
  assert(hasGetStockByItemRoute, 'S2: GET /api/inventory/items/:id/stock route exists in inventoryRoutes.ts');

  // S3: GET movements-by-item route exists in inventoryRoutes.ts
  const hasGetMovementsByItemRoute =
    routesContent.includes("'/items/:id/movements'") &&
    routesContent.includes('listStockMovementsByItem');
  assert(hasGetMovementsByItemRoute, 'S3: GET /api/inventory/items/:id/movements route exists in inventoryRoutes.ts');

  // S4: ItemCard panel component exists and is imported in workspace
  const panelPath = path.join(root, 'src/components/inventory/ItemCardPanel.tsx');
  const panelExists = fs.existsSync(panelPath);
  const workspacePath = path.join(root, 'src/components/inventory/InventoryWorkspace.tsx');
  const workspaceContent = fs.readFileSync(workspacePath, 'utf8');
  const isPanelWired =
    panelExists &&
    workspaceContent.includes('ItemCardPanel') &&
    (workspaceContent.includes('cardItemId') || workspaceContent.includes('setCardItemId'));
  assert(isPanelWired, 'S4: ItemCardPanel component exists and is wired in InventoryWorkspace.tsx');

  // S5: setCardItemId or equivalent open-from-list state exists
  const hasCardState =
    workspaceContent.includes('cardItemId') ||
    workspaceContent.includes('setCardItemId');
  assert(hasCardState, 'S5: setCardItemId state and open-from-list handler exist in InventoryWorkspace.tsx');

  // S6: AI_PROJECT_STATE.md contains AN-INV-ITEM-CARD-1 record
  const statePath = path.join(root, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.readFileSync(statePath, 'utf8');
  const hasStateRecord = stateContent.includes('AN-INV-ITEM-CARD-1');
  assert(hasStateRecord, 'S6: AI_PROJECT_STATE.md contains AN-INV-ITEM-CARD-1 record');

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: 0`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification();
