# Results Report: AN-FIX-ABD-1-LIVE-PROOF

## Package Details
- **Package**: AN-FIX-ABD-1-LIVE-PROOF
- **Type**: DIAGNOSTIC & LIVE PROOF
- **Status**: IMPLEMENTED

## Verification Results
- **Typecheck**: PASSED (0 errors)
- **Build**: PASS
- **verifyAbd1LiveProof**: PASSED (7/7 assertions passed)
- **verifyBatteryIntegrity**: PASSED

## Summary of Findings
1. **Git State Verification**:
   - Branch: `main`
   - HEAD SHA: `1858a716a82d473f4fa3df7cc8c251162633ce22`
   - Active membership gate present in `src/server/routes/companyRoutes.ts` (B).
   - Unused `getDefaultExecutor` and `getExecutor()` removed from `src/server/org/companySettingsRepository.ts` (A).
2. **RBAC Proof (A–E)**:
   - A) Cross-company access (`userA` querying `companyB`): HTTP 403 `code: FORBIDDEN` -> PASS
   - B) Inactive membership query (`userA` querying `companyA` after deactivation): HTTP 403 `code: FORBIDDEN` -> PASS
   - C) Active member query (`userA` querying `companyA`): HTTP 200 OK -> PASS
   - D) Platform admin query (`platformAdmin` querying `companyB`): HTTP 200 OK -> PASS
   - E) Non-existent company UUID query (`userA` querying random valid UUID): HTTP 404 `code: NOT_FOUND` -> PASS
3. **Migration 010 Live ACL Proof**:
   - Absent function scenario: `010_security_rls_baseline.sql` handles missing `rls_auto_enable` function cleanly without failing.
   - Present function scenario: `010_security_rls_baseline.sql` revokes `EXECUTE` on `public.rls_auto_enable()` for `PUBLIC`, `anon`, and `authenticated`.
