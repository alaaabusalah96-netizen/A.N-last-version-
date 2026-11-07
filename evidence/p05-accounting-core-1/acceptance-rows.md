# Acceptance Rows — AN-P05-ACCOUNTING-CORE-1

| Requirement | Result | Evidence |
|---|---|---|
| Migration 011 defines accounts with RLS | PASS | `database/migrations/011_accounting_core.sql` |
| Table ownership registers tenant tables | PASS | `database/table_ownership.json` |
| Backend accounting service & repository | PASS | `src/server/accounting/accountService.ts` |
| Accounting API mounted at `/api/accounting` | PASS | `src/server/routes/index.ts` |
| UI Navigation to Accounting workspace | PASS | `src/App.tsx` nav tab "المحاسبة" |
| UI AccountsPanel list, seed & create modal | PASS | `src/components/accounting/AccountsPanel.tsx` |
| No firebase imports | PASS | Codebase clean |
| P05_STARTED set to YES for accounting slice | PASS | `docs/foundation/AI_PROJECT_STATE.md` |
| Other modules (inventory/purchasing) unstarted | PASS | Verified NO code created for out-of-scope modules |
