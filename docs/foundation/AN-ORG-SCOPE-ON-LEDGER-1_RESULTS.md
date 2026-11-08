# AN-ORG-SCOPE-ON-LEDGER-1 Results Report

## Overview
- **Package**: `AN-ORG-SCOPE-ON-LEDGER-1`
- **Scope**: Wired `assertUserOrgAccess` from `orgUnitService` into general ledger entry operations (`createDraftEntry`, `postEntry`, `reverseEntry`, `listEntries`, `getEntry`) and `trialBalanceService.getTrialBalance`.
- **Policy Decided & Implemented**:
  1. **Empty Scopes (Backward-Compatible)**: Users with zero configured org unit scopes have full company-wide access.
  2. **Scoped Users**: Users with configured org unit scopes must select/specify an authorized org unit (direct match or descendant if `include_descendants=true`). Creating, posting, or reversing an entry without an authorized org unit returns HTTP 403 / `ForbiddenError`.
  3. **Platform Admin Policy**: `platform_admin` role bypasses org unit scoping checks for support and administrative tasks.

---

## Verification Results
- `npm run typecheck`: **PASSED** (0 errors)
- `npm run build`: **PASSED**
- `npm run test:org-scope-on-ledger-1`: **PASSED** (All S1–S8 checks passed)
