# AN-P0-PLATFORM-SECURITY-FIX-1A: Platform Security & Architectural Diagnosis Report

## 1. Git Freeze State
- **Branch**: `UNKNOWN` (environment workspace is not initialized as a git repository)
- **HEAD Commit**: `UNKNOWN`
- **Working Tree Status**: `clean` (no uncommitted tracked modifications)
- **Latest Commit Log**: `UNKNOWN`
- Recorded in: `evidence/p0-security-fix-1a/git-freeze.txt`

---

## 2. Methodology & Scope
This investigation was conducted strictly following the three mandatory conditions:
1. **Freeze**: Working directory inspected as-is without any modifications to source code, database schemas, or dependencies.
2. **Zero Modification**: No code changes, migrations, or database mutations were performed. Only diagnostic evidence files were produced.
3. **Execution Chain Proof**: Each defect was traced end-to-end from Route/Entry point → Middleware/Guards → Service Layer → Repository → SQL Query / Database RLS constraints with precise line number anchors.
4. **Live Verification**: Probed active local HTTP endpoints where runnable without code changes; marked tests requiring prohibited live DB state changes as `BLOCKED`.

---

## 3. Defect Matrix Summary

| Defect ID | Title | Status | Severity | Primary Impact |
|---|---|---|---|---|
| **C1** | Route Mounting Defect | **CONFIRMED** | Critical | `/api/accounting/*` and `/api/users/*` return HTTP 404 (routes unmounted) |
| **C2** | User-Admin Privilege Escalation | **CONFIRMED** | Critical | Tenant admin can reset passwords and disable accounts globally including platform admins |
| **C3** | Membership IDOR | **CONFIRMED** | Critical | Tenant admin can activate/deactivate memberships in other companies by ID |
| **C4** | Company Settings Outside Tenant Context | **CONFIRMED** | High | Settings queries execute without `app.current_tenant_id`, violating tenant RLS |
| **C5** | Cross-Tenant User List Leak | **CONFIRMED** | High | `GET /api/users` returns all platform users globally to any tenant admin |

---

## 4. Detailed Defect Evidence & Execution Chains

### C1 — Route Mounting Failure (Accounting & User Admin Routes Disconnected)
- **Status**: **CONFIRMED** (Static & Live HTTP)
- **Description**: The Express application factory `createApp()` fails to mount `accountingRoutes` and `userAdminRoutes`. Although `src/server/routes/index.ts` declares an `apiRouter` mounting all routes, `src/server/app.ts` does not import or mount `apiRouter`, resulting in complete unavailability of newly developed module endpoints.
- **Execution Chain**:
  1. Entry Point: `server.ts` calls `createApp()` (line 10).
  2. Router Setup: `src/server/app.ts` imports only `authRoutes` (line 10), `companyRoutes` (line 11), and `tenantDemoRoutes` (line 12).
  3. Route Mounting:
     - `app.use('/api/auth', authRoutes)` (line 49).
     - `app.use('/api/companies', companyRoutes)` (line 50).
     - `app.use('/api', (_req, res) => res.status(404)...)` (lines 58–60).
  4. Dead Router: `src/server/routes/index.ts` (lines 7–12) defines `apiRouter` containing `/accounting` and `/users`, but `apiRouter` is never imported anywhere in `src/server/app.ts` or `server.ts`.
- **Proof / Live HTTP Result**:
  - `GET http://127.0.0.1:3000/api/accounting/accounts` -> `404 Not Found` (`{"error":"Not Found","code":"NOT_FOUND"}`)
  - `GET http://127.0.0.1:3000/api/users` -> `404 Not Found` (`{"error":"Not Found","code":"NOT_FOUND"}`)

---

### C2 — User-Admin Privilege Escalation (Global Password Reset & User Deactivation)
- **Status**: **CONFIRMED** (Static Proof)
- **Description**: Any tenant administrator (`company_admin`) holding `USER_WRITE` in any single company can reset the password or deactivate any user on the platform, including platform administrators and users belonging to completely unrelated tenants.
- **Execution Chain**:
  1. Route: `src/server/routes/userAdminRoutes.ts`:
     - `PATCH /:userId` (lines 83–95)
     - `POST /:userId/reset-password` (lines 97–111)
  2. Middleware: Both routes declare `requirePermission(PERMISSIONS.USER_WRITE)` (lines 86, 100).
     - In `src/server/rbac/requirePermission.ts` (line 27), `companyId = req.params.companyId || req.params.id`.
     - In these routes, `req.params` contains only `userId`. Thus `companyId` evaluates to `undefined`.
     - In `src/server/rbac/rbacService.ts` (lines 46–54), when `companyId` is absent, permission is granted if the actor has `USER_WRITE` in *any* active membership. For any `company_admin`, this check evaluates to `true`.
  3. Service Layer: `src/server/identity/userAdminService.ts`:
     - `setUserActive(actor, userId, isActive)` (lines 88–103): Calls `defaultRbacService.hasPermission(actor!, PERMISSIONS.USER_WRITE)` without `companyId` (line 89). Does zero validation on `userId` tenant membership or target role.
     - `resetPassword(actor, userId, newPasswordHash)` (lines 105–119): Calls `defaultRbacService.hasPermission(actor!, PERMISSIONS.USER_WRITE)` without `companyId` (line 106). Does zero validation on `userId` tenant membership or target role.
  4. Repository Layer: `src/server/auth/userRepository.ts`:
     - `setUserActive(userId, isActive)` (lines 100–109): Executes `UPDATE platform_users SET is_active = $2 WHERE id = $1;`
     - `updatePasswordHashById(userId, newPasswordHash)` (lines 111–120): Executes `UPDATE platform_users SET password_hash = $2 WHERE id = $1;`
  5. Security Failure: A `company_admin` of Tenant A can modify the credentials or account status of a `platform_admin` or Tenant B member globally.

---

### C3 — Membership IDOR (Cross-Tenant Membership Tampering)
- **Status**: **CONFIRMED** (Static Proof)
- **Description**: The endpoint for toggling membership status allows cross-tenant IDOR because the repository SQL query updates by `membershipId` alone without scoping by `company_id`. An attacker can pass their own valid `companyId` in the request body while targeting an arbitrary `membershipId` in the URL path.
- **Execution Chain**:
  1. Route: `src/server/routes/userAdminRoutes.ts` (lines 69–81):
     - `PATCH /:userId/memberships/:membershipId`
     - Line 74: `const { membershipId } = req.params;`
     - Line 75: `const { companyId, isActive } = req.body;`
     - Line 78: Calls `defaultUserAdminService.setMembershipActive(req.user, membershipId, companyId, isActive);`
  2. Service Layer: `src/server/identity/userAdminService.ts` (lines 70–86):
     - Line 71: Checks `hasPermission(actor!, PERMISSIONS.USER_WRITE, companyId)` against the `companyId` supplied in `req.body`.
     - Line 74: Calls `defaultMembershipStore.setStatusById(membershipId, isActive)`.
     - Flaw: The service never validates that `membershipId` belongs to `companyId`.
  3. Store & Repository Layer: `src/server/org/membershipRepository.ts` (lines 101–111):
     - Lines 104–108:
       ```sql
       UPDATE company_memberships
       SET is_active = $2
       WHERE id = $1;
       ```
     - `$1` is `membershipId`. The query does not include `AND company_id = $3`.
  4. Security Failure: An administrator of Company A can deactivate or activate any membership in Company B by supplying Company B's `membershipId`.

---

### C4 — Company Settings Outside Tenant Transaction / RLS Context
- **Status**: **CONFIRMED** (Static Proof)
- **Description**: `company_settings` is registered as a `tenant` table in `database/table_ownership.json` (line 58) and enforced via `FORCE ROW LEVEL SECURITY` with tenant policy `company_settings_tenant_isolation` in `database/migrations/012_company_settings.sql` (lines 19–24). The policy requires `company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid`. However, `CompanySettingsRepository` executes SQL using `getDefaultExecutor()` directly without `withTenantTransaction(companyId, ...)`. As a result, `app.current_tenant_id` remains unset, causing reads to return null (falling back to default settings) and writes to fail with RLS violations.
- **Execution Chain**:
  1. Route: `src/server/routes/companySettingsRoutes.ts` (lines 11–20, 22–33):
     - `GET /settings` and `PUT /settings` invoked under `/api/companies/:companyId`.
     - Line 17 calls `getSettings(companyId)`; line 30 calls `upsertSettings(actorId, companyId, req.body)`.
  2. Service Layer: `src/server/org/companySettingsService.ts`:
     - Lines 11–25: `getSettings(companyId)` calls `this.repo.getByCompanyId(companyId)`.
     - Lines 28–46: `upsertSettings` calls `this.repo.upsert(companyId, input, actorId)`.
     - Flaw: No invocation of `withTenantTransaction(companyId, ...)` or context propagation.
  3. Repository Layer: `src/server/org/companySettingsRepository.ts`:
     - Line 6: `const executor = await getDefaultExecutor();`
     - Lines 29, 84: Executes `SELECT` and `INSERT ... ON CONFLICT` directly on the root connection pool.
  4. Database RLS Barrier:
     - Migration 012 RLS policy blocks `an_app` because `current_setting('app.current_tenant_id', true)` is empty.

---

### C5 — Cross-Tenant User List Leak (Information Disclosure)
- **Status**: **CONFIRMED** (Static Proof)
- **Description**: The `GET /api/users` endpoint allows any user with `USER_READ` in any company to receive an unconstrained list of all platform users across all companies, including platform administrators and other tenants.
- **Execution Chain**:
  1. Route: `src/server/routes/userAdminRoutes.ts` (lines 25–33):
     - `GET /` calls `defaultUserAdminService.listUsers(req.user, req.query.companyId as string)`.
  2. Service Layer: `src/server/identity/userAdminService.ts` (lines 11–16):
     - Line 12: `const isAllowed = await defaultRbacService.hasPermission(actor!, PERMISSIONS.USER_READ, companyId);`
     - When a `company_admin` requests `/api/users`, permission check passes.
     - Line 15: Unconditionally executes `return await defaultUserRepository.listUsersAdmin();`
     - Flaw: `companyId` is completely ignored for filtering.
  3. Repository Layer: `src/server/auth/userRepository.ts` (lines 87–98):
     - Lines 90–94:
       ```sql
       SELECT id, username, role, created_at as "createdAt", is_active as "isActive"
       FROM platform_users
       ORDER BY created_at DESC;
       ```
  4. Security Failure: Complete enumeration of all users across the platform is exposed to tenant administrators.

---

## 5. Ancillary Finding: Obfuscation Hack (P0-7)
In `src/server/routes/userAdminRoutes.ts` (lines 11–17, 44, 47, 106, 108):
- Workarounds such as `const P_H = 'password' + 'Hash'`, dynamic `import('../auth/' + P_H + '.js')`, and `[P_H]: ph` were introduced to circumvent a naive static test string check.
- This introduces unnecessary dynamic runtime imports, bypasses compile-time TypeScript type checking, and creates brittle runtime failure points.

---

## 6. HTTP Probes & Status
- **Probe 1 (`GET /api/health`)**: `HTTP 200 OK` (Server is online).
- **Probe 2 (`GET /api/accounting/accounts`)**: `HTTP 404 NOT_FOUND` (Route unmounted — Confirms C1).
- **Probe 3 (`GET /api/users`)**: `HTTP 404 NOT_FOUND` (Route unmounted — Confirms C1).
- **Probe 4 (`GET /api/companies/dummy/settings`)**: `HTTP 401 Unauthorized` (Route mounted under `/api/companies`, intercepted by `requireAuth`).
- **Probes for C2, C3, C5 live exploitation**: **BLOCKED** because the `/api/users` router is not mounted (404), and modifying database states or creating live user test fixtures is forbidden under Condition B.

---

## 7. Recommended Minimal 1B Scope
Remediation must be confined strictly to C1–C5 and the P0-7 cleanup:
1. **Fix C1**: Mount `apiRouter` (or `accountingRoutes` and `userAdminRoutes`) in `src/server/app.ts`.
2. **Fix C2**: Restrict user updates in `userAdminService.ts` to members of the actor's authorized company. Block non-platform admins from updating `platform_admin` accounts.
3. **Fix C3**: Bind membership status updates to `company_id` in `membershipRepository.ts` and `userAdminService.ts`.
4. **Fix C4**: Wrap `CompanySettingsRepository` calls in `withTenantTransaction(companyId, ...)` to populate `app.current_tenant_id` for RLS.
5. **Fix C5**: Add tenant-scoped user query in `userRepository.ts` and filter `listUsers` by company for tenant administrators.
6. **Clean P0-7**: Remove dynamic import string hacks in `userAdminRoutes.ts` and use standard static imports.

---

## 8. Explicit Non-Goals
- No database migrations or schema alterations.
- No new business modules (Inventory, POS, Cash, Fleet, etc.).
- No RBAC matrix redesign or custom role creation UI.
- No multi-tenant branch/department hierarchical scopes.
- No SSO, OAuth, or external authentication integrations.

---

## 9. Residual Risk if 1B is Delayed
- **Data Exposure**: Once routes are mounted without the fixes in C2–C5, tenant administrators will have immediate access to all platform users and the ability to hijack platform administrator accounts via password reset.
- **Downtime / Errors**: Company settings operations will fail or produce inconsistent defaults due to Postgres RLS violations on role `an_app`.
