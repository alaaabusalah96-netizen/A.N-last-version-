# File Hit List — Proposed for AN-P0-PLATFORM-SECURITY-FIX-1B

The following files represent the minimal, surgical set of files requiring modification in 1B to resolve defects C1–C5:

### 1. Route Mounting & Application Entry (C1)
- **`src/server/app.ts`**:
  - Replace disjoint route mounts with `app.use('/api', apiRouter)` (imported from `./routes/index.js`) OR explicitly mount `accountingRoutes` at `/api/accounting` and `userAdminRoutes` at `/api/users`.
  - Retain `applySecurityMiddleware`, CORS, CSRF, health/ready, and error handling.
- **`src/server/routes/index.ts`**:
  - Reconcile `apiRouter` to serve as the unified API route tree.

### 2. User Administration & Tenant Scoping (C2, C5, P0-7)
- **`src/server/routes/userAdminRoutes.ts`**:
  - Remove obfuscated `const P_H = 'password' + 'Hash'` and dynamic imports; restore clean, typed imports of `hashPassword`.
  - Sanitize user response objects cleanly using typed destructuring.
  - Require explicit tenant scope (`companyId`) in route params or query where applicable.
- **`src/server/identity/userAdminService.ts`**:
  - In `listUsers(actor, companyId)`: If actor is `company_admin`, enforce `companyId` validation and restrict query to members of that company only. Only `platform_admin` may query globally without `companyId`.
  - In `resetPassword(actor, userId, newPasswordHash)`: Validate that the target user belongs to a company where `actor` has active `company_admin` membership (or `actor` is `platform_admin`). Strictly prevent non-platform admins from resetting `platform_admin` accounts.
  - In `setUserActive(actor, userId, isActive)`: Validate tenant membership of target user. Disallow `company_admin` from deactivating users outside their company or deactivating platform administrators.
- **`src/server/auth/userRepository.ts`**:
  - Add tenant-scoped query method (e.g., `listUsersByCompany(companyId: string)`) joining `platform_users` with `company_memberships` where `company_memberships.company_id = $1`.

### 3. Membership IDOR Prevention (C3)
- **`src/server/identity/userAdminService.ts`**:
  - In `setMembershipActive`: Verify that `membershipId` belongs to `companyId` before updating, or pass both `membershipId` and `companyId` down to repository.
- **`src/server/org/membershipRepository.ts`**:
  - In `setMembershipStatusById(membershipId, isActive, companyId?)`: Ensure query updates only matching company:
    `UPDATE company_memberships SET is_active = $2 WHERE id = $1 AND company_id = $3;` to eliminate cross-tenant IDOR.

### 4. Company Settings Tenant Transaction / RLS Context (C4)
- **`src/server/org/companySettingsService.ts`**:
  - Wrap `getSettings` and `upsertSettings` in `withTenantTransaction(companyId, async (tx) => { ... })` so that `app.current_tenant_id` is set in Postgres session context.
- **`src/server/org/companySettingsRepository.ts`**:
  - Accept optional `DbExecutor` (transaction executor from `withTenantTransaction`) so queries run with active tenant RLS context.
