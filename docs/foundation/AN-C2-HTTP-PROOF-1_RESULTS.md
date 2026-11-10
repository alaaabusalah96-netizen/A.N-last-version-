# Results Report: AN-C2-HTTP-PROOF-1

## Summary
- **Package**: AN-C2-HTTP-PROOF-1
- **Type**: LEAN / LIVE HTTP PROOF (RBAC user-admin boundaries)
- **Status**: IMPLEMENTED
- **Target Harness**: `scripts/verifyC2HttpProof1.ts`
- **CI Workflow**: `.github/workflows/foundation-ci.yml`

## Covered Routes
- `GET /api/users` (List users, global for platform_admin vs company-scoped for company_admin)
- `POST /api/users` (Create user with role binding)
- `POST /api/users/:userId/memberships` (Add user company membership)
- `PATCH /api/users/:userId/memberships/:membershipId` (Set membership active state)
- `PATCH /api/users/:userId` (Set user active state)
- `POST /api/users/:userId/reset-password` (Reset user password)

## Proof Matrix (Cases A - F)
- **Case A (Unauthenticated Requests)**:
  - `GET /api/users` without auth session -> **401 Unauthorized**
  - `POST /api/users` without auth session -> **401 Unauthorized**
  - Status: **PASS**
- **Case B (Company User Forbidden)**:
  - `GET /api/users` as `company_user` -> **403 FORBIDDEN** (code: `FORBIDDEN`)
  - `POST /api/users` as `company_user` -> **403 FORBIDDEN** (code: `FORBIDDEN`)
  - Status: **PASS**
- **Case C (Company Admin Escalation Guard)**:
  - Attempt to create user with `role: 'platform_admin'` -> **403 FORBIDDEN** (code: `FORBIDDEN`)
  - Attempt to assign `role: 'platform_admin'` via membership -> **403 FORBIDDEN** (code: `FORBIDDEN`)
  - Status: **PASS**
- **Case D (Platform Admin Allowed Actions)**:
  - Create user with password length >= 12 -> **201 Created**
  - List users -> **200 OK**
  - Update user active status -> **200 OK**
  - Reset password -> **200 OK**
  - Status: **PASS**
- **Case E (Platform Admin Target Protection)**:
  - `company_admin` attempting to disable `platform_admin` -> **403 FORBIDDEN** (code: `FORBIDDEN`)
  - `company_admin` attempting to reset `platform_admin` password -> **403 FORBIDDEN** (code: `FORBIDDEN`)
  - Status: **PASS**
- **Case F (No Credential Leakage)**:
  - All responses sanitized via `mapUserResponse`: `passwordHash` and `password` are undefined in user payloads.
  - Status: **PASS**

## CI Wiring
- Wired step `Verify C2 HTTP User-Admin Proof (AN-C2-HTTP-PROOF-1)` in `.github/workflows/foundation-ci.yml`.
- Executed against CI PostgreSQL service container with provisioned `an_app` application role and `MIGRATION_DATABASE_URL`.

## Scope & Non-Claims
- `OPEN_GAPS.md` item `C2-LIVE` marked as **CLOSED**.
- `PG-SMOKE-LIVE` remains open for operator execution on real live database instance.
- No new business modules started.
