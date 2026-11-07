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
