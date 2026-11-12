# WAVE-A-CHANGES — خريطة الموجة A (الحزمة → الملفات → المعايير)

**Branch:** `wave-a` — commit واحد تراكمي `459969e` فوق `00c8489`
**الحزمة الجامعة:** `AN-WAVE-A-COMPLETION-1` (التفصيل الكامل في `AN-WAVE-A-COMPLETION-1_RESULTS.md`)

## A1 — Foundation Integrity (تثبيت بلا كود جديد)

| الملف | التغيير | المعيار المحقق |
|---|---|---|
| `scripts/verifyWaveACompletion1.ts` (S1–S3) | إعادة تأكيد سطح A1 | ترتيب GRN/GL، resolveEntryDate من createdAt، permissions في /me — كلها مؤكدة |
| (الاعتماد) `00c8489` | ميجريشنز 022–026 + grnService + authRoutes | إعادة الهجومين على PG16.15 نظيفة → رفض + تحكم ناجح (مُثبت خارج هذا الكومِت) |

## A2 — Configuration Registry

| الملف | التغيير | المعيار المحقق |
|---|---|---|
| `database/migrations/027_config_platform_registry.sql` | جديد | الجداول الثلاثة بتعريفات وثيقة 03 (UNIQUE keys، فهرس is_active الجزئي)، RLS ENABLE+FORCE، سياسات عزل `app.current_tenant_id`، منح adn_app أدنى امتيازًا، سحب من anon/authenticated، trigger CONFIG_REGISTRY_IMMUTABLE، بذرة تعريفين |
| `src/server/config-platform/configTypes.ts` | جديد | أنواع المنصة |
| `src/server/config-platform/configRepository.ts` | جديد | عمليات الكتالوج/الإصدارات/المسودات + `defaultConfigRepository` |
| `src/server/routes/configRoutes.ts` | جديد | `/api/config/definitions` + مسارات الشركة السبعة (قراءة/كتابة/نشر/تراجع) |
| `src/server/app.ts` | mount عالمي | `app.use('/api/config', configPlatformRoutes)` |
| `src/server/routes/companyRoutes.ts` | mount لكل شركة | `companyRoutes.use('/:companyId', companyConfigRoutes)` |

## A3 — Versioning & Publishing

| الملف | التغيير | المعيار المحقق |
|---|---|---|
| `src/server/config-platform/configService.ts` | جديد | publishDraft (v=latest+1، إطفاء السابق، حذف المسودة، changeSummary إلزامي)، rollback (نسخ لإصدار جديد — لا un-publish، رفض تراجع للناشط)، resolveConfig (Published ← Default)، حواجز tenant صارمة |

## A4 — Validation Engine

| الملف | التغيير | المعيار المحقق |
|---|---|---|
| `src/server/config-platform/configValidationService.ts` | جديد | تحقق بنيوي (JSON-Schema subset، رسائل عربية) + تحقق مرجعي لحسابات `_account_id` عبر checker قابل للحقن — **بلا eval/new Function** |
| `configService.ts` | بوابة A4 | بنيوي عند الحفظ والنشر + مرجعي قبل النشر (accountCheckerFactory(tx)) |

## الاختبارات والإثبات والتوثيق

| الملف | التغيير | النتيجة |
|---|---|---|
| `src/server/config-platform/__tests__/configService.test.ts` | 14 اختبارًا | دورة v1→v2→rollback→v3، بوابات A4، Conflict/NotFound |
| `src/server/config-platform/__tests__/configWiring.test.ts` | 5 اختبارات | حواجز tenant + عقد SQL الثابت + ميجريشن 027 |
| `scripts/verifyWaveACompletion1.ts` | جديد، مُسجَّل في `runFoundationBattery.ts` وأمر `test:wave-a-completion-1` | S1–S17 (17/17) + T1–T6 حي على PG16 بدور an_app غير مميز (6/6): RLS قراءة=0، رفض كتابة عابرة، رفض UPDATE/DELETE، نجاح قلب المؤشر |
| `package.json` | سكربت الإثبات | `npm run test:wave-a-completion-1` |
| `docs/foundation/AN-WAVE-A-COMPLETION-1_RESULTS.md` + `OPEN_GAPS.md` + `AI_PROJECT_STATE.md` | سجل الحالة | WAVE-A = CLOSED (بانتظار CI أخضر) |

## النتائج المُشغَّلة (من هذه الجولة)
- typecheck: 0 أخطاء · build: ناجح · Vitest: **10 ملفات / 60 اختبارًا كلها ناجحة** (كانت 8/41)
- الإثبات الحي: 23/23 (S+T) — بدون DATABASE_URL يخرج الكود 2 = BLOCKED وفق سياسة البطارية

## مؤجل / غير قابل للتحقق محليًا (صريح)
1. الإثبات على Supabase المُدارة يتم في أول CI أخضر بعد الرفع (نمط PG-SMOKE-LIVE).
2. طبقة Org-Unit Override في ترتيب الحل (مستوى أول في §3 وثيقة 03) مؤجلة لـWave B/C عمدًا.
3. B1..B6 وC1..C12 لم تُمس — قيد "Don't build Wave C features in Wave A" (وثيقة 05).
4. نقاط جاهزية البيع السابقة (قائمة الدخل/الميزانية، توسيع اختبارات grnService/stockService) خارجة عن نطاق الموجة A.
