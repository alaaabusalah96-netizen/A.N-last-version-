import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';
import { defaultAuthService } from '../src/server/auth/authService.js';
import { defaultUserRepository } from '../src/server/auth/userRepository.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';

console.log('=== VERIFYING AN-BOOT-FIRST-RUN-1: BOOTSTRAP ADMIN CLI ===\n');

export function isLoopbackDbUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

async function runVerification() {
  const rootDir = process.cwd();

  // ==========================================
  // Section 1: Static Invariants
  // ==========================================
  const cliPath = path.join(rootDir, 'scripts/bootstrapPlatformAdmin.ts');
  const pkgPath = path.join(rootDir, 'package.json');
  const authServicePath = path.join(rootDir, 'src/server/auth/authService.ts');
  const userRepoPath = path.join(rootDir, 'src/server/auth/userRepository.ts');
  const firstRunDocPath = path.join(rootDir, 'docs/ops/FIRST_RUN.md');

  const cliSrc = fs.existsSync(cliPath) ? fs.readFileSync(cliPath, 'utf8') : '';
  const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const authServiceSrc = fs.readFileSync(authServicePath, 'utf8');
  const userRepoSrc = fs.readFileSync(userRepoPath, 'utf8');
  const firstRunDoc = fs.existsSync(firstRunDocPath) ? fs.readFileSync(firstRunDocPath, 'utf8') : '';

  await check(
    'S1: scripts/bootstrapPlatformAdmin.ts exists and wired in package.json bootstrap:admin',
    Boolean(cliSrc) &&
      cliSrc.includes('createInitialPlatformAdminFromEnv') &&
      pkgJson.scripts?.['bootstrap:admin'] === 'tsx scripts/bootstrapPlatformAdmin.ts'
  );

  await check(
    'S2: server boot path bootstrapPlatformAdminFromEnv remains non-creating when user absent',
    authServiceSrc.includes('Automatic creation is disabled') &&
      authServiceSrc.includes('createInitialPlatformAdminFromEnv') &&
      authServiceSrc.includes('password.length < 12') &&
      authServiceSrc.includes('trim().toLowerCase()')
  );

  await check(
    'S3: userRepository exposes countPlatformAdmins()',
    userRepoSrc.includes('countPlatformAdmins') && userRepoSrc.includes("role = 'platform_admin'")
  );

  await check(
    'S4: docs/ops/FIRST_RUN.md documents exact first-run order and dev ports',
    Boolean(firstRunDoc) &&
      firstRunDoc.includes('migrate') &&
      firstRunDoc.includes('db:provision-app-role') &&
      firstRunDoc.includes('bootstrap:admin') &&
      firstRunDoc.includes('/api/auth/login') &&
      firstRunDoc.includes('/api/companies') &&
      firstRunDoc.includes('3000') &&
      firstRunDoc.includes('3001')
  );

  await check(
    'S5: Loopback guard accepts localhost/127.0.0.1 and rejects remote host',
    isLoopbackDbUrl('postgresql://an_app:secret@127.0.0.1:5432/an_foundation') &&
      isLoopbackDbUrl('postgresql://an_app:secret@localhost:5432/an_foundation') &&
      !isLoopbackDbUrl('postgresql://postgres:secret@aws-1-eu-central-1.pooler.supabase.com:5432/postgres')
  );

  // ==========================================
  // Section 2: Live Loopback PostgreSQL Verification
  // ==========================================
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('Live PostgreSQL bootstrap:admin verification skipped — DATABASE_URL not configured');
    const { exitCode } = summary();
    process.exit(exitCode);
  }

  if (!isLoopbackDbUrl(dbUrl)) {
    console.error('[verifyBootstrapAdmin1] FATAL: Refusing to run mutating bootstrap test against non-loopback DATABASE_URL.');
    process.exit(1);
  }

  const prevUsername = process.env.PLATFORM_ADMIN_USERNAME;
  const prevPassword = process.env.PLATFORM_ADMIN_PASSWORD;
  const createdUserIds: string[] = [];

  try {
    const executor = await getDefaultExecutor();
    if (!executor) {
      blocked('Live PostgreSQL bootstrap:admin verification skipped — executor unavailable');
      const { exitCode } = summary();
      process.exit(exitCode);
    }

    const suffix = Date.now();
    const validPass = 'BootstrapVerifyPass123!';
    const missingUsername = `boot_missing_${suffix}@erp.local`;

    // T1: Boot reconciliation must NOT create absent user
    process.env.PLATFORM_ADMIN_USERNAME = missingUsername;
    process.env.PLATFORM_ADMIN_PASSWORD = validPass;
    const bootRes = await defaultAuthService.bootstrapPlatformAdminFromEnv();
    const afterBootUser = await defaultUserRepository.findByUsername(missingUsername);
    await check(
      'T1: boot/reconcile leaves missing platform_admin uncreated',
      bootRes === false && afterBootUser === null
    );

    // T2: Reject short password (< 12)
    process.env.PLATFORM_ADMIN_PASSWORD = 'short';
    let shortRejected = false;
    try {
      await defaultAuthService.createInitialPlatformAdminFromEnv();
    } catch (err: any) {
      shortRejected = String(err?.message || '').includes('12 characters');
    }
    await check('T2: CLI bootstrap rejects passwords shorter than 12 characters', shortRejected);

    // T3: Prevent silent promotion of existing regular user
    const regularUsername = `boot_regular_${suffix}@erp.local`;
    const regUser = await defaultUserRepository.createUser({
      username: regularUsername,
      passwordHash: await hashPassword(validPass),
      role: 'user',
    });
    createdUserIds.push(regUser.id);

    process.env.PLATFORM_ADMIN_USERNAME = `  ${regularUsername.toUpperCase()}  `;
    process.env.PLATFORM_ADMIN_PASSWORD = validPass;
    let promotionBlocked = false;
    try {
      await defaultAuthService.createInitialPlatformAdminFromEnv();
    } catch (err: any) {
      promotionBlocked = String(err?.message || '').includes('Silent promotion is forbidden');
    }
    await check('T3: CLI bootstrap refuses silent promotion of existing non-platform_admin user', promotionBlocked);

    // T4: count(platform_admin) === 0 creates once & idempotent for same username; rejects different username when count > 0
    const initialCount = await defaultUserRepository.countPlatformAdmins();
    if (initialCount === 0) {
      const targetUser = `  Boot_Admin_${suffix}@ERP.Local  `;
      const normalizedTarget = `boot_admin_${suffix}@erp.local`;
      process.env.PLATFORM_ADMIN_USERNAME = targetUser;
      process.env.PLATFORM_ADMIN_PASSWORD = validPass;

      const firstCreate = await defaultAuthService.createInitialPlatformAdminFromEnv();
      createdUserIds.push(firstCreate.userId);
      const createdRecord = await defaultUserRepository.findByUsername(normalizedTarget);

      await check(
        'T4a: When count(platform_admin)===0, CLI creates initial platform_admin with normalized username & Argon2id hash',
        firstCreate.status === 'created' &&
          createdRecord !== null &&
          createdRecord.role === 'platform_admin' &&
          createdRecord.passwordHash.startsWith('$argon2id$')
      );

      const secondSame = await defaultAuthService.createInitialPlatformAdminFromEnv();
      await check(
        'T4b: Re-running CLI bootstrap for same username reports already_exists cleanly',
        secondSame.status === 'already_exists' && secondSame.userId === firstCreate.userId
      );

      process.env.PLATFORM_ADMIN_USERNAME = `boot_second_${suffix}@erp.local`;
      let secondDiffRejected = false;
      try {
        await defaultAuthService.createInitialPlatformAdminFromEnv();
      } catch (err: any) {
        secondDiffRejected = String(err?.message || '').includes('already exists');
      }
      await check(
        'T4c: CLI bootstrap fails clearly when count(platform_admin) > 0 for another username',
        secondDiffRejected
      );
    } else {
      process.env.PLATFORM_ADMIN_USERNAME = `boot_second_${suffix}@erp.local`;
      process.env.PLATFORM_ADMIN_PASSWORD = validPass;
      let secondDiffRejected = false;
      try {
        await defaultAuthService.createInitialPlatformAdminFromEnv();
      } catch (err: any) {
        secondDiffRejected = String(err?.message || '').includes('already exists');
      }
      await check(
        `T4: Existing platform_admin detected (count=${initialCount}); CLI bootstrap rejects creating a new admin`,
        secondDiffRejected
      );
    }
  } finally {
    if (prevUsername === undefined) delete process.env.PLATFORM_ADMIN_USERNAME;
    else process.env.PLATFORM_ADMIN_USERNAME = prevUsername;
    if (prevPassword === undefined) delete process.env.PLATFORM_ADMIN_PASSWORD;
    else process.env.PLATFORM_ADMIN_PASSWORD = prevPassword;

    try {
      const executor = await getDefaultExecutor();
      if (executor && createdUserIds.length > 0) {
        await executor.query('DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])', [createdUserIds]).catch(() => {});
        await executor.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [createdUserIds]).catch(() => {});
      }
    } catch (cleanupErr) {
      console.warn('[verifyBootstrapAdmin1] Cleanup note:', cleanupErr);
    }
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runVerification().catch(async (err) => {
  console.error('[verifyBootstrapAdmin1] Unhandled error:', err);
  await closeAllExecutors().catch(() => {});
  process.exit(1);
});
