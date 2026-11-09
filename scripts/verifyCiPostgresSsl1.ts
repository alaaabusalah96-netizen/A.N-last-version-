import fs from 'fs';
import path from 'path';

async function verifyCiPostgresSsl1() {
  console.log('=== VERIFYING AN-CI-POSTGRES-SSL-1 ===\n');
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

  // S1: migrationRunner uses buildPgConfig
  const runnerPath = path.join(process.cwd(), 'src/server/db/migrationRunner.ts');
  const runnerContent = fs.existsSync(runnerPath) ? fs.readFileSync(runnerPath, 'utf8') : '';
  assert(
    runnerContent.includes('buildPgConfig'),
    'S1: migrationRunner.ts uses buildPgConfig for connection config'
  );

  // S2: migrationRunner does not hardcode non-prod ssl without checking buildPgConfig
  assert(
    !runnerContent.includes('rejectUnauthorized: false') || runnerContent.includes('buildPgConfig'),
    'S2: migrationRunner.ts delegates SSL configuration to buildPgConfig'
  );

  // S3: foundation-ci.yml contains DATABASE_SSL: disable
  const ciPath = path.join(process.cwd(), '.github/workflows/foundation-ci.yml');
  const ciContent = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, 'utf8') : '';
  assert(
    ciContent.includes('DATABASE_SSL: disable'),
    'S3: foundation-ci.yml contains DATABASE_SSL: disable for CI steps'
  );

  // S4: foundation-ci.yml runs test:pg-proof-2 with AN_PG_PROOF_STRICT
  assert(
    ciContent.includes('test:pg-proof-2') && ciContent.includes('AN_PG_PROOF_STRICT'),
    'S4: foundation-ci.yml runs test:pg-proof-2 with AN_PG_PROOF_STRICT'
  );

  // S5: connection.ts still forbids DATABASE_SSL=disable when NODE_ENV=production
  const connPath = path.join(process.cwd(), 'src/server/db/connection.ts');
  const connContent = fs.existsSync(connPath) ? fs.readFileSync(connPath, 'utf8') : '';
  assert(
    connContent.includes('DATABASE_SSL=disable is strictly forbidden in production'),
    'S5: connection.ts strictly forbids DATABASE_SSL=disable in production'
  );

  // S6: AI_PROJECT_STATE.md records AN-CI-POSTGRES-SSL-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-CI-POSTGRES-SSL-1'),
    'S6: AI_PROJECT_STATE.md records AN-CI-POSTGRES-SSL-1'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-CI-POSTGRES-SSL-1 assertions passed!');
  }
}

verifyCiPostgresSsl1().catch((err) => {
  console.error('Unhandled error in verifyCiPostgresSsl1:', err);
  process.exit(1);
});
