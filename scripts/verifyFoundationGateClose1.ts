import fs from 'fs';
import path from 'path';
import { check, summary } from './lib/testkit.js';

console.log('=== RUNNING FOUNDATION GATE CLOSE VERIFICATION (AN-FOUNDATION-GATE-CLOSE-1) ===\n');

async function runVerification() {
  const rootDir = process.cwd();

  // S1: AI_PROJECT_STATE contains AN-FOUNDATION-GATE-CLOSE-1
  const projectStatePath = path.join(rootDir, 'docs/foundation/AI_PROJECT_STATE.md');
  const projectStateContent = fs.readFileSync(projectStatePath, 'utf8');
  await check(
    'S1: AI_PROJECT_STATE.md contains package entry AN-FOUNDATION-GATE-CLOSE-1',
    projectStateContent.includes('AN-FOUNDATION-GATE-CLOSE-1')
  );

  // S2: AI_PROJECT_STATE contains FOUNDATION_CI_GATE or GREEN_CI_SHA
  await check(
    'S2: AI_PROJECT_STATE.md records FOUNDATION_CI_GATE or GREEN_CI_SHA',
    projectStateContent.includes('FOUNDATION_CI_GATE') || projectStateContent.includes('GREEN_CI_SHA')
  );

  // S3: OPEN_GAPS mentions gate close or CLOSED foundation CI
  const openGapsPath = path.join(rootDir, 'docs/foundation/OPEN_GAPS.md');
  const openGapsContent = fs.readFileSync(openGapsPath, 'utf8');
  await check(
    'S3: OPEN_GAPS.md records FOUNDATION-CI-GATE as CLOSED',
    openGapsContent.includes('FOUNDATION-CI-GATE') && openGapsContent.includes('CLOSED')
  );

  // S4: OPERATOR_LIVE_SMOKE_CHECKLIST.md exists
  const checklistPath = path.join(rootDir, 'docs/foundation/OPERATOR_LIVE_SMOKE_CHECKLIST.md');
  await check(
    'S4: OPERATOR_LIVE_SMOKE_CHECKLIST.md exists in docs/foundation',
    fs.existsSync(checklistPath)
  );

  // S5: companyRoutes.ts still has hasMembership on GET /:id
  const companyRoutesPath = path.join(rootDir, 'src/server/routes/companyRoutes.ts');
  const companyRoutesContent = fs.readFileSync(companyRoutesPath, 'utf8');
  await check(
    'S5: companyRoutes.ts retains hasMembership check on GET /:id',
    companyRoutesContent.includes('hasMembership') && companyRoutesContent.includes("ForbiddenError('Forbidden')")
  );

  // S6: scram.ts contains salt$StoredKey pattern
  const scramPath = path.join(rootDir, 'src/server/security/scram.ts');
  const scramContent = fs.readFileSync(scramPath, 'utf8');
  await check(
    'S6: scram.ts contains SCRAM salt$StoredKey delimiter pattern',
    scramContent.includes('SCRAM-SHA-256') && scramContent.includes('}$${storedKey')
  );

  // S7: migrationRunner.ts inserts checksum
  const runnerPath = path.join(rootDir, 'src/server/db/migrationRunner.ts');
  const runnerContent = fs.readFileSync(runnerPath, 'utf8');
  await check(
    'S7: migrationRunner.ts inserts checksum into schema_migrations',
    runnerContent.includes('INSERT INTO schema_migrations') && runnerContent.includes('checksum')
  );

  const { exitCode } = summary();
  process.exit(exitCode);
}

runVerification().catch((err) => {
  console.error('Unhandled error in verifyFoundationGateClose1:', err);
  process.exit(1);
});
