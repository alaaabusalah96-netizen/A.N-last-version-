# Acceptance Rows Evidence: AN-FIX-VERIFY-MIGRATE-SCOPE-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | `scripts/migrate.ts` does not contain `/proc` | **PASS** | Source check in `verifyFixVerifyMigrateScope1.ts` |
| **S2** | `scripts/migrate.ts` does not fallback/retry `DATABASE_URL` | **PASS** | Source check in `verifyFixVerifyMigrateScope1.ts` |
| **S3** | `scripts/migrate.ts` requires `MIGRATION_DATABASE_URL` | **PASS** | Source check in `verifyFixVerifyMigrateScope1.ts` |
| **S4** | `scripts/verifyPgIntegrationSmoke1.ts` does not contain `/proc` | **PASS** | Source check in `verifyFixVerifyMigrateScope1.ts` |
| **S5** | `smoke T2` strictly requires `CANNOT_MODIFY_POSTED` error | **PASS** | Source check in `verifyFixVerifyMigrateScope1.ts` |
| **S6** | `journalService.ts` `listEntries` enforces `orgUnitId` for scoped users | **PASS** | Source check in `verifyFixVerifyMigrateScope1.ts` |
| **S7** | `docs/foundation/AI_PROJECT_STATE.md` has `AN-FIX-VERIFY-MIGRATE-SCOPE-1` | **PASS** | Source check in `verifyFixVerifyMigrateScope1.ts` |
