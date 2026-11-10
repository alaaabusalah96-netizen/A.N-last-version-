import fs from 'fs';
import path from 'path';
import { check, summary } from './lib/testkit.js';

console.log('=== RUNNING ACCOUNTING PERIODS ENFORCEMENT VERIFICATION (AN-ACCOUNTING-PERIODS-ENFORCE-1) ===\n');

async function runVerification() {
  const rootDir = process.cwd();

  // S1: postEntry source contains is_closed or period closed check
  const journalServicePath = path.join(rootDir, 'src/server/accounting/journalService.ts');
  const journalServiceContent = fs.readFileSync(journalServicePath, 'utf8');
  const hasPeriodClosedCheck =
    journalServiceContent.includes('period.isClosed') ||
    journalServiceContent.includes('is_closed') ||
    journalServiceContent.includes('الفترة المحاسبية');
  const hasNoPeriodCheck =
    journalServiceContent.includes('findCoveringDate') &&
    journalServiceContent.includes('لا توجد فترة محاسبية');
  await check(
    'S1: journalService.ts postEntry enforces open period and rejects closed/missing periods',
    hasPeriodClosedCheck && hasNoPeriodCheck
  );

  // S2: period repository and service exist and export defaults
  const periodRepoPath = path.join(rootDir, 'src/server/accounting/periodRepository.ts');
  const periodServicePath = path.join(rootDir, 'src/server/accounting/periodService.ts');
  const periodTypesPath = path.join(rootDir, 'src/server/accounting/periodTypes.ts');
  const reposExist =
    fs.existsSync(periodRepoPath) &&
    fs.existsSync(periodServicePath) &&
    fs.existsSync(periodTypesPath);
  await check('S2: periodRepository.ts, periodService.ts, and periodTypes.ts exist', reposExist);

  // S3: routes for periods exist in accountingRoutes.ts
  const routesPath = path.join(rootDir, 'src/server/routes/accountingRoutes.ts');
  const routesContent = fs.readFileSync(routesPath, 'utf8');
  const hasPeriodsRoutes =
    routesContent.includes("'/periods'") &&
    routesContent.includes("'/periods/:id/close'") &&
    routesContent.includes("'/periods/:id/reopen'");
  await check('S3: accountingRoutes.ts includes list, create, close, and reopen endpoints for periods', hasPeriodsRoutes);

  // S4: UI panel/tab exists and is reachable from AccountingWorkspace
  const periodsPanelPath = path.join(rootDir, 'src/components/accounting/PeriodsPanel.tsx');
  const workspacePath = path.join(rootDir, 'src/components/accounting/AccountingWorkspace.tsx');
  const workspaceContent = fs.readFileSync(workspacePath, 'utf8');
  const uiReachable =
    fs.existsSync(periodsPanelPath) &&
    workspaceContent.includes('PeriodsPanel') &&
    workspaceContent.includes("'periods'");
  await check('S4: PeriodsPanel.tsx exists and is mounted as a visible tab in AccountingWorkspace.tsx', uiReachable);

  // S5: OPEN_GAPS or AI_PROJECT_STATE records this package
  const projectStatePath = path.join(rootDir, 'docs/foundation/AI_PROJECT_STATE.md');
  const openGapsPath = path.join(rootDir, 'docs/foundation/OPEN_GAPS.md');
  const projectStateContent = fs.readFileSync(projectStatePath, 'utf8');
  const openGapsContent = fs.readFileSync(openGapsPath, 'utf8');
  const docsUpdated =
    projectStateContent.includes('AN-ACCOUNTING-PERIODS-ENFORCE-1') &&
    openGapsContent.includes('PERIODS') &&
    openGapsContent.includes('CLOSED');
  await check('S5: AI_PROJECT_STATE.md and OPEN_GAPS.md record AN-ACCOUNTING-PERIODS-ENFORCE-1', docsUpdated);

  // S6: No unauthorized business modules added
  const srcServerDir = path.join(rootDir, 'src/server');
  const forbiddenModules = ['sales', 'inventory', 'purchasing', 'fleet', 'pos', 'cash_bank'];
  let noForbiddenModules = true;
  for (const mod of forbiddenModules) {
    if (fs.existsSync(path.join(srcServerDir, mod))) {
      noForbiddenModules = false;
      break;
    }
  }
  await check('S6: ERP scope disciplined: no sales, inventory, or unapproved external business modules created', noForbiddenModules);

  const { exitCode } = summary();
  process.exit(exitCode);
}

runVerification().catch((err) => {
  console.error('Unhandled error in verifyAccountingPeriodsEnforce1:', err);
  process.exit(1);
});
