# Acceptance Criteria Matrix: AN-P1D-ACCOUNTING-UI-EXPANSION-1

| Req ID | Description | Status | Proof / Location |
| :--- | :--- | :--- | :--- |
| **S1** | Expose `GET /api/accounting/trial-balance` endpoint | **PASS** | `src/server/routes/accountingRoutes.ts` line ~145 |
| **S2** | Aggregate posted entries only (`status = 'posted'`) | **PASS** | `src/server/accounting/trialBalanceService.ts` SQL query |
| **S3** | Render Trial Balance UI panel with filters and balance status | **PASS** | `src/components/accounting/TrialBalancePanel.tsx` & `AccountingWorkspace.tsx` |
| **S4** | Support optional `orgUnitId` in draft entries & lists | **PASS** | `src/server/accounting/journalRepository.ts`, `journalService.ts` |
| **S5** | Integrate Org Unit filtering & selection in General Ledger UI | **PASS** | `src/components/accounting/JournalWorkspace.tsx` |
| **S6** | Preserve P1b ledger posting guarantees (`postEntry`) | **PASS** | `src/server/accounting/journalService.ts` |
| **S7** | Preserve P1c Org Units read permission check | **PASS** | `src/server/security/permissions.ts` |
| **S8** | Update `AI_PROJECT_STATE.md` with implementation status | **PASS** | `docs/foundation/AI_PROJECT_STATE.md` |
| **S9** | Wrap trial balance queries in `withTenantTransaction` RLS context | **PASS** | `src/server/accounting/trialBalanceService.ts` |
