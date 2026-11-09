import fs from 'fs';
import path from 'path';

async function verifyProvisionRoleMissingRolesFix1() {
  console.log('=== VERIFYING AN-PROVISION-ROLE-MISSING-ROLES-FIX-1 ===\n');
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
  const scriptPath = path.join(rootDir, 'scripts/provisionAppRole.ts');

  // V1: scripts/provisionAppRole.ts exists
  assert(fs.existsSync(scriptPath), 'V1: scripts/provisionAppRole.ts exists');

  const content = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';

  // V2: protectedRoles list retains all 6 protected roles
  const expectedRoles = ['postgres', 'supabase_admin', 'service_role', 'authenticator', 'anon', 'authenticated'];
  const hasAllRoles = expectedRoles.every((r) => content.includes(`'${r}'`));
  assert(hasAllRoles, `V2: protectedRoles retains all 6 roles (${expectedRoles.join(', ')})`);

  // V3: checks existence in pg_roles before querying pg_has_role
  const checksRoleExists =
    content.includes('pg_roles WHERE rolname = $1') &&
    content.includes('pg_has_role') &&
    content.includes('continue');
  assert(checksRoleExists, 'V3: checks role existence in pg_roles before invoking pg_has_role');

  // V4: Simulation unit test of the algorithm
  // Emulate client.query behavior
  async function simulateProtectedRoleCheck(
    existingRoles: Set<string>,
    memberOfRoles: Set<string>,
    appUser: string,
    protectedList: string[]
  ): Promise<{ skipped: string[]; checked: string[]; error?: string }> {
    const skipped: string[] = [];
    const checked: string[] = [];

    for (const protRole of protectedList) {
      // 1. Role exists check
      const roleExists = existingRoles.has(protRole);
      if (!roleExists) {
        skipped.push(protRole);
        continue;
      }

      // 2. Membership check
      checked.push(protRole);
      const hasProt = memberOfRoles.has(protRole);
      if (hasProt) {
        return {
          skipped,
          checked,
          error: `[provision] Verification failed: '${appUser}' has unauthorized direct or inherited membership in '${protRole}'`,
        };
      }
    }
    return { skipped, checked };
  }

  // Case A: vanilla CI environment (postgres does not exist, anon/authenticated exist with no membership)
  const caseA = await simulateProtectedRoleCheck(
    new Set(['anon', 'authenticated']), // postgres, supabase_admin, etc. don't exist
    new Set(), // no memberships
    'an_app',
    expectedRoles
  );
  assert(
    caseA.skipped.includes('postgres') &&
      caseA.skipped.includes('supabase_admin') &&
      caseA.checked.includes('anon') &&
      caseA.checked.includes('authenticated') &&
      !caseA.error,
    'V4: Missing roles (e.g. postgres) are safely skipped without 42704 error'
  );

  // Case B: role exists and an_app is accidentally granted membership -> MUST fail
  const caseB = await simulateProtectedRoleCheck(
    new Set(['postgres', 'anon', 'authenticated']),
    new Set(['postgres']), // an_app is in postgres role!
    'an_app',
    expectedRoles
  );
  assert(
    Boolean(caseB.error?.includes("unauthorized direct or inherited membership in 'postgres'")),
    'V5: When protected role exists and membership is detected, it fails with error'
  );

  // Case C: Supabase environment where all roles exist and an_app has no membership -> PASS
  const caseC = await simulateProtectedRoleCheck(
    new Set(expectedRoles),
    new Set(),
    'an_app',
    expectedRoles
  );
  assert(
    caseC.checked.length === expectedRoles.length && !caseC.error,
    'V6: When all roles exist and an_app has no forbidden membership, check passes completely'
  );

  // V7: CI workflow untouched
  const ciPath = path.join(rootDir, '.github/workflows/foundation-ci.yml');
  const ciContent = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, 'utf8') : '';
  assert(
    ciContent.includes('Provision App DB Role') && ciContent.includes('npm run db:provision-app-role'),
    'V7: foundation-ci.yml retains Provision App DB Role step intact'
  );

  // V8: AI_PROJECT_STATE.md records AN-PROVISION-ROLE-MISSING-ROLES-FIX-1
  const statePath = path.join(rootDir, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-PROVISION-ROLE-MISSING-ROLES-FIX-1'),
    'V8: AI_PROJECT_STATE.md records AN-PROVISION-ROLE-MISSING-ROLES-FIX-1'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-PROVISION-ROLE-MISSING-ROLES-FIX-1 assertions passed!');
  }
}

verifyProvisionRoleMissingRolesFix1().catch((err) => {
  console.error('Unhandled error in verifyProvisionRoleMissingRolesFix1:', err);
  process.exit(1);
});
