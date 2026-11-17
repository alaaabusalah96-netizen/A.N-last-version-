# دليل التشغيل الأول للمنصة / First-Run Operations Guide

> ينطبق هذا الدليل على التشغيل النظيف الأول لمنصة `an-erp-platform` (محليًا أو على PostgreSQL مُدار / Supabase).
>
> **تحذير أمني:** لا تضع أسرارًا حقيقية أو كلمات مرور في المستودع أو في سجلات التشغيل.

---

## التسلسل الإلزامي للتشغيل الأول (Exact Sequence)

اتّبع الخطوات التالية **بالترتيب**:
1. **إعداد الأسرار ومتغيرات البيئة (`secrets` / `.env`)**
2. **تطبيق هجرات قاعدة البيانات (`migrate`)**
3. **تهيئة دور التطبيق المقيد (`provision an_app`)**
4. **إنشاء مدير المنصة الأول صراحةً لمرة واحدة (`bootstrap:admin`)**
5. **تشغيل الخادم وتسجيل الدخول (`login`)**
6. **إنشاء أول شركة وبدء الدورة المحاسبية**

---

### 1. إعداد الأسرار ومتغيرات البيئة (`.env`)

انسخ `.env.example` إلى `.env` ثم عبّئ القيم التالية دون رفع `.env` إلى Git:

```bash
cp .env.example .env
```

أهم المتغيرات المطلوبة:
- **`MIGRATION_DATABASE_URL`**: رابط اتصال **المالك / المشرف** (يُستخدم في `migrate` و`db:provision-app-role` فقط).
- **`APP_DB_USER`** و **`APP_DB_PASSWORD`**: اسم وكلمة مرور دور التطبيق الأقل امتيازًا (`an_app`؛ كلمة المرور >= 16 حرف ASCII قابل للطباعة).
- **`DATABASE_URL`**: رابط اتصال **دور التطبيق** `an_app` (يرفض `RoleGuard` تشغيل الخادم إذا اتصل بدور يملك `SUPERUSER` أو `BYPASSRLS` أو ملكية الجداول).
- **`PLATFORM_ADMIN_USERNAME`** و **`PLATFORM_ADMIN_PASSWORD`**: بيانات مدير المنصة الأول (`password >= 12` حرفًا، يُطبّع `username` عبر `trim + lower`).
- **`CSRF_SECRET`**: مفتاح عشوائي >= 32 حرفًا (إلزامي في الإنتاج).
- **`CORS_ORIGINS`**: النطاقات المسموح بها مفصولة بفاصلة (مثال للتطوير: `http://localhost:3000,http://127.0.0.1:3000`).
- **SSL (`DATABASE_SSL`, `DATABASE_SSL_CA` / `DATABASE_SSL_CA_FILE`)**: وفق إعدادات بيئة PostgreSQL المُدارة.

---

### 2. تطبيق هجرات قاعدة البيانات (`migrate`)

تُنفّذ الهجرات عبر رابط المالك `MIGRATION_DATABASE_URL`:

```bash
npm run migrate
```

*(توجد أيضًا التسمية المكافئة `npm run migration`).*

---

### 3. تهيئة دور التطبيق `an_app` (`provision an_app`)

ينشئ أو يحدّث دور `an_app` بصلاحيات `LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION` ويمنحه صلاحيات DML اللازمة على الجداول المقيدة بـ RLS:

```bash
npm run db:provision-app-role
```

بعد نجاح التهيئة، تأكد أن `DATABASE_URL` في `.env` يشير إلى `an_app` وليس إلى مالك القاعدة أو `postgres`.

---

### 4. إنشاء مدير المنصة الأول صراحةً (`bootstrap:admin`)

> **ملاحظة أمنية معمارية:** بدء تشغيل الخادم (`server.ts`) لا ينشئ حساب `platform_admin` تلقائيًا أبدًا عند غيابه ولا يُغيّر كلمة مرور حساب `platform_admin` موجود عند اختلاط أسرار البيئات (يبقى غير مُنشِئ وغير مُعدِّل، ويكتفي بالتحقق من الدور والحالة النشطة). لتغيير كلمة المرور بعد التأسيس الأولي استخدم المسار الإداري المصادق والمُدقَّق (`POST /api/users/:userId/reset-password`).

لتأسيس أول حساب `platform_admin` لمرة واحدة:

```bash
npm run bootstrap:admin
```

سلوك الأمر:
- يقرأ `PLATFORM_ADMIN_USERNAME` و `PLATFORM_ADMIN_PASSWORD` من البيئة فقط.
- يشترط طول كلمة المرور `>= 12` حرفًا.
- ينشئ الحساب باستخدام Argon2id **فقط** عندما يكون `count(platform_admin) = 0`.
- إذا كان نفس `username` موجودًا بالفعل كـ `platform_admin` يُرجع نجاحًا تعريفيًا (`already exists`) دون تعديل.
- إذا وُجد `platform_admin` مختلف (`count > 0`) أو وُجد نفس الاسم بدور مختلف (مثل `user`)، يفشل بوضوح ويرفض الترقية الصامتة.

---

### 5. منافذ التشغيل وتسجيل الدخول (`Server` & `Login`)

#### التطوير (`dev`)
- واجهة الويب (Vite): المنفذ **`3000`** (`http://localhost:3000`) مع تمرير `/api` إلى API.
- خادم الـ API (Express): المنفذ **`3001`** (`http://127.0.0.1:3001` عبر `PORT=3001` في `npm run dev:api`).
- أمر التشغيل الكامل للتطوير: `npm run dev` (أو تشغيل الواجهة فقط `npm run dev:web` / الخادم فقط `npm run dev:api`).

#### الإنتاج (`production`)
```bash
npm run build
npm start
```
يخدم الإنتاج ملفات الواجهة المبنية وواجهات `/api` على منفذ **`PORT`** (الافتراضي **`3000`**).

#### تسجيل الدخول الأول عبر API (مثال `curl`)
1. الحصول على CSRF token وتخزين الكوكيز:
   ```bash
   curl -i -c cookies.txt http://127.0.0.1:3001/api/auth/csrf
   ```
2. تسجيل الدخول باستخدام الكوكيز و `x-csrf-token`:
   ```bash
   curl -i -b cookies.txt -c cookies.txt \
     -H "Content-Type: application/json" \
     -H "x-csrf-token: <CSRF_TOKEN_FROM_STEP_1>" \
     -d '{"username":"<PLATFORM_ADMIN_USERNAME>","password":"<PLATFORM_ADMIN_PASSWORD>"}' \
     http://127.0.0.1:3001/api/auth/login
   ```
   *(يعيد الخادم كوكي الجلسة `an_session` ويُدوّر رمز CSRF في الاستجابة/`an_csrf` لاستخدامه في الطلبات اللاحقة).*

---

### 6. إنشاء أول شركة وبدء الدورة المحاسبية

بعد تسجيل الدخول بحساب `platform_admin`:
1. **إنشاء الشركة**: `POST /api/companies` (مع `{ "code": "COMP_01", "nameAr": "الشركة الأولى" }`).
2. **إنشاء فترة محاسبية مفتوحة**: `POST /api/accounting/periods`.
3. **بذر شجرة الحسابات الافتراضية أو إنشاء الحسابات**: `POST /api/accounting/accounts/seed-default` أو `POST /api/accounting/accounts`.
4. **إنشاء قيد متوازن وترحيله**: `POST /api/accounting/journals` ثم `POST /api/accounting/journals/:id/post`.
5. **قراءة ميزان المراجعة والتقارير**: `GET /api/accounting/trial-balance?companyId=...` و `GET /api/accounting/reports/balance-sheet?companyId=...`.

---

## اختبارات التحقق الدخاني على PostgreSQL محلي (`loopback` فقط)

> تحذير: السكربتات التجريبية المدمّرة ترفض أي عنوان قاعدة بيانات غير محلي (`localhost` / `127.0.0.1` / `::1`).

- التحقق من مسار `bootstrap:admin`:
  ```bash
  npm run test:bootstrap-admin-1
  ```
- التحقق الدخاني الكامل لسلسلة (تسجيل دخول → شركة → فترة → حسابات → قيد → ترحيل → ميزان وتقارير):
  ```bash
  npm run test:smoke-ledger-api-1
  ```
