import fs from 'fs';
import path from 'path';
import { resolveSslConfig, buildPgConfig, sanitizeConnectionString } from '../src/server/db/connection.js';

async function verifyDbSslPolicy2() {
  console.log('=== VERIFYING AN-DB-SSL-POLICY-2 ===\n');
  let passedCount = 0;
  let failedCount = 0;

  function assert(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
      passedCount++;
    } else {
      console.error(`[FAIL] ${description}`);
      failedCount++;
    }
  }

  // S1: production + disable -> throws
  let threwProdDisable = false;
  try {
    resolveSslConfig({ NODE_ENV: 'production', DATABASE_SSL: 'disable' });
  } catch {
    threwProdDisable = true;
  }
  assert(threwProdDisable, 'S1: production + DATABASE_SSL=disable throws error');

  // S2: non-prod + disable -> ssl undefined
  const sslNonProdDisable = resolveSslConfig({ NODE_ENV: 'test', DATABASE_SSL: 'disable' }, 'postgres://localhost:5432/db');
  assert(sslNonProdDisable === undefined, 'S2: non-prod + DATABASE_SSL=disable returns undefined (no SSL)');

  // S3: non-prod + host localhost URL -> ssl off (undefined)
  const sslLocalhost = resolveSslConfig({ NODE_ENV: 'test' }, 'postgres://postgres:pass@localhost:5432/db');
  assert(sslLocalhost === undefined, 'S3: non-prod + localhost URL returns undefined (no SSL)');

  // S4: non-prod + host remote remote URL without DATABASE_SSL -> ssl object present (truthy)
  const sslRemote = resolveSslConfig({ NODE_ENV: 'test' }, 'postgres://postgres:pass@db.pwnycxxrmpaxdxldgaxm.supabase.co:5432/postgres?sslmode=require');
  assert(Boolean(sslRemote) && typeof sslRemote === 'object', 'S4: non-prod + remote Supabase URL returns SSL config object by default');

  // S5: non-prod + DATABASE_SSL=require -> ssl present
  const sslRequire = resolveSslConfig({ NODE_ENV: 'test', DATABASE_SSL: 'require' }, 'postgres://localhost:5432/db');
  assert(Boolean(sslRequire) && typeof sslRequire === 'object', 'S5: non-prod + DATABASE_SSL=require returns SSL config');

  // S6: sanitize still strips sslmode from returned connectionString
  const rawUrl = 'postgres://user:pass@db.example.supabase.co:5432/postgres?sslmode=require';
  const built = buildPgConfig(rawUrl, { NODE_ENV: 'test' });
  assert(
    !built.connectionString.includes('sslmode'),
    'S6: sanitizeConnectionString / buildPgConfig strips sslmode from connectionString while keeping ssl config enabled for remote host'
  );
  assert(Boolean(built.ssl), 'S6b: buildPgConfig returns truthy ssl config for remote host');

  // S7: AI_PROJECT_STATE.md has AN-DB-SSL-POLICY-2
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-DB-SSL-POLICY-2'),
    'S7: AI_PROJECT_STATE.md records AN-DB-SSL-POLICY-2'
  );

  // S8: foundation-ci still has DATABASE_SSL disable for migrate
  const ciPath = path.join(process.cwd(), '.github/workflows/foundation-ci.yml');
  const ciContent = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, 'utf8') : '';
  assert(
    ciContent.includes('DATABASE_SSL: disable'),
    'S8: foundation-ci.yml contains DATABASE_SSL: disable for CI steps'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-DB-SSL-POLICY-2 assertions passed!');
  }
}

verifyDbSslPolicy2().catch((err) => {
  console.error('Unhandled error in verifyDbSslPolicy2:', err);
  process.exit(1);
});
