# حالة عزل المستأجرين (Tenant Isolation Status)

## 1. التقييم الفني للحالة الراهنة (Current State)
- **الحالة الحالية**: `IMPLEMENTED` (على مستوى العقود والمحدد والسجل والتخزين بالذاكرة).
- **الجاهزية للإنتاج**: `NOT_PRODUCTION_READY`.
- **أسباب عدم الجاهزية للإنتاج**:
  1. قواعد البيانات الحالية ومخازن البيانات ما زالت تعتمد على الذاكرة (`V1_ONLY Memory Stores`).
  2. لم يتم تفعيل سياسات أمان صفوف الجداول (`Row-Level Security - RLS`) على محرك PostgreSQL بعد.
  3. يتم توجيه الاستعلامات حاليًا عبر المعرف المنطقي للشركة (`companyId`) وسياق `tenantContextStorage (AsyncLocalStorage)` دون حواجز مفروضة على مستوى محرك قاعدة البيانات نفسه.

## 2. آليات العزل المنفذة في هذه المرحلة
- **Tenant-to-Database Resolver**: تم تفعيله لتوجيه الشركات إلى مفاتيح الاتصال (`connectionKey`) وأنماط التخزين (`central`, `per_company`, `on_prem`).
- **Fail-Closed Execution**: دالة `getExecutorForCompany(companyId)` ترفض صراحة أي معرف شركة فارغ أو غير صالح وترجع `null` دون تراجع خطير للاتصال الافتراضي.
- **Tenant Context Propagation**: توفير سياق المستأجر عبر `AsyncLocalStorage` لربط العمليات غير المتزامنة بهوية الشركة.

## 3. خارطة الحزم التالية المقترحة
1. **PERSISTENCE-CORE**: نقل مخازن المستخدمين والشركات والعضويات والجلسات من الذاكرة إلى جداول PostgreSQL حقيقية مع الـ migrations.
2. **TENANT-ISOLATION**: فرض سياسات RLS (`Row Level Security`) وتفعيل `SET LOCAL app.current_tenant_id` داخل المعاملات المحاسبية لضمان عزل حديدي لا يقبل التسريب.
