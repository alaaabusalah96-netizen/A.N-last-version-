import fs from 'fs';
import path from 'path';

async function verifyCiProofWire1() {
  console.log('=== VERIFYING AN-CI-PROOF-WIRE-1 ===\n');
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

  // S1: foundation-ci.yml contains test:pg-proof-2
  const ciPath = path.join(process.cwd(), '.github/workflows/foundation-ci.yml');
  const ciContent = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, 'utf8') : '';
  assert(
    ciContent.includes('test:pg-proof-2'),
    'S1: foundation-ci.yml contains test:pg-proof-2 command'
  );

  // S2: foundation-ci.yml contains AN_PG_PROOF_STRICT
  assert(
    ciContent.includes('AN_PG_PROOF_STRICT'),
    'S2: foundation-ci.yml contains AN_PG_PROOF_STRICT environment variable'
  );

  // S3: package.json has test:pg-proof-2
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkgContent = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
  assert(
    pkgContent.includes('test:pg-proof-2'),
    'S3: package.json contains test:pg-proof-2 script'
  );

  // S4: verifyPgIntegrationProof2.ts exists
  const proofScriptPath = path.join(process.cwd(), 'scripts/verifyPgIntegrationProof2.ts');
  assert(
    fs.existsSync(proofScriptPath),
    'S4: scripts/verifyPgIntegrationProof2.ts exists'
  );

  // S5: AI_PROJECT_STATE.md has AN-CI-PROOF-WIRE-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-CI-PROOF-WIRE-1'),
    'S5: AI_PROJECT_STATE.md records AN-CI-PROOF-WIRE-1'
  );

  // S6: no /proc in migrate.ts / migrationRunner.ts
  const migratePath = path.join(process.cwd(), 'scripts/migrate.ts');
  const runnerPath = path.join(process.cwd(), 'src/server/db/migrationRunner.ts');
  const migrateContent = fs.existsSync(migratePath) ? fs.readFileSync(migratePath, 'utf8') : '';
  const runnerContent = fs.existsSync(runnerPath) ? fs.readFileSync(runnerPath, 'utf8') : '';
  assert(
    !migrateContent.includes('/proc') && !runnerContent.includes('/proc'),
    'S6: Migration tooling contains no /proc environment scraping'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-CI-PROOF-WIRE-1 assertions passed!');
  }
}

verifyCiProofWire1().catch((err) => {
  console.error('Unhandled error in verifyCiProofWire1:', err);
  process.exit(1);
});
