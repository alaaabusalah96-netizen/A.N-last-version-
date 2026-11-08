# Acceptance Matrix: AN-FIX-LEDGER-ORG-FOLLOWUP-1

| Req ID | Description | Status | Proof / Location |
| :--- | :--- | :--- | :--- |
| **S1** | Migration 017 file exists | **PASS** | `database/migrations/017_ledger_org_followup.sql` |
| **S2** | Replaced `ON DELETE SET NULL` with `ON DELETE RESTRICT` for composite FKs | **PASS** | `database/migrations/017_ledger_org_followup.sql` lines 8-35 |
| **S3** | Trigger function checks `TG_OP` branches ('INSERT', 'DELETE', 'UPDATE') & validates BOTH `OLD` and `NEW` parent entries | **PASS** | `database/migrations/017_ledger_org_followup.sql` lines 40-80 |
| **S4** | `trialBalanceService.ts` SQL filters posted entries in subquery | **PASS** | `src/server/accounting/trialBalanceService.ts` lines 50-70 |
| **S5** | Migration 015 file preserved | **PASS** | `database/migrations/015_ledger_hardening.sql` |
| **S6** | Migration 016 file preserved | **PASS** | `database/migrations/016_org_integrity.sql` |
| **S7** | `AI_PROJECT_STATE.md` updated with implementation status | **PASS** | `docs/foundation/AI_PROJECT_STATE.md` |
