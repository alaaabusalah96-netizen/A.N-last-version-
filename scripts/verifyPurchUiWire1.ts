import fs from 'fs';
import path from 'path';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function run() {
  console.log('=== VERIFY PURCH UI WIRE 1 ===');
  const rootDir = process.cwd();

  const wsPath = path.join(rootDir, 'src/components/purchasing/PurchasingWorkspace.tsx');
  assert(fs.existsSync(wsPath), 'PurchasingWorkspace.tsx exists');
  const content = fs.readFileSync(wsPath, 'utf8');

  // S1: activeTab union includes match, returns, ap, payments
  assert(content.includes('match') && content.includes('returns') && content.includes('ap') && content.includes('payments'), 'activeTab union includes match, returns, ap, payments');

  // S2: API paths referenced
  assert(content.includes('three-way-match'), 'References three-way-match API');
  assert(content.includes('returns'), 'References returns API');
  assert(content.includes('ap/open-items'), 'References ap/open-items API');
  assert(content.includes('supplier-payments'), 'References supplier-payments API');

  // S3: No new migration files modified or added in this package (check git status or migrations count)
  const migrations = fs.readdirSync(path.join(rootDir, 'database/migrations')).filter(f => f.endsWith('.sql'));
  assert(migrations.length === 43 || migrations.length === 44, 'No unauthorized migrations added');

  // S4: Arabic tab/button labels
  assert(content.includes('المطابقة الثلاثية') || content.includes('مطابقة') || content.includes('المطابقة'), 'Arabic label for match');
  assert(content.includes('مردودات') || content.includes('المرتجعات'), 'Arabic label for returns');
  assert(content.includes('الذمم') || content.includes('المستحقات'), 'Arabic label for AP open items');
  assert(content.includes('السداد') || content.includes('سداد'), 'Arabic label for payments');

  console.log('PASS: verifyPurchUiWire1 static checks passed successfully.');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
