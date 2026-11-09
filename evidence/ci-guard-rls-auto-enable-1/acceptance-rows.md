# Acceptance Rows Evidence: AN-CI-GUARD-RLS-AUTO-ENABLE-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | `010_security_rls_baseline.sql` contains `rls_auto_enable` | **PASS** | Source check in `verifyCiGuardRlsAutoEnable1.ts` |
| **S2** | `010_security_rls_baseline.sql` wraps revoke in `IF EXISTS (pg_proc)` | **PASS** | Source check in `verifyCiGuardRlsAutoEnable1.ts` |
| **S3** | No unguarded standalone `REVOKE` for `rls_auto_enable` | **PASS** | Line scan in `verifyCiGuardRlsAutoEnable1.ts` |
| **S4** | `audit_logs_block_mutation` revoke remains present and intact | **PASS** | Source check in `verifyCiGuardRlsAutoEnable1.ts` |
| **S5** | `AI_PROJECT_STATE.md` records `AN-CI-GUARD-RLS-AUTO-ENABLE-1` | **PASS** | Static check in `verifyCiGuardRlsAutoEnable1.ts` |
| **S6** | No fake `CREATE FUNCTION rls_auto_enable` created | **PASS** | Regex scan in `verifyCiGuardRlsAutoEnable1.ts` |
