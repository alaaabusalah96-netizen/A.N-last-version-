# Acceptance Rows Evidence: AN-DB-SSL-POLICY-2

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | Production + `DATABASE_SSL=disable` throws error | **PASS** | Unit test in `verifyDbSslPolicy2.ts` |
| **S2** | Non-prod + `DATABASE_SSL=disable` returns undefined (no SSL) | **PASS** | Unit test in `verifyDbSslPolicy2.ts` |
| **S3** | Non-prod + localhost URL returns undefined (no SSL) | **PASS** | Unit test in `verifyDbSslPolicy2.ts` |
| **S4** | Non-prod + remote Supabase URL returns SSL config object by default | **PASS** | Unit test in `verifyDbSslPolicy2.ts` |
| **S5** | Non-prod + `DATABASE_SSL=require` returns SSL config | **PASS** | Unit test in `verifyDbSslPolicy2.ts` |
| **S6** | `sanitizeConnectionString` strips `sslmode` while keeping SSL config enabled for remote host | **PASS** | Unit test in `verifyDbSslPolicy2.ts` |
| **S7** | `AI_PROJECT_STATE.md` records `AN-DB-SSL-POLICY-2` | **PASS** | Static check in `verifyDbSslPolicy2.ts` |
| **S8** | `foundation-ci.yml` contains `DATABASE_SSL: disable` for CI steps | **PASS** | Static check in `verifyDbSslPolicy2.ts` |
