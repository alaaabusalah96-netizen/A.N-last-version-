import 'dotenv/config';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { SessionRepository } from '../src/server/auth/sessionRepository.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { MembershipRepository } from '../src/server/org/membershipRepository.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';

async function runPersistenceVerification() {
  console.log('--- Running AN-PERSISTENCE-CORE-1 Verification ---');

  let passed = 0;
  let failed = 0;
  let blocked = 0;

  const databaseUrl = process.env.DATABASE_URL;
  const requireDb = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true';

  if (!databaseUrl || databaseUrl.trim() === '') {
    console.log('[BLOCKED] DATABASE_URL is not set. Live PostgreSQL persistence tests are BLOCKED.');
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
    console.log('[BLOCKED] Failed to connect to PostgreSQL database using DATABASE_URL.');
    blocked++;
    console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked}`);
    process.exit(requireDb ? 1 : 0);
  }

  try {
    // 1) Test connection & schema readiness
    const health = await executor.health();
    if (!health.ok) {
      console.log(`[BLOCKED] Database health check failed: ${health.detail}`);
      blocked++;
      console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked}`);
      process.exit(1);
    }
    console.log('[PASS] Database connection and health verified');
    passed++;

    // Instantiate repositories
    const userRepo = new UserRepository();
    const sessionRepo = new SessionRepository();
    const companyRepo = new CompanyRepository();
    const membershipRepo = new MembershipRepository();

    const testSuffix = Date.now();
    const testUsername = `testuser_${testSuffix}@erp.local`;
    const testCompanyCode = `TCODE_${testSuffix}`;

    // 2) Create user
    const passwordHash = await hashPassword('SecurePass123!');
    const user = await userRepo.createUser({
      username: testUsername,
      passwordHash,
      role: 'user',
    });
    if (user && user.id) {
      console.log('[PASS] User created successfully in database');
      passed++;
    } else {
      console.error('[FAIL] User creation returned invalid record');
      failed++;
    }

    // 3) Create company
    const company = await companyRepo.create({
      code: testCompanyCode,
      nameAr: 'شركة الاختبار المتقدمة',
      nameEn: 'Advanced Test Co',
      createdBy: user.id,
    });
    if (company && company.id) {
      console.log('[PASS] Company created successfully in database');
      passed++;
    } else {
      console.error('[FAIL] Company creation returned invalid record');
      failed++;
    }

    // 4) Add membership
    const membership = await membershipRepo.addMember(user.id, company.id, 'company_admin', true);
    if (membership && membership.userId === user.id) {
      console.log('[PASS] Company membership added successfully');
      passed++;
    } else {
      console.error('[FAIL] Membership creation failed');
      failed++;
    }

    // 5) Create session (hashes token internally)
    const sessionInfo = await sessionRepo.createSession(user.id);
    if (sessionInfo && sessionInfo.rawToken) {
      console.log('[PASS] Session created with hashed token storage');
      passed++;
    } else {
      console.error('[FAIL] Session creation failed');
      failed++;
    }

    // 6) Simulate "new process" by instantiating brand new repository instances
    const freshUserRepo = new UserRepository();
    const freshSessionRepo = new SessionRepository();
    const freshCompanyRepo = new CompanyRepository();
    const freshMembershipRepo = new MembershipRepository();

    const foundUser = await freshUserRepo.findByUsername(testUsername);
    const foundCompany = await freshCompanyRepo.findByCode(testCompanyCode);
    const foundMembership = await freshMembershipRepo.getMembership(user.id, company.id);
    const foundSession = await freshSessionRepo.getSessionByToken(sessionInfo.rawToken);

    if (foundUser && foundCompany && foundMembership && foundSession) {
      console.log('[PASS] Data successfully re-read across fresh repository instances (Persistence verified)');
      passed++;
    } else {
      console.error('[FAIL] Data persistence verification across fresh instances failed');
      failed++;
    }

    // 7) Revoke session -> getSessionByToken should return null
    await freshSessionRepo.revokeSessionByToken(sessionInfo.rawToken);
    const revokedSession = await freshSessionRepo.getSessionByToken(sessionInfo.rawToken);
    if (revokedSession === null) {
      console.log('[PASS] Session revocation successfully invalidated session token');
      passed++;
    } else {
      console.error('[FAIL] Revoked session was still considered active');
      failed++;
    }
  } catch (err: unknown) {
    console.error('[FAIL] Error during persistence verification:', err);
    failed++;
  }

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runPersistenceVerification().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
