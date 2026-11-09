# Acceptance Criteria & Evidence Matrix: AN-FOUNDATION-GATE-CLOSE-1

## Summary
- **Package**: AN-FOUNDATION-GATE-CLOSE-1
- **Status**: IMPLEMENTED
- **CI Gate Status**: CLOSED
- **Green Actions Run**: Run #72 (operator-confirmed green on main)
- **Green CI HEAD SHA**: `a1d1197abf78b38c7a7b123e5527b704d77bf871` (or HEAD)

## Acceptance Criteria Matrix

| Item | Criterion | Verification Method | Status | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **S1** | `AI_PROJECT_STATE.md` contains package entry `AN-FOUNDATION-GATE-CLOSE-1` | Static File Check (`verifyFoundationGateClose1.ts`) | **PASS** | Package recorded in `AI_PROJECT_STATE.md` section 2 |
| **S2** | `AI_PROJECT_STATE.md` records `FOUNDATION_CI_GATE: CLOSED` and `GREEN_CI_SHA` | Static File Check (`verifyFoundationGateClose1.ts`) | **PASS** | `FOUNDATION_CI_GATE: CLOSED` recorded in `AI_PROJECT_STATE.md` |
| **S3** | `OPEN_GAPS.md` records `FOUNDATION-CI-GATE` as CLOSED with SHA | Static File Check (`verifyFoundationGateClose1.ts`) | **PASS** | Row updated in `OPEN_GAPS.md` |
| **S4** | `OPERATOR_LIVE_SMOKE_CHECKLIST.md` exists and contains smoke steps without secrets | File System Check | **PASS** | `docs/foundation/OPERATOR_LIVE_SMOKE_CHECKLIST.md` created |
| **S5** | `companyRoutes.ts` retains `hasMembership` check on `GET /:id` | Code Pattern Search | **PASS** | `hasMembership` active in `src/server/routes/companyRoutes.ts` |
| **S6** | `scram.ts` retains correct `salt$StoredKey` delimiter pattern | Code Pattern Search | **PASS** | `SCRAM-SHA-256$4096:...$StoredKey...` verified in `src/server/security/scram.ts` |
| **S7** | `migrationRunner.ts` inserts checksum into `schema_migrations` | Code Pattern Search | **PASS** | `INSERT INTO schema_migrations (version, checksum)` verified in `src/server/db/migrationRunner.ts` |
| **S8** | Sub-ledger business ERP modules remain unstarted | Codebase Scope Verification | **PASS** | `MODULES_STARTED: NO` recorded in `AI_PROJECT_STATE.md` |
