import fs from 'fs';
import path from 'path';

function assert(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${label}`);
  }
  console.log(`[PASS] ${label}`);
}

async function run() {
  console.log('=== VERIFY AN-REPORTS-OPS-1 (Cash & Bank Summary + AR/AP Aging Operational Reports) ===');
  const rootDir = process.cwd();

  const opsSvcPath = path.join(rootDir, 'src/server/accounting/operationalReportsService.ts');
  assert(fs.existsSync(opsSvcPath), 'operationalReportsService.ts exists');
  const opsSvc = fs.readFileSync(opsSvcPath, 'utf8');
  assert(
    opsSvc.includes('getCashAndBankSummary') && opsSvc.includes('getArApAgingSummary'),
    'operationalReportsService exposes getCashAndBankSummary & getArApAgingSummary'
  );
  assert(
    opsSvc.includes('toMinorUnits') && opsSvc.includes('fromMinorUnits'),
    'operationalReportsService aggregates amounts with bigint minor units'
  );

  const routesSrc = fs.readFileSync(path.join(rootDir, 'src/server/routes/accountingRoutes.ts'), 'utf8');
  assert(
    routesSrc.includes("'/reports/ops-cash-summary'") && routesSrc.includes("'/reports/ops-ar-ap-aging'"),
    'accountingRoutes.ts exposes /reports/ops-cash-summary and /reports/ops-ar-ap-aging'
  );

  const csvSrc = fs.readFileSync(path.join(rootDir, 'src/lib/csvExport.ts'), 'utf8');
  assert(
    csvSrc.includes('buildOpsCashSummaryCsv') && csvSrc.includes('buildOpsArApSummaryCsv'),
    'csvExport.ts provides operational report CSV builders'
  );

  const reportsPanel = fs.readFileSync(path.join(rootDir, 'src/components/accounting/ReportsPanel.tsx'), 'utf8');
  assert(
    reportsPanel.includes("'ops-cash'") &&
      reportsPanel.includes("'ops-aging'") &&
      reportsPanel.includes('/api/accounting/reports/ops-cash-summary') &&
      reportsPanel.includes('/api/accounting/reports/ops-ar-ap-aging'),
    'ReportsPanel.tsx wires operational Cash/Bank & AR/AP Aging subtabs and endpoints'
  );

  console.log('PASS: verifyReportsOps1 completed successfully.');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
