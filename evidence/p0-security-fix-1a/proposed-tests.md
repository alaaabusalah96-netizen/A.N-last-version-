# Proposed Test Suite — AN-P0-PLATFORM-SECURITY-FIX-1B

The following tests are proposed to be implemented as an automated verification script (`scripts/verifyPlatformSecurityFix1b.ts` and associated unit tests) during package 1B:

### Test T1: Route Mounting Verification (C1)
- **Description**: Verify that `createApp()` mounts `/api/accounting` and `/api/users` into the Express router.
- **Assertion**: An unauthenticated request to `/api/accounting/accounts` and `/api/users` returns HTTP 401 (Authentication required), proving the route is active and intercepted by auth middleware, rather than HTTP 404 (Not Found).

### Test T2: Cross-Tenant Password Reset Rejection (C2)
- **Description**: Verify that a `company_admin` cannot reset the password of a user belonging exclusively to another company.
- **Assertion**: `userAdminService.resetPassword(actorCompanyAdminA, userInCompanyB, newHash)` throws `ForbiddenError` or `NotFoundError`.

### Test T3: Platform Admin Account Protection (C2)
- **Description**: Verify that a `company_admin` cannot reset the password of a `platform_admin` account.
- **Assertion**: `userAdminService.resetPassword(actorCompanyAdminA, platformAdminUser, newHash)` throws `ForbiddenError`.

### Test T4: Cross-Tenant User Deactivation Rejection (C2)
- **Description**: Verify that a `company_admin` cannot deactivate (`setUserActive(false)`) a user who is not a member of their company.
- **Assertion**: `userAdminService.setUserActive(actorCompanyAdminA, userInCompanyB, false)` throws `ForbiddenError`.

### Test T5: Membership IDOR Protection (C3)
- **Description**: Verify that `setMembershipActive` enforces company ownership on the target membership.
- **Assertion**: Updating a membership ID that belongs to Company B while supplying Company A's `companyId` fails to modify the record and returns false/throws error.
- **Static Code Assertion**: `membershipRepository.setMembershipStatusById` query text contains `AND company_id = $3` (or equivalent parameter check).

### Test T6: Company Settings Tenant RLS Scoping (C4)
- **Description**: Verify that `CompanySettingsService` invokes repository calls within `withTenantTransaction(companyId, ...)`.
- **Assertion**: Static code inspection and mock execution confirm that `withTenantTransaction` wraps all read/write settings operations.

### Test T7: User List Tenant Scoping (C5)
- **Description**: Verify that `UserAdminService.listUsers` called by a `company_admin` filters by `companyId`.
- **Assertion**: A `company_admin` actor only receives users associated with their active company, and does not receive users belonging solely to other tenants.

### Test T8: Code Cleanliness & Static Type Safety (P0-7)
- **Description**: Verify that `userAdminRoutes.ts` does not contain dynamic string-split imports or string concatenation workarounds.
- **Assertion**: `userAdminRoutes.ts` imports `hashPassword` directly at top-level; TypeScript compiler completes without type assertions or implicit any errors.
