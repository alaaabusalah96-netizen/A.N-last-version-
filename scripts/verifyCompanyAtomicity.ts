import { check, blocked, summary } from './lib/testkit.js';
import { CompanyService } from '../src/server/org/companyService.js';
import { defaultCompanyRepository } from '../src/server/org/companyRepository.js';
import { defaultMembershipRepository } from '../src/server/org/membershipRepository.js';
import { defaultUserRepository } from '../src/server/auth/userRepository.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';
import { AuditUnavailableError } from '../src/server/http/errors.js';

console.log('--- Running Company Creation Atomicity Verification (R2) ---');

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live company atomicity tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Database executor unavailable for company atomicity test.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    const suffix = Date.now();
    const passwordHash = await hashPassword('AdminPass123!');
    const adminUser = await defaultUserRepository.createUser({
      username: `admin_atom_${suffix}@erp.local`,
      passwordHash,
      role: 'platform_admin',
    });

    const companyService = new CompanyService();

    // 1. Failing audit log rolls back company and membership creation
    const failingAuditService: any = {
      record: async () => {
        throw new AuditUnavailableError('Simulated audit service failure');
      },
    };

    const failCode = `ATOM_FAIL_${suffix}`;
    let createThrew = false;
    try {
      await companyService.createCompanyWithAdmin(
        { code: failCode, nameAr: 'شركة فشل التدقيق' },
        adminUser.id,
        '127.0.0.1',
        { auditService: failingAuditService }
      );
    } catch (err) {
      createThrew = err instanceof AuditUnavailableError;
    }

    await check('Audit log failure causes transaction rollback and throws AuditUnavailableError', createThrew);

    const checkCompRes = await executor.query('SELECT 1 FROM companies WHERE code = $1', [failCode]);
    await check('No company row exists after transaction rollback on audit error', checkCompRes.rows.length === 0);

    // 2. Successful creation commits company, membership, and audit log atomically
    const succCode = `ATOM_SUCC_${suffix}`;
    const succComp = await companyService.createCompanyWithAdmin(
      { code: succCode, nameAr: 'شركة ناجحة' },
      adminUser.id,
      '127.0.0.1'
    );

    await check('Company creation succeeded', Boolean(succComp && succComp.id));

    const checkSuccComp = await executor.query('SELECT id FROM companies WHERE code = $1', [succCode]);
    const checkSuccMem = await executor.query(
      'SELECT id FROM company_memberships WHERE user_id = $1 AND company_id = $2 AND role = $3',
      [adminUser.id, succComp.id, 'company_admin']
    );
    const checkSuccAudit = await executor.query(
      "SELECT id FROM audit_logs WHERE company_id = $1 AND action = 'company.create'",
      [succComp.id]
    );

    await check(
      'Company, creator membership, and audit log all exist in DB after atomic transaction commit',
      checkSuccComp.rows.length === 1 && checkSuccMem.rows.length === 1 && checkSuccAudit.rows.length === 1
    );

    // 3. Duplicate code fails transaction cleanly
    let dupThrew = false;
    try {
      await companyService.createCompanyWithAdmin(
        { code: succCode, nameAr: 'شركة مكررة' },
        adminUser.id,
        '127.0.0.1'
      );
    } catch (err: any) {
      dupThrew = err?.code === '23505' || err?.message?.includes('duplicate key') || err?.message?.includes('violates unique constraint');
    }
    await check('Duplicate company code throws unique constraint violation and rolls back', dupThrew);

  } catch (err) {
    await check('Company creation atomicity test execution', false, err instanceof Error ? err.message : String(err));
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
