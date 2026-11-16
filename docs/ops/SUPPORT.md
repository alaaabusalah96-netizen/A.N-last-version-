# دليل المراقبة والصحة والدعم التشغيلي (Monitoring, Health & Support Runbook)

> يغطي هذا الدليل الحد الأدنى الإلزامي لمراقبة الإنتاج: نقاط فحص الحياة والجاهزية، تتبع الطلبات عبر `X-Request-Id`، سياسة تنقيح السجلات، وإجراءات التعامل مع الأعطال الشائعة.

---

## 1. نقاط فحص الصحة والجاهزية (Health & Readiness Probes)

| المسار | النوع | الغرض | الاستجابة المتوقعة عند السلامة | متى يعيد خطأ (`503`) |
|---|---|---|---|---|
| `GET /api/health` | **Liveness** | التأكد من أن عملية Node.js/Express حية وتستجيب للطلبات دون الاعتماد على قاعدة البيانات. | `200 OK`: `{ "status": "ok", "service": "an-erp-platform", "uptimeSeconds": ..., "timestamp": "..." }` | عدم استجابة العملية أو انهيارها |
| `GET /api/ready` | **Readiness** | التحقق قبل تمرير حركة الإنتاج من توفر `DATABASE_URL` وصحة اتصال PostgreSQL ودور `an_app` الآمن (`assertSafeDbRole`) وتطابق جميع ملفات `database/migrations/*.sql` مع جدول `schema_migrations`. | `200 OK`: `{ "ready": true, "version": "..." }` | غياب `DATABASE_URL`، فشل اتصال DB، دور مفرط الصلاحيات، وجود هجرات معلّقة (`migrations_pending`) أو تعارض (`migrations_mismatch`). |

### أداة الفحص السريع من سطر الأوامر:
```bash
npx tsx scripts/ops/healthCheck.ts --base-url http://127.0.0.1:3000
```

---

## 2. السجلات وتتبع الحوادث (`X-Request-Id` & Log Redaction)

1. **معرّف التتبع الموحد (`X-Request-Id`)**:
   - يولّد وسيط `requestIdMiddleware` معرّف طلب فريد (أو يعقم قيمة `X-Request-Id` الواردة وفق النمط `^[A-Za-z0-9._-]{8,64}$` ويرفض محاولات حقن CR/LF).
   - يُعاد المعرّف في ترويسة الاستجابة `X-Request-Id` وفي استجابات الأخطاء الداخلية (`500 INTERNAL`) لتمكين فريق الدعم من ربط شكوى المستخدم بسجل الخادم مباشرة.
2. **سياسة حظر تسريب الأسرار (`No Secrets in Logs`)**:
   - تُنقّح جميع نصوص الأخطاء المسجلة في `errorHandler` و`scripts/ops/*` بحيث تُستبدل سلاسل الاتصال وكلمات المرور والرموز بـ `[REDACTED]`.
   - لا تُعاد تفاصيل `internalDetail` أو تتبع المكدس (`stack`) إلى العميل في استجابات HTTP أبدًا.

---

## 3. مصفوفة فرز الأعطال وتشخيص الدعم (`Incident Triage Matrix`)

| رمز الحالة / الكود | السبب المرجح | خطوة التحقق والتصحيح |
|---|---|---|
| `401 Unauthorized` | انتهاء صلاحية الجلسة (`an_session`) أو عدم إرسال كوكيز الجلسة | التحقق من ضبط `CORS_ORIGINS` و`TRUST_PROXY=1` خلف Reverse Proxy ومطابقة نطاق الكوكيز. |
| `403 CSRF_INVALID` / `CSRF_ORIGIN` | غياب `x-csrf-token` أو اختلاف `Origin`/`Referer` عن `CORS_ORIGINS` | التحقق من استدعاء `GET /api/auth/csrf` أولًا وإرسال الترويسة، ومراجعة `CORS_ORIGINS` في `.env`. |
| `429 Too Many Requests` | تجاوز حد محاولات تسجيل الدخول الفاشلة (`login_rate_events`) | الانتظار حتى انتهاء نافذة الحظر (`Retry-After`)؛ يصفّر الدخول الناجح عداد المستخدم فقط وليس عداد IP. |
| `503 DB_UNAVAILABLE` / `migrations_pending` | قاعدة البيانات غير متاحة أو توجد هجرات غير مطبقة بعد | التحقق من حالة PostgreSQL وتشغيل `npm run migrate` عبر `MIGRATION_DATABASE_URL` ثم إعادة فحص `/api/ready`. |
| `503` مع فشل `roleGuard` | اتصال التطبيق بدور يملك `SUPERUSER` أو `BYPASSRLS` أو ملكية الجداول | تصحيح `DATABASE_URL` ليشير إلى دور `an_app` المقيد وتشغيل `npm run db:provision-app-role`. |
| `500 INTERNAL` + `requestId` | استثناء غير متوقع في الخادم | البحث في سجلات الخادم عن `requestId` المبلغ من المستخدم وتصعيد التقرير مرفقًا بالمسار والوقت. |
| خطأ `TENANT_DB_ROUTE_MISSING` | تفعيل `DB_MODE` غير مدعوم (`per_company` أو `on_prem`) دون مسار مسجل | مراجعة [وثيقة أنماط قواعد البيانات](./DB_MODES.md) وإعادة ضبط `DB_MODE=central` المدعوم رسميًا للإنتاج. |

---

## 4. روتين الفحص اليومي وإجراءات الطوارئ للمشغّل

- **فحص يومي سريع**:
  1. التأكد من استجابة `GET /api/health` (`200`) و`GET /api/ready` (`200`).
  2. مراجعة معدل أخطاء `5xx` و`429` في سجلات التطبيق القياسية (`stdout/stderr`).
  3. التأكد من نجاح مهمة النسخ الاحتياطي الأخيرة ووجود ملف `.manifest.json` مطابق.
- **مسار التصعيد**:
  - **المستوى الأول (L1 Support)**: جمع `requestId`، اسم المستخدم، الشركة، الوقت التقريبي، ولقطة الشاشة دون طلب كلمات المرور.
  - **المستوى الثاني (L2 Ops)**: فحص `/api/ready` وسجلات `requestId` وحالة PostgreSQL واتصال `an_app`.
  - **المستوى الثالث (L3 Engineering)**: معالجة أخطاء الشفرة أو استعادة النسخ الاحتياطي وفق [دليل النسخ الاحتياطي](./BACKUP.md).
