# Acceptance Rows — AN-P0-VERIFY-1

| Check ID | Defect / Pattern | Verification Method | Result | Notes |
|----------|------------------|---------------------|--------|-------|
| V1 | C1 Route Mounting (Static) | `src/server/app.ts` checks | PASS | `accountingRoutes` & `userAdminRoutes` mounted on `/api` |
| V2a | C1 HTTP `/api/accounting/accounts` | Real in-process HTTP GET via ephemeral loopback server | PASS | Returns HTTP 401 Unauthorized (NOT 404) |
| V2b | C1 HTTP `/api/users` | Real in-process HTTP GET via ephemeral loopback server | PASS | Returns HTTP 401 Unauthorized (NOT 404) |
| V2c | Baseline 404 Catch-All | Real in-process HTTP GET on undefined `/api/*` route | PASS | Correctly returns HTTP 404 Not Found |
| V3 | C2 Platform Admin Immunity | `userAdminService.ts` static AST audit | PASS | Non-platform admins cannot mutate platform admin accounts |
| V4 | C2 Company Scope Enforcement | `userAdminService.ts` static AST audit | PASS | Non-platform admins must supply `companyId` with target membership |
| V5 | C3 Membership IDOR Prevention | `membershipRepository.ts` SQL inspection | PASS | `WHERE id = $1 AND company_id = $3` strictly enforced |
| V6 | C4 Tenant Context (RLS) | `companySettingsRepository.ts` code audit | PASS | All operations wrapped in `withTenantTransaction(companyId, ...)` |
| V7 | C5 Cross-Tenant User Listing Leak | `userAdminService.ts` code audit | PASS | Scoped to company memberships via `listUsersByCompany` |
| V8 | P0-7 Obfuscation Elimination | `userAdminRoutes.ts` regex check | PASS | Zero `P_H` or `'password'+'Hash'` concatenation; typed imports |
| V9 | Password Policy Enforcement | `userAdminRoutes.ts` length validation | PASS | Min length >= 12 enforced for create and reset |
| V10 | App Factory Testability | `src/server/app.ts` export audit | PASS | `createApp()` exported without listen side-effects |
| V11 | State Documentation | `AI_PROJECT_STATE.md` audit | PASS | `AN-P0-VERIFY-1: IMPLEMENTED` documented |
