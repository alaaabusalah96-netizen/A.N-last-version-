# Acceptance Rows Evidence: AN-FIX-A-B-D-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | `companySettingsRepository.ts` has no `getDefaultExecutor` import or `getExecutor()` method | **PASS** | Source check in `verifyFixAbd1.ts` |
| **S2** | `executor_import_allowlist.json` does NOT allowlist `companySettingsRepository.ts` | **PASS** | File check in `verifyFixAbd1.ts` |
| **S3** | `companyRoutes.get("/:id")` enforces active membership check with 403 Forbidden for non-platform_admin | **PASS** | Route check in `verifyFixAbd1.ts` |
| **S4** | `verifyMigration010.ts` supports guarded DO + `pg_proc` check pattern for `rls_auto_enable` | **PASS** | Regex check in `verifyFixAbd1.ts` |
| **S5** | `010_security_rls_baseline.sql` preserves `IF EXISTS (pg_proc)` guard for `rls_auto_enable` | **PASS** | Source check in `verifyFixAbd1.ts` |
| **S6** | `AI_PROJECT_STATE.md` records `AN-FIX-A-B-D-1` | **PASS** | State ledger check in `verifyFixAbd1.ts` |
