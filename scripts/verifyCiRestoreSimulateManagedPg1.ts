import fs from 'fs';
import path from 'path';

async function verifyCiRestoreSimulateManagedPg1() {
  console.log('=== VERIFYING AN-CI-RESTORE-SIMULATE-MANAGED-PG-1 ===\n');
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

  // S1: scripts/ciSimulateManagedPg.ts exists
  const scriptPath = path.join(process.cwd(), 'scripts/ciSimulateManagedPg.ts');
  assert(
    fs.existsSync(scriptPath),
    'S1: scripts/ciSimulateManagedPg.ts exists'
  );

  // S2: package.json script points to that path
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkgContent = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
  assert(
    pkgContent.includes('"ci:simulate-managed-pg": "cross-env NODE_ENV=test tsx scripts/ciSimulateManagedPg.ts"') ||
      pkgContent.includes('scripts/ciSimulateManagedPg.ts'),
    'S2: package.json points to scripts/ciSimulateManagedPg.ts'
  );

  // S3: file contains loopback or localhost check
  const scriptContent = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
  assert(
    scriptContent.includes('localhost') &&
      scriptContent.includes('127.0.0.1') &&
      scriptContent.includes('loopback'),
    'S3: scripts/ciSimulateManagedPg.ts enforces loopback / localhost host restriction'
  );

  // S4: foundation-ci.yml still runs npm run ci:simulate-managed-pg
  const ciPath = path.join(process.cwd(), '.github/workflows/foundation-ci.yml');
  const ciContent = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, 'utf8') : '';
  assert(
    ciContent.includes('npm run ci:simulate-managed-pg'),
    'S4: foundation-ci.yml still executes npm run ci:simulate-managed-pg'
  );

  // S5: AI_PROJECT_STATE has AN-CI-RESTORE-SIMULATE-MANAGED-PG-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-CI-RESTORE-SIMULATE-MANAGED-PG-1'),
    'S5: AI_PROJECT_STATE.md records AN-CI-RESTORE-SIMULATE-MANAGED-PG-1'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-CI-RESTORE-SIMULATE-MANAGED-PG-1 assertions passed!');
  }
}

verifyCiRestoreSimulateManagedPg1().catch((err) => {
  console.error('Unhandled error in verifyCiRestoreSimulateManagedPg1:', err);
  process.exit(1);
});
