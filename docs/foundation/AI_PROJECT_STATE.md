# حالة المشروع وسجل المساعد الذكي (AI Project State)

## 1. مفردات الحالة المعيارية المعتمدة
- `IMPLEMENTED`: تم بناء الهيكل والكود المكتوب وفق المواصفات.
- `UNIT_TESTED`: تم إجراء اختبارات سلوكية للأجزاء المنفذة.
- `INTEGRATION_TESTED`: تم التحقق من التكامل وقاعدة البيانات و RLS سلوكيًا عبر بيئة اختبارات محلية.
- `SECURITY_VERIFIED`: تم فحص وتحصين آليات الأمان والعزل واختبارها عبر بطارية الاختبارات الموحدة.
- `PRODUCTION_READY`: تُمنح فقط بعد نجاح تشغيل GitHub Actions بعلامة خضراء مع `REQUIRE_DB=1` واستخدام دور تطبيق غير متجاوز لـ RLS.

---

## 2. سجل الحزم وحالتها الحالية الدقيقة
- **P00-CONSTITUTION-1**: `IMPLEMENTED` + `SECURITY_VERIFIED`
- **P01-PLATFORM-SCAFFOLD-1**: `IMPLEMENTED` + `UNIT_TESTED`
- **P02a-DB-FOUNDATION-1**: `IMPLEMENTED` + `INTEGRATION_TESTED`
- **P03-AUTH-CORE-1**: `IMPLEMENTED` + `INTEGRATION_TESTED` + `SECURITY_VERIFIED`
- **P04-ORG-RBAC-1**: `IMPLEMENTED` + `INTEGRATION_TESTED` + `SECURITY_VERIFIED`
- **AN-FOUNDATION-REPAIR-2**: `IMPLEMENTED` + `INTEGRATION_TESTED` + `SECURITY_VERIFIED`
- **AN-PERSISTENCE-CORE-1**: `IMPLEMENTED` + `INTEGRATION_TESTED` + `SECURITY_VERIFIED`
- **AN-TENANT-ISOLATION-1**: `IMPLEMENTED` + `INTEGRATION_TESTED` + `SECURITY_VERIFIED`
- **AN-AUTH-SECURITY-1**: `IMPLEMENTED` + `INTEGRATION_TESTED` + `SECURITY_VERIFIED`
- **AN-FOUNDATION-CI-1**: `IMPLEMENTED` + `INTEGRATION_TESTED` + `SECURITY_VERIFIED`
- **AN-FOUNDATION-REPAIR-3**: `IMPLEMENTED` + `INTEGRATION_TESTED` + `SECURITY_VERIFIED`
  - CI_STATUS: `PENDING` (انتظار تشغيل GitHub Actions الخارجي).
  - إطلاق حارس أدوار قاعدة البيانات (`assertSafeDbRole`) ودور التطبيق المخصص (`an_app`).
  - معالجة أخطاء مركزية (`errorHandler`) وإسناد معرف الطلب (`requestIdMiddleware`).
  - حماية CSRF المزدوجة المربوطة بالجلسة (`csrfProtection`) وواجهة العميل للفرونت إند (`apiFetch`).
  - تحديد معدل الطلبات الدائم بجدول قاعدة البيانات (`RateLimitStore`) والفشل المغلق عند انقطاع الاتصال.
  - حوكمة عزل المستأجرين عبر `tenantScope` وسياسات RLS المحصنة (الترحيل `008_hardening.sql`).

---

## 3. الأنماط المعمارية والقواعد الحاكمة
1. **نمط النطاق للمستأجرين (`tenantScope`)**:
   - استخدام برمجية `requireCompanyAccess` لحصر قراءة `companyId` من `req.params.companyId` وتمرير السياق عبر `tenantContextStorage`.
2. **حارس RLS والجداول**:
   - كافة الجداول التي تحتوي على عمود `company_id` مفعل عليها RLS ومفروضة قطعيًا (`FORCE ROW LEVEL SECURITY`) ما لم تكن مسجلة في `rls_allowlist.json`.
3. **سياسة التدقيق (`Audit Policy`)**:
   - `required`: حاسمة وتفشل المعاملة/الطلب عند تعذر كتابة السجل (مثل الدخول الناجح، إنشاء شركة، تغيير عضوية).
   - `best_effort`: تسجل الخطأ دون إيقاف الطلب (مثل الدخول الفاشل، الخروج).
4. **فصل أدوار قاعدة البيانات**:
   - `MIGRATION_DATABASE_URL`: للترحيلات وتزويد الأدوار بحساب سوبر (مثل `an_test`).
   - `DATABASE_URL`: للتطبيق التجاري عبر دور مقيد (`an_app`) يمنع تجاوز RLS.

---

## 4. محددات الأمان وقاعدة عدم البدء التلقائي
- **حظر Firebase**: مؤكد ومفروض قطعيًا (`FORBIDDEN`).
- **الموقف الحالي**: توقف تام وانتظار المراجعة والاعتماد البشري.
- **بدء P05**: ممنوع منعًا باتًا البدء في P05 دون موافقة صريحة ومباشرة.
- **P05_STARTED**: `NO`.
