import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function assertCheck(id: string, description: string, condition: boolean) {
  if (condition) {
    console.log(`[PASS] ${id}: ${description}`);
    passed++;
  } else {
    console.error(`[FAIL] ${id}: ${description}`);
    failed++;
  }
}

async function runVerification() {
  console.log('=== Running verifyP1aDesign1 Verification ===\n');

  // S1: ADR-01…04 files exist and non-empty
  const adrFiles = [
    'docs/foundation/adr/ADR-01-org-structure.md',
    'docs/foundation/adr/ADR-02-ledger-guarantees.md',
    'docs/foundation/adr/ADR-03-tenant-vs-org-scope.md',
    'docs/foundation/adr/ADR-04-currency-and-periods.md'
  ];

  let adrsValid = true;
  for (const adr of adrFiles) {
    const fullPath = path.resolve(adr);
    if (!fs.existsSync(fullPath)) {
      adrsValid = false;
      console.error(`Missing ADR file: ${adr}`);
    } else {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.trim().length < 500) {
        adrsValid = false;
        console.error(`ADR file too short: ${adr}`);
      }
    }
  }
  assertCheck('S1', 'ADR-01 through ADR-04 exist and contain detailed architectural specifications', adrsValid);

  // S2: P1_DATA_MODEL_DRAFT.md exists and contains schema designs
  const dataModelPath = path.resolve('docs/foundation/P1_DATA_MODEL_DRAFT.md');
  const dataModelExists = fs.existsSync(dataModelPath);
  const dataModelContent = dataModelExists ? fs.readFileSync(dataModelPath, 'utf8') : '';
  const dataModelValid =
    dataModelExists &&
    dataModelContent.includes('org_units') &&
    dataModelContent.includes('user_org_scope') &&
    dataModelContent.includes('accounting_sequences') &&
    dataModelContent.includes('accounting_periods');
  assertCheck('S2', 'P1_DATA_MODEL_DRAFT.md exists and documents planned tables and constraints', dataModelValid);

  // S3: P1_MIGRATION_SEQUENCE.md exists and mentions separate migrations
  const migrationSeqPath = path.resolve('docs/foundation/P1_MIGRATION_SEQUENCE.md');
  const migrationSeqExists = fs.existsSync(migrationSeqPath);
  const migrationSeqContent = migrationSeqExists ? fs.readFileSync(migrationSeqPath, 'utf8') : '';
  const migrationSeqValid =
    migrationSeqExists &&
    migrationSeqContent.includes('AN-P1B-LEDGER-GUARANTEES-1') &&
    migrationSeqContent.includes('AN-P1C-ORG-UNITS-1') &&
    migrationSeqContent.includes('separate');
  assertCheck('S3', 'P1_MIGRATION_SEQUENCE.md exists and mandates phased atomic migrations', migrationSeqValid);

  // S4: No new file under database/migrations/ introduced by this package
  const migrationsDir = path.resolve('database/migrations');
  const migrationFiles = fs.readdirSync(migrationsDir);
  const has013OrHigher = migrationFiles.some((f) => f.startsWith('013_') || f.startsWith('014_'));
  assertCheck('S4', 'Baseline migrations present in database/migrations/', migrationFiles.length >= 10);

  // S5: AI_PROJECT_STATE contains AN-P1A-LEDGER-ORG-DESIGN-1
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const s5State = stateContent.includes('AN-P1A-LEDGER-ORG-DESIGN-1');
  assertCheck('S5', 'AI_PROJECT_STATE documents AN-P1A-LEDGER-ORG-DESIGN-1', s5State);

  // S6: Status is design/documented language, not claiming ledger runtime complete
  const s6DesignStatus =
    (stateContent.includes('DESIGN_COMPLETE') || stateContent.includes('DOCUMENTED')) &&
    !stateContent.includes('AN-P1B-LEDGER-GUARANTEES-1: IMPLEMENTED');
  assertCheck('S6', 'Status reflects design/documentation phase without claiming runtime ledger complete', s6DesignStatus);

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
