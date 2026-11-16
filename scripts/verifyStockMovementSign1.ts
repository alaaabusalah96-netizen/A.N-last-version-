import fs from 'fs';
import path from 'path';

function assert(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${label}`);
  }
  console.log(`[PASS] ${label}`);
}

async function run() {
  console.log('=== VERIFY AN-FIX-STOCK-MOVEMENT-SIGN-1 ===');
  const rootDir = process.cwd();

  // S1: salesDeliveryService does not pass negative qty into createMovement
  const salesDeliverySrc = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesDeliveryService.ts'), 'utf8');
  assert(!salesDeliverySrc.includes("'issue', -line.qty"), 'salesDeliveryService does not pass negative qty');

  // S2: purchReturnService does not pass negative qty into createMovement
  const purchReturnSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/purchReturnService.ts'), 'utf8');
  assert(!purchReturnSrc.includes("'purchase_return', -line.qty"), 'purchReturnService does not pass negative qty');

  // S3: stockRepository createMovement checks qty <= 0 or not finite
  const stockRepoSrc = fs.readFileSync(path.join(rootDir, 'src/server/inventory/stockRepository.ts'), 'utf8');
  assert(stockRepoSrc.includes('!Number.isFinite(qty) || qty <= 0'), 'stockRepository.createMovement guards against non-positive qty');

  // S4: migration 019 retains CHECK (qty > 0)
  const mig019Path = path.join(rootDir, 'database/migrations/019_inventory_core.sql');
  const mig019 = fs.existsSync(mig019Path) ? fs.readFileSync(mig019Path, 'utf8') : '';
  assert(mig019.includes('CHECK (qty > 0)') || mig019.includes('qty > 0'), 'Migration 019 retains qty > 0 constraint');

  console.log('PASS: verifyStockMovementSign1 static checks passed successfully.');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
