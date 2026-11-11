import fs from 'fs';
import path from 'path';

async function runVerification() {
  console.log('=== RUNNING GRN GL EXPLICIT TX VERIFICATION (AN-FIX-GRN-GL-EXPLICIT-TX-1) ===');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const root = process.cwd();

  // S1: grnService.ts postGrn calls JournalService
  const grnServicePath = path.join(root, 'src/server/purchasing/grnService.ts');
  const grnServiceContent = fs.existsSync(grnServicePath) ? fs.readFileSync(grnServicePath, 'utf8') : '';
  const callsJournal = grnServiceContent.includes('defaultJournalService.createDraftEntry') && 
                       grnServiceContent.includes('defaultJournalService.postEntry');
  assert(callsJournal, 'S1: grnService.ts invokes JournalService.createDraftEntry and postEntry');

  // S2: grnRepository.ts markPosted includes journal_entry_id
  const grnRepoPath = path.join(root, 'src/server/purchasing/grnRepository.ts');
  const grnRepoContent = fs.readFileSync(grnRepoPath, 'utf8');
  const repoUpdatesJournalId = grnRepoContent.includes('journal_entry_id = $5');
  assert(repoUpdatesJournalId, 'S2: grnRepository.ts marks GRN with journal_entry_id');

  // S3: grnService.ts does NOT map warehouseId to orgUnitId and does NOT pass isPlatformAdmin=true
  const hasNoOrgUnitWarehouse = !grnServiceContent.includes('orgUnitId: grn.warehouseId');
  const hasNoPlatformAdminBypass = !grnServiceContent.includes('true // Assuming platform admin') && !grnServiceContent.includes(', true)');
  assert(hasNoOrgUnitWarehouse && hasNoPlatformAdminBypass, 'S3: grnService.ts GL context does not map warehouse to orgUnitId or pass isPlatformAdmin=true');

  // S4: grnService.ts retains incrementBalance
  const hasIncrementBalance = grnServiceContent.includes('incrementBalance');
  assert(hasIncrementBalance, 'S4: grnService.ts retains atomic incrementBalance');

  // S5: AI_PROJECT_STATE.md records AN-FIX-GRN-GL-CONTEXT-1 or AN-FIX-GRN-GL-POST-1
  const statePath = path.join(root, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const hasStateRecord = stateContent.includes('AN-FIX-GRN-GL-') || stateContent.includes('AN-FIX-GRN-GL-POST-1');
  assert(hasStateRecord, 'S5: AI_PROJECT_STATE.md records GRN GL fix');

  // S6: grnService.ts passes explicit tx into createDraftEntry and postEntry, and journalService accepts executor
  const journalServicePath = path.join(root, 'src/server/accounting/journalService.ts');
  const journalServiceContent = fs.existsSync(journalServicePath) ? fs.readFileSync(journalServicePath, 'utf8') : '';
  const passesExplicitTx = grnServiceContent.includes(', tx') && journalServiceContent.includes('executor?: DbExecutor');
  assert(passesExplicitTx, 'S6: grnService.ts explicitly passes tx into journal calls and journalService accepts executor');

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
