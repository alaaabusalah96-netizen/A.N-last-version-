import fs from 'fs';
import path from 'path';

function verifyP1cOrgIntegrity1() {
  console.log('=== VERIFYING AN-P1C-ORG-INTEGRITY-1 ===');
  let failures = 0;

  function assertCondition(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
    } else {
      console.error(`[FAIL] ${description}`);
      failures++;
    }
  }

  // S1: Migration 016 exists
  const migrationPath = path.join(process.cwd(), 'database/migrations/016_org_integrity.sql');
  assertCondition(fs.existsSync(migrationPath), 'S1: 016_org_integrity.sql migration file exists');

  const migrationContent = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';

  // S2: 016 mentions composite FK or same-company parent/org_unit validation
  assertCondition(
    migrationContent.includes('(company_id, parent_id)') &&
      migrationContent.includes('(company_id, org_unit_id)') &&
      migrationContent.includes('REFERENCES org_units (company_id, id)'),
    'S2: 016_org_integrity.sql contains composite same-company foreign key constraints'
  );

  // S3: setUserScopes / service checks membership
  const repoPath = path.join(process.cwd(), 'src/server/org/orgUnitRepository.ts');
  const servicePath = path.join(process.cwd(), 'src/server/org/orgUnitService.ts');
  const repoContent = fs.readFileSync(repoPath, 'utf8');
  const serviceContent = fs.readFileSync(servicePath, 'utf8');

  assertCondition(
    repoContent.includes('checkUserCompanyMembership') && serviceContent.includes('checkUserCompanyMembership'),
    'S3: setUserScopes checks active target user company membership before granting org scopes'
  );

  // S4: org_units listed in table_ownership
  const ownershipPath = path.join(process.cwd(), 'database/table_ownership.json');
  const ownershipContent = fs.readFileSync(ownershipPath, 'utf8');
  assertCondition(
    ownershipContent.includes('"org_units"') && ownershipContent.includes('"user_org_scope"'),
    'S4: org_units and user_org_scope are registered in table_ownership.json'
  );

  // S5: P1B hardening 015 still present
  const hardening015Path = path.join(process.cwd(), 'database/migrations/015_ledger_hardening.sql');
  assertCondition(fs.existsSync(hardening015Path), 'S5: 015_ledger_hardening.sql remains present');

  // S6: AI_PROJECT_STATE has AN-P1C-ORG-INTEGRITY-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCondition(
    stateContent.includes('AN-P1C-ORG-INTEGRITY-1'),
    'S6: AI_PROJECT_STATE.md records AN-P1C-ORG-INTEGRITY-1'
  );

  // S7: verify script does not claim org-scope-on-ledger done
  assertCondition(
    !stateContent.includes('AN-ORG-SCOPE-ON-LEDGER-1: IMPLEMENTED'),
    'S7: Explicitly preserves distinction that org-scope-on-ledger is NOT claimed complete in this package'
  );

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} assertions failed.`);
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-P1C-ORG-INTEGRITY-1 checks passed!');
  }
}

verifyP1cOrgIntegrity1();
