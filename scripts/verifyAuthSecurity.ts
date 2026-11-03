import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';

console.log('--- Running Auth Security Structural Verification ---');

const rootDir = process.cwd();

async function runTests() {
  // Check 1: csrfProtection.ts exists
  const csrfPath = path.join(rootDir, 'src/server/security/csrfProtection.ts');
  await check('csrfProtection.ts module exists', fs.existsSync(csrfPath));

  // Check 2: auditRepository.ts and auditService.ts exist
  const auditRepoPath = path.join(rootDir, 'src/server/audit/auditRepository.ts');
  const auditSvcPath = path.join(rootDir, 'src/server/audit/auditService.ts');
  await check('Audit repository and service modules exist', fs.existsSync(auditRepoPath) && fs.existsSync(auditSvcPath));

  // Check 3: Migration 007 exists
  const migPath = path.join(rootDir, 'database/migrations/007_audit_and_rate_limit.sql');
  await check('Migration 007 (audit and rate limit) exists', fs.existsSync(migPath));

  // Check 4: Database-backed rateLimitStore exists
  const rateLimitPath = path.join(rootDir, 'src/server/security/rateLimitStore.ts');
  await check('rateLimitStore.ts module exists', fs.existsSync(rateLimitPath));

  // Check 5: Live database audit test
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live audit log DB test is BLOCKED.');
  } else {
    try {
      const { defaultAuditService } = await import('../src/server/audit/auditService.js');
      await defaultAuditService.record({
        action: 'verify.test',
        ipAddress: '127.0.0.1',
        metadata: { test: true },
      });
      await check('Live audit log recording succeeded', true);
    } catch (err) {
      await check('Live audit log recording', false, err instanceof Error ? err.message : String(err));
    }
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
