import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';

console.log('--- Running DB Wiring & SSL Hardening Verification ---');

const rootDir = process.cwd();

async function runTests() {
  // Check 1: getExecutorForCompany is exported in src/server/db/index.ts
  const dbIndexPath = path.join(rootDir, 'src/server/db/index.ts');
  const dbIndexContent = fs.readFileSync(dbIndexPath, 'utf8');

  await check(
    'getExecutorForCompany is defined and exported in src/server/db/index.ts',
    dbIndexContent.includes('export async function getExecutorForCompany')
  );

  // Check 2: TenantDatabaseResolver is imported and wired
  await check(
    'TenantDatabaseResolver is imported and actively wired to company resolution',
    dbIndexContent.includes('TenantDatabaseResolver') && dbIndexContent.includes('defaultResolver.resolve')
  );

  // Check 3: Behavioral test - getExecutorForCompany('') throws TENANT_CONTEXT_REQUIRED error
  await check(
    'getExecutorForCompany("") throws TENANT_CONTEXT_REQUIRED error (fail-closed)',
    async () => {
      try {
        const { getExecutorForCompany } = await import('../src/server/db/index.js');
        await getExecutorForCompany('');
        return false; // Should have thrown
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return msg.includes('TENANT_CONTEXT_REQUIRED');
      }
    }
  );

  // Check 4: Safe SSL enforcement
  const adapterPath = path.join(rootDir, 'src/server/db/adapters/PostgresqlAdapter.ts');
  const adapterContent = fs.readFileSync(adapterPath, 'utf8');

  await check(
    'PostgresqlAdapter enforces safe production SSL (rejectUnauthorized true by default)',
    adapterContent.includes('DATABASE_SSL_REJECT_UNAUTHORIZED') &&
      adapterContent.includes("rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'")
  );

  // Check 5: Live DB probe
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
    await check('Live DB probe health check', async () => {
      const { getDefaultExecutor } = await import('../src/server/db/index.js');
      const executor = await getDefaultExecutor();
      if (!executor) return false;
      const health = await executor.health();
      return health.ok === true;
    });
  } else {
    blocked('Live DB probe skipped (DATABASE_URL is not set in environment)');
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
