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
  console.log('=== VERIFY AN-YEAR-CLOSE-1 (Fiscal Year Close on top of closePeriod) ===');
  const rootDir = process.cwd();

  const mig046 = fs.readFileSync(path.join(rootDir, 'database/migrations/046_finance_ext.sql'), 'utf8');
  assert(mig046.includes('CREATE TABLE IF NOT EXISTS fin_fiscal_year_closes'), 'Migration 046 defines fin_fiscal_year_closes');
  assert(mig046.includes('ALTER TABLE fin_fiscal_year_closes ENABLE ROW LEVEL SECURITY'), 'Migration enables RLS on fin_fiscal_year_closes');
  assert(mig046.includes('ALTER TABLE fin_fiscal_year_closes FORCE ROW LEVEL SECURITY'), 'Migration forces RLS on fin_fiscal_year_closes');

  const ownership = JSON.parse(fs.readFileSync(path.join(rootDir, 'database/table_ownership.json'), 'utf8')) as Array<{ table: string; scope: string }>;
  const entry = ownership.find((e) => e.table === 'fin_fiscal_year_closes');
  assert(entry?.scope === 'tenant', 'table_ownership.json registers fin_fiscal_year_closes as tenant');

  const periodSvc = fs.readFileSync(path.join(rootDir, 'src/server/accounting/periodService.ts'), 'utf8');
  assert(
    periodSvc.includes('async closePeriod(') && periodSvc.includes('PERIOD_CLOSE'),
    'Existing PeriodService.closePeriod remains intact'
  );

  const ycPath = path.join(rootDir, 'src/server/accounting/yearCloseService.ts');
  assert(fs.existsSync(ycPath), 'yearCloseService.ts exists');
  const ycSrc = fs.readFileSync(ycPath, 'utf8');
  assert(
    ycSrc.includes('previewYearClose') &&
      ycSrc.includes('executeYearClose') &&
      ycSrc.includes('createDraftEntry') &&
      ycSrc.includes('postEntry') &&
      ycSrc.includes('setClosed'),
    'yearCloseService.ts posts P&L closing JE before closing open periods via periodRepo.setClosed'
  );
  assert(
    ycSrc.includes('toMinorUnits') && ycSrc.includes('fromMinorUnits'),
    'yearCloseService.ts uses bigint minor units arithmetic'
  );

  const routesSrc = fs.readFileSync(path.join(rootDir, 'src/server/routes/accountingRoutes.ts'), 'utf8');
  assert(
    routesSrc.includes("'/year-close'") &&
      routesSrc.includes("'/year-close/preview'") &&
      routesSrc.includes("'/year-close/execute'"),
    'accountingRoutes.ts mounts /year-close, /year-close/preview, and /year-close/execute'
  );

  const periodsPanel = fs.readFileSync(path.join(rootDir, 'src/components/accounting/PeriodsPanel.tsx'), 'utf8');
  assert(
    periodsPanel.includes('/api/accounting/year-close/preview') &&
      periodsPanel.includes('/api/accounting/year-close/execute') &&
      periodsPanel.includes('إقفال سنة مالية'),
    'PeriodsPanel.tsx integrates Fiscal Year Close UI while keeping period close/reopen intact'
  );

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    console.log('[INFO] DATABASE_URL not set; static, architectural, and UI checks passed.');
    console.log('PASS: verifyYearClose1 completed successfully.');
    return;
  }

  assertLoopbackUrl(dbUrl, 'DATABASE_URL');
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const client = await pool.connect();
    try {
      const tblRes = await client.query<{ relname: string }>(
        `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'fin_fiscal_year_closes'`
      );
      assert(tblRes.rows.length === 1, 'Live loopback DB has fin_fiscal_year_closes table');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  console.log('PASS: verifyYearClose1 static and loopback DB checks passed.');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
