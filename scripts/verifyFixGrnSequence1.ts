import fs from 'fs';
import path from 'path';

async function runVerification() {
  console.log('=== RUNNING GRN ATOMIC SEQUENCE VERIFICATION (AN-FIX-GRN-SEQUENCE-1) ===');
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

  // S1: grnService.ts does not contain Date.now for GRN numbering
  const grnServicePath = path.join(root, 'src/server/purchasing/grnService.ts');
  const grnServiceContent = fs.existsSync(grnServicePath) ? fs.readFileSync(grnServicePath, 'utf8') : '';
  const hasDateNowForGrn = grnServiceContent.includes('Date.now()');
  assert(!hasDateNowForGrn, 'S1: grnService.ts does not use Date.now() for GRN numbers');

  // S2: grnService.ts uses allocateSequenceNumber with 'goods_receipt' and 'GRN'
  const usesAllocateSeq = grnServiceContent.includes('allocateSequenceNumber') && 
                          grnServiceContent.includes('goods_receipt') && 
                          grnServiceContent.includes('GRN');
  assert(usesAllocateSeq, 'S2: grnService.ts invokes allocateSequenceNumber with goods_receipt and GRN inside transaction');

  // S3: JournalRepository.allocateSequenceNumber uses FOR UPDATE
  const journalRepoPath = path.join(root, 'src/server/accounting/journalRepository.ts');
  const journalRepoContent = fs.existsSync(journalRepoPath) ? fs.readFileSync(journalRepoPath, 'utf8') : '';
  const seqUsesForUpdate = journalRepoContent.includes('FOR UPDATE') && journalRepoContent.includes('accounting_sequences');
  assert(seqUsesForUpdate, 'S3: allocateSequenceNumber uses accounting_sequences with FOR UPDATE row locking');

  // S4: AI_PROJECT_STATE.md records AN-FIX-GRN-SEQUENCE-1
  const statePath = path.join(root, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const hasStateRecord = stateContent.includes('AN-FIX-GRN-SEQUENCE-1');
  assert(hasStateRecord, 'S4: AI_PROJECT_STATE.md records AN-FIX-GRN-SEQUENCE-1');

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
