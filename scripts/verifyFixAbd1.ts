import fs from 'fs';
import path from 'path';

async function verifyFixAbd1() {
  console.log('=== VERIFYING AN-FIX-A-B-D-1 ===\n');
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

  // S1: A) companySettingsRepository has no getDefaultExecutor import or getExecutor method
  const settingsRepoPath = path.join(rootDir, 'src/server/org/companySettingsRepository.ts');
  const settingsContent = fs.readFileSync(settingsRepoPath, 'utf8');
  assert(
    !settingsContent.includes('getDefaultExecutor') && !settingsContent.includes('getExecutor()'),
    'S1: companySettingsRepository.ts has no getDefaultExecutor import or getExecutor method'
  );

  // S2: A) executor_import_allowlist.json does NOT contain companySettingsRepository
  const allowlistPath = path.join(rootDir, 'database/executor_import_allowlist.json');
  const allowlistContent = fs.readFileSync(allowlistPath, 'utf8');
  assert(
    !allowlistContent.includes('companySettingsRepository.ts'),
    'S2: executor_import_allowlist.json does NOT allowlist companySettingsRepository.ts'
  );

  // S3: B) GET /api/companies/:id in companyRoutes.ts checks existence first (404), then checks COMPANY_READ permission (403)
  const routesPath = path.join(rootDir, 'src/server/routes/companyRoutes.ts');
  const routesContent = fs.readFileSync(routesPath, 'utf8');
  const notFoundIdx = routesContent.indexOf("NotFoundError('Company not found')");
  const permCheckIdx = routesContent.indexOf("hasPermission(user, PERMISSIONS.COMPANY_READ, id)");
  const forbiddenIdx = routesContent.indexOf("ForbiddenError('Forbidden')");
  const s3Valid =
    notFoundIdx !== -1 &&
    permCheckIdx !== -1 &&
    forbiddenIdx !== -1 &&
    notFoundIdx < permCheckIdx &&
    permCheckIdx < forbiddenIdx;
  assert(
    s3Valid,
    'S3: companyRoutes.get("/:id") enforces existence check (404) before COMPANY_READ permission check (403)'
  );

  // S4: D) verifyMigration010.ts checks 14 & 15 allow guarded DO block pattern
  const verify010Path = path.join(rootDir, 'scripts/verifyMigration010.ts');
  const verify010Content = fs.readFileSync(verify010Path, 'utf8');
  assert(
    verify010Content.includes('pg_proc') && verify010Content.includes('rls_auto_enable'),
    'S4: verifyMigration010.ts supports guarded DO + pg_proc check pattern for rls_auto_enable'
  );

  // S5: D) 010_security_rls_baseline.sql preserves IF EXISTS (pg_proc) guard
  const mig010Path = path.join(rootDir, 'database/migrations/010_security_rls_baseline.sql');
  const mig010Content = fs.readFileSync(mig010Path, 'utf8');
  assert(
    mig010Content.includes('rls_auto_enable') && mig010Content.includes('pg_proc'),
    'S5: 010_security_rls_baseline.sql preserves IF EXISTS (pg_proc) guard for rls_auto_enable'
  );

  // S6: AI_PROJECT_STATE.md records AN-FIX-A-B-D-1
  const statePath = path.join(rootDir, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-FIX-A-B-D-1'),
    'S6: AI_PROJECT_STATE.md records AN-FIX-A-B-D-1'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-FIX-A-B-D-1 assertions passed!');
  }
}

verifyFixAbd1().catch((err) => {
  console.error('Unhandled error in verifyFixAbd1:', err);
  process.exit(1);
});
