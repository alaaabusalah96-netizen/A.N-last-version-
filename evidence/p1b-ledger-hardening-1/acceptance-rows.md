# Acceptance Matrix: AN-P1B-LEDGER-HARDENING-1

| Req ID | Requirement Description | Status | Proof / Location |
| :--- | :--- | :--- | :--- |
| **S1** | Migration 015 file exists | **PASS** | `database/migrations/015_ledger_hardening.sql` |
| **S2** | Trigger blocks `INSERT`, `UPDATE`, `DELETE` lines on posted entries | **PASS** | `database/migrations/015_ledger_hardening.sql` line ~7 |
| **S3** | DB-level balance check on transition to posted | **PASS** | `database/migrations/015_ledger_hardening.sql` line ~60 |
| **S4** | `postEntry` path uses `FOR UPDATE` row locking | **PASS** | `src/server/accounting/journalRepository.ts` & `journalService.ts` |
| **S5** | Narrowed posted update trigger checks `period_id` and metadata columns | **PASS** | `database/migrations/015_ledger_hardening.sql` line ~45 |
| **S6** | P1b `postEntry` method present | **PASS** | `src/server/accounting/journalService.ts` line ~118 |
| **S7** | `AI_PROJECT_STATE.md` records implementation | **PASS** | `docs/foundation/AI_PROJECT_STATE.md` |
| **S8** | App mounts `/api/accounting` | **PASS** | `src/server/routes/accountingRoutes.ts` |
