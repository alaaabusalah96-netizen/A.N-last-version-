# Proposed Scope for AN-P0-PLATFORM-SECURITY-FIX-1B

### Core Objectives
The objective of package 1B is strictly to remediate the confirmed critical defects C1 through C5 diagnosed in 1A, without scope creep.

### In-Scope Remediation Items
1. **Remediate C1 (Route Mounting)**:
   - Wire `accountingRoutes` and `userAdminRoutes` into the main application Express router in `src/server/app.ts` (unifying with `apiRouter` in `src/server/routes/index.ts`).
2. **Remediate C2 (Privilege Escalation on User Admin)**:
   - Enforce tenant verification for user administration. Prevent `company_admin` from modifying any user not actively belonging to their company.
   - Enforce explicit guard prohibiting non-`platform_admin` actors from updating or resetting `platform_admin` accounts.
3. **Remediate C3 (Membership IDOR)**:
   - Bind `membershipId` mutations to `companyId` in both service logic and SQL queries (`WHERE id = $1 AND company_id = $2`), preventing cross-tenant membership state tampering.
4. **Remediate C4 (Company Settings Tenant RLS Scoping)**:
   - Wrap company settings database queries inside `withTenantTransaction(companyId, ...)` to ensure Postgres session setting `app.current_tenant_id` satisfies the `company_settings_tenant_isolation` RLS policy.
5. **Remediate C5 (Cross-Tenant User List Leak)**:
   - Implement tenant-filtered user querying so that `company_admin` can only retrieve users who hold memberships in their authorized company.
6. **Remediate P0-7 (Code Cleanliness & De-obfuscation)**:
   - Remove string concatenation (`'password' + 'Hash'`) and dynamic import workarounds in `userAdminRoutes.ts`, returning to standard statically-typed imports and proper TypeScript interfaces.

---

### Strict Out-of-Scope Boundaries for 1B
- **NO** database migrations (Migration 012 schema remains unchanged).
- **NO** new business modules (Inventory, Purchasing, Cash, POS, etc.).
- **NO** custom role builder or dynamic permission assignment engine.
- **NO** org units, multi-branch, or department hierarchy.
- **NO** SSO, OAuth, MFA, or external auth providers.
- **NO** changes to database connection architecture or SSL configs.
- **NO** modifications to existing foundation security tests or live Supabase configuration.
