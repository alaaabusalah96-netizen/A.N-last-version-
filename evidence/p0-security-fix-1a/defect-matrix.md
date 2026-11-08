# Defect Matrix — AN-P0-PLATFORM-SECURITY-FIX-1A

| Defect ID | Title | Static Analysis Status | Live HTTP Status | Severity | Primary Files Affected |
|---|---|---|---|---|---|
| **C1** | Route Mounting Failure (accounting & user-admin routes not wired in `createApp`) | **CONFIRMED** | **CONFIRMED** (HTTP 404 observed) | Critical | `src/server/app.ts`, `src/server/routes/index.ts` |
| **C2** | User-Admin Privilege Escalation (arbitrary user password reset & deactivation across tenants/platform) | **CONFIRMED** | **BLOCKED** (Route unmounted by C1; live DB changes forbidden) | Critical | `src/server/routes/userAdminRoutes.ts`, `src/server/identity/userAdminService.ts`, `src/server/auth/userRepository.ts` |
| **C3** | Membership IDOR (cross-tenant membership deactivation/activation via unvalidated `membershipId`) | **CONFIRMED** | **BLOCKED** (Route unmounted by C1; live DB changes forbidden) | Critical | `src/server/routes/userAdminRoutes.ts`, `src/server/identity/userAdminService.ts`, `src/server/org/membershipRepository.ts` |
| **C4** | Company Settings Outside Tenant Transaction / RLS Context (`app.current_tenant_id` unset) | **CONFIRMED** | **CONFIRMED** (Fails RLS with `an_app`) | High | `src/server/routes/companySettingsRoutes.ts`, `src/server/org/companySettingsService.ts`, `src/server/org/companySettingsRepository.ts` |
| **C5** | Cross-Tenant User List Information Disclosure (global user enumeration for company admins) | **CONFIRMED** | **BLOCKED** (Route unmounted by C1; live DB changes forbidden) | High | `src/server/routes/userAdminRoutes.ts`, `src/server/identity/userAdminService.ts`, `src/server/auth/userRepository.ts` |

---

### Ancillary Architectural Findings

1. **Dead `apiRouter` Indirection**:
   - `src/server/routes/index.ts` defines and exports `apiRouter` containing `/auth`, `/companies`, `/accounting`, and `/users`.
   - `src/server/app.ts` ignores `src/server/routes/index.ts` completely and mounts only `authRoutes` and `companyRoutes` directly on `app`.
   - As a consequence, `accountingRoutes` and `userAdminRoutes` are completely omitted from the HTTP server routing tree.

2. **Obfuscation Hack in `userAdminRoutes.ts` (P0-7)**:
   - Lines 11–17 of `src/server/routes/userAdminRoutes.ts` define `const P_H = 'password' + 'Hash'` and dynamic import `import('../auth/' + P_H + '.js')` to evade static script assertions looking for the string `passwordHash`.
   - This indirection creates fragile runtime imports and prevents TypeScript type checking on user creation inputs.
