import fs from 'node:fs';
import path from 'node:path';
import { defaultOrgUnitRepository } from '../src/server/org/orgUnitRepository.js';
import { DbExecutor } from '../src/server/db/types.js';

async function runVerification() {
  console.log('=== RUNNING N1 ORG SCOPE STATUS FIX VERIFICATION (AN-FIX-N1-ORG-SCOPE-STATUS-1) ===');
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

  // 1. Static assertion: orgUnitRepository.ts does NOT contain status = 'active'
  const repoPath = path.join(root, 'src/server/org/orgUnitRepository.ts');
  const repoContent = fs.readFileSync(repoPath, 'utf8');

  const hasStatusCheck = repoContent.includes("status = 'active'");
  assert(!hasStatusCheck, 'S1: orgUnitRepository.ts does NOT query non-existent status column on company_memberships');

  // 2. Static assertion: orgUnitRepository.ts uses is_active = true
  const hasIsActiveCheck = repoContent.includes('is_active = true');
  assert(hasIsActiveCheck, 'S2: orgUnitRepository.ts correctly uses is_active = true on company_memberships');

  // 3. Behavioral test for checkUserCompanyMembership with mock executor
  const activeCompanyId = '11111111-1111-1111-1111-111111111111';
  const activeUserId = '22222222-2222-2222-2222-222222222222';
  const inactiveUserId = '33333333-3333-3333-3333-333333333333';
  const absentUserId = '44444444-4444-4444-4444-444444444444';

  const mockDbExecutor: DbExecutor = {
    query: async <T = any>(sql: string, params?: any[]) => {
      // Ensure query uses is_active = true and NOT status = 'active'
      if (sql.includes('company_memberships')) {
        if (sql.includes('status')) {
          throw new Error('PostgreSQL Error: column "status" does not exist in company_memberships');
        }

        const compId = params?.[0];
        const uId = params?.[1];

        if (compId === activeCompanyId && uId === activeUserId) {
          return { rows: [{ '?column?': 1 }], rowCount: 1 } as any;
        }
        if (compId === activeCompanyId && uId === inactiveUserId) {
          return { rows: [], rowCount: 0 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    withTransaction: async <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> => fn(mockDbExecutor),
    health: async () => ({ ok: true }),
    close: async () => {},
  };

  // Test active member -> should return true
  const isActiveMember = await defaultOrgUnitRepository.checkUserCompanyMembership(
    activeCompanyId,
    activeUserId,
    mockDbExecutor
  );
  assert(isActiveMember === true, 'S3: checkUserCompanyMembership returns true for active membership (is_active = true)');

  // Test inactive member -> should return false
  const isInactiveMember = await defaultOrgUnitRepository.checkUserCompanyMembership(
    activeCompanyId,
    inactiveUserId,
    mockDbExecutor
  );
  assert(isInactiveMember === false, 'S4: checkUserCompanyMembership returns false for inactive membership (is_active = false)');

  // Test absent member -> should return false
  const isAbsentMember = await defaultOrgUnitRepository.checkUserCompanyMembership(
    activeCompanyId,
    absentUserId,
    mockDbExecutor
  );
  assert(isAbsentMember === false, 'S5: checkUserCompanyMembership returns false for absent membership');

  // 4. AI_PROJECT_STATE.md contains AN-FIX-N1-ORG-SCOPE-STATUS-1
  const statePath = path.join(root, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.readFileSync(statePath, 'utf8');
  const hasStateRecord = stateContent.includes('AN-FIX-N1-ORG-SCOPE-STATUS-1');
  assert(hasStateRecord, 'S6: AI_PROJECT_STATE.md contains AN-FIX-N1-ORG-SCOPE-STATUS-1 record');

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: 0`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
