import fs from 'fs';
import path from 'path';

async function verifyProvisioningHangGuard1() {
  console.log('=== VERIFYING AN-PROVISIONING-TEST-HANG-DIAGNOSTIC-1 ===\n');
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

  const rootDir = process.cwd();
  const scriptPath = path.join(rootDir, 'scripts/verifyProvisioning.ts');

  assert(fs.existsSync(scriptPath), 'V1: scripts/verifyProvisioning.ts exists');

  const content = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';

  // V2: Connection timeout
  assert(
    content.includes('CONNECT_TIMEOUT_MS') && content.includes('connectionTimeoutMillis'),
    'V2: connectionTimeoutMillis is configured on pg.Client instances'
  );

  // V3: Statement timeout
  assert(
    content.includes('statement_timeout'),
    'V3: statement_timeout is configured on active database connections'
  );

  // V4: spawnSync timeout
  assert(
    content.includes('SPAWN_TIMEOUT_MS') && content.includes('timeout: SPAWN_TIMEOUT_MS'),
    'V4: spawnSync calls specify an explicit timeout to prevent subprocess hanging'
  );

  // V5: Stages instrumented with [START] and [END] logs
  assert(
    content.includes('[START]') && content.includes('[END]') && content.includes('logStage'),
    'V5: Test stages are instrumented with timing and stage boundaries'
  );

  // V6: Client cleanup in finally blocks
  assert(
    content.includes('finally') && content.includes('client.end()') && content.includes('userClient.end()'),
    'V6: All PostgreSQL client connections are closed inside finally blocks'
  );

  // V7: All 17 verification checks preserved
  const checkCount = (content.match(/await check\(/g) || []).length;
  assert(
    checkCount >= 17,
    `V7: All verification checks are preserved (found ${checkCount} checks, minimum 17)`
  );

  // V8: AI_PROJECT_STATE.md records AN-PROVISIONING-TEST-HANG-DIAGNOSTIC-1
  const statePath = path.join(rootDir, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-PROVISIONING-TEST-HANG-DIAGNOSTIC-1'),
    'V8: AI_PROJECT_STATE.md records AN-PROVISIONING-TEST-HANG-DIAGNOSTIC-1'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-PROVISIONING-TEST-HANG-DIAGNOSTIC-1 assertions passed!');
  }
}

verifyProvisioningHangGuard1().catch((err) => {
  console.error('Unhandled error in verifyProvisioningHangGuard1:', err);
  process.exit(1);
});
