import fs from 'fs';
import path from 'path';
import { check, summary } from './lib/testkit.js';

console.log('=== RUNNING ACCOUNTING PERIODS HARDENING VERIFICATION (AN-ACCOUNTING-PERIODS-HARDEN-1) ===\n');

async function runVerification() {
  const rootDir = process.cwd();

  // 1. S1: createPeriod path mentions overlap or overlapping range check
  const periodServicePath = path.join(rootDir, 'src/server/accounting/periodService.ts');
  const periodRepoPath = path.join(rootDir, 'src/server/accounting/periodRepository.ts');
  const periodServiceContent = fs.readFileSync(periodServicePath, 'utf8');
  const periodRepoContent = fs.readFileSync(periodRepoPath, 'utf8');

  const s1OverlapCheck =
    periodServiceContent.includes('findOverlapping') &&
    periodRepoContent.includes('findOverlapping') &&
    periodRepoContent.includes('start_date <= $3::date') &&
    periodRepoContent.includes('end_date >= $2::date') &&
    (periodServiceContent.includes('تتعارض تواريخ الفترة') || periodServiceContent.includes('تداخل'));
  await check(
    'S1: createPeriod rejects overlapping fiscal period ranges for the same company_id',
    s1OverlapCheck
  );

  // 2. S2: postEntry checks entryDate against period bounds when periodId is specified
  const journalServicePath = path.join(rootDir, 'src/server/accounting/journalService.ts');
  const journalServiceContent = fs.readFileSync(journalServicePath, 'utf8');

  const s2PeriodBoundsCheck =
    journalServiceContent.includes('entry.entryDate < period.startDate || entry.entryDate > period.endDate') &&
    journalServiceContent.includes('يقع خارج نطاق الفترة المحاسبية المحددة');
  await check(
    'S2: postEntry validates entryDate strictly falls within [startDate, endDate] when periodId is specified',
    s2PeriodBoundsCheck
  );

  // 3. S3: FOR UPDATE appears in period repository and postEntry/closePeriod locking paths
  const s3Locking =
    periodRepoContent.includes('findByIdForUpdate') &&
    periodRepoContent.includes('findCoveringDateForUpdate') &&
    periodRepoContent.includes('FOR UPDATE') &&
    periodServiceContent.includes('findByIdForUpdate') &&
    journalServiceContent.includes('findByIdForUpdate') &&
    journalServiceContent.includes('findCoveringDateForUpdate');
  await check(
    'S3: Row locking (SELECT ... FOR UPDATE) is enforced on period rows in closePeriod, reopenPeriod, and postEntry',
    s3Locking
  );

  // 4. S4: PeriodsPanel UI component is present and wired
  const periodsPanelPath = path.join(rootDir, 'src/components/accounting/PeriodsPanel.tsx');
  const workspacePath = path.join(rootDir, 'src/components/accounting/AccountingWorkspace.tsx');
  const periodsPanelContent = fs.existsSync(periodsPanelPath) ? fs.readFileSync(periodsPanelPath, 'utf8') : '';
  const workspaceContent = fs.existsSync(workspacePath) ? fs.readFileSync(workspacePath, 'utf8') : '';

  const s4UiPresent =
    fs.existsSync(periodsPanelPath) &&
    periodsPanelContent.includes('PeriodsPanel') &&
    workspaceContent.includes('PeriodsPanel') &&
    workspaceContent.includes("'periods'");
  await check('S4: PeriodsPanel.tsx remains present and mounted in AccountingWorkspace.tsx', s4UiPresent);

  // 5. S5: Package recorded in AI_PROJECT_STATE.md and OPEN_GAPS.md
  const projectStatePath = path.join(rootDir, 'docs/foundation/AI_PROJECT_STATE.md');
  const openGapsPath = path.join(rootDir, 'docs/foundation/OPEN_GAPS.md');
  const projectStateContent = fs.readFileSync(projectStatePath, 'utf8');
  const openGapsContent = fs.readFileSync(openGapsPath, 'utf8');

  const s5DocsRecorded =
    projectStateContent.includes('AN-ACCOUNTING-PERIODS-HARDEN-1') &&
    openGapsContent.includes('PERIODS');
  await check(
    'S5: Package AN-ACCOUNTING-PERIODS-HARDEN-1 documented in AI_PROJECT_STATE.md and OPEN_GAPS.md',
    s5DocsRecorded
  );

  // 6. S6: No unapproved external ERP business modules created
  const srcServerDir = path.join(rootDir, 'src/server');
  const forbiddenModules = ['sales', 'inventory', 'purchasing', 'fleet', 'pos', 'cash_bank'];
  let noForbiddenModules = true;
  for (const mod of forbiddenModules) {
    if (fs.existsSync(path.join(srcServerDir, mod))) {
      noForbiddenModules = false;
      break;
    }
  }
  await check(
    'S6: Scope discipline preserved (no unapproved external business modules created)',
    noForbiddenModules
  );

  const { exitCode } = summary();
  process.exit(exitCode);
}

runVerification().catch((err) => {
  console.error('Unhandled error in verifyAccountingPeriodsHarden1:', err);
  process.exit(1);
});
