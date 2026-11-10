import fs from 'fs';
import path from 'path';

async function verifyFixVerifyMigrateScope1() {
  console.log('=== VERIFYING AN-FIX-VERIFY-MIGRATE-SCOPE-1 ===\n');
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

  // S1: migrate.ts does not contain /proc
  const migratePath = path.join(process.cwd(), 'scripts/migrate.ts');
  const migrateContent = fs.existsSync(migratePath) ? fs.readFileSync(migratePath, 'utf8') : '';
  assert(
    !migrateContent.includes('/proc'),
    'S1: scripts/migrate.ts does not contain /proc environment scraping'
  );

  // S2: migrate.ts does not fallback retry DATABASE_URL
  const hasDatabaseUrlFallback = /DATABASE_URL/.test(
    migrateContent.replace(/MIGRATION_DATABASE_URL/g, '')
  );
  assert(
    !hasDatabaseUrlFallback,
    'S2: scripts/migrate.ts does not fall back or retry using DATABASE_URL'
  );

  // S3: migrate requires MIGRATION_DATABASE_URL
  const runnerPath = path.join(process.cwd(), 'src/server/db/migrationRunner.ts');
  const runnerContent = fs.existsSync(runnerPath) ? fs.readFileSync(runnerPath, 'utf8') : '';
  assert(
    (migrateContent.includes('MIGRATION_DATABASE_URL') || runnerContent.includes('MIGRATION_DATABASE_URL')) &&
      (migrateContent.includes('FATAL') || runnerContent.includes('MIGRATION_DATABASE_URL')),
    'S3: migrate tooling requires MIGRATION_DATABASE_URL'
  );

  // S4: verifyPgIntegrationSmoke1.ts does not contain /proc
  const smokePath = path.join(process.cwd(), 'scripts/verifyPgIntegrationSmoke1.ts');
  const smokeContent = fs.existsSync(smokePath) ? fs.readFileSync(smokePath, 'utf8') : '';
  assert(
    !smokeContent.includes('/proc'),
    'S4: scripts/verifyPgIntegrationSmoke1.ts does not contain /proc environment scraping'
  );

  // S5: smoke T2 checks CANNOT_MODIFY_POSTED / posted error
  assert(
    smokeContent.includes('CANNOT_MODIFY_POSTED') &&
      smokeContent.includes('/CANNOT_MODIFY_POSTED|posted journal entry|cannot modify|posted/i'),
    'S5: verifyPgIntegrationSmoke1.ts T2 enforces pattern matching on CANNOT_MODIFY_POSTED'
  );

  // S6: journalService listEntries handles scoped user without orgUnitId
  const jsPath = path.join(process.cwd(), 'src/server/accounting/journalService.ts');
  const jsContent = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';
  assert(
    jsContent.includes('listUserScopes') &&
      jsContent.includes('Organizational unit filter (orgUnitId) is required for scoped users'),
    'S6: journalService.ts listEntries enforces orgUnitId requirement for scoped users'
  );

  // S7: AI_PROJECT_STATE.md records AN-FIX-VERIFY-MIGRATE-SCOPE-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-FIX-VERIFY-MIGRATE-SCOPE-1'),
    'S7: docs/foundation/AI_PROJECT_STATE.md records AN-FIX-VERIFY-MIGRATE-SCOPE-1'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount} | Blocked: 0`);

  if (failedCount > 0) {
    console.error('\nFAILED: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-FIX-VERIFY-MIGRATE-SCOPE-1 assertions passed!');
  }
}

verifyFixVerifyMigrateScope1().catch((err) => {
  console.error('Unhandled error in verifyFixVerifyMigrateScope1:', err);
  process.exit(1);
});
