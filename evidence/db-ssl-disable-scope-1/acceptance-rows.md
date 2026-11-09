# Acceptance Rows Evidence: AN-DB-SSL-DISABLE-SCOPE-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | Production + `DATABASE_SSL=disable` throws error | **PASS** | Unit test in `verifyDbSslDisableScope1.ts` |
| **S2** | Non-prod + `DATABASE_SSL=disable` + localhost URL returns undefined (no SSL) | **PASS** | Unit test in `verifyDbSslDisableScope1.ts` |
| **S3** | Non-prod + `DATABASE_SSL=disable` + remote Supabase URL forces SSL ON | **PASS** | Unit test in `verifyDbSslDisableScope1.ts` |
| **S4** | Non-prod + `DATABASE_SSL=disable` + pooler host URL forces SSL ON | **PASS** | Unit test in `verifyDbSslDisableScope1.ts` |
| **S5** | Non-prod remote without disable has SSL enabled | **PASS** | Unit test in `verifyDbSslDisableScope1.ts` |
| **S6** | Non-prod localhost without disable has SSL off | **PASS** | Unit test in `verifyDbSslDisableScope1.ts` |
| **S7** | `AI_PROJECT_STATE.md` records `AN-DB-SSL-DISABLE-SCOPE-1` | **PASS** | Static check in `verifyDbSslDisableScope1.ts` |
