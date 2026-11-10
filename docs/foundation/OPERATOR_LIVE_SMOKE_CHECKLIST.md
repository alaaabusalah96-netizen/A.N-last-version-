# Operator Live Smoke Verification Checklist / قائمة الفحص السريع للتشغيل الحي

## English

This checklist provides a manual, non-destructive smoke verification procedure for operators validating a live or staging PostgreSQL / Supabase deployment after applying foundation packages up through `AN-FOUNDATION-GATE-CLOSE-1`.

> **Note:** Never commit production credentials or secrets to repository source code or logs.

### Verification Steps
1. **Application Startup & Database Connection**:
   - Start the application server with configured `DATABASE_URL` and `MIGRATION_DATABASE_URL`.
   - Confirm in logs that startup completes without `DB_UNAVAILABLE` or `RoleGuard` fatal errors.
2. **Platform Administrator Authentication**:
   - Log in as the initial platform admin user (`/api/auth/login`).
   - Verify receipt of a valid session cookie (`an_session`) and rotated CSRF token (`an_csrf`).
3. **Tenant Access & Multi-Tenant Isolation**:
   - Access a company owned or assigned to the active user (`GET /api/companies/:id`). Confirm `HTTP 200 OK`.
   - Attempt to access a different company ID where the user holds no active membership (`GET /api/companies/:otherCompanyId`). Confirm `HTTP 403 Forbidden` with `code: 'FORBIDDEN'`.
4. **Database Role Privileges (`an_app`)**:
   - Query `pg_roles` in PostgreSQL to confirm the application role `an_app` has attributes `NOSUPERUSER` and `NOBYPASSRLS`:
     ```sql
     SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'an_app';
     ```
5. **Database Migration Checksums**:
   - Inspect `schema_migrations` to confirm all applied migration rows contain valid, non-null 64-character SHA-256 checksums:
     ```sql
     SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version;
     ```
6. **PostgreSQL Integration Smoke (`test:pg-smoke-1`)**:
   - When executing the live integration smoke test on an isolated disposable test database, pass `SMOKE_ALLOW_DISPOSABLE=1`:
     ```bash
     SMOKE_ALLOW_DISPOSABLE=1 MIGRATION_DATABASE_URL="postgresql://an_test:pass@host:5432/db" npm run test:pg-smoke-1
     ```
   - The test harness strictly refuses to execute live write operations against Supabase or production hosts unless `SMOKE_ALLOW_DISPOSABLE=1` is explicitly set.

---

## العربية

توفر هذه القائمة خطوات الفحص الحي الميداني واليدوي للمُشغّل لتأكيد سلامة البيئة التشغيلية أو بيئة الاختبار الحية (PostgreSQL / Supabase) بعد إغلاق بوابة الأساس والتكامل (`AN-FOUNDATION-GATE-CLOSE-1`).

> **تنبيه:** يمنع تضمين أي كلمات مرور أو مفاتيح سرية في ملفات المستودع أو سجلات التشغيل.

### خطوات الفحص التشغيلي
1. **تشغيل التطبيق والاتصال بقاعدة البيانات**:
   - تشغيل الخادم بالتكوينات المعتمدة عبر متغيرات البيئة (`DATABASE_URL` و `MIGRATION_DATABASE_URL`).
   - التأكد في سجلات الخادم من عدم وجود أخطاء انقطاع أو رفض من حارس الأدوار (`RoleGuard`).
2. **تسجيل دخول مدير المنصة (Platform Admin)**:
   - تسجيل الدخول بحساب مدير المنصة من خلال `/api/auth/login`.
   - التأكد من إرجاع جلسة صحيحة (`an_session`) ورمز CSRF مُحدث (`an_csrf`).
3. **عزل المستأجرين والصلاحيات (Multi-Tenant Isolation)**:
   - قراءة شركة يملك المستخدم عضوية نشطة فيها (`GET /api/companies/:id`) للتحقق من الاستجابة بـ `HTTP 200 OK`.
   - قراءة شركة أخرى لا ينتمي إليها المستخدم بنفس الحساب لضمان الحصول على `HTTP 403 Forbidden` مع رمز الخطأ `code: 'FORBIDDEN'`.
4. **صلاحيات دور التطبيق التجاري (`an_app`)**:
   - تنفيذ استعلام التحقق من أدوار PostgreSQL والتأكد أن `an_app` لا يملك صلاحيات سوبرأدزر أو تجاوز RLS:
     ```sql
     SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'an_app';
     ```
5. **بصمات الهجرات (`schema_migrations checksums`)**:
   - فحص جدول الهجرات للتأكد من وجود بصمة SHA-256 غير فارغة لكل هجرة مُطبقة:
     ```sql
     SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version;
     ```
6. **الفحص الدخاني الحي لقاعدة البيانات (`test:pg-smoke-1`)**:
   - عند تشغيل الفحص على قاعدة بيانات تجريبية معزولة، يتم تمرير متغير البيئة `SMOKE_ALLOW_DISPOSABLE=1`:
     ```bash
     SMOKE_ALLOW_DISPOSABLE=1 MIGRATION_DATABASE_URL="postgresql://an_test:pass@host:5432/db" npm run test:pg-smoke-1
     ```
   - يرفض سكريبت الفحص قطعيًا تنفيذ أي عمليات كتابة أو اختبارات حية ضد استضافة Supabase أو الإنتاج ما لم يُعيّن `SMOKE_ALLOW_DISPOSABLE=1` صراحة.
