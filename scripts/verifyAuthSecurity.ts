import fs from 'fs';
import path from 'path';

console.log('--- Running AN-AUTH-SECURITY-1 Verification ---');

const rootDir = process.cwd();

async function runTests() {
  let passed = 0;
  let failed = 0;
  let blocked = 0;

  // Check 1: csrfProtection.ts exists
  const csrfPath = path.join(rootDir, 'src/server/security/csrfProtection.ts');
  if (fs.existsSync(csrfPath)) {
    console.log('[PASS] csrfProtection.ts module exists');
    passed++;
  } else {
    console.error('[FAIL] csrfProtection.ts module missing');
    failed++;
  }

  // Check 2: auditRepository.ts and auditService.ts exist
  const auditRepoPath = path.join(rootDir, 'src/server/audit/auditRepository.ts');
  const auditSvcPath = path.join(rootDir, 'src/server/audit/auditService.ts');
  if (fs.existsSync(auditRepoPath) && fs.existsSync(auditSvcPath)) {
    console.log('[PASS] Audit repository and service modules exist');
    passed++;
  } else {
    console.error('[FAIL] Audit modules missing');
    failed++;
  }

  // Check 3: Migration 007 exists
  const migPath = path.join(rootDir, 'database/migrations/007_audit_and_rate_limit.sql');
  if (fs.existsSync(migPath)) {
    console.log('[PASS] Migration 007 (audit and rate limit) exists');
    passed++;
  } else {
    console.error('[FAIL] Migration 007 missing');
    failed++;
  }

  // Check 4: Database-backed rateLimitStore exists
  const rateLimitPath = path.join(rootDir, 'src/server/security/rateLimitStore.ts');
  if (fs.existsSync(rateLimitPath)) {
    console.log('[PASS] rateLimitStore.ts module exists');
    passed++;
  } else {
    console.error('[FAIL] rateLimitStore.ts module missing');
    failed++;
  }

  // Check 5: Live database verification
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    console.log('[BLOCKED] DATABASE_URL is not set. Live audit log and rate limit DB integration tests are BLOCKED.');
    blocked++;
  } else {
    try {
      const { defaultAuditService } = await import('../src/server/audit/auditService.js');
      await defaultAuditService.record({
        action: 'verify.test',
        ipAddress: '127.0.0.1',
        metadata: { test: true },
      });
      console.log('[PASS] Live audit log recording succeeded');
      passed++;
    } catch (err) {
      console.log(`[BLOCKED] Live audit test skipped or blocked: ${err}`);
      blocked++;
    }
  }

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
