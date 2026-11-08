# Acceptance Criteria Matrix: AN-P1C-ORG-INTEGRITY-1

| Req ID | Description | Status | Proof / Location |
| :--- | :--- | :--- | :--- |
| **S1** | Migration 016 file exists | **PASS** | `database/migrations/016_org_integrity.sql` |
| **S2** | Composite foreign keys for same-company org unit references | **PASS** | `database/migrations/016_org_integrity.sql` lines 1-100 |
| **S3** | Target user active company membership check in `setUserScopes` | **PASS** | `src/server/org/orgUnitRepository.ts` & `orgUnitService.ts` |
| **S4** | `org_units` and `user_org_scope` registered in `table_ownership.json` | **PASS** | `database/table_ownership.json` |
| **S5** | P1B hardening migration 015 preserved | **PASS** | `database/migrations/015_ledger_hardening.sql` |
| **S6** | `AI_PROJECT_STATE.md` updated with implementation status | **PASS** | `docs/foundation/AI_PROJECT_STATE.md` |
| **S7** | Explicit non-claim: org-scope-on-ledger deferred to future package | **PASS** | `scripts/verifyP1cOrgIntegrity1.ts` |
