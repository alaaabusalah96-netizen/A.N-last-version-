# Acceptance Rows Evidence: AN-CI-BOOTSTRAP-ROLES-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | `foundation-ci.yml` contains `ci:bootstrap-roles` before `Run Database Migrations` | **PASS** | File sequence check in `verifyCiBootstrapRoles1.ts` |
| **S2** | `ciBootstrapRoles.ts` creates `anon` and `authenticated` with `NOLOGIN` | **PASS** | Source check in `verifyCiBootstrapRoles1.ts` |
| **S3** | Historical migrations 010–014 intact without modifications | **PASS** | Content check in `verifyCiBootstrapRoles1.ts` |
| **S4** | `AI_PROJECT_STATE.md` records `AN-CI-BOOTSTRAP-ROLES-1` | **PASS** | Static check in `verifyCiBootstrapRoles1.ts` |
| **S5** | No production Supabase URL hardcoded in `foundation-ci.yml` | **PASS** | Static check in `verifyCiBootstrapRoles1.ts` |
