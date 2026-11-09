import { check, blocked, summary } from './lib/testkit.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { TenantDemoRepository } from '../src/server/org/tenantDemoRepository.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { getExecutorForCompany, getDefaultExecutor } from '../src/server/db/index.js';

console.log('--- Running Tenant Isolation Verification ---');

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live RLS tenant isolation tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    const executor = await getDefaultExecutor();
    if (!executor) {
      blocked('Unable to connect to database for tenant isolation test.');
      const { exitCode } = summary();
      process.exit(exitCode);
      return;
    }

    // Role check: Ensure not running as superuser or bypassrls role
    const roleCheckRes = await executor.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    const userRole = roleCheckRes.rows[0];

    const isSuperOrBypass = userRole && (userRole.rolsuper || userRole.rolbypassrls);
    if (isSuperOrBypass) {
      await check(
        'Isolation test role check (must NOT be superuser or BYPASSRLS)',
        false,
        'Connected user has BYPASSRLS or SUPERUSER privileges which bypasses RLS'
      );
      const { exitCode } = summary();
      process.exit(exitCode);
      return;
    }

    await check('Role is restricted (NOBYPASSRLS and NOSUPERUSER)', true);

    const companyRepo = new CompanyRepository();
    const demoRepo = new TenantDemoRepository();

    const suffix = Date.now();
    const codeA = `ISO_A_${suffix}`;
    const codeB = `ISO_B_${suffix}`;

    // Create test companies A and B
    const compA = await companyRepo.create({ code: codeA, nameAr: 'شركة العزل أ', createdBy: null });
    const compB = await companyRepo.create({ code: codeB, nameAr: 'شركة العزل ب', createdBy: null });

    await check('Created test companies A and B', Boolean(compA && compB));

    // 1 & 2) Insert items and check visibility
    const itemA = await demoRepo.createItem(compA.id, 'Demo Item Company A');
    const itemB = await demoRepo.createItem(compB.id, 'Demo Item Company B');

    const listA = await demoRepo.listItems(compA.id);
    await check(
      'Company A transaction sees ONLY Company A items',
      listA.length === 1 && listA[0].id === itemA.id
    );

    const listB = await demoRepo.listItems(compB.id);
    await check(
      'Company B transaction sees ONLY Company B items',
      listB.length === 1 && listB[0].id === itemB.id
    );

    // 3) Direct query without set_config returns 0 rows due to RLS
    const directRes = await executor.query('SELECT * FROM tenant_demo_items;');
    await check(
      'Direct query on RLS table without set_config returns 0 rows',
      directRes.rows.length === 0
    );

    // 4) Attempting to INSERT B's company_id inside A's transaction fails WITH CHECK
    let checkFailed = false;
    try {
      await withTenantTransaction(compA.id, async (tx) => {
        await tx.query(
          'INSERT INTO tenant_demo_items (company_id, label) VALUES ($1, $2)',
          [compB.id, 'Cross-tenant write attempt']
        );
      });
    } catch {
      checkFailed = true;
    }
    await check(
      'Cross-tenant write with mismatched company_id is rejected by RLS WITH CHECK',
      checkFailed
    );

    // 5) Calling withTenantTransaction('') throws TENANT_CONTEXT_REQUIRED
    let emptyTxFailed = false;
    try {
      await withTenantTransaction('', async (tx) => {
        await tx.query('SELECT 1');
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emptyTxFailed = msg.includes('TENANT_CONTEXT_REQUIRED');
    }
    await check('withTenantTransaction("") throws TENANT_CONTEXT_REQUIRED', emptyTxFailed);

    // 6) Concurrency test: 40 parallel withTenantTransaction calls alternating A and B
    const tasks = Array.from({ length: 40 }, (_, i) => {
      const targetCompany = i % 2 === 0 ? compA : compB;
      const expectedLabel = i % 2 === 0 ? 'Demo Item Company A' : 'Demo Item Company B';

      return withTenantTransaction(targetCompany.id, async (tx) => {
        const res = await tx.query<{ label: string }>('SELECT label FROM tenant_demo_items');
        return res.rows.length === 1 && res.rows[0].label === expectedLabel;
      });
    });

    const concurrencyResults = await Promise.all(tasks);
    const allConcurrentIsolated = concurrencyResults.every((res) => res === true);
    await check('40 parallel concurrent transactions maintained strict RLS isolation', allConcurrentIsolated);

    // 7) Session setting reset check on new pool client
    const freshExecutor = await getDefaultExecutor();
    if (freshExecutor) {
      const settingRes = await freshExecutor.query<{ val: string }>(
        "SELECT current_setting('app.current_tenant_id', true) as val"
      );
      const val = settingRes.rows[0]?.val;
      await check(
        'Tenant context variable resets after transaction completion',
        !val || val === ''
      );
    }

    // 8) getExecutorForCompany('') throws TENANT_CONTEXT_REQUIRED
    let emptyExecFailed = false;
    try {
      await getExecutorForCompany('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emptyExecFailed = msg.includes('TENANT_CONTEXT_REQUIRED');
    }
    await check('getExecutorForCompany("") throws TENANT_CONTEXT_REQUIRED', emptyExecFailed);

    // Cleanup test data
    await executor.query('DELETE FROM tenant_demo_items WHERE company_id IN ($1, $2)', [compA.id, compB.id]);
    await executor.query('DELETE FROM companies WHERE id IN ($1, $2)', [compA.id, compB.id]);
  } catch (err) {
    await check('Tenant isolation test execution', false, err instanceof Error ? err.message : String(err));
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
