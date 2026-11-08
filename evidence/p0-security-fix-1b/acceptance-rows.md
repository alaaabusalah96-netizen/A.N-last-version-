# Acceptance Rows — AN-P0-PLATFORM-SECURITY-FIX-1B

| Item | Requirement | Verification Method | Status | Notes |
|------|-------------|---------------------|--------|-------|
| C1 | Mount `accountingRoutes` & `userAdminRoutes` in `app.ts` | Static AST check + Express router layer probe | PASS | Routes mounted at `/api/accounting` and `/api/users` before 404 handler |
| C2 | Privilege escalation prevention (company admin cannot mutate platform admins or cross-company users) | Unit assertion in `userAdminService.ts` | PASS | Fails closed with `ForbiddenError` / `ValidationError` |
| C3 | Membership update IDOR prevention | SQL inspection in `membershipRepository.ts` | PASS | `WHERE id = $1 AND company_id = $3` enforced |
| C4 | Company settings tenant context enforcement | Repository code audit in `companySettingsRepository.ts` | PASS | All operations wrapped in `withTenantTransaction(companyId, ...)` |
| C5 | Cross-tenant user list leak prevention | Service & repository code audit | PASS | `listUsersByCompany` performs `INNER JOIN company_memberships` |
| P0-7 | Remove dynamic obfuscation (`'password'+'Hash'`) | Code pattern search in `userAdminRoutes.ts` | PASS | Direct import of `hashPassword` from `passwordHash.js` |
| PassLen | Minimum password length >= 12 | Route validation checks | PASS | `ValidationError` thrown if length < 12 |
| S1–S10 | Automated verification harness | `npm run test:p0-security-fix-1b` | PASS | 10 static + 2 route checks pass |
| Typecheck | Zero TypeScript compilation errors | `npm run typecheck` | PASS | Clean 0 errors |
| Build | Vite client & Node server bundle | `npm run build` | PASS | Clean production build |
