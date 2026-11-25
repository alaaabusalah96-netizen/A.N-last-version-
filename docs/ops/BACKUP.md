# دليل النسخ الاحتياطي والاستعادة وتجربة الاستعادة الدورية (Backup & Restore Runbook)

> ينطبق هذا الدليل على النمط المدعوم رسميًا للإنتاج: **`central` PostgreSQL**.
> **تحذير أمني:** لا تطبع روابط الاتصال أو كلمات المرور في السجلات، ولا تنفّذ أي تجربة استعادة تجريبية (`drill`) إلا على خادم PostgreSQL محلي (`loopback`: `localhost` / `127.0.0.1` / `::1`).

---

## 1. أهداف الاستعادة المقترحة (RPO / RTO)

| المؤشر | القيمة الموصى بها للإنتاج | آلية التحقيق |
|---|---|---|
| **RPO (أقصى فقد بيانات مقبول)** | `<= 24 ساعة` (يفضّل كل 6 ساعات في الإنتاج النشط + WAL archiving من المزود المُدار) | جدولة `scripts/ops/backupDb.ts` أو `pg_dump` دوريًا |
| **RTO (الزمن المستهدف للاستعادة)** | `<= 60 دقيقة` لقاعدة بيانات متوسطة الحجم | اختبار دوري عبر `scripts/ops/restoreDb.ts` و`scripts/ops/backupRestoreDrill.ts` |
| **التحقق من السلامة** | إلزامي قبل وبعد الاستعادة عبر بصمة `SHA-256` وملف `.manifest.json` | رفض الاستعادة عند تعارض `SHA-256` |

---

## 2. الأدوات المرفقة في المستودع (`scripts/ops/`)

1. **`scripts/ops/backupDb.ts`** — إنشاء نسخة احتياطية بصيغة PostgreSQL Custom Format (`.dump`) مع ملف بيان `.manifest.json` يحتوي على:
   - `sha256` وحجم الملف بالبايت.
   - طابع زمني UTC ووضع القاعدة (`central`).
   - عدد الهجرات المطبقة وأحدث هجرة في `schema_migrations` (عند إمكانية الاستعلام).
2. **`scripts/ops/restoreDb.ts`** — استعادة آمنة تتضمن:
   - التحقق المسبق من بصمة `SHA-256` قبل المساس بقاعدة البيانات الهدف.
   - حماية `loopback-only` افتراضيًا؛ تتطلب الاستعادة على هدف غير محلي تمرير `--confirm-production-restore` صراحةً.
   - فحص ما بعد الاستعادة (`post-restore verification`): مطابقة `schema_migrations` والتحقق من بقاء `ENABLE` + `FORCE ROW LEVEL SECURITY` مفعلة على الجداول المملوكة للمستأجرين.
3. **`scripts/ops/backupRestoreDrill.ts`** — أداة تمرين الاستعادة الكاملة على قاعدة بيانات تجريبية معزولة (`disposable database`) على `loopback` فقط.

---

## 3. أوامر التشغيل القياسية

### أ. أخذ نسخة احتياطية
```bash
# عبر سكربت المنصة (يستخدم MIGRATION_DATABASE_URL أو DATABASE_URL)
npx tsx scripts/ops/backupDb.ts --output-dir ./backups
```
أو مباشرة عبر `pg_dump` (صيغة مخصصة مضغوطة دون تضمين ملكية المضيف القديم):
```bash
pg_dump --format=custom --no-owner --no-privileges --file=./backups/an_erp_$(date -u +%Y%m%dT%H%M%SZ).dump "$MIGRATION_DATABASE_URL"
```

### ب. استعادة نسخة احتياطية والتحقق منها
```bash
# 1) استعادة على بيئة اختبار محلية (loopback)
npx tsx scripts/ops/restoreDb.ts --manifest ./backups/<backup>.manifest.json --confirm-restore

# 2) استعادة إنتاجية صريحة (بعد إيقاف حركة الكتابة وأخذ نسخة وقائية قبلية)
npx tsx scripts/ops/restoreDb.ts --manifest ./backups/<backup>.manifest.json --confirm-restore --confirm-production-restore
```
بعد الاستعادة:
1. تأكد من تشغيل `npm run db:provision-app-role` إذا تم الاستعادة إلى خادم PostgreSQL جديد لا يحتوي على دور `an_app` بنفس الامتيازات.
2. تحقق من جاهزية التطبيق عبر `GET /api/ready` (`ready: true`).

---

## 4. تجربة النسخ الاحتياطي والاستعادة الدورية (`Backup → Restore Drill`)

### أمر تنفيذ التجربة على بيئة `loopback` تجريبية (`disposable`)
```bash
MIGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
  npx tsx scripts/ops/backupRestoreDrill.ts
```

### مراحل التجربة المؤتمتة:
1. التحقق الصارم من أن المضيف محلي (`localhost` / `127.0.0.1` / `::1`) فقط.
2. إنشاء قاعدة بيانات تجريبية مصدرية (`an_drill_src_<timestamp>`) وتطبيق الهجرات عليها.
3. تنفيذ `backupDb` لإنتاج `.dump` و`.manifest.json` وحساب `SHA-256`.
4. إنشاء قاعدة بيانات تجريبية مستهدفة فارغة (`an_drill_dst_<timestamp>`).
5. تنفيذ `restoreDb` مع التحقق المسبق من البصمة، ثم التحقق من:
   - تطابق عدد سطور `schema_migrations` وأحدث إصدار هجرة.
   - بقاء `relrowsecurity = true` و`relforcerowsecurity = true` على الجداول التابعة للمستأجرين.
   - وجود البيانات الاختبارية المستعادة سليمة.
6. حذف قاعدتي التجربة والملفات المؤقتة عند الانتهاء.

### سجل وتوثيق الحالة الحالية للتجربة (Honest Drill Status)
- **في بيئة البناء المعزولة الحالية (Sandbox Container)**: لا تتوفر خدمة PostgreSQL محلية ولا أدوات العميل `pg_dump` / `pg_restore` / `psql`، ولذلك يبلّغ السكربت صراحةً بحالة **`BLOCKED`** للتشغيل الحي مع اجتياز جميع اختبارات التحقق البنيوي، وتوليد/تحقق `.manifest.json`، وبصمة `SHA-256`، وكشف التلاعب بالملفات، وتنقيح الأسرار من السجلات، وحارس `loopback-only` عبر `npm run test:backup-restore-1`.
- **قبل الإطلاق الفعلي للإنتاج (Mandatory Pre-Go-Live Gate)**: يجب تشغيل `npx tsx scripts/ops/backupRestoreDrill.ts` على خادم Staging أو Runner يحتوي على PostgreSQL محلي + `pg_dump`/`pg_restore` وتوثيق تاريخ التنفيذ ونتيجة `PASS` في سجل الإطلاق.

---

## المستهدفات المعتمدة (قرار المالك بتفويضه، 2026-11-25)

- **RPO ≤ 15 دقيقة**: أرشفة WAL للاستعادة لنقطة زمنية + نسخة كاملة يومية محفوظة 30 يومًا.
- **RTO ≤ 60 دقيقة**: تمرين استعادة إلزامي كل إصدار على قاعدة loopback معلومة الملكية.
- **قاعدة الهدف غير الفارغ**: الاستعادة فوق قاعدة بها جداول ممنوعة إلا بتأكيد صريح مضاعف (`--confirm-non-empty-target`)، وأي نسخة تالفة تُرفض بفحص SHA-256 قبل لمس الهدف.
