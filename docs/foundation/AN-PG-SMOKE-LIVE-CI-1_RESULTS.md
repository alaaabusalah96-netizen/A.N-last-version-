# AN-PG-SMOKE-LIVE-CI-1 Results Report

## 1. Overview
- **Package**: `AN-PG-SMOKE-LIVE-CI-1`
- **Type**: Lean / Live PG Smoke in CI + Safety Guards
- **Repository**: `alaaabusalah96-netizen/A.N-last-version-`
- **Branch**: `main`
- **Baseline**: After `AN-ACCOUNTING-PERIODS-HARDEN-1`

## 2. Hardening Objectives & Delivered Solutions
1. **CI Automation of Integration Smoke (`test:pg-smoke-1`)**:
   - Added step `PostgreSQL Integration Smoke (AN-PG-SMOKE-LIVE-CI-1)` to `.github/workflows/foundation-ci.yml`.
   - Wired with `SMOKE_ALLOW_DISPOSABLE: "1"`, `MIGRATION_DATABASE_URL`, and `DATABASE_URL` after migrations and role provisioning.

2. **Host-Based Safety Guard (`SMOKE_ALLOW_DISPOSABLE`)**:
   - Added `isProductionOrSupabaseDb` function inside `scripts/verifyPgIntegrationSmoke1.ts`.
   - Refuses live write operations against Supabase or production hostnames unless `SMOKE_ALLOW_DISPOSABLE=1` is explicitly set in environment.

3. **Isolated Live Test Cases with Guaranteed Client Teardown**:
   - Switched to `buildPgConfig` for robust SSL policy handling.
   - Isolated cases T1–T7 with individual savepoints (`sp_smoke_t2` through `sp_smoke_t7`) so that individual case outcomes are clearly tracked and isolated.
   - Guaranteed client closure via `client.end().catch(() => {})` in finally blocks.
   - Strict exit policy failing when `failedCount > 0`, and in CI failing if any case is blocked.

4. **Documentation & Gaps Registry**:
   - Updated `docs/foundation/OPEN_GAPS.md` marking `PG-SMOKE-LIVE` as `CLOSED` for the automated CI gate.
   - Documented operational execution instructions in `docs/foundation/OPERATOR_LIVE_SMOKE_CHECKLIST.md`.
