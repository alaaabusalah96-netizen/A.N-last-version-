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
  - CI_STATUS: `PENDING` (في انتظار تشغيل GitHub Actions الخارجي واستحصال العلامة الخضراء).
  - إغلاق العيوب الخمسة المسببة لفشل CI وحوكمة إنشاء الشركات عبر معاملة حقيقية ذرية (`CompanyService`).
  - تطبيق سجل ملكية الجداول الشامل (`table_ownership.json`) والمصنع القابل للاختبار لحماية CSRF (`createCsrfProtection`).
  - تزويد دور التطبيق `an_app` بصلاحية `GRANT SELECT ON schema_migrations` لمعالجة انقطاع Readiness probe.
  - إزالة كافة أصول التعليمات والملفات النصية المسربة من `public/` وتحصين `.gitignore` وحارس الأصول العلوية (`verifyPublicAssets.ts`).
  - تطبيق حارس الاستيرادات المعماري (`verifyExecutorImports.ts`) ومصفوفة صلاحيات قاعدة البيانات (`verifyDbPrivileges.ts`).

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
