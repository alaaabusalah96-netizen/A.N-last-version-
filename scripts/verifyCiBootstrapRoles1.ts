import fs from 'fs';
import path from 'path';

async function verifyCiBootstrapRoles1() {
  console.log('=== VERIFYING AN-CI-BOOTSTRAP-ROLES-1 ===\n');
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

  // S1: foundation-ci.yml contains Bootstrap stub OR ci:bootstrap-roles before migrate
  const ciPath = path.join(process.cwd(), '.github/workflows/foundation-ci.yml');
  const ciContent = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, 'utf8') : '';
  const bootstrapIndex = ciContent.indexOf('ci:bootstrap-roles');
  const migrateIndex = ciContent.indexOf('Run Database Migrations');
  assert(
    bootstrapIndex !== -1 && migrateIndex !== -1 && bootstrapIndex < migrateIndex,
    'S1: foundation-ci.yml contains ci:bootstrap-roles before Run Database Migrations'
  );

  // S2: bootstrap script/sql creates anon and authenticated with NOLOGIN
  const scriptPath = path.join(process.cwd(), 'scripts/ciBootstrapRoles.ts');
  const scriptContent = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
  assert(
    scriptContent.includes('CREATE ROLE anon NOLOGIN') &&
      scriptContent.includes('CREATE ROLE authenticated NOLOGIN'),
    'S2: ciBootstrapRoles.ts creates anon and authenticated stub roles with NOLOGIN'
  );

  // S3: 010 still mentions REVOKE FROM anon (unchanged historical - OK)
  const m10Path = path.join(process.cwd(), 'database/migrations/010_security_rls_baseline.sql');
  const m10Content = fs.existsSync(m10Path) ? fs.readFileSync(m10Path, 'utf8') : '';
  assert(
    m10Content.includes('FROM anon, authenticated;') || m10Content.includes('FROM anon;'),
    'S3: Migration 010 mentions REVOKE FROM anon and authenticated (historical intact)'
  );

  // S4: AI_PROJECT_STATE has AN-CI-BOOTSTRAP-ROLES-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-CI-BOOTSTRAP-ROLES-1'),
    'S4: AI_PROJECT_STATE.md records AN-CI-BOOTSTRAP-ROLES-1'
  );

  // S5: no production Supabase URL hard-coded in workflow
  assert(
    !ciContent.includes('supabase.co') && !ciContent.includes('pooler.supabase.com'),
    'S5: No production Supabase URL hard-coded in foundation-ci.yml'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-CI-BOOTSTRAP-ROLES-1 assertions passed!');
  }
}

verifyCiBootstrapRoles1().catch((err) => {
  console.error('Unhandled error in verifyCiBootstrapRoles1:', err);
  process.exit(1);
});
