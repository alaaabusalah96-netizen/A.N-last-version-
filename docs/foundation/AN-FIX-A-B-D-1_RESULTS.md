# Results Report: AN-FIX-A-B-D-1

## Package Details
- **Package**: AN-FIX-A-B-D-1
- **Type**: LEAN / SECURITY & TEST ALIGNMENT
- **Status**: IMPLEMENTED

## Verification Results
- **Typecheck**: PASSED (0 errors)
- **Build**: PASSED
- **verifyFixAbd1**: PASSED (6/6 assertions passed)
- **verifyExecutorImports**: PASSED (No allowlist modification required)
- **verifyMigration010**: PASSED (Guarded DO block pattern accepted)
- **verifyBatteryIntegrity**: PASSED

## Summary of Changes
1. **A - Dead Executor Clean-Up (`src/server/org/companySettingsRepository.ts`)**:
   - Removed `import { getDefaultExecutor } from '../db/index.js';`
   - Removed unused `private async getExecutor()` helper.
   - Preserved `withTenantTransaction` execution paths intact without modifying `database/executor_import_allowlist.json`.
2. **B - Company GET RBAC Isolation (`src/server/routes/companyRoutes.ts`)**:
   - Enforced active membership requirement on `GET /api/companies/:id` for non-`platform_admin` users.
   - Throws `ForbiddenError('Forbidden')` (yielding HTTP 403 and `code: 'FORBIDDEN'`) when user lacks active membership for company `:id`.
   - Preserved `NotFoundError` (HTTP 404) for non-existent company IDs.
3. **D - Migration 010 Security Guard Alignment (`scripts/verifyMigration010.ts`)**:
   - Updated static regex checks 14 & 15 to support guarded `DO $$ ... IF EXISTS (SELECT 1 FROM pg_proc ... 'rls_auto_enable') THEN EXECUTE 'REVOKE ...'; END IF; $$;` pattern.
   - Preserved `010_security_rls_baseline.sql` guard without modifying applied migration behavior or breaking vanilla PostgreSQL CI compatibility.
4. **Out-of-Scope**:
   - Did NOT modify `migrationRunner.ts` or `schema_migrations` checksum logic (Package C reserved).
