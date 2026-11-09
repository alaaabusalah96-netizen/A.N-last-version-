import fs from 'fs';
import path from 'path';

async function verifyCiGuardRlsAutoEnable1() {
  console.log('=== VERIFYING AN-CI-GUARD-RLS-AUTO-ENABLE-1 ===\n');
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

  const m10Path = path.join(process.cwd(), 'database/migrations/010_security_rls_baseline.sql');
  const m10Content = fs.existsSync(m10Path) ? fs.readFileSync(m10Path, 'utf8') : '';

  // S1: 010 contains rls_auto_enable
  assert(
    m10Content.includes('rls_auto_enable'),
    'S1: 010_security_rls_baseline.sql contains rls_auto_enable'
  );

  // S2: 010 contains IF EXISTS / pg_proc guard around rls_auto_enable revoke
  assert(
    m10Content.includes('pg_proc') &&
      m10Content.includes("proname = 'rls_auto_enable'") &&
      m10Content.includes('IF EXISTS'),
    'S2: 010_security_rls_baseline.sql contains IF EXISTS / pg_proc guard around rls_auto_enable revoke'
  );

  // S3: 010 does NOT contain unguarded pair of lines without guard context
  const lines = m10Content.split('\n').map((l) => l.trim());
  const hasUnguardedStandaloneRevoke = lines.some(
    (l) => l === 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;'
  );
  assert(
    !hasUnguardedStandaloneRevoke,
    'S3: 010_security_rls_baseline.sql does NOT contain unguarded standalone REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()'
  );

  // S4: audit_logs_block_mutation REVOKE still present
  assert(
    m10Content.includes('REVOKE EXECUTE ON FUNCTION public.audit_logs_block_mutation() FROM PUBLIC;') &&
      m10Content.includes('REVOKE EXECUTE ON FUNCTION public.audit_logs_block_mutation() FROM anon, authenticated;'),
    'S4: REVOKE EXECUTE ON FUNCTION public.audit_logs_block_mutation() is still present and intact'
  );

  // S5: AI_PROJECT_STATE has AN-CI-GUARD-RLS-AUTO-ENABLE-1
  const statePath = path.join(process.cwd(), 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assert(
    stateContent.includes('AN-CI-GUARD-RLS-AUTO-ENABLE-1'),
    'S5: AI_PROJECT_STATE.md records AN-CI-GUARD-RLS-AUTO-ENABLE-1'
  );

  // S6: no CREATE FUNCTION rls_auto_enable added in 010 (must remain absent)
  assert(
    !m10Content.toLowerCase().includes('create function public.rls_auto_enable') &&
      !m10Content.toLowerCase().includes('create function rls_auto_enable') &&
      !m10Content.toLowerCase().includes('create or replace function public.rls_auto_enable') &&
      !m10Content.toLowerCase().includes('create or replace function rls_auto_enable'),
    'S6: No fake rls_auto_enable function was created in 010_security_rls_baseline.sql'
  );

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAIL: Verification assertions failed.');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All AN-CI-GUARD-RLS-AUTO-ENABLE-1 assertions passed!');
  }
}

verifyCiGuardRlsAutoEnable1().catch((err) => {
  console.error('Unhandled error in verifyCiGuardRlsAutoEnable1:', err);
  process.exit(1);
});
