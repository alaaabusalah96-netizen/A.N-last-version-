import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { toDecimal, toMoney } from '../src/server/lib/numeric.js';

async function verify() {
  console.log('=== Verifying Numeric Qty & Cost Hardening (AN-FIX-NUMERIC-QTY-COST-1) ===');

  // 1. Test numeric helpers
  assert.strictEqual(toDecimal(toDecimal('0.1') + toDecimal('0.2')), 0.3, 'toDecimal addition precision test');
  assert.strictEqual(toDecimal(null), 0, 'toDecimal null handling');
  assert.strictEqual(toDecimal(undefined), 0, 'toDecimal undefined handling');
  assert.strictEqual(toDecimal('10.55556', 4), 10.5556, 'toDecimal rounding scale 4');
  assert.strictEqual(toMoney('100.559'), 100.56, 'toMoney rounding scale 2');
  console.log('Passed: Numeric helpers unit tests');

  // 2. Static checks on repositories
  const stockRepoPath = path.resolve('src/server/inventory/stockRepository.ts');
  const stockRepoContent = fs.readFileSync(stockRepoPath, 'utf8');
  assert(!stockRepoContent.includes('::float'), 'stockRepository must not contain ::float casts');
  assert(stockRepoContent.includes('toDecimal'), 'stockRepository must use toDecimal');
  console.log('Passed: stockRepository static checks');

  const grnRepoPath = path.resolve('src/server/purchasing/grnRepository.ts');
  const grnRepoContent = fs.readFileSync(grnRepoPath, 'utf8');
  assert(!grnRepoContent.includes('::float'), 'grnRepository must not contain ::float casts');
  assert(grnRepoContent.includes('toDecimal'), 'grnRepository must use toDecimal');
  console.log('Passed: grnRepository static checks');

  // 3. Static check on grnService
  const grnServicePath = path.resolve('src/server/purchasing/grnService.ts');
  const grnServiceContent = fs.readFileSync(grnServicePath, 'utf8');
  assert(grnServiceContent.includes('toDecimal') && grnServiceContent.includes('toMoney'), 'grnService must use toDecimal and toMoney for totals and quantities');
  console.log('Passed: grnService static checks');

  console.log('=== All Numeric Qty & Cost Verifications Passed ===');
}

verify().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
