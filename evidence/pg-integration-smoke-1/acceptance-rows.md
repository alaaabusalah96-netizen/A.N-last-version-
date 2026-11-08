# Acceptance Matrix: AN-PG-INTEGRATION-SMOKE-1

| Req ID | Description | Status | Proof / Location |
| :--- | :--- | :--- | :--- |
| **S1** | Migrations 015, 016, 017 file existence | **PASS** | `database/migrations/` |
| **S2** | `trialBalanceService.ts` posted subquery isolation | **PASS** | `src/server/accounting/trialBalanceService.ts` |
| **S3** | `017_ledger_org_followup.sql` TG_OP OLD/NEW trigger checks | **PASS** | `database/migrations/017_ledger_org_followup.sql` |
| **S4** | `package.json` contains `test:pg-smoke-1` script | **PASS** | `package.json` |
| **S5** | `AI_PROJECT_STATE.md` updated with package record | **PASS** | `docs/foundation/AI_PROJECT_STATE.md` |
| **T1** | DB URL presence check | **BLOCKED** | Missing privileged DDL connection string in local preview |
| **T2** | Block line INSERT on posted entry | **BLOCKED** | DB URL unconfigured |
| **T3** | Block line UPDATE/move on posted entry | **BLOCKED** | DB URL unconfigured |
| **T4** | DB balance trigger on status transition to posted | **BLOCKED** | DB URL unconfigured |
| **T5** | Block cross-company parent org unit FK | **BLOCKED** | DB URL unconfigured |
| **T6** | Block cross-company accounts/entries org unit FK | **BLOCKED** | DB URL unconfigured |
| **T7** | Live Trial Balance query execution | **BLOCKED** | DB URL unconfigured |
