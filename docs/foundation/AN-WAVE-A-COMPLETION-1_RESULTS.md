# AN-WAVE-A-COMPLETION-1 — نتائج تنفيذ الموجة A كاملة

**Branch:** `wave-a` (from `00c8489` — feat(purchasing): track journal entries in GRN)
**Date:** 2026-11-12
**Scope:** A1 stabilization seal + A2 Configuration Registry + A3 Versioning & Publishing + A4 Validation Engine، وفق `docs/foundation/configuration-platform/` (README + 01..05).

---

## 1. الحزم المنفذة

### A1 — Foundation Integrity (تثبيت، لا كود جديد)
- الحالة عند البداية: مغلقة عمليًا في `00c8489` (ترتيب GRN/GL، resolveEntryDate، permissions في /me، مفاتيح مركبة 022–026).
- ما أُضيف هنا: إعادة إثبات السطح عبر S1–S3 في `scripts/verifyWaveACompletion1.ts` + إدخال حالة موحدة في OPEN_GAPS/AI_PROJECT_STATE (انظر §3).
- الدليل المباشر خارج هذه الحزمة: إعادة الهجومين حرفيًا على PostgreSQL 16.15 نظيفة → `fk_journal_lines_entry_company` و`fk_journal_lines_account_company` يرفضان السطر المخالف، والسطر الشرعي يُقبل (1 صف فقط).

### A2 — Configuration Registry
- `database/migrations/027_config_platform_registry.sql`:
  - `config_definitions` (كتالوج عالمي، UNIQUE(key)، schema JSONB إلزامي، default_value).
  - `config_registry` (إصدارات منشورة غير قابلة للتعديل، UNIQUE(company_id, config_definition_id, version_no)، فهرس جزئي `uq_config_registry_one_active` يضمن إصدارًا نشطًا واحدًا لكل شركة+تعريف).
  - `config_drafts` (مسودة واحدة لكل شركة+تعريف، حالتا draft/in_review).
  - Trigger `CONFIG_REGISTRY_IMMUTABLE`: يمنع تعديل content/version وأي DELETE — يسمح فقط بقلب is_active.
  - RLS: ENABLE + FORCE على الجداول الثلاثة، سياسة عزل مستأجر على `app.current_tenant_id` للـregistry والـdrafts، منح لأدنى امتياز لدور `an_app`، وسحب كامل من anon/authenticated/PUBLIC.
  - بذرة تعريفين: `system.general` و`accounting.grn_mapping`.
- طبقة الخدمة: `src/server/config-platform/configTypes.ts` + `configRepository.ts` (+ `defaultConfigRepository`).
- طبقة الـAPI: `src/server/routes/configRoutes.ts`:
  - `/api/config/definitions` (كتالوج عالمي، قراءة).
  - تحت `/api/companies/:companyId` (عبر companyRoutes): `GET /config`، `GET /config/resolve?key=`، `GET /config/versions?key=`، `GET /config/draft?key=`، `PUT /config/draft`، `POST /config/publish`، `POST /config/rollback`.
  - الحماية: `requireAuth` + `requirePermission` (قراءة: COMPANY_SETTINGS_READ، كتابة: COMPANY_SETTINGS_WRITE) — مبدأ No-Demolition: صلاحيات الإعدادات القائمة تُعاد استخدامها.
- التركيب: `src/server/app.ts` (mount عالمي) + `src/server/routes/companyRoutes.ts` (mount لكل شركة).

### A3 — Versioning & Publishing
- `src/server/config-platform/configService.ts`:
  - `publishDraft`: تحقق → version_no = latest+1 → إدخال إصدار جديد نشط → إطفاء السابق → حذف المسودة. `changeSummary` إلزامي (سطر تدقيق).
  - `rollback`: نسخ إصدار سابق إلى version جديد (لا un-publish مطلقًا — §2.5 من وثيقة 03)، مع رفض تراجع لإصدار نشط أصلًا (Conflict).
  - `resolveConfig`: ترتيب الحل المعتمد — Company Published ثم Platform Default (طبقة Org-Unit Override تُترك لـWave B/C عمدًا).
  - `listActiveConfigs` / `listVersions` / `getDraft` / `saveDraft`.

### A4 — Validation Engine
- `src/server/config-platform/configValidationService.ts`:
  - تحقق بنيوي: JSON-Schema subset (type/properties/required/additionalProperties/enum/min/max) برسائل عربية صريحة، يُطبق عند الحفظ وعند النشر.
  - تحقق مرجعي: أي حقل ينتهي بـ`_account_id` يُحل مقابل دليل حسابات الشركة (يجب أن يوجد ونشط) — عبر `accountCheckerFactory` قابل للحقن.
  - **لا eval ولا new Function** — metadata فقط (قصر "Safety First").

---

## 2. الإثبات

- اختبارات وحدة (Vitest): 19 اختبارًا جديدًا في `src/server/config-platform/__tests__/` (دورة الحياة الكاملة v1→v2→rollback→v3، بوابات A4، حواجز tenant، عقد SQL الثابت). **المجموع الكلي: 10 ملفات / 60 اختبارًا كلها ناجحة** (كانت 8/41).
- سكربت إثبات `scripts/verifyWaveACompletion1.ts` (مُسجَّل في battery عند السطر التالي لـverifyGrnGlOrderAndMe1، وأمر `npm run test:wave-a-completion-1`):
  - S1–S17: فحوص ثابتة — 17/17 PASS.
  - T1–T6: إثبات حي على PostgreSQL (RLS قراءة صفرية للشركة B، رفض كتابة عابرة للحدود عبر WITH CHECK، رفض UPDATE/DELETE عبر الـtrigger، نجاح قلب المؤشر النشط) — 6/6 PASS على PG16.15 محلية بدور `an_app` غير المميز. عند غياب DATABASE_URL يخرج الكود 2 (BLOCKED) وفق سياسة البطارية.
- `npm run typecheck` → 0 أخطاء. `npm run build` → ناجح.

### ملاحظة صراحة (ما لم يُنفذ / غير قابل للتحقق هنا)
- الـT1–T6 الحية نجحت على PG16 محلية؛ الإثبات على Supabase المُدارة يتم تلقائيًا في أول CI أخضر بعد الرفع (نفس نمط PG-SMOKE-LIVE).
- طبقة Org-Unit Override في ترتيب الحل (المستوى الأول في §3 من وثيقة 03) مؤجلة عمدًا لـWave B/C.
- B1..B6 وC1..C12: لم تُمس — وفق وثيقة 05 ("Don't build Wave C features in Wave A").
- نقاط البيع P1 السابقة (قائمة الدخل/الميزانية، اختبارات grnService/stockService الإضافية) خارجة عن نطاق الموجة A ولم تُعالج هنا.

---

## 3. تحديث سجل التوثيق
- `docs/foundation/OPEN_GAPS.md`: إدخال `WAVE-A-CONFIG-PLATFORM` = CLOSED (بانتظار CI أخضر).
- `docs/foundation/AI_PROJECT_STATE.md`: إدخال `AN-WAVE-A-COMPLETION-1` = IMPLEMENTED + UNIT_TESTED.
