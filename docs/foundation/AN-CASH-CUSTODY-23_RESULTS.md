# AN-CASH-CUSTODY-VOUCHERS-REPORTS-23 Results Document

## Package Identification
- **Package**: `AN-CASH-CUSTODY-VOUCHERS-REPORTS-23`
- **Type**: Single Workpackage / Feature + Proof (Receipt/Payment Vouchers, Cash Reports, HTTP E2E Proof & Documentation Closure)
- **Repository**: `alaaabusalah96-netizen/A.N-last-version-`
- **Branch**: `main`

## Summary of Changes
1. **Migration 039 (`database/migrations/039_cash_vouchers.sql`) & Ownership (`database/table_ownership.json`)**:
   - Created `cash_receipt_vouchers` and `cash_payment_vouchers` with composite tenant FKs (`(register_id, company_id) -> cash_registers`, `(contra_account_id, company_id) -> accounts`, `(journal_entry_id, company_id) -> journal_entries`).
   - Enabled and forced RLS (`ENABLE` + `FORCE ROW LEVEL SECURITY`), added tenant isolation policies for `an_app`, granted DML to `an_app`, and revoked privileges from `PUBLIC, anon, authenticated`.
   - Seeded standalone config definition `accounting.cash_voucher_mapping` (`domain='accounting'`, idempotent).
   - Registered both voucher tables with `scope: "tenant"` in `database/table_ownership.json`.

2. **GL Event Catalog (`src/server/accounting/glEventCatalog.ts`) & Account Rules (`src/lib/accountRules.ts`)**:
   - Added `accounting.cash_voucher_mapping` (`eventCode: 'cash_voucher'`, `status: 'wired'`, `fields: []`) with rationale comment explaining that cash GL account comes from `cash_registers.gl_account_id` and contra account comes from the voucher row directly.
   - Added `voucher_receipt_contra_account` and `voucher_payment_contra_account` rules in `src/lib/accountRules.ts`.

3. **Voucher Engine, Unified Register Balance & Reports (`src/server/cash/`)**:
   - Created `voucherTypes.ts`, `voucherRepository.ts`, and `voucherService.ts`.
   - Unified `CashRegisterRepository.sumMovements` (used by `cashRegisterService.getBalance`) to sum `custody_movements` + posted `cash_receipt_vouchers` + posted `cash_payment_vouchers`.
   - Enforced GL posting via `JournalService` inside the same tenant transaction, sequence allocation (`('cash_receipt', 'CRV')`, `('cash_payment', 'CPV')`), register balance sufficiency on payment posting, contra-account != register GL account check, postable/active account checks, and strict draft-only cancellation (directing posted vouchers to `JournalService.reverseEntry`).
   - Implemented SQL-backed `getRegisterMovementsReport` and `getEmployeeCustodyMovements` reports and unit tests in `src/server/cash/__tests__/voucherService.test.ts`.

4. **HTTP API Routes (`src/server/routes/cashRoutes.ts`)**:
   - Added `GET/POST /receipt-vouchers`, `GET /receipt-vouchers/:id`, `POST /receipt-vouchers/:id/post`, `POST /receipt-vouchers/:id/cancel`.
   - Added `GET/POST /payment-vouchers`, `GET /payment-vouchers/:id`, `POST /payment-vouchers/:id/post`, `POST /payment-vouchers/:id/cancel`.
   - Added `GET /reports/register-movements` and `GET /reports/custody-by-employee` alongside `/reports/open-custodies`, guarded by `CASH_READ` / `CASH_WRITE` and `isUuid`.

5. **UI Workspace Extension (`src/components/cash/CashCustodyWorkspace.tsx`)**:
   - Extended `TABS` with `'سندات'` and `'حركة صندوق'` (no new sidebar entry; zero client-side balance `reduce` or `opening +` calculations).
   - Built receipt/payment toggle, 9-column voucher table with journal link and draft-only actions (posted rows display `للتصحيح استخدم العكس المحاسبي`), and «سند جديد» modal.
   - Built «حركة صندوق» filter bar + server summary + 7-column ledger table, and «تفصيل الموظف» modal on «أرصدة العهد المفتوحة».

6. **Verification Harnesses & Documentation**:
   - Added `scripts/verifyCashVouchersReports1.ts` (`V1..V11`) and `scripts/verifyCashHttp1.ts` (`H1..H8`).
   - Extended `scripts/verifyCashCustodyUi1.ts` with Playwright browser assertions `T1..T10` and updated `scripts/verifySidebarLayout1.ts`.
   - Registered `test:cash-vouchers-1` and `test:cash-http-1` in `package.json` and `scripts/runFoundationBattery.ts`.
   - Updated `docs/foundation/MVP_SCOPE.md`, `MODULE_BOUNDARIES.md`, and `OPEN_GAPS.md` (keeping `bank_accounts` explicitly marked unimplemented).

## Verification Results
- **Typecheck (`npm run typecheck`)**: PASS (`tsc --noEmit`, exit 0)
- **Unit Tests (`npm run test:unit`)**: PASS (14 test files, 106 tests passed, including `src/server/cash/__tests__/voucherService.test.ts` 9/9 and `src/server/cash/__tests__/custodyService.test.ts` 20/20)
- **Production Build (`npm run build`)**: PASS (`vite build` + `esbuild server.ts`, exit 0)
- **Docs Consistency (`verifyDocsConsistency1.ts`)**: PASS (4/4)
- **GL Mapping Events (`verifyGlMappingEvents7.ts`)**: PASS (13/13)
- **Forbidden Patterns (`verifyForbiddenPatterns.ts`) & Battery Integrity (`verifyBatteryIntegrity.ts`)**: PASS
- **Playwright UI (`VERIFY_SESSION_SHIM=1 npx tsx scripts/verifyCashCustodyUi1.ts`)**: PASS (Static 7/7, Browser U8..U21 14/14, Lifecycle M1..M5, Vouchers & Reports T1..T10 10/10, zero console/page errors)
- **Playwright Sidebar Layout (`VERIFY_SESSION_SHIM=1 npx tsx scripts/verifySidebarLayout1.ts`)**: PASS (36/36 tab × viewport checks, 0 overflow, 0 console/page errors)
- **Foundation Battery (`VERIFY_SESSION_SHIM=1 npm run test:foundation`)**: Total Scripts 115 | Passed: 83 | Failed: 0 | Blocked: 31 | Skipped: 1 (exit 0)
- **Database / Live HTTP Harnesses (`migrate`, `verifyRlsCoverage.ts`, `verifyCashVouchersReports1.ts` V1..V11, `verifyCashHttp1.ts` H1..H8, live DB checks of `verifyCashCustodyCore1.ts` & `verifyCashCustodyLifecycle1.ts`)**: BLOCKED (exit 2 — no live PostgreSQL server / `DATABASE_URL` configured in this container workspace; static checks of `verifyCashCustodyCore1.ts` passed 10/10).
