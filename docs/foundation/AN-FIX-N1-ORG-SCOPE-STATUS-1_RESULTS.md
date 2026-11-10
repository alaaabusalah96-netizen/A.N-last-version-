# AN-FIX-N1-ORG-SCOPE-STATUS-1 Results Document

## Package Identification
- **Package**: `AN-FIX-N1-ORG-SCOPE-STATUS-1`
- **Type**: Fix — Organizational Unit Access Scope (N1) Column Reference
- **Repository**: `alaaabusalah96-netizen/A.N-last-version-`
- **Branch**: `main`

## Summary of Root Cause & Fix
- **Root Cause**: `checkUserCompanyMembership` in `src/server/org/orgUnitRepository.ts` queried `company_memberships` with `WHERE company_id = $1 AND user_id = $2 AND status = 'active'`. However, `company_memberships` table defines boolean column `is_active`, and has no column named `status`. This resulted in PostgreSQL runtime error `column "status" does not exist`.
- **Fix**: Replaced `AND status = 'active'` with `AND is_active = true` in `src/server/org/orgUnitRepository.ts`.

## Files Changed
- `src/server/org/orgUnitRepository.ts` (replaced `status = 'active'` with `is_active = true`)
- `scripts/verifyFixN1OrgScopeStatus1.ts` (new verification harness)
- `package.json` (registered `test:fix-n1-org-scope-status-1`)
- `scripts/lib/battery_exclusions.json` (registered `verifyFixN1OrgScopeStatus1.ts`)
- `docs/foundation/AI_PROJECT_STATE.md` (documented package state)
- `docs/foundation/AN-FIX-N1-ORG-SCOPE-STATUS-1_RESULTS.md` (results summary)

## Verification Results
- **TypeScript Typecheck**: `npm run typecheck` — **PASSED**
- **N1 Fix Verification**: `npm run test:fix-n1-org-scope-status-1` — **PASSED (6/6)**
- **Battery Integrity**: `npm run test:battery-integrity` — **PASSED**
- **Production Build**: `npm run build` — **PASSED**
- **Applet Compilation & Linting**: `compile_applet` & `lint_applet` — **PASSED**
