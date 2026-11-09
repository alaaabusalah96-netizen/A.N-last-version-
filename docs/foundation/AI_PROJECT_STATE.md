# حالة المشروع وسجل المساعد الذكي (AI Project State)

## 1. مفردات الحالة المعيارية المعتمدة
- `IMPLEMENTED`: تم بناء الهيكل والكود المكتوب وفق المواصفات.
- `UNIT_TESTED`: تم إجراء اختبارات سلوكية للأجزاء المنفذة.
- `INTEGRATION_TESTED`: تم التحقق من التكامل وقاعدة البيانات و RLS سلوكيًا في بيئة اختبار حية متكاملة بوجود run أخضر في GitHub Actions.
- `SECURITY_VERIFIED`: تم فحص وتحصين آليات الأمان والعزل بوجود run أخضر في GitHub Actions (تحديد رقم الـ Run والـ Commit SHA إلزاميان).
- `PRODUCTION_READY`: تُمنح فقط بعد نجاح تشغيل GitHub Actions بعلامة خضراء مع `REQUIRE_DB=1` واستخدام دور تطبيق مخصص (`an_app`) غير متجاوز لـ RLS.

---

## 2. سجل الحزم وحالتها الحالية الدقيقة
- **P00-CONSTITUTION-1**: `IMPLEMENTED`
- **P01-PLATFORM-SCAFFOLD-1**: `IMPLEMENTED` + `UNIT_TESTED`
- **P02a-DB-FOUNDATION-1**: `IMPLEMENTED`
- **P03-AUTH-CORE-1**: `IMPLEMENTED`
- **P04-ORG-RBAC-1**: `IMPLEMENTED`
- **AN-FOUNDATION-REPAIR-2**: `IMPLEMENTED`
- **AN-PERSISTENCE-CORE-1**: `IMPLEMENTED`
- **AN-TENANT-ISOLATION-1**: `IMPLEMENTED`
- **AN-AUTH-SECURITY-1**: `IMPLEMENTED`
- **AN-FOUNDATION-CI-1**: `IMPLEMENTED`
- **AN-FOUNDATION-REPAIR-3**: `IMPLEMENTED`
- **AN-FOUNDATION-REPAIR-4**: `IMPLEMENTED`
- **AN-FOUNDATION-REPAIR-5**: `IMPLEMENTED`
- **AN-FOUNDATION-REPAIR-6**: `IMPLEMENTED` + `UNIT_TESTED`
- **AN-FOUNDATION-REPAIR-6A**: `IMPLEMENTED` + `UNIT_TESTED`
  - Baseline SHA: `259f609db5883ed1a6fc3f947190875fc45da984`
  - Final SHA: `HEAD` (local working tree verified)
  - Actual RBAC root cause: Cross-company RBAC tests in `verifyRbacHttp.ts` verify that company membership and platform admin role separation correctly return HTTP 403 FORBIDDEN when users attempt cross-tenant access without authorized platform privileges.
  - Role guard changes: Hardened `assertSafeDbRole` in `src/server/db/roleGuard.ts` to check direct role attributes (`rolsuper`, `rolbypassrls`, `rolcreatedb`, `rolcreaterole`), check inherited memberships via `pg_auth_members`, fail closed on unverifiable roles or connection errors, and completely remove `ALLOW_PRIVILEGED_DB_ROLE` as an environment bypass in any environment (including development).
  - Files changed: `src/server/db/roleGuard.ts`, `scripts/verifyAuthSecurity.ts`, `docs/foundation/AI_PROJECT_STATE.md`.
  - Exact tests and results: Typecheck (PASSED), Build (PASSED), 12 R6.3 DB Role Guard unit tests (12/12 PASSED), Foundation battery passed all static checks.
  - GitHub Actions run ID: Pending push & manual CI run trigger by repository owner.
  - CI URL: `https://github.com/alaaabusalah96-netizen/A.N-last-version-/actions`
  - Remaining blockers: None for 6A local verification.
- **AN-FOUNDATION-REPAIR-6B**: `IMPLEMENTED` + `UNIT_TESTED`
  - Baseline SHA: `HEAD` (from 6A verified state)
  - Final SHA: `HEAD`
  - SSL Policy Changes (R3): Removed `ALLOW_INSECURE_DB_SSL=1` bypass in production; enforced strict TLS and `rejectUnauthorized: true` in production without exception; updated `verifyRepair2.ts` tests.
  - App Role Provisioning (R4): Hardened `scripts/provisionAppRole.ts` with strict identifier validation (`USER_REGEX`), parameterized password binding, full idempotency, and secure password/credential redaction in logs/exceptions.
  - Files changed: `src/server/db/adapters/PostgresqlAdapter.ts`, `scripts/provisionAppRole.ts`, `scripts/verifyDbPrivileges.ts`, `scripts/verifyRepair2.ts`, `docs/foundation/AI_PROJECT_STATE.md`, `docs/foundation/AN_FOUNDATION_REPAIR_6B.md`.
  - Exact tests and results: Typecheck (PASSED), Build (PASSED), SSL resolution tests (PASSED), Database privilege verification tests (PASSED), Foundation battery static checks (PASSED).
  - GitHub Actions run ID: Pending push & manual CI run trigger by repository owner.
  - CI URL: `https://github.com/alaaabusalah96-netizen/A.N-last-version-/actions`
  - Remaining blockers: None for local verification; awaiting CI run on main.
- **AN-FOUNDATION-SECURITY-REPAIR-7**: `IMPLEMENTED`
  - Baseline SHA: `5cf2dc502e358b5746d0f5973d47554d0da8cdc3`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Fixed database provisioning and security verification regressions. Provisioning modifies only dedicated `an_app` role and leaves Supabase built-in roles (`anon`, `authenticated`, `service_role`) and PUBLIC global privileges untouched. Added `NOINHERIT` to `an_app`. Replaced `dataApiGuard` with fail-closed implementation checking `anon`/`authenticated` public tables, sequences, functions, and schema create. Strengthened `roleGuard` with protected role list and multi-level `pg_has_role` membership check. Restored provisioning stdout/stderr capture, URL API handling, and built-in role preservation snapshots. Enforced loopback-only host restriction in `runFoundationBattery.ts` and `ciSimulateManagedPg.ts`.
- **AN-FOUNDATION-SECURITY-BASELINE-1**: `IMPLEMENTED` + `UNIT_TESTED`
  - Baseline SHA: `5cf2dc502e358b5746d0f5973d47554d0da8cdc3`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Applied repository-only security and RLS baseline repair. Created migration 010_security_rls_baseline.sql with idempotent RLS policies for an_app, strict revocation on anon/authenticated, and default privileges. Enhanced dataApiGuard to exclude trigger and event_trigger functions while retaining fail-closed validation on callable RPCs. Extended verifyRlsCoverage.ts with full table_ownership catalog validation, an_app target policy checks, and append-only/select-only privilege verification. Strengthened provisionAppRole.ts with post-provision attribute/membership/ownership assertions. Hardened bootstrapPlatformAdminFromEnv with strict credential pairing, role conflict detection, and fail-closed startup halt. Added robust frontend Content-Type handling for intercepted HTML proxy responses.
  - P05_STARTED: `NO`
  - SUPABASE_TOUCHED: `NO` (disposable/local CI testing only)
- **AN-FOUNDATION-SECURITY-BASELINE-2**: `IMPLEMENTED` + `UNIT_TESTED`
  - Baseline SHA: `49d3e8ef40f523d71329f724b6bb1599e8d1e8dd`
  - Final SHA: `HEAD` (local working tree verified)
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Fixed security and startup regressions identified during read-only inspection of the live AN-ERP-MAIN Supabase database.
    1. Migration 010: Added explicit `REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;` to close public EXECUTE exposure on existing routines (including `public.audit_logs_block_mutation` and `public.rls_auto_enable`), while preserving service_role attributes and untrusted Data API revocations.
    2. Data API Guard: Hardened `assertNoDataApiExposure` in `src/server/db/dataApiGuard.ts` by removing trigger/event_trigger exclusions to scan all routines in schema public for unauthorized EXECUTE exposure.
    3. Test Suite: Updated `scripts/verifyDataApiGuard.ts` tests 6 and 7 to assert detection of trigger and event-trigger routines. Created `scripts/verifyMigration010.ts` for static verification of RLS and routine revocations.
    4. Dev Preview Startup: Hardened `server.ts` to skip platform administrator bootstrap with a clear warning in development/preview when `DATABASE_URL` is unconfigured, while retaining fatal fail-closed behavior for mispaired admin credentials and production startup.
  - P05_STARTED: `NO`
  - SUPABASE_TOUCHED: `NO` (repository repair only; remote database untouched)
- **AN-DOC-SYNC-LIVE-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Operator-confirmed live facts (no secrets):
    1. Application authentication (platform admin login) works against the configured database.
    2. Environment secrets are configured in the runtime host (Google AI Studio / deployment), not in git.
    3. DATABASE_SSL=require is in use for live connection policy.
    4. Foundation security packages through AN-FOUNDATION-SECURITY-REPAIR-7 / SECURITY-BASELINE remain IMPLEMENTED.
  - Explicit non-claims:
    - Do NOT set SECURITY_VERIFIED.
    - Do NOT set PRODUCTION_READY.
    - Do NOT set INTEGRATION_TESTED solely because login works.
    - CI_STATUS stays PENDING until a green GitHub Actions run SHA is recorded.
  - P05_STARTED: `NO`
  - SUPABASE_OPERATOR_CONNECTED: `YES` (operator-confirmed; no project URL or credentials in docs)
- **AN-P05-ACCOUNTING-CORE-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Delivered first P05 business module slice (Accounting Core & COA UI).
    1. Database: Added migration 011_accounting_core.sql with tenant-scoped `accounts`, `journal_entries`, `journal_lines` tables with forced RLS & an_app isolation policy. Registered tables in `table_ownership.json`.
    2. Backend: Created accountTypes, accountRepository, accountService (list, create, seedDefaultCoa), and accountingRoutes mounted at `/api/accounting`.
    3. Frontend (UI_VISIBILITY_RULE): Added top navigation in App.tsx to "المحاسبة", rendered AccountingWorkspace with company selector, AccountsPanel (COA list, seed default button, create account modal), and Journal Entries placeholder.
    4. Scope Control: Other P05 modules (Inventory, Purchasing, Cash, Fleet, POS) are NOT started.
  - P05_STARTED: `YES` (Accounting Core slice only)
  - OTHER_MODULES_STARTED: `NO`
- **AN-UI-SHELL-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Delivered clean Arabic product-language UI shell with vertical scrollable right sidebar (AppSidebar), role label translation (roleLabels), and removal of infrastructure/developer jargon (Firebase, Foundation Repair, P04, raw snake_case roles) from all user-facing screens.
  - P05_STARTED: `YES` (Accounting Core slice UI reorganized into sidebar)
  - CI_STATUS: `PENDING`
- **AN-FIX-ACCOUNTING-RBAC-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Enforced strict domain accounting permissions (`accounting.accounts.read`, `accounting.accounts.create`, `accounting.accounts.seed`) across accounting routes (`/api/accounting/accounts` and `/seed-default`) via `RbacService`, preventing `company_user` from performing write operations without relying on generic `company:write`.
  - P05_STARTED: `YES` (Accounting RBAC secured)
  - CI_STATUS: `PENDING`
- **AN-FIX-ACCOUNTING-UI-GATES-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Aligned AccountsPanel UI with server-side accounting permissions by gating `canCreate` and `canSeed` action buttons based on user role (`platform_admin` / `company_admin`), ensuring fail-closed UI behavior for read-only roles (`company_user`).
  - P05_STARTED: `YES` (Accounting UI gates aligned)
  - CI_STATUS: `PENDING`
- **AN-IDENTITY-USERS-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Delivered operational user and membership administration using existing tables (`platform_users`, `company_memberships`). Added UserAdminService with business rules (create user, add membership, toggle active, reset password) and enforced domain security (USER_READ/USER_WRITE). UI provides a dedicated workspace for admins in the sidebar. Audit logs implemented for all modifications.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-COMPANY-SETTINGS-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Delivered per-company operational settings (currency, timezone, fiscal year, locale). Added migration 012 for `company_settings` table with tenant-scoped RLS policies. Implemented backend service and routes under `/api/companies/:companyId/settings`. Added `CompanySettingsPanel` to the UI, accessible via the sidebar for users with `COMPANY_SETTINGS_READ/WRITE` permissions.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-P0-PLATFORM-SECURITY-FIX-1B**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Remediated confirmed security and architectural defects C1–C5 and P0-7 based on 1A diagnosis.
    1. C1: Explicitly mounted `accountingRoutes` (`/api/accounting`) and `userAdminRoutes` (`/api/users`) in `src/server/app.ts`.
    2. C2: Added privilege escalation guards in `userAdminService.ts` ensuring non-platform admins cannot modify or reset platform admins, and must operate strictly within their active company membership scope. Enforced minimum password length >= 12 on user creation and reset.
    3. C3: Closed membership update IDOR vulnerability by scoping `company_memberships` updates to `WHERE id = $1 AND company_id = $3` (and optional `AND user_id = $4`).
    4. C4: Wrapped all `companySettingsRepository` queries within `withTenantTransaction(companyId, ...)` to set `app.current_tenant_id` session variable required by RLS.
    5. C5: Closed cross-tenant user listing leak by querying tenant memberships via `listUsersByCompany` for company admins.
    6. P0-7: Removed string concatenation and dynamic import obfuscation in `userAdminRoutes.ts`, using direct typed imports.
  - P05_STARTED: `YES` (Fixes applied to existing platform routes and services; org units / ledger engine NOT started)
  - CI_STATUS: `PENDING`
- **AN-P0-VERIFY-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Automated regression harness and HTTP verification locking P0 security fixes C1–C5.
    1. C1 Route Verification: Real in-process HTTP tests (`src/server/tests/p0HttpRoutes.test.ts` and `scripts/verifyP0Verify1.ts`) proving `/api/accounting/accounts` and `/api/users` are mounted and return HTTP 401/403 rather than 404.
    2. Regression Guards: Automated static assertions for target protection (C2), company-scoped mutations (C2), membership IDOR prevention (C3), RLS tenant context (C4), tenant user listing (C5), de-obfuscation (P0-7), and min password length >= 12.
    3. Architecture: Validated clean app factory (`createApp`) export without side-effect server listen.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING` (P0 C1–C5 code fixes locked with verifyP0Verify1; CI green SHA still PENDING until Actions run)
- **AN-P1A-LEDGER-ORG-DESIGN-1**: `DESIGN_COMPLETE`
  - Status: `DESIGN_COMPLETE`, `DOCUMENTED`, `CI_STATUS=PENDING`
  - Summary: Architectural design and Architecture Decision Records (ADRs) for double-entry ledger guarantees and organizational unit structure.
    1. ADR-01 (Org Structure): Adjacency list (`parent_id`) with path hierarchy, `branch`/`department`/`cost_center` types, `user_org_scope`, nullable org fields in P1. No intercompany in P1.
    2. ADR-02 (Ledger Guarantees): Invariant balance requirement `SUM(debit) == SUM(credit)`, positive amounts, minimum 2 lines, composite tenant FK integrity (`company_id`), posted entry immutability, reversal state machine, and per-company atomic monotonic numbering.
    3. ADR-03 (Tenant vs Org Scope): RLS strictly tied to `company_id` via `app.current_tenant_id`; org units handled via application-layer filtering in Phase 1 with forward compatibility for RLS v2.
    4. ADR-04 (Currency & Periods): Functional currency from `company_settings.default_currency_code`, single functional currency in P1 with future-proof currency/rate columns, fiscal year period locks preventing historical entries in closed periods.
    5. Data Model & Phased Migration: Defined logical schema draft and strict separated migration sequencing (P1b Ledger Guarantees -> P1c Org Units -> P1d Accounting UI Expansion).
  - Explicit non-claim: Runtime ledger engine and `org_units` database tables are NOT implemented yet (design and specification phase only).
  - P05_STARTED: `YES` (Design foundations complete; next phase is P1b runtime implementation)
  - CI_STATUS: `PENDING`
- **AN-P1B-LEDGER-GUARANTEES-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Implemented double-entry ledger guarantees per ADR-02.
    1. Migration 013: Created `accounting_sequences` (atomic monotonic document numbering) and `accounting_periods`, added `entry_no`, `posted_at`, `posted_by`, and `reversed_by_entry_id` columns, enforced non-negative and single-sided line constraints, and implemented immutability triggers on posted entries and lines with tenant RLS policies for `an_app`. Registered in `table_ownership.json`.
    2. Journal Engine: Created `journalTypes`, `journalRepository`, and `journalService` enforcing `SUM(debit) === SUM(credit) > 0`, minimum 2 lines, active/postable account validation, sequence allocation, immutability, and transactional reversal.
    3. API Routes: Added `/api/accounting/journals` (list, get, create draft, post, reverse) guarded by fine-grained permissions `ACCOUNTING_JOURNALS_READ/WRITE/POST`.
    4. UI: Mounted `JournalWorkspace` inside the Accounting Core workspace under the «دفتر اليومية العامة» tab with draft creation, balance indicators, entry posting, and reversing actions.
    5. Out of scope / Deferred: Org units (P1c), multi-currency revaluation, auto-close periods.
  - P05_STARTED: `YES` (Ledger Posting Engine implemented)
  - CI_STATUS: `PENDING` (Requires operator `npm run migrate` for migration 013 on live environments)
- **AN-P1C-ORG-UNITS-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Implemented company-scoped organizational units and user org scoping per ADR-01 and ADR-03.
    1. Migration 014: Created `org_units` (adjacency list `parent_id` + hierarchical `path`), `user_org_scope` (user access by unit with `include_descendants`), and added nullable `org_unit_id` on `accounts`, `journal_entries`, and `journal_lines`. Enabled & forced tenant RLS for `an_app`. Registered in `table_ownership.json`.
    2. Backend: Created `orgUnitTypes`, `orgUnitRepository`, and `orgUnitService` with parent company isolation validation (preventing intercompany), automated path generation, and application-layer access helpers (`assertUserOrgAccess`).
    3. API Routes: Added `/api/companies/:companyId/org-units` (list, create, update) and `/api/companies/:companyId/org-scopes` guarded by `ORG_UNITS_READ/WRITE` permissions.
    4. UI: Added «الوحدات التنظيمية» to AppSidebar, created `OrgUnitsPanel` with tree indentation by path, unit creation modal (with parent selection), and active/inactive toggles.
    5. Architecture: RLS remains strictly company-first; org scoping is enforced in application services for v1 with forward compatibility for RLS v2.
  - P05_STARTED: `YES` (Organizational structure implemented)
  - CI_STATUS: `PENDING` (Requires operator `npm run migrate` for migration 014 on live environments)
- **AN-P1D-ACCOUNTING-UI-EXPANSION-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Implemented Trial Balance aggregation and optional Org Unit filtering in general ledger entries.
    1. Backend: Added `GET /api/accounting/trial-balance` endpoint in `accountingRoutes.ts`, creating `trialBalanceService` wrapped in `withTenantTransaction` to compute debits, credits, and net balances for postable accounts from posted journal entries (`status = 'posted'`) with optional date (`asOfDate`) and `orgUnitId` filters.
    2. Journal Org Unit Integration: Updated `journalTypes`, `journalRepository`, and `journalService` to handle `orgUnitId` persistence and filtering.
    3. UI Expansion: Added `TrialBalancePanel` component with date and org unit filters, debit/credit totals, and balance status indicators. Wired as «ميزان المراجعة» tab in `AccountingWorkspace`. Added org unit filter dropdown and draft selection in `JournalWorkspace`.
    4. Constraints: No new migrations or business modules added.
  - P05_STARTED: `YES` (Trial Balance & Ledger UI Expansion implemented)
  - CI_STATUS: `PENDING`
- **AN-P1B-LEDGER-HARDENING-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Closed critical ledger guarantee gaps per ADR-02 via migration 015 and application row locking.
    1. Migration 015: Created `015_ledger_hardening.sql` with trigger `trg_journal_lines_immutability` blocking `INSERT`, `UPDATE`, and `DELETE` of lines against posted entries using `COALESCE(NEW.entry_id, OLD.entry_id)`.
    2. Posted Immutability: Narrowed `trg_fn_journal_entries_immutability` to permit strictly setting `reversed_by_entry_id` from NULL to a valid UUID while asserting equality on all other columns (`period_id`, `memo`, `entry_date`, `posted_at`, `posted_by`, `created_by`, `org_unit_id`).
    3. DB Balance Guard: Added DB-level validation on transition to `posted` verifying `SUM(debit) == SUM(credit) > 0` and line count >= 2.
    4. Concurrency Locking: Added `FOR UPDATE` row locking in `journalRepository.ts` (`findByIdForUpdate`) and used in `journalService.ts` (`postEntry`).
  - P05_STARTED: `YES` (Ledger Hardening implemented)
  - CI_STATUS: `PENDING` (Requires operator `npm run migrate` for migration 015 on live environments)
- **AN-P1C-ORG-INTEGRITY-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Closed organizational unit data integrity gaps via migration 016 and application membership checks.
    1. Migration 016: Created `016_org_integrity.sql` enforcing composite tenant foreign keys `(company_id, parent_id)` on `org_units`, `(company_id, org_unit_id)` on `user_org_scope`, `accounts`, `journal_entries`, and `journal_lines` to guarantee cross-company parent/unit assignments are prevented at DB layer.
    2. Application Membership Guard: Added `checkUserCompanyMembership` in `orgUnitRepository.ts` and enforced active target user membership check inside `orgUnitService.ts` `setUserScopes`.
  - P05_STARTED: `YES` (Org Data Integrity implemented)
  - CI_STATUS: `PENDING` (Requires operator `npm run migrate` for migration 016 on live environments)
- **AN-FIX-LEDGER-ORG-FOLLOWUP-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Remediated residual org unit composite foreign key delete behavior, trial balance posted entry aggregation, and journal lines trigger immutability.
    1. Migration 017: Created `017_ledger_org_followup.sql` replacing composite FK `ON DELETE SET NULL` with `ON DELETE RESTRICT` for `(company_id, org_unit_id)` on `accounts`, `journal_entries`, and `journal_lines`.
    2. Journal Lines Immutability Trigger: Hardened `trg_fn_journal_lines_immutability` to evaluate `TG_OP` branches ('INSERT', 'DELETE', 'UPDATE') and validate status on BOTH `OLD.entry_id` and `NEW.entry_id`.
    3. Trial Balance Aggregation: Fixed `trialBalanceService.ts` to use subquery pattern strictly filtering `e.status = 'posted'`, preventing unposted draft line amounts from being aggregated.
  - P05_STARTED: `YES` (Followup fixes implemented)
  - CI_STATUS: `PENDING` (Requires operator `npm run migrate` for migration 017 on live environments)
- **AN-PG-INTEGRATION-SMOKE-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Smoke Posture: `DB_BLOCKED` in local preview environment without privileged DDL connection string; static assertions S1–S5 **PASSED**; live DB cases T1–T7 **BLOCKED** cleanly without false passes or failures.
  - Summary: Created automated PostgreSQL integration smoke verification script `scripts/verifyPgIntegrationSmoke1.ts` validating migrations 015–017 presence, trial balance posted subquery isolation, journal line trigger OLD/NEW checks, and live DB case assertions when a valid connection string is provided.
  - P05_STARTED: `YES` (PostgreSQL Smoke Harness implemented)
  - CI_STATUS: `PENDING`
- **AN-ORG-SCOPE-ON-LEDGER-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Connected `assertUserOrgAccess` to general ledger entries and trial balance routes per ADR-03.
    1. Backward Compatibility: Preserved company-wide access when a user has zero org scopes configured.
    2. Scoped User Enforcements: Enforced that users with active org scopes must select/specify an authorized org unit for creation, posting, and reversal.
    3. Platform Admin Policy: Implemented BYPASS policy for `platform_admin` role for support/administrative actions.
    4. Service Integration: Wired scope checks across `journalService.ts` (`createDraftEntry`, `postEntry`, `reverseEntry`, `listEntries`, `getEntry`), `trialBalanceService.ts` (`getTrialBalance`), and `accountingRoutes.ts`.
  - P05_STARTED: `YES` (Org Scope Ledger Wiring implemented)
  - CI_STATUS: `PENDING` (No database migrations required)
- **AN-P1-FOUNDATION-CLOSE-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `P1_FOUNDATION_CLOSED=YES`, `CI_STATUS=PENDING`
  - Summary: Formally closed the P1 Foundation track in documentation and verification markers.
    1. Open Gaps Registry: Created `docs/foundation/OPEN_GAPS.md` recording residual risks (`PG-SMOKE-LIVE`, `PERIODS`, `CI`, `C2-LIVE`, `RLS-ORG-V2`, `MODULES`).
    2. Foundation Close Document: Created `docs/foundation/P1_FOUNDATION_CLOSE.md` summarizing all closed foundation packages and decision rules.
    3. Automated Closure Harness: Created `scripts/verifyP1FoundationClose1.ts` validating regression markers for P0 security, ledger hardening, org integrity, trial balance isolation, and org scope wiring.
  - P05_STARTED: `YES` (P1 Foundation track CLOSED; external business modules remain unstarted)
  - CI_STATUS: `PENDING` (No runtime code or migration changes)
- **AN-FIX-VERIFY-MIGRATE-SCOPE-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Closed three residual security, tooling, and scoping defects.
    1. Migrate Tooling Security: Completely removed `/proc` process environment scraping and `DATABASE_URL` retry/fallback from `scripts/migrate.ts`, requiring `MIGRATION_DATABASE_URL` explicitly for running schema migrations.
    2. PostgreSQL Smoke Verification: Removed `/proc` loading from `scripts/verifyPgIntegrationSmoke1.ts` and hardened T2 assertion to match strictly on `/CANNOT_MODIFY_POSTED|posted journal entry/i`.
    3. Scope Security Enforcement: Updated `journalService.ts` (`listEntries`) and `trialBalanceService.ts` (`getTrialBalance`) to require an `orgUnitId` filter parameter for scoped users when listing entries or generating a trial balance.
    4. Verification Harness: Created `scripts/verifyFixVerifyMigrateScope1.ts` (script `test:fix-verify-migrate-scope-1`).
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-PG-INTEGRATION-PROOF-2**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Upgraded PostgreSQL smoke verification to a robust independent proof harness (T1–T7) and addressed database security advisor recommendations.
    1. Independent Proof Harness: Created `scripts/verifyPgIntegrationProof2.ts` with explicit independent try/catch blocks for T1–T7 cases, unique session/rollback transaction safety, and strict error pattern matching.
    2. Connection Policy: Supported `AN_PG_PROOF_URL`, `MIGRATION_DATABASE_URL`, and `DATABASE_URL` with graceful BLOCKED state when unconfigured, plus strict mode (`AN_PG_PROOF_STRICT=1`).
    3. Migration 018: Created `database/migrations/018_trigger_search_path.sql` setting explicit `search_path = public` on trigger functions (`trg_fn_journal_entries_immutability`, `trg_fn_journal_lines_immutability`, `audit_logs_block_mutation`) for Supabase advisor compliance.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-CI-PROOF-WIRE-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Wired PostgreSQL integration proof harness (`test:pg-proof-2`) into `.github/workflows/foundation-ci.yml` running with `AN_PG_PROOF_STRICT="1"` against the CI PostgreSQL service container after migrations and role provisioning.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-CI-POSTGRES-SSL-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Fixed local Postgres SSL connection in CI (`foundation-ci.yml`) by setting `DATABASE_SSL: disable` on CI postgres steps and refactoring `migrationRunner.ts` to use `buildPgConfig`, while maintaining strict SSL enforcement in production.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-DB-SSL-POLICY-2**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Implemented dual-mode host-based SSL policy in `connection.ts` (`resolveSslConfig`). Non-production connections to localhost / 127.0.0.1 / ::1 default to no SSL (or honor `DATABASE_SSL=disable`), while remote hosts (Supabase direct / pooler) enable SSL by default even when `sslmode` query parameters are stripped from connection strings. Production strict SSL enforcement is unchanged.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-DB-SSL-DISABLE-SCOPE-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Scoped `DATABASE_SSL=disable` in `resolveSslConfig` (`connection.ts`) so that global secret disable is honored ONLY for local hosts (`localhost`, `127.0.0.1`, `::1`). For remote hosts (Supabase pooler/direct), `DATABASE_SSL=disable` is ignored and TLS remains enforced.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-CI-BOOTSTRAP-ROLES-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Added CI pre-migration bootstrap step (`scripts/ciBootstrapRoles.ts` and `npm run ci:bootstrap-roles`) in `.github/workflows/foundation-ci.yml` to create stub Supabase roles (`anon`, `authenticated` with `NOLOGIN`) in vanilla PostgreSQL CI container before migrations run, without altering historical migrations 010–014.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-CI-GUARD-RLS-AUTO-ENABLE-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Wrapped `REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()` in `010_security_rls_baseline.sql` inside an idempotent `IF EXISTS` check querying `pg_proc`, enabling vanilla PostgreSQL in CI to run migration 010 without failing on missing Supabase-only routine.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-CI-RESTORE-SIMULATE-MANAGED-PG-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Restored missing `scripts/ciSimulateManagedPg.ts` referenced in `package.json` and `.github/workflows/foundation-ci.yml`, enforcing loopback-only host restriction during CI managed Postgres simulation.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-CI-MISSING-SCRIPTS-RESTORE-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Restored all 28 missing scripts referenced in `package.json` plus supporting `scripts/lib/*` libraries from historical Git commit `ad07ba9557a453705770988cf4c11f8a0f714cfe` (prior to accidental deletion in `c718317`). Fixed MembershipRepository backward compatibility method.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`
- **AN-PROVISION-ROLE-MISSING-ROLES-FIX-1**: `IMPLEMENTED`
  - Status: `IMPLEMENTED`, `CI_STATUS=PENDING`
  - Summary: Fixed CI failure in `provisionAppRole.ts` where `pg_has_role` threw code 42704 on non-existent roles (e.g. `postgres`). Added existence check in `pg_roles` before calling `pg_has_role`, skipping missing roles while retaining strict membership failure when roles exist.
  - P05_STARTED: `YES`
  - CI_STATUS: `PENDING`

### Current Operational Posture
- Auth login: operational (operator-confirmed)
- Live DB: operator-configured via environment secrets
- P05 Accounting Core: IMPLEMENTED & UI WIRED
- Next gate: green CI on main OR explicit approval for subsequent P05 slices
- Forbidden: running foundation battery against live DB

---

## 3. الأنماط المعمارية والقواعد الحاكمة
1. **ذرية الخدمات المعاملاتية (`Transactional Service Atomicity`)**:
   - كافة العمليات المترابطة (مثل إنشاء شركة + إضافة العضوية + كتابة سجل التدقيق) تتم داخل معاملة واحدة متكاملة عبر `CompanyService`.
2. **سجل ملكية الجداول (`Table Ownership Registry`)**:
   - تصنيف صريح لكل جدول في قاعدة البيانات (`global` / `shared` / `tenant`). الجداول ذات النطاق `tenant` يلزمها RLS صارم بـ `relforcerowsecurity = true` وسياسات فحص المالك.
3. **حارس الأدوار والامتيارات (`Role & Privilege Guards`)**:
   - منع استخدام حسابات `SUPERUSER` أو `BYPASSRLS` في الإنتاج، وحصر دور التطبيق التجاري `an_app` في الصلاحيات التشغيلية فقط دون TRUNCATE أو تعديل سجل المخطط.

---

## 4. محددات الأمان وقاعدة عدم البدء التلقائي
- **حظر Firebase**: مؤكد ومفروض قطعيًا (`FORBIDDEN`).
- **بدء P05**: تم البدء رسمياً في النواة المحاسبية (Accounting Core Slice). باقي الوحدات الخارجية متوقفة.
- **P05_STARTED**: `YES` (Accounting Core slice only).
