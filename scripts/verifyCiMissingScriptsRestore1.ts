import fs from 'fs';
import path from 'path';

async function verifyCiMissingScriptsRestore1() {
  console.log('=== VERIFYING AN-CI-MISSING-SCRIPTS-RESTORE-1 ===\n');
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

  // S1: Priority 1 - scripts/provisionAppRole.ts exists
  const provPath = path.join(rootDir, 'scripts/provisionAppRole.ts');
  assert(fs.existsSync(provPath), 'S1: scripts/provisionAppRole.ts exists (Priority 1)');

  // S2: Priority 2 - scripts/runFoundationBattery.ts exists
  const batteryPath = path.join(rootDir, 'scripts/runFoundationBattery.ts');
  assert(fs.existsSync(batteryPath), 'S2: scripts/runFoundationBattery.ts exists (Priority 2)');

  // S3: Priority 3 - scripts/verifyLocal.ts exists
  const localPath = path.join(rootDir, 'scripts/verifyLocal.ts');
  assert(fs.existsSync(localPath), 'S3: scripts/verifyLocal.ts exists (Priority 3)');

  // S4: Supporting libraries scripts/lib/ exists
  const testkitPath = path.join(rootDir, 'scripts/lib/testkit.ts');
  const localPgPath = path.join(rootDir, 'scripts/lib/localPg.ts');
  const exclPath = path.join(rootDir, 'scripts/lib/battery_exclusions.json');
  assert(
    fs.existsSync(testkitPath) && fs.existsSync(localPgPath) && fs.existsSync(exclPath),
    'S4: Supporting library files in scripts/lib/ exist'
  );

  // S5: All scripts referenced in package.json exist on disk
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const referenced = new Set<string>();
  for (const [, v] of Object.entries(pkg.scripts as Record<string, string>)) {
    const matches = v.matchAll(/([a-zA-Z0-9_\-\.\/]+\.(ts|js|cjs|mjs|tsx|jsx))/g);
    for (const m of matches) {
      if (m[1].includes('/') && !m[1].includes('node_modules')) {
        referenced.add(m[1]);
      }
    }
  }

  const missingFromPkg: string[] = [];
  for (const f of Array.from(referenced)) {
    if (!fs.existsSync(path.join(rootDir, f))) {
      missingFromPkg.push(f);
    }
  }
  assert(
    missingFromPkg.length === 0,
    `S5: Zero missing scripts from package.json (Missing: ${missingFromPkg.join(', ') || 'none'})`
  );

  // S6: foundation-ci.yml was not modified/deleted
  const ciPath = path.join(rootDir, '.github/workflows/foundation-ci.yml');
  const ciContent = fs.readFileSync(ciPath, 'utf8');
  assert(
    ciContent.includes('ci:simulate-managed-pg') && ciContent.includes('ci:bootstrap-roles'),
    'S6: foundation-ci.yml retained without removing any CI steps'
  );

  // S7: AI_PROJECT_STATE.md records AN-CI-MISSING-SCRIPTS-RESTORE-1
  const statePath = path.join(rootDir, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-CI-MISSING-SCRIPTS-RESTORE-1'),
    'S7: AI_PROJECT_STATE.md records AN-CI-MISSING-SCRIPTS-RESTORE-1'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-CI-MISSING-SCRIPTS-RESTORE-1 assertions passed!');
  }
}

verifyCiMissingScriptsRestore1().catch((err) => {
  console.error('Unhandled error in verifyCiMissingScriptsRestore1:', err);
  process.exit(1);
});
