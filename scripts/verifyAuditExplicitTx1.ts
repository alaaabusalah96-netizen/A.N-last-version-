import fs from 'fs';
import path from 'path';

async function runVerification() {
  console.log('=== RUNNING AUDIT EXPLICIT TX VERIFICATION (AN-FIX-AUDIT-EXPLICIT-TX-1) ===');
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

  // Helper to check for explicit tx audit record
  function checkServiceForExplicitAudit(servicePath: string) {
    const content = fs.existsSync(servicePath) ? fs.readFileSync(servicePath, 'utf8') : '';
    // Look for patterns like .record({ ... }, { executor: tx })
    const hasExplicitAudit = /record\([\s\S]*?\{ executor: tx \}/.test(content);
    return hasExplicitAudit;
  }

  const grnServicePath = path.join(root, 'src/server/purchasing/grnService.ts');
  const journalServicePath = path.join(root, 'src/server/accounting/journalService.ts');

  assert(checkServiceForExplicitAudit(grnServicePath), 'S1: grnService.ts audit records pass { executor: tx }');
  assert(checkServiceForExplicitAudit(journalServicePath), 'S2: journalService.ts audit records pass { executor: tx }');

  // Verify no regression in stockService
  const stockServicePath = path.join(root, 'src/server/inventory/stockService.ts');
  assert(checkServiceForExplicitAudit(stockServicePath), 'S3: stockService.ts still uses { executor: tx }');

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
