import { execSync } from 'child_process';
import { startLocalPostgres } from './lib/localPg.js';
import crypto from 'crypto';

async function verifyLocal() {
  console.log('========================================');
  console.log('--- Running Local Foundation Verification (F1) ---');
  console.log('========================================');

  // 1. Typecheck
  console.log('[verifyLocal] Step 1/7: Typecheck...');
  try {
    execSync('npm run typecheck', { stdio: 'inherit' });
  } catch (err) {
    console.error('[verifyLocal] Typecheck failed.');
    process.exit(1);
  }

  // 2. Build
  console.log('[verifyLocal] Step 2/7: Build...');
  try {
    execSync('npm run build', { stdio: 'inherit' });
  } catch (err) {
    console.error('[verifyLocal] Build failed.');
    process.exit(1);
  }

  // 3. Start Local Postgres
  console.log('[verifyLocal] Step 3/7: Starting ephemeral PostgreSQL...');
  const pgInstance = await startLocalPostgres();
  const appPassword = crypto.randomBytes(16).toString('hex'); // >= 16 chars printable ASCII

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    REQUIRE_DB: '1',
    CI: 'true',
    ENABLE_TENANT_DEMO: '1',
    MIGRATION_DATABASE_URL: pgInstance.ownerUrl,
    DATABASE_URL: pgInstance.ownerUrl.replace(/\/[^/]+$/, '/an_app_db'), // will connect as an_app after provision
    APP_DB_USER: 'an_app',
    APP_DB_PASSWORD: appPassword,
    CSRF_SECRET: crypto.randomBytes(32).toString('hex'),
    CORS_ORIGINS: 'http://127.0.0.1:3000',
    PLATFORM_ADMIN_USERNAME: 'admin@erp.local',
    PLATFORM_ADMIN_PASSWORD: 'AdminPassword123!',
  };

  try {
    // Note: create an_app db if needed or use same db name with different user
    const appDbUrl = pgInstance.ownerUrl;

    const runtimeEnv = {
      ...env,
      DATABASE_URL: appDbUrl.replace(/an_test@/, 'an_app@'),
    };

    // 4. Migrate
    console.log('[verifyLocal] Step 4/7: Running migrations...');
    execSync('npx tsx scripts/migrate.ts', { env, stdio: 'inherit' });

    // 5. Provision app role
    console.log('[verifyLocal] Step 5/7: Provisioning app role...');
    execSync('npx tsx scripts/provisionAppRole.ts', { env, stdio: 'inherit' });

    // 6. Simulate Managed PG (Data API guard prep)
    console.log('[verifyLocal] Step 6/7: Simulating managed PG / Data API guard...');
    execSync('npx tsx scripts/ciSimulateManagedPg.ts', { env, stdio: 'inherit' });

    // 7. Run foundation battery
    console.log('[verifyLocal] Step 7/7: Running Foundation Battery...');
    execSync('npx tsx scripts/runFoundationBattery.ts', { env: runtimeEnv, stdio: 'inherit' });

    console.log('========================================');
    console.log('--- LOCAL VERIFICATION SUCCESS (PASS) ---');
    console.log('========================================');
    await pgInstance.stop();
    process.exit(0);
  } catch (err) {
    console.error('[verifyLocal] FAILED during verification steps:', err);
    await pgInstance.stop();
    process.exit(1);
  }
}

verifyLocal().catch((err) => {
  console.error('[verifyLocal] Fatal error:', err);
  process.exit(1);
});
