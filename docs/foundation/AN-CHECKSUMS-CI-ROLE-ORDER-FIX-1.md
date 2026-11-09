# Results Report: AN-CHECKSUMS-CI-ROLE-ORDER-FIX-1

## Summary
- **Package**: AN-CHECKSUMS-CI-ROLE-ORDER-FIX-1
- **Status**: IMPLEMENTED
- **CI Workflow File**: `.github/workflows/foundation-ci.yml`
- **Verification Harness**: `scripts/verifyMigrationChecksums1.ts`

## Key Fixes Applied
1. **CI Step Ordering**:
   - Moved `Verify Migration Checksums (AN-MIGRATION-CHECKSUMS-1)` step in `.github/workflows/foundation-ci.yml` to execute **AFTER** `Provision App DB Role`.
2. **Environment Variables for Checksums Verification Step**:
   - `MIGRATION_DATABASE_URL`: `postgresql://an_test:an_test_pass@localhost:5432/an_foundation` (Owner role `an_test`)
   - `DATABASE_URL`: `postgresql://an_app:AppRoleSecurePass123!@localhost:5432/an_foundation` (App role `an_app`)
   - `APP_DB_USER`: `an_app`
   - `NODE_ENV`: `test`
   - `REQUIRE_DB`: `1`
   - `DATABASE_SSL`: `disable`
3. **Privilege Separation & Role Verification (C11 & C12)**:
   - `C11`: `getDefaultExecutor()` connects via `DATABASE_URL` as `an_app` passing `roleGuard.ts` check, verifying that `INSERT`, `UPDATE`, and `DELETE` on `schema_migrations` are blocked.
   - `C12`: Checks table privileges of Migration Owner (`an_test`) yielding full access (INSERT/UPDATE/DELETE/SELECT), and asserts `an_app` has `SELECT` only (no INSERT/UPDATE/DELETE).
