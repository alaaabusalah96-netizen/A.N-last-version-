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
  - CI_STATUS: `PENDING` (في انتظار تشغيل GitHub Actions الخارجي واستحصال العلامة الخضراء).
  - إصلاح R1: توثيق استثناء `allowOptionalCompanyId` لجدول `platform_users` وتحسين استعلام catalog في `verifyRlsCoverage.ts` بالاعتماد المباشر على `pg_constraint`.
  - إصلاح R2: تصحيح صلاحيات مستخدم الاختبار A في `verifyTenantHttp.ts` إلى `company_admin` وتمرير Transaction Executor في `tenantContextStorage` لمنع انقطاع السياق وتأكيد سلامة ROLLBACK وعدم تسرب السياق بين الشركات.
  - إصلاح R3: تفعيل `loginAs()` المتوافقة مع CSRF Rotation في `verifyRbacHttp.ts` وإضافة أكواد الأخطاء الدقيقة (`FORBIDDEN_PLATFORM_ADMIN`).
  - إصلاح R4: معالجة تكامل CORS وCSRF في `verifyHttpSecurity.ts`، وإضافة اختبارات عزل عداد IP في `RateLimitStore` واختبار صمود `withTransaction` عند تعثر ROLLBACK، واختبارات الجاهزية `/api/ready`.
  - إصلاح R5: مقارنة شاملة لكافة ملفات migrations على القرص مع `schema_migrations` في `readiness.ts`، وإضافة اختبارات Idempotency وChecksum mismatch في `verifyMigrations.ts`.
  - إصلاح R6: حصر أخطاء CORS بـ `CorsOriginError` فقط، وتحصين مسح `internalDetail` ومعالجة CR/LF في Request ID، وتوسيع اختبارات مصنع CSRF، وحارس صلاحيات قاعدة البيانات `assertSafeDbRole`، ودلالات فشل المصادقة `DB_UNAVAILABLE`.
  - إصلاح R7: توحيد تقارير البطارية في ملف `foundation-test-report.json` و`foundation-battery.log` ورفعها كـ Artifact مع مهلة استبقاء 7 أيام.
  - تنبيه بيئة CI: قاعدة بيانات PostgreSQL المستخدمة في سير عمل GitHub Actions هي قاعدة بيانات اختبارية مؤقتة (Ephemeral Test Database) مخصصة فقط لتشغيل بطارية الفحص، وليست قاعدة بيانات إنتاجية للمشروع أو قاعدة بيانات العميل. لا يُعلن عن أي ترقية لحالة `SECURITY_VERIFIED` أو `INTEGRATION_TESTED` أو `PRODUCTION_READY` قبل استكمال تشغيل أخضر لـ CI برقم run وcommit SHA محددين.

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
- **الموقف الحالي**: توقف تام وانتظار المراجعة والاعتماد البشري.
- **بدء P05**: ممنوع منعًا باتًا البدء في P05 دون موافقة صريحة ومباشرة.
- **P05_STARTED**: `NO`.
