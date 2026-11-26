import fs from 'fs';
import path from 'path';
import pg from 'pg';

function assert(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${label}`);
  }
  console.log(`[PASS] ${label}`);
}

function assertLoopbackUrl(raw: string, varName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${varName} is invalid URL format`);
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
  }
  return parsed;
}

async function run() {
  console.log('=== VERIFY AN-BANK-RECONCILE-1 (Bank Accounts & Simplified Reconciliation) ===');
  const rootDir = process.cwd();

  const mig046Path = path.join(rootDir, 'database/migrations/046_finance_ext.sql');
  assert(fs.existsSync(mig046Path), 'Migration 046_finance_ext.sql exists');
  const mig046 = fs.readFileSync(mig046Path, 'utf8');

  const bankTables = ['fin_bank_accounts', 'fin_bank_reconciliations', 'fin_bank_statement_lines'];
  for (const tbl of bankTables) {
    assert(mig046.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`), `Migration defines ${tbl}`);
    assert(mig046.includes(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`), `Migration enables RLS on ${tbl}`);
    assert(mig046.includes(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`), `Migration forces RLS on ${tbl}`);
    assert(mig046.includes(`ON ${tbl}`) && mig046.includes('app.current_tenant_id'), `Migration defines tenant policy on ${tbl}`);
  }
  assert(!/EXCEPTION\s+WHEN\s+OTHERS/i.test(mig046), 'Migration 046 does NOT contain EXCEPTION WHEN OTHERS');
  assert(mig046.includes('uq_journal_lines_company_id_id'), 'Migration 046 enforces composite key on journal_lines');

  const ownership = JSON.parse(fs.readFileSync(path.join(rootDir, 'database/table_ownership.json'), 'utf8')) as Array<{ table: string; scope: string }>;
  const ownershipMap = new Map(ownership.map((e) => [e.table, e.scope]));
  for (const tbl of bankTables) {
    assert(ownershipMap.get(tbl) === 'tenant', `table_ownership.json registers ${tbl} as tenant`);
  }

  const permsContent = fs.readFileSync(path.join(rootDir, 'src/server/rbac/permissions.ts'), 'utf8');
  assert(
    permsContent.includes("BANKING_READ: 'banking:read'") &&
      permsContent.includes("BANKING_WRITE: 'banking:write'") &&
      permsContent.includes("BANKING_RECONCILE: 'banking:reconcile'"),
    'permissions.ts defines BANKING_READ, BANKING_WRITE, and BANKING_RECONCILE'
  );

  const bankingFiles = [
    'src/server/banking/bankingTypes.ts',
    'src/server/banking/bankAccountRepository.ts',
    'src/server/banking/bankAccountService.ts',
    'src/server/banking/bankReconcileRepository.ts',
    'src/server/banking/bankReconcileService.ts',
    'src/server/routes/bankingRoutes.ts',
    'src/components/accounting/BankingReconcilePanel.tsx',
  ];
  for (const f of bankingFiles) {
    assert(fs.existsSync(path.join(rootDir, f)), `Module exists: ${f}`);
  }

  const appContent = fs.readFileSync(path.join(rootDir, 'src/server/app.ts'), 'utf8');
  assert(appContent.includes("app.use('/api/banking', bankingRoutes)"), 'app.ts mounts /api/banking router');

  const wsContent = fs.readFileSync(path.join(rootDir, 'src/components/accounting/AccountingWorkspace.tsx'), 'utf8');
  assert(wsContent.includes("'banking'") && wsContent.includes('BankingReconcilePanel'), 'AccountingWorkspace mounts banking tab');

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    console.log('[INFO] DATABASE_URL not set; static, RLS, RBAC, and UI wiring checks passed.');
    console.log('PASS: verifyBankReconcile1 completed successfully.');
    return;
  }

  assertLoopbackUrl(dbUrl, 'DATABASE_URL');
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const client = await pool.connect();
    try {
      const tblRes = await client.query<{ relname: string }>(
        `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [bankTables]
      );
      assert(tblRes.rows.length === bankTables.length, 'Live loopback DB has all 3 banking tables');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  // New bank account currency must come from the company default, not a hardcoded SAR in the UI or the service.
  const panelSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/accounting/BankingReconcilePanel.tsx'), 'utf8');
  assert(!/currencyCode:\s*'SAR'/.test(panelSrc), "Bank panel must not hardcode 'SAR' as the default currency");
  const svcSrc = fs.readFileSync(path.join(process.cwd(), 'src/server/banking/bankAccountService.ts'), 'utf8');
  assert(svcSrc.includes('defaultCurrencyCode'), 'Bank account service resolves the default currency from company settings');
  assert(panelSrc.includes('postableAssets.some((a) => a.id === prev.glAccountId)'), 'Bank panel re-validates the selected GL account against the current company list');
  assert(panelSrc.includes("usableAccounts(glJson.accounts || [], 'cash_register_gl_account')"), 'Bank panel hides receivable/custody accounts from the GL picker');
  const modalStart = panelSrc.indexOf('<form onSubmit={handleCreateBank}');
  const modalEnd = panelSrc.indexOf('</form>', modalStart);
  assert(panelSrc.slice(modalStart, modalEnd).includes('{error && ('), 'Create-bank errors are shown inside the modal, not behind it');
  console.log('PASS: verifyBankReconcile1 static and loopback DB checks passed.');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
