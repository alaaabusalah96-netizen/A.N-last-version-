import { check, blocked, summary, CookieJarFetch, loginAs } from './lib/testkit.js';
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

    // Test A: Login as compAUser using loginAs and check GET /api/companies
    const jarA = new CookieJarFetch();
    const { csrfToken: csrfA } = await loginAs(jarA, baseUrl, compAUser.username, commonPass);

    const listResA = await jarA.fetch(`${baseUrl}/api/companies`);
    const listDataA = await listResA.json();
    const compIdsA = (listDataA.companies || []).map((c: any) => c.id);
    await check('Company A user sees only Company A in list', compIdsA.includes(compA.id) && !compIdsA.includes(compB.id));

    // Test B: Company A user cannot GET /api/companies/<compB.id> => 403 Forbidden with code
    const getCompBRes = await jarA.fetch(`${baseUrl}/api/companies/${compB.id}`);
    const getCompBData = await getCompBRes.json().catch(() => ({}));
    await check(
      'Company A user querying Company B ID receives 403 Forbidden with code FORBIDDEN',
      getCompBRes.status === 403 && getCompBData.code === 'FORBIDDEN'
    );

    // Test C: Invalid UUID in /api/companies/invalid-uuid => 400 Bad Request
    const invalidUuidRes = await jarA.fetch(`${baseUrl}/api/companies/not-a-valid-uuid`);
    const invalidUuidData = await invalidUuidRes.json();
    await check('Invalid UUID format in URL parameter returns 400 Bad Request', invalidUuidRes.status === 400 && invalidUuidData.code === 'VALIDATION_ERROR');

    // Test D: company_admin gets 403 on POST /api/companies with code = FORBIDDEN_PLATFORM_ADMIN (verifying RBAC rejected it, not CSRF)
    const jarAdmin = new CookieJarFetch();
    const { csrfToken: csrfAdmin } = await loginAs(jarAdmin, baseUrl, compAdminUser.username, commonPass);

    const createAttemptRes = await jarAdmin.fetch(`${baseUrl}/api/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfAdmin },
      body: JSON.stringify({ code: `ILLEGAL_${suffix}`, nameAr: 'محاولة غير مصرحة' }),
    });
    const createAttemptData = await createAttemptRes.json().catch(() => ({}));
    await check(
      'Company Admin attempting POST /api/companies receives 403 with code FORBIDDEN_PLATFORM_ADMIN',
      createAttemptRes.status === 403 && createAttemptData.code === 'FORBIDDEN_PLATFORM_ADMIN'
    );

    // Test E: Platform admin creates company (201) and audit log written
    const jarPlat = new CookieJarFetch();
    const { csrfToken: csrfPlat } = await loginAs(jarPlat, baseUrl, platformAdminUser.username, commonPass);

    const createCode = `VALID_${suffix}`;
    const createRes = await jarPlat.fetch(`${baseUrl}/api/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfPlat },
      body: JSON.stringify({ code: createCode, nameAr: 'شركة جديدة للمنصة' }),
    });
    const createData = await createRes.json();
    await check('Platform Admin creating company succeeds with 201 Created', createRes.status === 201 && createData.company?.code === createCode);

    // Verify audit_logs record was written with event = 'company.create'
    const auditRes = await executor.query<{ event: string }>(
      'SELECT event FROM audit_logs WHERE company_id = $1 AND event = $2',
      [createData.company.id, 'company.create']
    );
    await check('audit_logs records company.create event after successful company creation', auditRes.rows.length > 0);

    // Test F: Duplicate company code returns 409 Conflict
    const dupRes = await jarPlat.fetch(`${baseUrl}/api/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfPlat },
      body: JSON.stringify({ code: createCode, nameAr: 'شركة مكررة' }),
    });
    const dupData = await dupRes.json();
    await check('Duplicate company code returns 409 Conflict', dupRes.status === 409 && dupData.code === 'CONFLICT');

    // Test G: Platform admin sees all companies
    const platListRes = await jarPlat.fetch(`${baseUrl}/api/companies`);
    const platListData = await platListRes.json();
    const platCompIds = (platListData.companies || []).map((c: any) => c.id);
    await check(
      'Platform Admin can list and view all companies',
      platCompIds.includes(compA.id) && platCompIds.includes(compB.id) && platCompIds.includes(createData.company.id)
    );

    // Test H: Membership isActive = false hides company and returns 403
    await defaultMembershipRepository.setMembershipStatus(compAUser.id, compA.id, false);
    const listResInact = await jarA.fetch(`${baseUrl}/api/companies`);
    const listDataInact = await listResInact.json();
    const compIdsInact = (listDataInact.companies || []).map((c: any) => c.id);
    await check('Deactivated membership causes company to disappear from list', !compIdsInact.includes(compA.id));

    const inactDirectRes = await jarA.fetch(`${baseUrl}/api/companies/${compA.id}`);
    const inactDirectData = await inactDirectRes.json().catch(() => ({}));
    await check(
      'Deactivated membership attempting direct company access returns 403 Forbidden with code FORBIDDEN',
      inactDirectRes.status === 403 && inactDirectData.code === 'FORBIDDEN'
    );

    // Cleanup test data
    await executor.query('DELETE FROM audit_logs WHERE company_id IN ($1, $2, $3)', [compA.id, compB.id, createData.company.id]);
    await executor.query('DELETE FROM company_memberships WHERE company_id IN ($1, $2, $3)', [compA.id, compB.id, createData.company.id]);
    await executor.query('DELETE FROM platform_users WHERE id IN ($1, $2, $3)', [platformAdminUser.id, compAUser.id, compAdminUser.id]);
    await executor.query('DELETE FROM companies WHERE id IN ($1, $2, $3)', [compA.id, compB.id, createData.company.id]);

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
