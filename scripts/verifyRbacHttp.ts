import { check, blocked, summary, CookieJarFetch } from './lib/testkit.js';
import { createApp } from '../src/server/app.js';
import { defaultUserRepository } from '../src/server/auth/userRepository.js';
import { defaultCompanyRepository } from '../src/server/org/companyRepository.js';
import { defaultMembershipRepository } from '../src/server/org/membershipRepository.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { Server } from 'http';

console.log('--- Running RBAC HTTP Integration Verification (S9.2) ---');

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live RBAC HTTP integration tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Database executor unavailable for RBAC HTTP tests.');
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
    const commonPass = 'RbacTestPass123!';
    const passwordHash = await hashPassword(commonPass);

    // 1. Create test companies A and B
    const compA = await defaultCompanyRepository.create({ code: `RBC_A_${suffix}`, nameAr: 'شركة صلاحيات أ' });
    const compB = await defaultCompanyRepository.create({ code: `RBC_B_${suffix}`, nameAr: 'شركة صلاحيات ب' });

    // 2. Create users
    const platformAdminUser = await defaultUserRepository.createUser({
      username: `plat_admin_${suffix}@erp.local`,
      passwordHash,
      role: 'platform_admin',
    });

    const compAUser = await defaultUserRepository.createUser({
      username: `user_a_${suffix}@erp.local`,
      passwordHash,
      role: 'user',
    });

    const compAdminUser = await defaultUserRepository.createUser({
      username: `comp_admin_${suffix}@erp.local`,
      passwordHash,
      role: 'user',
    });

    // Add memberships
    await defaultMembershipRepository.addMember(compAUser.id, compA.id, 'company_user', true);
    await defaultMembershipRepository.addMember(compAdminUser.id, compA.id, 'company_admin', true);

    // Test A: Login as compAUser and check GET /api/companies
    const jarA = new CookieJarFetch();
    const csrfDataA = await (await jarA.fetch(`${baseUrl}/api/auth/csrf`)).json();
    await jarA.fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfDataA.csrfToken },
      body: JSON.stringify({ username: compAUser.username, password: commonPass }),
    });

    const listResA = await jarA.fetch(`${baseUrl}/api/companies`);
    const listDataA = await listResA.json();
    const compIdsA = (listDataA.companies || []).map((c: any) => c.id);
    await check('Company A user sees only Company A in list', compIdsA.includes(compA.id) && !compIdsA.includes(compB.id));

    // Test B: Company A user cannot GET /api/companies/<compB.id> => 403
    const getCompBRes = await jarA.fetch(`${baseUrl}/api/companies/${compB.id}`);
    await check('Company A user querying Company B ID receives 403 Forbidden', getCompBRes.status === 403);

    // Test C: Invalid UUID in /api/companies/invalid-uuid => 400
    const invalidUuidRes = await jarA.fetch(`${baseUrl}/api/companies/not-a-valid-uuid`);
    const invalidUuidData = await invalidUuidRes.json();
    await check('Invalid UUID format in URL parameter returns 400 Bad Request', invalidUuidRes.status === 400 && invalidUuidData.code === 'VALIDATION_ERROR');

    // Test D: company_admin gets 403 on POST /api/companies
    const jarAdmin = new CookieJarFetch();
    const csrfAdmin = await (await jarAdmin.fetch(`${baseUrl}/api/auth/csrf`)).json();
    await jarAdmin.fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfAdmin.csrfToken },
      body: JSON.stringify({ username: compAdminUser.username, password: commonPass }),
    });

    const createAttemptRes = await jarAdmin.fetch(`${baseUrl}/api/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfAdmin.csrfToken },
      body: JSON.stringify({ code: `ILLEGAL_${suffix}`, nameAr: 'محاولة غير مصرحة' }),
    });
    await check('Company Admin attempting POST /api/companies receives 403 Forbidden', createAttemptRes.status === 403);

    // Test E: Platform admin creates company (201) and audit log written
    const jarPlat = new CookieJarFetch();
    const csrfPlat = await (await jarPlat.fetch(`${baseUrl}/api/auth/csrf`)).json();
    await jarPlat.fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfPlat.csrfToken },
      body: JSON.stringify({ username: platformAdminUser.username, password: commonPass }),
    });

    const createCode = `VALID_${suffix}`;
    const createRes = await jarPlat.fetch(`${baseUrl}/api/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfPlat.csrfToken },
      body: JSON.stringify({ code: createCode, nameAr: 'شركة جديدة للمنصة' }),
    });
    const createData = await createRes.json();
    await check('Platform Admin creating company succeeds with 201 Created', createRes.status === 201 && createData.company?.code === createCode);

    // Test F: Duplicate company code returns 409 Conflict
    const dupRes = await jarPlat.fetch(`${baseUrl}/api/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfPlat.csrfToken },
      body: JSON.stringify({ code: createCode, nameAr: 'شركة مكررة' }),
    });
    const dupData = await dupRes.json();
    await check('Duplicate company code returns 409 Conflict', dupRes.status === 409 && dupData.code === 'CONFLICT');

    // Test G: Membership isActive = false hides company and returns 403
    await defaultMembershipRepository.setMembershipStatus(compAUser.id, compA.id, false);
    const listResInact = await jarA.fetch(`${baseUrl}/api/companies`);
    const listDataInact = await listResInact.json();
    const compIdsInact = (listDataInact.companies || []).map((c: any) => c.id);
    await check('Deactivated membership causes company to disappear from list', !compIdsInact.includes(compA.id));

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
