import fs from 'fs';
import path from 'path';
import { check, summary } from './lib/testkit.js';

console.log('=== VERIFYING AN-PG-SMOKE-LIVE-CI-1 (LIVE PG SMOKE IN CI + GUARDS) ===\n');

async function runVerification() {
  const rootDir = process.cwd();

  // S1: foundation-ci.yml contains test:pg-smoke-1 with SMOKE_ALLOW_DISPOSABLE
  const ciPath = path.join(rootDir, '.github/workflows/foundation-ci.yml');
  const ciContent = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, 'utf8') : '';
  const s1Wired =
    ciContent.includes('npm run test:pg-smoke-1') &&
    ciContent.includes('SMOKE_ALLOW_DISPOSABLE: "1"');
  await check('S1: foundation-ci.yml wires test:pg-smoke-1 with SMOKE_ALLOW_DISPOSABLE=1', s1Wired);

  // S2: verifyPgIntegrationSmoke1.ts has isProductionOrSupabaseDb and SMOKE_ALLOW_DISPOSABLE guard
  const smokePath = path.join(rootDir, 'scripts/verifyPgIntegrationSmoke1.ts');
  const smokeContent = fs.existsSync(smokePath) ? fs.readFileSync(smokePath, 'utf8') : '';
  const s2Guarded =
    smokeContent.includes('isProductionOrSupabaseDb') &&
    smokeContent.includes('SMOKE_ALLOW_DISPOSABLE') &&
    smokeContent.includes('buildPgConfig') &&
    smokeContent.includes('client.end()');
  await check(
    'S2: verifyPgIntegrationSmoke1.ts contains Supabase/production guard, buildPgConfig, and client cleanup',
    s2Guarded
  );

  // S3: OPEN_GAPS.md records PG-SMOKE-LIVE as CLOSED
  const gapsPath = path.join(rootDir, 'docs/foundation/OPEN_GAPS.md');
  const gapsContent = fs.existsSync(gapsPath) ? fs.readFileSync(gapsPath, 'utf8') : '';
  const s3GapsUpdated =
    gapsContent.includes('PG-SMOKE-LIVE') &&
    gapsContent.includes('AN-PG-SMOKE-LIVE-CI-1') &&
    gapsContent.includes('CLOSED');
  await check('S3: docs/foundation/OPEN_GAPS.md records PG-SMOKE-LIVE as CLOSED', s3GapsUpdated);

  // S4: AI_PROJECT_STATE.md records AN-PG-SMOKE-LIVE-CI-1
  const statePath = path.join(rootDir, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const s4StateUpdated = stateContent.includes('AN-PG-SMOKE-LIVE-CI-1');
  await check('S4: docs/foundation/AI_PROJECT_STATE.md records AN-PG-SMOKE-LIVE-CI-1', s4StateUpdated);

  // S5: OPERATOR_LIVE_SMOKE_CHECKLIST.md records SMOKE_ALLOW_DISPOSABLE
  const checklistPath = path.join(rootDir, 'docs/foundation/OPERATOR_LIVE_SMOKE_CHECKLIST.md');
  const checklistContent = fs.existsSync(checklistPath) ? fs.readFileSync(checklistPath, 'utf8') : '';
  const s5ChecklistUpdated =
    checklistContent.includes('SMOKE_ALLOW_DISPOSABLE=1') &&
    checklistContent.includes('test:pg-smoke-1');
  await check(
    'S5: docs/foundation/OPERATOR_LIVE_SMOKE_CHECKLIST.md records SMOKE_ALLOW_DISPOSABLE instructions',
    s5ChecklistUpdated
  );

  const { exitCode } = summary();
  process.exit(exitCode);
}

runVerification().catch((err) => {
  console.error('Unhandled error in verifyPgSmokeLiveCi1:', err);
  process.exit(1);
});
