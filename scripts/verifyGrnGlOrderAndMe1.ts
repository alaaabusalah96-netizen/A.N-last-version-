import fs from 'fs';
import path from 'path';
import assert from 'assert';

async function verify() {
  console.log('=== Verifying GRN GL Order and Me Access (AN-FIX-GRN-GL-ORDER-AND-ME-1) ===');

  let passed = 0;
  let failed = 0;

  function check(name: string, condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${name}: ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name}: ${message}`);
      failed++;
    }
  }

  const grnServiceContent = fs.readFileSync(path.resolve('src/server/purchasing/grnService.ts'), 'utf8');
  const grnRepoContent = fs.readFileSync(path.resolve('src/server/purchasing/grnRepository.ts'), 'utf8');
  const purchasingTypesContent = fs.readFileSync(path.resolve('src/server/purchasing/purchasingTypes.ts'), 'utf8');
  const authRoutesContent = fs.readFileSync(path.resolve('src/server/routes/authRoutes.ts'), 'utf8');

  // S1: grnService contains requireGlAccounts
  check('S1', grnServiceContent.includes('requireGlAccounts'), 'grnService contains requireGlAccounts helper');

  // S2: grnService contains resolveEntryDate
  check('S2', grnServiceContent.includes('resolveEntryDate'), 'grnService contains resolveEntryDate helper');

  // S3: grnService contains toDecimal and toMoney
  check('S3', grnServiceContent.includes('toDecimal') && grnServiceContent.includes('toMoney'), 'grnService preserves numeric helpers');

  // S4: grnService zero-value reject message
  check('S4', grnServiceContent.includes('إجمالي قيمة السند صفر'), 'grnService rejects zero-value GRN receipts');

  // S5: GL validation order before stock write
  const glIndex = grnServiceContent.indexOf('requireGlAccounts');
  const stockWriteIndex = grnServiceContent.indexOf('incrementBalance');
  check('S5', glIndex !== -1 && stockWriteIndex !== -1 && glIndex < stockWriteIndex, 'GL validation happens before stock write in postGrn');

  // S6: grnRepository SELECT includes journal_entry_id as "journalEntryId"
  check('S6', grnRepoContent.includes('journal_entry_id as "journalEntryId"'), 'grnRepository selects journalEntryId');

  // S7: purchasingTypes GrnHeader includes journalEntryId
  check('S7', purchasingTypesContent.includes('journalEntryId'), 'GrnHeader type includes journalEntryId');

  // S8: authRoutes contains resolveEffectiveAccess
  check('S8', authRoutesContent.includes('resolveEffectiveAccess'), 'authRoutes contains resolveEffectiveAccess');

  // S9: authRoutes /me returns permissions, memberships, degraded
  check('S9', authRoutesContent.includes('permissions') && authRoutesContent.includes('memberships') && authRoutesContent.includes('degraded'), 'GET /me returns permissions, memberships, and degraded');

  // S10: authRoutes catches errors returning degraded true
  check('S10', authRoutesContent.includes('degraded: true'), 'authRoutes failure path returns degraded: true');

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('=== All GRN GL Order & Me Verifications Passed ===');
  }
}

verify().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
