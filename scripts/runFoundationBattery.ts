import { spawnSync } from 'child_process';
import path from 'path';

console.log('========================================');
console.log('=== RUNNING FOUNDATION TEST BATTERY ===');
console.log('========================================');

const scripts = [
  'scripts/verifyFixRbacCompanies.ts',
  'scripts/verifyFixDbWiring.ts',
  'scripts/verifyRepair2.ts',
  'scripts/verifyPersistence.ts',
  'scripts/verifyTenantIsolation.ts',
  'scripts/verifyAuthSecurity.ts',
];

let totalPassed = 0;
let totalFailed = 0;
let totalBlocked = 0;

for (const script of scripts) {
  console.log(`\n--- Running: ${script} ---`);
  const fullPath = path.resolve(process.cwd(), script);
  const result = spawnSync('npx', ['tsx', fullPath], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    console.error(`[ERROR] Script failed or exited non-zero: ${script}`);
    totalFailed++;
  } else {
    totalPassed++;
  }
}

const requireDb = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true';

console.log('\n========================================');
console.log('=== FOUNDATION BATTERY SUMMARY       ===');
console.log(`Scripts Executed: ${scripts.length}`);
console.log(`Passed Scripts:   ${totalPassed}`);
console.log(`Failed Scripts:   ${totalFailed}`);
console.log('========================================');

if (totalFailed > 0) {
  process.exit(1);
}

if (requireDb && totalBlocked > 0) {
  console.error('[ERROR] REQUIRE_DB=1 is set, but some checks reported BLOCKED.');
  process.exit(1);
}

process.exit(0);
