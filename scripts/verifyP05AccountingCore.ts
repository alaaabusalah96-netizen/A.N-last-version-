import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;
let blocked = 0;

function assertCheck(id: string, description: string, condition: boolean) {
  if (condition) {
    console.log(`[PASS] ${id}: ${description}`);
    passed++;
  } else {
    console.error(`[FAIL] ${id}: ${description}`);
    failed++;
  }
}

async function verifyP05() {
  console.log('=== Running verifyP05AccountingCore Verification ===\n');

  // S1: Migration 011 exists & defines accounts + RLS + an_app policy
  const migPath = path.resolve('database/migrations/011_accounting_core.sql');
  const migExists = fs.existsSync(migPath);
  const migContent = migExists ? fs.readFileSync(migPath, 'utf8') : '';
  const migValid =
    migExists &&
    migContent.includes('CREATE TABLE IF NOT EXISTS accounts') &&
    migContent.includes('ALTER TABLE accounts ENABLE ROW LEVEL SECURITY') &&
    migContent.includes('ALTER TABLE accounts FORCE ROW LEVEL SECURITY') &&
    migContent.includes('accounts_tenant_isolation ON accounts') &&
    migContent.includes('TO an_app');
  assertCheck('S1', 'Migration 011 exists and defines accounts with forced RLS & an_app policy', migValid);

  // S2: table_ownership registers accounts as tenant scope
  const ownershipPath = path.resolve('database/table_ownership.json');
  const ownershipContent = fs.existsSync(ownershipPath) ? fs.readFileSync(ownershipPath, 'utf8') : '[]';
  const ownershipData = JSON.parse(ownershipContent);
  const accountsRegistered = ownershipData.some((t: any) => t.table === 'accounts' && t.scope === 'tenant');
  assertCheck('S2', 'table_ownership.json registers accounts as tenant scope', accountsRegistered);

  // S3: accountingRoutes mounted in routes/index.ts
  const routesIndexPath = path.resolve('src/server/routes/index.ts');
  const routesIndexContent = fs.readFileSync(routesIndexPath, 'utf8');
  const routesMounted =
    routesIndexContent.includes('/accounting') && routesIndexContent.includes('accountingRoutes');
  assertCheck('S3', 'accountingRoutes imported and mounted at /accounting in routes/index.ts', routesMounted);

  // S4: accountService exports required methods
  const servicePath = path.resolve('src/server/accounting/accountService.ts');
  const serviceExists = fs.existsSync(servicePath);
  const serviceContent = serviceExists ? fs.readFileSync(servicePath, 'utf8') : '';
  const serviceValid =
    serviceExists &&
    serviceContent.includes('seedDefaultCoa') &&
    serviceContent.includes('listAccounts') &&
    serviceContent.includes('createAccount');
  assertCheck('S4', 'accountService exists and exports seedDefaultCoa, listAccounts, createAccount', serviceValid);

  // S5: App.tsx has navigation label المحاسبة and renders AccountingWorkspace
  const appPath = path.resolve('src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');
  const appValid =
    appContent.includes('المحاسبة') && appContent.includes('AccountingWorkspace');
  assertCheck('S5', 'App.tsx contains navigation label المحاسبة and renders AccountingWorkspace', appValid);

  // S6: AccountingWorkspace fetches accounts API
  const wsPath = path.resolve('src/components/accounting/AccountingWorkspace.tsx');
  const wsExists = fs.existsSync(wsPath);
  const wsContent = wsExists ? fs.readFileSync(wsPath, 'utf8') : '';
  const wsValid = wsExists && (wsContent.includes('/api/companies') || wsContent.includes('AccountsPanel'));
  assertCheck('S6', 'AccountingWorkspace component exists and integrates company selection & AccountsPanel', wsValid);

  // S7: AccountsPanel has seed and create affordances
  const panelPath = path.resolve('src/components/accounting/AccountsPanel.tsx');
  const panelExists = fs.existsSync(panelPath);
  const panelContent = panelExists ? fs.readFileSync(panelPath, 'utf8') : '';
  const panelValid =
    panelExists &&
    panelContent.includes('/api/accounting/accounts') &&
    panelContent.includes('seed-default') &&
    panelContent.includes('حساب جديد');
  assertCheck('S7', 'AccountsPanel component exists with seed-default and new account modal affordances', panelValid);

  // S8: No firebase imports in codebase
  const searchFirebase = (dir: string): boolean => {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue;
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (searchFirebase(full)) return true;
      } else if (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js')) {
        const c = fs.readFileSync(full, 'utf8');
        if (c.includes("from 'firebase'") || c.includes('from "firebase"')) return true;
      }
    }
    return false;
  };
  const hasFirebase = searchFirebase(path.resolve('src'));
  assertCheck('S8', 'No firebase imports present in codebase', !hasFirebase);

  // S9: AI_PROJECT_STATE marks AN-P05-ACCOUNTING-CORE-1 as IMPLEMENTED
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.readFileSync(statePath, 'utf8');
  const stateValid = stateContent.includes('AN-P05-ACCOUNTING-CORE-1') && stateContent.includes('IMPLEMENTED');
  assertCheck('S9', 'AI_PROJECT_STATE.md marks AN-P05-ACCOUNTING-CORE-1 as IMPLEMENTED', stateValid);

  // S10: P05_STARTED set to YES in docs
  const p05Started = stateContent.includes('P05_STARTED: `YES`') || stateContent.includes('P05_STARTED=YES');
  assertCheck('S10', 'AI_PROJECT_STATE.md records P05_STARTED: YES for accounting core', p05Started);

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

verifyP05().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
