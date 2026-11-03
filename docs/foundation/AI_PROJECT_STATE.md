# حالة المشروع وسجل المساعد الذكي (AI Project State)

## 1. مفردات الحالة المعيارية المعتمدة
- `IMPLEMENTED`: تم بناء الهيكل والكود وفق المواصفات.
- `UNIT_TESTED`: تم إجراء اختبارات سلوكية أو وحدة للأجزاء المنفذة.
- `INTEGRATION_TESTED`: تم التحقق من التكامل عبر اتصالات حقيقية.
- `SECURITY_VERIFIED`: تم فحص وتحصين آليات الأمان والحماية.
- `PRODUCTION_READY`: جاهز للنشر الإنتاجي المالي (يتطلب DB حقيقية و RLS).

---

## 2. سجل الحزم وحالتها الحالية الدقيقة
- **P00-CONSTITUTION-1**: `IMPLEMENTED` + `SECURITY_VERIFIED`
  - تثبيت دستور المنتج والقرارات المعمارية ونطاق V1.
- **P01-PLATFORM-SCAFFOLD-1**: `IMPLEMENTED` + `UNIT_TESTED`
  - سقالة المنصة المستقلة بدون أي محاكيات وهمية في Vite، وخادم Express حقيقي.
- **P02a-DB-FOUNDATION-1**: `IMPLEMENTED` + partial `UNIT_TESTED` (not `PRODUCTION_READY`)
  - تم ربط محدد المستأجرين دلاليًا (`getExecutorForCompany` fail-closed).
  - إعدادات SSL تحظر `disable` في بيئة الإنتاج إلا بوجود `ALLOW_INSECURE_DB_SSL=1`.
  - لا تزال بحاجة لاختبارات تكاملية على قاعدة بيانات حية (`INTEGRATION_TESTED`) لتصبح `PRODUCTION_READY`.
- **P03-AUTH-CORE-1**: `IMPLEMENTED` + `UNIT_TESTED` + `SECURITY_VERIFIED` (`V1_ONLY Memory Stores`)
  - تشفير كلمات المرور بـ Argon2id، وجلسات HttpOnly.
  - محدد معدل الطلبات محصور على المحاولات الفاشلة مع تنظيف دوري.
  - تخزين المستخدمين والجلسات لا يزال بالذاكرة (غير مخصص للإنتاج).
- **P04-ORG-RBAC-1**: `IMPLEMENTED` + `UNIT_TESTED` + `SECURITY_VERIFIED` (`V1_ONLY Memory Stores`)
  - إنشاء الشركات مقصور حصريًا على `platform_admin` عبر `requirePlatformAdmin`.
  - احترام حالة العضوية `isActive === false` ورفضها في RBAC.
  - تخزين الشركات والعضويات لا يزال بالذاكرة (غير مخصص للإنتاج).
- **AN-FOUNDATION-REPAIR-2**: `IMPLEMENTED` + `UNIT_TESTED` + `SECURITY_VERIFIED`
  - حذف كامل لأي محاكي API تجريبي أو كلمات مرور افتراضية من `vite.config.ts`.
  - توجيه `/api` في التطوير إلى خادم Express عبر proxy حقيقي.
  - تشديد قواعد CORS بحظر التطابق الجزئي مثل `evil-localhost.com`.
  - تفعيل CSP أساسي في الإنتاج عبر Helmet.

---

## 3. محددات الأمان وقاعدة عدم البدء التلقائي
- **حظر Firebase**: مؤكد ومفروض قطعيًا (`FORBIDDEN`).
- **الموقف الحالي**: توقف تام وانتظار الاعتماد البشري.
- **بدء P05**: ممنوع منعًا باتًا البدء في P05 أو أي حزم محاسبية دون موافقة صريحة ومباشرة.
