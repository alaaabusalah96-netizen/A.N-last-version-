# Results Report: AN-FIX-VERIFY-MIGRATE-SCOPE-1

## Package Details
- **Package**: AN-FIX-VERIFY-MIGRATE-SCOPE-1
- **Type**: LEAN / SECURITY + VERIFY QUALITY + LIST SCOPE
- **Status**: IMPLEMENTED

## Verification Results
- **Typecheck**: PASSED
- **Build**: PASSED
- **verifyFixVerifyMigrateScope1**: PASSED (7/7 assertions passed)

## Component Summary
1. **scripts/migrate.ts**:
   - `/proc` environ scraping: REMOVED
   - `DATABASE_URL` fallback/retry: REMOVED
   - `MIGRATION_DATABASE_URL` requirement: ENFORCED (Fatal exit on missing)

2. **scripts/verifyPgIntegrationSmoke1.ts**:
   - `/proc` environ scraping: REMOVED
   - T2 strict condition: ENFORCED (`/CANNOT_MODIFY_POSTED|posted journal entry/i`)

3. **src/server/accounting/journalService.ts**:
   - Scoped user `listEntries` without `orgUnitId`: Throws `ValidationError` asking for `orgUnitId`.

4. **src/server/accounting/trialBalanceService.ts**:
   - Scoped user `getTrialBalance` without `orgUnitId`: Throws `ValidationError` asking for `orgUnitId`.
