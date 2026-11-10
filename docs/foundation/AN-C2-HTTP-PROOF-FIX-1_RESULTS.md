# AN-C2-HTTP-PROOF-FIX-1 Results Report

## 1. Overview
- **Package**: `AN-C2-HTTP-PROOF-FIX-1`
- **Scope**: Lean / Test Harness Fix + Safety (zero RBAC redesign, zero CSRF loosening)
- **Repository**: `alaaabusalah96-netizen/A.N-last-version-`
- **Branch**: `main`

## 2. Root Cause Analysis
In GitHub Actions Run #75, step `Verify C2 HTTP User-Admin Proof (AN-C2-HTTP-PROOF-1)` failed on Case A:
- `verifyC2HttpProof1.ts` sent unauthenticated `POST /api/users` and asserted `res.status === 401`.
- However, the global `csrfProtection` middleware executes ahead of `requireAuth` for mutating HTTP methods (`POST`, `PATCH`, `DELETE`).
- Without session cookies or CSRF tokens/headers, mutating requests are rejected by `csrfProtection` with HTTP `403` and `code: 'CSRF_INVALID'` or `code: 'CSRF_ORIGIN'`.
- This rejection is correct security behavior and should NOT be relaxed or bypassed.

## 3. Implemented Fixes
1. **Case A Contract Realignment**:
   - `GET /api/users` without auth: strictly expects `401`.
   - `POST /api/users` without auth: accepts `401` OR `403` with CSRF rejection code (`code.startsWith('CSRF_')`, `'CSRF_INVALID'`, `'CSRF_ORIGIN'`, or `'FORBIDDEN'`).
   - Rejection is strictly non-200/201.
   - Preserved strict 403 checks for RBAC Cases B–F without any weakening.

2. **Database Test Entity Cleanup**:
   - `scripts/verifyC2HttpProof1.ts` tracks all created company IDs and user IDs (`createdCompanyIds`, `createdUserIds`).
   - In `finally`, entities are deleted in FK-safe dependency order:
     - `user_sessions`
     - `company_memberships`
     - `platform_users`
     - `companies`
   - All delete operations use individual `.catch(() => {})` handlers to prevent unhandled rejections from masking test execution.

3. **Production / Supabase Environment Guard**:
   - Added `isProductionOrSupabaseDb(urlStr: string): boolean` helper checking host patterns (`supabase.co`, `pooler.supabase`, `supabase.com`, `aws.neon.tech`, `rds.amazonaws.com`).
   - Before executing live tests against `DATABASE_URL`, if the URL matches protected hosts and `process.env.C2_ALLOW_DISPOSABLE !== '1'`, the harness immediately aborts with `BLOCKED` status without issuing live mutating DDL/DML.
   - Added static check `S5` to continuously test the guard function behavior.

4. **CI Workflow Configuration**:
   - In `.github/workflows/foundation-ci.yml`, added `C2_ALLOW_DISPOSABLE: "1"` to step `Verify C2 HTTP User-Admin Proof (AN-C2-HTTP-PROOF-1)`.
