# Results Report: AN-PROVISION-ROLE-MISSING-ROLES-FIX-1

## Package Details
- **Package**: AN-PROVISION-ROLE-MISSING-ROLES-FIX-1
- **Type**: CI PROVISIONING REPAIR (skip missing protected roles before invoking pg_has_role)
- **Status**: IMPLEMENTED

## Verification Results
- **Typecheck**: PASSED (0 errors)
- **Build**: PASSED
- **verifyProvisionRoleMissingRolesFix1**: PASSED (6/6 assertions passed)

## Root Cause
In vanilla PostgreSQL in GitHub Actions CI, the database is created with user `an_test`. Roles such as `postgres`, `supabase_admin`, `authenticator`, and `service_role` may not exist. Calling `SELECT pg_has_role($1, 'postgres', 'USAGE')` on a non-existent role raises PostgreSQL error code `42704` (`role "postgres" does not exist`), failing the `Provision App DB Role` CI step.

## Solution
1. **Protected Roles Existence Check**:
   - `scripts/provisionAppRole.ts` checks `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1)` before calling `pg_has_role`.
   - If a role does not exist: skipped (`continue`).
   - If a role exists: invokes `pg_has_role(appDbUser, protRole, 'USAGE')`. If membership is detected, strictly throws an error.
2. **Preserved Invariants**:
   - Retained all 6 role names in `protectedRoles`: `['postgres', 'supabase_admin', 'service_role', 'authenticator', 'anon', 'authenticated']`.
   - No fake or stub roles created in CI.
   - All `an_app` attribute and ownership checks (`NOSUPERUSER`, `NOBYPASSRLS`, table ownership, `has_schema_privilege`, `schema_migrations`, `audit_logs`) preserved intact.
   - CI workflow steps retained untouched.
