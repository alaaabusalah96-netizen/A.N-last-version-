# Acceptance Rows — AN-P1B-LEDGER-GUARANTEES-1

| Check ID | Requirement | Verification Method | Result | Notes |
|----------|-------------|---------------------|--------|-------|
| S1 | Migration 013 (Sequences, Periods, Constraints, Immutability) | Inspection of `database/migrations/013_ledger_guarantees.sql` | PASS | Defines `accounting_sequences`, `accounting_periods`, check constraints, and triggers `trg_fn_journal_entries_immutability` & `trg_fn_journal_lines_immutability` |
| S2 | Table Ownership Registration | Inspection of `database/table_ownership.json` | PASS | `accounting_sequences` and `accounting_periods` registered under `tenant` scope |
| S3 | Journal Engine Methods | Inspection of `src/server/accounting/journalService.ts` | PASS | `createDraftEntry`, `postEntry`, `reverseEntry`, `listEntries`, `getEntry` implemented |
| S4 | Double-Entry Balance Check | Source check in `journalService.postEntry` | PASS | Fails closed with `ValidationError` if `totalDebit !== totalCredit` or amounts <= 0 |
| S5 | Journal Routes Mounted | Inspection of `src/server/routes/accountingRoutes.ts` | PASS | GET `/journals`, GET `/journals/:id`, POST `/journals`, POST `/journals/:id/post`, POST `/journals/:id/reverse` |
| S6 | Fine-grained RBAC Permissions | Inspection of `permissions.ts` and `roles.ts` | PASS | `ACCOUNTING_JOURNALS_READ`, `WRITE`, and `POST` mapped to `platform_admin` and `company_admin`; read-only to `company_user` |
| S7 | User Interface Presence | Inspection of `AccountingWorkspace.tsx` and `JournalWorkspace.tsx` | PASS | General Ledger tab «دفتر اليومية العامة» active with list, create modal, balance indicators, post, and reverse actions |
| S8 | Tenant Isolation Kernel | Inspection of `journalRepository.ts` & `journalService.ts` | PASS | All operations wrapped in `withTenantTransaction(companyId, ...)` |
| S9 | AI Project State Status | Inspection of `docs/foundation/AI_PROJECT_STATE.md` | PASS | Documented as `AN-P1B-LEDGER-GUARANTEES-1: IMPLEMENTED` |
| S10 | P0 Security Mounts Intact | Inspection of `src/server/app.ts` | PASS | `/api/accounting` and `/api/users` routes cleanly mounted |
| Typecheck | Clean TypeScript Compilation | `npm run typecheck` | PASS | 0 errors |
| Build | Client & Server Production Bundle | `npm run build` | PASS | Clean Vite & esbuild bundles |
| Verification | Automated Harness | `npm run test:p1b-ledger-1` | PASS | 10 of 10 checks pass |
