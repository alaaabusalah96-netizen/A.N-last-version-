import 'dotenv/config';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { TenantDemoRepository } from '../src/server/org/tenantDemoRepository.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';

async function runTenantIsolationVerification() {
  console.log('--- Running AN-TENANT-ISOLATION-1 Verification ---');

  let passed = 0;
  let failed = 0;
  let blocked = 0;

  const databaseUrl = process.env.DATABASE_URL;
  const requireDb = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true';

  if (!databaseUrl || databaseUrl.trim() === '') {
    console.log('[BLOCKED] DATABASE_URL is not set. Live RLS tenant isolation tests are BLOCKED.');
    blocked++;
    console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked}`);
    if (requireDb) {
      console.error('[FAIL] REQUIRE_DB=1 is set but DATABASE_URL is missing.');
      process.exit(1);
    }
    process.exit(0);
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    console.log('[BLOCKED] Failed to connect to PostgreSQL database.');
    blocked++;
    console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked}`);
    process.exit(requireDb ? 1 : 0);
  }

  try {
    const companyRepo = new CompanyRepository();
    const demoRepo = new TenantDemoRepository();

    const suffix = Date.now();
    const codeA = `TCA_${suffix}`;
    const codeB = `TCB_${suffix}`;

    // 1) Create Company A and B
    const compA = await companyRepo.create({ code: codeA, nameAr: 'شركة أ', createdBy: '' });
    const compB = await companyRepo.create({ code: codeB, nameAr: 'شركة ب', createdBy: '' });

    if (compA && compB) {
      console.log('[PASS] Created test companies A and B');
      passed++;
    } else {
      console.error('[FAIL] Failed to create test companies');
      failed++;
    }

    // 2) Insert items via withTenantTransaction
    const itemA = await demoRepo.createItem(compA.id, 'Item for A');
    const itemB = await demoRepo.createItem(compB.id, 'Item for B');

    if (itemA && itemB) {
      console.log('[PASS] Inserted demo items within tenant transactions');
      passed++;
    } else {
      console.error('[FAIL] Failed to insert demo items');
      failed++;
    }

    // 3) Select items under transaction A -> should only see A items
    const listA = await demoRepo.listItems(compA.id);
    if (listA.length === 1 && listA[0].label === 'Item for A') {
      console.log('[PASS] Tenant A transaction correctly isolates and sees only Tenant A items');
      passed++;
    } else {
      console.error('[FAIL] Tenant A item isolation check failed', listA);
      failed++;
    }

    // 4) Select items under transaction B -> should only see B items
    const listB = await demoRepo.listItems(compB.id);
    if (listB.length === 1 && listB[0].label === 'Item for B') {
      console.log('[PASS] Tenant B transaction correctly isolates and sees only Tenant B items');
      passed++;
    } else {
      console.error('[FAIL] Tenant B item isolation check failed', listB);
      failed++;
    }

    // 5) Empty companyId transaction -> must throw
    let errorThrown = false;
    try {
      await withTenantTransaction('', async (tx) => {
        await tx.query('SELECT 1');
      });
    } catch {
      errorThrown = true;
    }

    if (errorThrown) {
      console.log('[PASS] Empty companyId transaction correctly throws error (fail-closed)');
      passed++;
    } else {
      console.error('[FAIL] Empty companyId transaction should have thrown error');
      failed++;
    }
  } catch (err: unknown) {
    console.error('[FAIL] Exception during tenant isolation verification:', err);
    failed++;
  }

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTenantIsolationVerification().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
