# AN-FIX-LEDGER-ORG-FOLLOWUP-1 Results Report

## Overview
- **Package**: `AN-FIX-LEDGER-ORG-FOLLOWUP-1`
- **Scope**: Remediated three residual defects:
  1. Replaced invalid composite FK `ON DELETE SET NULL` on non-nullable `company_id` with `ON DELETE RESTRICT` in `017_ledger_org_followup.sql`.
  2. Fixed Trial Balance aggregation query in `trialBalanceService.ts` to use a subquery pattern strictly filtering `status = 'posted'`, preventing draft line amounts from being calculated.
  3. Hardened `trg_fn_journal_lines_immutability` trigger in `017_ledger_org_followup.sql` to check `TG_OP` branches ('INSERT', 'DELETE', 'UPDATE') and evaluate parent entry status on BOTH `OLD.entry_id` and `NEW.entry_id`.

---

## Verification Results
- `npm run typecheck`: **PASSED** (0 errors)
- `npm run build`: **PASSED**
- `npm run test:fix-ledger-org-followup-1`: **PASSED** (All S1–S7 checks passed)
