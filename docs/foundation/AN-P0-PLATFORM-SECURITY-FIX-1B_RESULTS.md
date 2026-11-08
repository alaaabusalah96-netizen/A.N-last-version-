# AN-P0-PLATFORM-SECURITY-FIX-1B Results Report

**Package**: AN-P0-PLATFORM-SECURITY-FIX-1B  
**Type**: LEAN / IMPLEMENTATION — P0 C1–C5 (+ P0-7 only)  
**Status**: IMPLEMENTED  
**Date**: 2026-11-08  

---

## 1. Executive Summary

This package remediated the confirmed architectural and security vulnerabilities diagnosed in `AN-P0-PLATFORM-SECURITY-FIX-1A`:
- **C1 Route Mounting**: Mounted `accountingRoutes` under `/api/accounting` and `userAdminRoutes` under `/api/users` in `src/server/app.ts`.
- **C2 Privilege Escalation**: Enforced tenant company membership checks and platform admin target immunity in `UserAdminService` for `setUserActive` and `resetPassword`. Enforced password length >= 12 characters.
- **C3 Membership IDOR**: Scoped membership status updates in `MembershipRepository` with `AND company_id = $3` (and optional `AND user_id = $4`).
- **C4 Company Settings Tenant Context**: Routed all `CompanySettingsRepository` operations through `withTenantTransaction(companyId, ...)` to satisfy tenant-level RLS.
- **C5 User List Leak**: Scoped user listing in `userAdminService.listUsers` to company memberships for tenant actors via `userRepository.listUsersByCompany(companyId)`.
- **P0-7 Obfuscation Cleanup**: Replaced string-concatenation dynamic import hacks in `userAdminRoutes.ts` with direct typed imports from `../auth/passwordHash.js`.

---

## 2. Remediated Files

| File | Change Description |
|------|--------------------|
| `src/server/app.ts` | Explicitly mounted `accountingRoutes` (`/api/accounting`) and `userAdminRoutes` (`/api/users`) before catch-all handler. |
| `src/server/routes/index.ts` | Re-exported route modules (`authRoutes`, `companyRoutes`, `accountingRoutes`, `userAdminRoutes`) alongside `apiRouter`. |
| `src/server/auth/userRepository.ts` | Added `listUsersByCompany(companyId)` joining on `company_memberships`. |
| `src/server/org/membershipRepository.ts` | Updated `setMembershipStatusById` to require `companyId` and enforce `AND company_id = $3` in SQL `WHERE`. |
| `src/server/org/membershipStore.ts` | Updated `setStatusById` signature to pass `companyId` and optional `userId`. |
| `src/server/identity/userAdminService.ts` | Added actor authentication check, target role protection, company scope validation, and tenant user filtering. |
| `src/server/routes/userAdminRoutes.ts` | Removed `P_H` obfuscation, imported `hashPassword` directly, enforced minimum password length >= 12, passed `companyId` and `userId` context. |
| `src/server/org/companySettingsRepository.ts` | Wrapped queries inside `withTenantTransaction(companyId, ...)`. |
| `package.json` | Added `"test:p0-security-fix-1b": "tsx scripts/verifyP0SecurityFix1b.ts"`. |
| `scripts/verifyP0SecurityFix1b.ts` | Automated verification harness for tests S1–S10 and H1–H2. |
| `docs/foundation/AI_PROJECT_STATE.md` | Recorded `AN-P0-PLATFORM-SECURITY-FIX-1B` as `IMPLEMENTED`. |

---

## 3. Strict Boundary Compliance

- **No Migrations**: Zero database migrations added or modified.
- **No New Modules**: No org units, ledger engines, MFA/SSO, or custom role UI created.
- **No Secrets**: No secret tokens, credentials, or production connection strings committed or exposed.
