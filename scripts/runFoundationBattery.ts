import { spawnSync } from 'child_process';
import path from 'path';

console.log('========================================');
console.log('=== RUNNING FOUNDATION TEST BATTERY ===');
console.log('========================================');

const scripts = [
  'scripts/verifyPublicAssets.ts',
  'scripts/verifyExecutorImports.ts',
  'scripts/verifyNoMemoryFallback.ts',
  'scripts/verifyFixRbacCompanies.ts',
  'scripts/verifyFixDbWiring.ts',
  'scripts/verifyRepair2.ts',
  'scripts/verifyPersistence.ts',
  'scripts/verifyTenantIsolation.ts',
  'scripts/verifyAuthSecurity.ts',
  'scripts/verifyRlsCoverage.ts',
  'scripts/verifyHttpSecurity.ts',
  'scripts/verifyRbacHttp.ts',
  'scripts/verifyMigrations.ts',
  'scripts/verifyCompanyAtomicity.ts',
  'scripts/verifyTenantHttp.ts',
  'scripts/verifyDbPrivileges.ts',
];

interface ScriptRunResult {
  script: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  exitCode: number | null;
}

const runResults: ScriptRunResult[] = [];
let passedScripts = 0;
let failedScripts = 0;
let blockedScripts = 0;

const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');

for (const script of scripts) {
  console.log(`\n--- Running: ${script} ---`);
  const fullPath = path.resolve(process.cwd(), script);

  const result = spawnSync(tsxBin, [fullPath], {
    stdio: 'inherit',
    env: process.env,
  });

  const exitCode = result.status;
  let status: 'PASS' | 'FAIL' | 'BLOCKED' = 'FAIL';

  if (exitCode === 0) {
    status = 'PASS';
    passedScripts++;
  } else if (exitCode === 2) {
    status = 'BLOCKED';
    blockedScripts++;
  } else {
    status = 'FAIL';
    failedScripts++;
  }

  runResults.push({ script, status, exitCode });
}

const isDbRequired = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true' || process.env.CI === 'true';

console.log('\n======================================================');
console.log('=== FOUNDATION BATTERY SUMMARY                      ===');
console.log('======================================================');
console.log('| Script                             | Status    | Exit |');
console.log('|------------------------------------|-----------|------|');
for (const r of runResults) {
  const scriptName = r.script.padEnd(34, ' ');
  const statusStr = r.status.padEnd(9, ' ');
  const exitStr = String(r.exitCode ?? 'ERR').padStart(4, ' ');
  console.log(`| ${scriptName} | ${statusStr} | ${exitStr} |`);
}
console.log('======================================================');
console.log(`Total Scripts: ${scripts.length} | Passed: ${passedScripts} | Failed: ${failedScripts} | Blocked: ${blockedScripts}`);

if (failedScripts > 0) {
  console.error('\n[BATTERY ERROR] One or more test scripts FAILED.');
  process.exit(1);
}

if (isDbRequired && blockedScripts > 0) {
  console.error('\n[BATTERY ERROR] REQUIRE_DB=1 or CI=true is set, but test scripts reported BLOCKED.');
  process.exit(1);
}

process.exit(0);
