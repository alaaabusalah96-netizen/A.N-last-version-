import fs from 'fs';
import path from 'path';
import { resolveSslConfig } from '../src/server/db/connection.js';

async function verifyDbSslDisableScope1() {
  console.log('=== VERIFYING AN-DB-SSL-DISABLE-SCOPE-1 ===\n');
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

  // S1: prod + disable -> throws
  let threwProdDisable = false;
  try {
    resolveSslConfig({ NODE_ENV: 'production', DATABASE_SSL: 'disable' }, 'postgres://localhost:5432/db');
  } catch {
    threwProdDisable = true;
  }
  assert(threwProdDisable, 'S1: production + DATABASE_SSL=disable throws error');

  // S2: non-prod + disable + localhost URL -> ssl off (undefined)
  const sslLocalDisable = resolveSslConfig({ NODE_ENV: 'test', DATABASE_SSL: 'disable' }, 'postgres://localhost:5432/db');
  assert(sslLocalDisable === undefined, 'S2: non-prod + disable + localhost URL returns undefined (no SSL)');

  // S3: non-prod + disable + db.xxx.supabase.co URL -> ssl ON (truthy object)
  const sslSupabaseDisable = resolveSslConfig({ NODE_ENV: 'test', DATABASE_SSL: 'disable' }, 'postgres://user:pass@db.pwnycxxrmpaxdxldgaxm.supabase.co:5432/postgres');
  assert(Boolean(sslSupabaseDisable) && typeof sslSupabaseDisable === 'object', 'S3: non-prod + disable + remote Supabase URL forces SSL ON (ignores global disable for remote host)');

  // S4: non-prod + disable + pooler host URL -> ssl ON
  const sslPoolerDisable = resolveSslConfig({ NODE_ENV: 'test', DATABASE_SSL: 'disable' }, 'postgres://user:pass@aws-1-eu-central-1.pooler.supabase.com:5432/postgres');
  assert(Boolean(sslPoolerDisable) && typeof sslPoolerDisable === 'object', 'S4: non-prod + disable + pooler host URL forces SSL ON');

  // S5: non-prod without disable + remote -> ssl ON (regression)
  const sslRemoteNoDisable = resolveSslConfig({ NODE_ENV: 'test' }, 'postgres://user:pass@db.example.supabase.co:5432/postgres');
  assert(Boolean(sslRemoteNoDisable) && typeof sslRemoteNoDisable === 'object', 'S5: non-prod remote without disable has SSL enabled');

  // S6: non-prod without disable + localhost -> ssl off
  const sslLocalNoDisable = resolveSslConfig({ NODE_ENV: 'test' }, 'postgres://localhost:5432/db');
  assert(sslLocalNoDisable === undefined, 'S6: non-prod localhost without disable has SSL off');

  // S7: AI_PROJECT_STATE.md has AN-DB-SSL-DISABLE-SCOPE-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-DB-SSL-DISABLE-SCOPE-1'),
    'S7: AI_PROJECT_STATE.md records AN-DB-SSL-DISABLE-SCOPE-1'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-DB-SSL-DISABLE-SCOPE-1 assertions passed!');
  }
}

verifyDbSslDisableScope1().catch((err) => {
  console.error('Unhandled error in verifyDbSslDisableScope1:', err);
  process.exit(1);
});
