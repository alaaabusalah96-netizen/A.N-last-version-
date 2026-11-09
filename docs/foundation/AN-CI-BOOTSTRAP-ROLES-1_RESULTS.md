# Results Report: AN-CI-BOOTSTRAP-ROLES-1

## Package Details
- **Package**: AN-CI-BOOTSTRAP-ROLES-1
- **Type**: LEAN / CI ENV BOOTSTRAP ONLY (P0a continue)
- **Status**: IMPLEMENTED

## Verification Results
- **Typecheck**: PASSED
- **Build**: PASSED
- **verifyCiBootstrapRoles1**: PASSED (5/5 assertions passed).

## Component Summary
1. **scripts/ciBootstrapRoles.ts**:
   - Creates stub roles `anon` and `authenticated` with `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION` via idempotent `DO $$` block.
2. **.github/workflows/foundation-ci.yml**:
   - Added step `Bootstrap stub Supabase roles (anon, authenticated)` (`npm run ci:bootstrap-roles`) before `Run Database Migrations`.
3. **Historical Migrations**:
   - Historical migrations 010–014 remain intact and unedited.
4. **Documentation & Evidence**:
   - `docs/foundation/AN-CI-BOOTSTRAP-ROLES-1_RESULTS.md`
   - `evidence/ci-bootstrap-roles-1/acceptance-rows.md`
