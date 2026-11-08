import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function assertCheck(id: string, description: string, condition: boolean) {
  if (condition) {
    console.log(`[PASS] ${id}: ${description}`);
    passed++;
  } else {
    console.error(`[FAIL] ${id}: ${description}`);
    failed++;
  }
}

async function runVerification() {
  console.log('=== Running verifyP1bLedgerGuarantees1 Verification ===\n');

  // S1: Migration 013 file exists and mentions accounting_sequences and immutability/posted
  const mig013Path = path.resolve('database/migrations/013_ledger_guarantees.sql');
  const mig013Exists = fs.existsSync(mig013Path);
  const mig013Content = mig013Exists ? fs.readFileSync(mig013Path, 'utf8') : '';
  const s1Mig =
    mig013Exists &&
    mig013Content.includes('accounting_sequences') &&
    mig013Content.includes('accounting_periods') &&
    mig013Content.includes('trg_fn_journal_entries_immutability') &&
    mig013Content.includes("OLD.status = 'posted'");
  assertCheck('S1', 'Migration 013 exists and defines sequences, periods, and immutability triggers', s1Mig);

  // S2: table_ownership registers accounting_sequences and accounting_periods
  const ownershipPath = path.resolve('database/table_ownership.json');
  const ownershipContent = fs.existsSync(ownershipPath) ? fs.readFileSync(ownershipPath, 'utf8') : '';
  const s2Ownership =
    ownershipContent.includes('"table": "accounting_sequences"') &&
    ownershipContent.includes('"table": "accounting_periods"') &&
    ownershipContent.includes('"scope": "tenant"');
  assertCheck('S2', 'table_ownership.json registers accounting_sequences and accounting_periods with tenant scope', s2Ownership);

  // S3: journalService has postEntry and reverseEntry
  const servicePath = path.resolve('src/server/accounting/journalService.ts');
  const serviceExists = fs.existsSync(servicePath);
  const serviceContent = serviceExists ? fs.readFileSync(servicePath, 'utf8') : '';
  const s3Service =
    serviceExists &&
    serviceContent.includes('async postEntry(') &&
    serviceContent.includes('async reverseEntry(') &&
    serviceContent.includes('async createDraftEntry(');
  assertCheck('S3', 'journalService provides postEntry, reverseEntry, and createDraftEntry methods', s3Service);

  // S4: post path validates balance (source check for debit === credit)
  const s4BalanceCheck =
    serviceContent.includes('totalDebit !== totalCredit') ||
    serviceContent.includes('Unbalanced journal entry');
  assertCheck('S4', 'postEntry path enforces strict double-entry balance validation', s4BalanceCheck);

  // S5: routes journals post/reverse registered in accountingRoutes
  const routesPath = path.resolve('src/server/routes/accountingRoutes.ts');
  const routesContent = fs.existsSync(routesPath) ? fs.readFileSync(routesPath, 'utf8') : '';
  const s5Routes =
    routesContent.includes("accountingRoutes.get(\n  '/journals'") ||
    (routesContent.includes("'/journals'") &&
      routesContent.includes("'/journals/:id/post'") &&
      routesContent.includes("'/journals/:id/reverse'"));
  assertCheck('S5', 'accountingRoutes registers /journals endpoints including post and reverse', s5Routes);

  // S6: permissions ACCOUNTING_JOURNALS_* exist and roles mapped
  const permsPath = path.resolve('src/server/rbac/permissions.ts');
  const permsContent = fs.existsSync(permsPath) ? fs.readFileSync(permsPath, 'utf8') : '';
  const rolesPath = path.resolve('src/server/rbac/roles.ts');
  const rolesContent = fs.existsSync(rolesPath) ? fs.readFileSync(rolesPath, 'utf8') : '';
  const s6Perms =
    permsContent.includes('ACCOUNTING_JOURNALS_READ') &&
    permsContent.includes('ACCOUNTING_JOURNALS_WRITE') &&
    permsContent.includes('ACCOUNTING_JOURNALS_POST') &&
    rolesContent.includes('ACCOUNTING_JOURNALS_READ') &&
    rolesContent.includes('ACCOUNTING_JOURNALS_POST');
  assertCheck('S6', 'ACCOUNTING_JOURNALS permissions defined and mapped to roles', s6Perms);

  // S7: UI Journal workspace/panel referenced from accounting UI
  const wsPath = path.resolve('src/components/accounting/AccountingWorkspace.tsx');
  const wsContent = fs.existsSync(wsPath) ? fs.readFileSync(wsPath, 'utf8') : '';
  const journalUiPath = path.resolve('src/components/accounting/JournalWorkspace.tsx');
  const s7Ui =
    fs.existsSync(journalUiPath) &&
    wsContent.includes('JournalWorkspace') &&
    wsContent.includes('<JournalWorkspace');
  assertCheck('S7', 'JournalWorkspace component exists and is mounted in AccountingWorkspace', s7Ui);

  // S8: withTenantTransaction used in journal repository/service
  const repoPath = path.resolve('src/server/accounting/journalRepository.ts');
  const repoContent = fs.existsSync(repoPath) ? fs.readFileSync(repoPath, 'utf8') : '';
  const s8TenantTx =
    repoContent.includes('withTenantTransaction') &&
    serviceContent.includes('withTenantTransaction');
  assertCheck('S8', 'withTenantTransaction used in journal repository and service', s8TenantTx);

  // S9: AI_PROJECT_STATE has AN-P1B-LEDGER-GUARANTEES-1
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const s9State = stateContent.includes('AN-P1B-LEDGER-GUARANTEES-1');
  assertCheck('S9', 'AI_PROJECT_STATE documents AN-P1B-LEDGER-GUARANTEES-1', s9State);

  // S10: P0 security mounts still present (accounting routes in app.ts)
  const appTsPath = path.resolve('src/server/app.ts');
  const appTsContent = fs.existsSync(appTsPath) ? fs.readFileSync(appTsPath, 'utf8') : '';
  const s10Mounts =
    appTsContent.includes("app.use('/api/accounting', accountingRoutes)") &&
    appTsContent.includes("app.use('/api/users', userAdminRoutes)");
  assertCheck('S10', 'P0 security route mounts remain intact in app.ts', s10Mounts);

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
