# Acceptance Rows Evidence: AN-PG-INTEGRATION-PROOF-2

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | Migrations 015, 016, 017, 018 exist | **PASS** | File existence check in `verifyPgIntegrationProof2.ts` |
| **S2** | `trialBalanceService` posted-only aggregate | **PASS** | Source check in `verifyPgIntegrationProof2.ts` |
| **S3** | 017 trigger checks TG_OP and OLD/NEW | **PASS** | Source check in `verifyPgIntegrationProof2.ts` |
| **S4** | Migration tooling contains no `/proc` | **PASS** | Source check in `verifyPgIntegrationProof2.ts` |
| **S5** | `migrationRunner.ts` requires `MIGRATION_DATABASE_URL` | **PASS** | Source check in `verifyPgIntegrationProof2.ts` |
| **S6** | `AI_PROJECT_STATE.md` records `AN-PG-INTEGRATION-PROOF-2` | **PASS** | Source check in `verifyPgIntegrationProof2.ts` |
| **T1–T7** | Independent proof test cases with savepoint isolation & strict error matching | **PASS / BLOCKED** | Executed in `verifyPgIntegrationProof2.ts` |
