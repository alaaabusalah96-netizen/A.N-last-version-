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
  - CI_STATUS: `PENDING` (في انتظار تشغيل GitHub Actions للتحقق من تشغيل البطارية الحية على بيئة CI).
  - تصحيح `verifyHttpSecurity.ts`: إزالة حذف `testUser` المتعارض مع قيد `audit_logs` FK RESTRICT وقاعدة Append-Only، واختبار الدالة الفعلية `PostgresqlAdapter.withTransaction` بسلوك حقيقي على mock client ومحاكاة فشل ROLLBACK دون استبدال الخطأ الأصلي، واختبار مسار النجاح والـ client release.
  - تصحيح `verifyRbacHttp.ts`: تصحيح استعلام التحقق من حدث إنشاء الشركة لاستخدام العمود الحقيقي `action = 'company.create'` بدلاً من العمود غير الموجود `event`، وإلغاء محاولات تفريغ وحذف سجلات التدقيق والشركات والمستخدمين المرتبطة بقيود RESTRICT في الـ cleanup.
  - تصحيح `verifyTenantHttp.ts`: بناء اختبار تراجع المعاملات (Rollback) الفعلي عبر تنفيذ INSERT حقيقي داخل المعاملة ثم إلقاء خطأ اختباري والتأكد من عدم وجود أي كتابة جزئية بعد التراجع خارج المعاملة، وإزالة عمليات الحذف المتعارضة مع سجل التدقيق في الـ cleanup.
  - تعزيز قاعدة استبقاء بيانات التدقيق (Audit Data Retention Rule): بيانات الاختبارات التي تتضمن سجلات تدقيق تبقى في قاعدة بيانات CI المؤقتة، ويتم التخلص منها تلقائياً بانتهاء دورة حياة حاوية خدمة PostgreSQL المرتبطة بالـ GitHub Actions Job.
  - الحفاظ الصارم على قيود الأمان: RLS مفعلة، Append-Only Trigger مفعل على `audit_logs`، قيود FK RESTRICT لم تُمس، ولا توجد أي صلاحيات superuser أو bypassrls ممنوحة للتطبيق.
  - لا يتم ترقية الحالة إلى `INTEGRATION_TESTED` أو `SECURITY_VERIFIED` أو `PRODUCTION_READY` قبل استكمال تشغيل أخضر لـ CI برقم run وcommit SHA محددين.

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
