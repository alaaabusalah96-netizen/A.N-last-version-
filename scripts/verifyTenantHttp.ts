import { check, blocked, summary, CookieJarFetch, loginAs } from './lib/testkit.js';
import { createApp } from '../src/server/app.js';
import { defaultUserRepository } from '../src/server/auth/userRepository.js';
import { defaultCompanyRepository } from '../src/server/org/companyRepository.js';
import { defaultMembershipRepository } from '../src/server/org/membershipRepository.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { Server } from 'http';

console.log('--- Running Tenant Isolation HTTP E2E Verification (R9.2) ---');

// Enable tenant demo routes for testing
process.env.ENABLE_TENANT_DEMO = '1';

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Tenant HTTP E2E tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Database executor unavailable for tenant HTTP test.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const app = createApp();
  let server: Server | undefined;
  let baseUrl = '';

  await new Promise<void>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const addr = s.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
    server = s;
  });

  try {
    const suffix = Date.now();
    const password = 'TenantHttpPass123!';
    const passwordHash = await hashPassword(password);

    // 1. Setup companies A and B
    const compA = await defaultCompanyRepository.create({ code: `TH_A_${suffix}`, nameAr: 'شركة هـ أ' });
    const compB = await defaultCompanyRepository.create({ code: `TH_B_${suffix}`, nameAr: 'شركة هـ ب' });

    // 2. Setup User A (member of A) and User Inactive (inactive member of A)
    const userA = await defaultUserRepository.createUser({
      username: `user_th_a_${suffix}@erp.local`,
      passwordHash,
      role: 'user',
    });

    const userInactive = await defaultUserRepository.createUser({
      username: `user_th_inact_${suffix}@erp.local`,
      passwordHash,
      role: 'user',
    });

    await defaultMembershipRepository.addMember(userA.id, compA.id, 'company_user', true);
    await defaultMembershipRepository.addMember(userInactive.id, compA.id, 'company_user', false);

    // 3. User A logs in
    const jarA = new CookieJarFetch();
    const { csrfToken: csrfA } = await loginAs(jarA, baseUrl, userA.username, password);

    // 4. User A creates item in Company A => 201
    const createRes = await jarA.fetch(`${baseUrl}/api/companies/${compA.id}/demo-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfA },
      body: JSON.stringify({ label: 'عنصر اختبار المستأجر أ' }),
    });
    const createData = await createRes.json();
    await check('User A creating demo item in Company A succeeds (201)', createRes.status === 201 && createData.item?.label === 'عنصر اختبار المستأجر أ');

    // 5. User A reads items in Company A => 200 & activeContextCompanyId matches
    const listRes = await jarA.fetch(`${baseUrl}/api/companies/${compA.id}/demo-items`);
    const listData = await listRes.json();
    await check(
      'User A reading demo items in Company A succeeds and context matches company ID',
      listRes.status === 200 && listData.companyId === compA.id && listData.activeContextCompanyId === compA.id && listData.items.length === 1
    );

    // 6. User A attempts read/write on Company B => 403
    const crossReadRes = await jarA.fetch(`${baseUrl}/api/companies/${compB.id}/demo-items`);
    await check('User A attempting read on Company B receives 403 Forbidden', crossReadRes.status === 403);

    const crossWriteRes = await jarA.fetch(`${baseUrl}/api/companies/${compB.id}/demo-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfA },
      body: JSON.stringify({ label: 'محاولة تسريب' }),
    });
    await check('User A attempting write on Company B receives 403 Forbidden', crossWriteRes.status === 403);

    // 7. Inactive user attempts access on Company A => 403
    const jarInact = new CookieJarFetch();
    const { csrfToken: csrfInact } = await loginAs(jarInact, baseUrl, userInactive.username, password);

    const inactRes = await jarInact.fetch(`${baseUrl}/api/companies/${compA.id}/demo-items`);
    await check('User with inactive membership attempting access receives 403 Forbidden', inactRes.status === 403);

  } finally {
    if (server) server.close();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
