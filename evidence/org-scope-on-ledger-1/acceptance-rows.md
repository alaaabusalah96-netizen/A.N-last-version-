# Acceptance Matrix: AN-ORG-SCOPE-ON-LEDGER-1

| Req ID | Description | Status | Proof / Location |
| :--- | :--- | :--- | :--- |
| **S1** | `journalService.ts` references `assertUserOrgAccess` | **PASS** | `src/server/accounting/journalService.ts` |
| **S2** | `trialBalanceService.ts` references `assertUserOrgAccess` | **PASS** | `src/server/accounting/trialBalanceService.ts` |
| **S3** | `accountingRoutes.ts` passes `user.id` & `isPlatformAdmin` | **PASS** | `src/server/routes/accountingRoutes.ts` |
| **S4** | `assertUserOrgAccess` defined in `orgUnitService.ts` | **PASS** | `src/server/org/orgUnitService.ts` |
| **S5** | Empty-scope company-wide access preserved | **PASS** | `src/server/org/orgUnitService.ts` line ~170 |
| **S6** | `AI_PROJECT_STATE.md` updated with package status | **PASS** | `docs/foundation/AI_PROJECT_STATE.md` |
| **S7** | P1b `postEntry` method present | **PASS** | `src/server/accounting/journalService.ts` |
| **S8** | No new migrations added (018 expected none) | **PASS** | `database/migrations/` |
