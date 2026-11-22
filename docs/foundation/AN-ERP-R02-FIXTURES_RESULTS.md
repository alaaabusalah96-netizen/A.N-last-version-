# AN-ERP-R02-FIXTURES: إصلاح fixtures واكتشاف الاختبارات وبيئة CI

- **PACKAGE**: `02-AN-ERP-R02-FIXTURES`
- **EFFECTIVE_BASELINE**: `854ee6637b41d10e9ab8536db4c3f49d2d8f0746` (`main` بعد `AN-ERP-R01-DATES`)
- **SPEC_HEADER_REF**: `2eb51fb1a32f4304b1a0b281264ef7f9923b59d6`
- **CI_REF**: Run 180 (`44730466900`) — `https://github.com/alaaabusalah96-netizen/A.N-last-version-/actions/runs/44730466900`

## ملخص التنفيذ (WP-1 .. WP-4)

1. **WP-1 (إصلاح fixture عدم التطابق وتناغم المخزون/التقييم)**:
   - في `scripts/verifyInvAtomicBalance1.ts` و`scripts/helpers/inventoryTestHarness.ts`:
     - نُقل إنشاء مستودع عدم التطابق `whMismatch` وكافة بذور الجدول الخاصة بالمستأجر (`inv_warehouses`, `inv_stock_balances`, `inv_valuation_balances`, `inv_cost_layers`) إلى معاملة SQL واحدة على نفس المنفّذ (`appClient1` بدور `an_app`) بعد `BEGIN` و`SELECT set_config('app.current_tenant_id', $1, true)` مع بقاء RLS و`FORCE RLS` مفعّلين.
     - تم استبدال الأرقام الصماء السابقة بمواءمة ديناميكية تقرأ الأرصدة الفعلية وتمر عبر `defaultInventoryValuationService.processReceipt(..., { movementType: 'OPENING', stockSyncMode: 'external_verified' })` وتتحقق من `stock_qty == valuation_qty == SUM(inv_cost_layers.remaining_qty)`.
     - إثبات رفض `defaultStockService.transfer` لحالة عدم التطابق برمز `VALUATION_INTEGRITY_ERROR` متبوعًا بفحص SQL يثبت عدم بقاء أي حركات مخزون أو حركات تقييم أو سجلات تدقيق أو تغير أرصدة جزئي.

2. **WP-2 (دورة الحياة والتنظيف وعدم ابتلاع الأخطاء)**:
   - فصل أخطاء التنظيف (`teardownFailed` / `[TEARDOWN_FAIL]`) عن أخطاء تأكيدات الاختبار بدون ابتلاع أي استثناء في `finally`.
   - توسيع فحص ما بعد التنظيف في `countRemainingTestInventoryRows` ليشمل كل جداول المخزون والتقييم الاختبارية مع الإبقاء المتعمد على `companies` و`audit_logs` غير القابلة للتعديل، ودون استخدام `DISABLE TRIGGER`.

3. **WP-3 (اكتشاف الاختبارات وشروط PostgreSQL وSCRAM)**:
   - إنشاء `vitest.config.ts` وتحديث `package.json` (`test:unit` و`test:discovery`) لضمان قصر اكتشاف Vitest على `src/**/*.test.{ts,tsx}` واستبعاد `e2e/smoke.spec.ts` تمامًا (تُشغّل عبر `npm run test:e2e-smoke` فقط).
   - توثيق جرد الاختبارات الفعلي: الأساس الموروث من R01 كان `28` ملفًا / `225` اختبارًا (بعد أن كان `26` ملفًا / `215` قبل R01)، وأُضيف ملف `src/server/tests/testPrerequisitesAndDiscovery.test.ts` (`6` اختبارات حقيقية) ليصبح المجموع **29 ملفًا / 231 اختبارًا**.
   - إضافة `scripts/helpers/pgPrerequisites.ts` لفحص توافق الإصدار الرئيسي لـ `pg_dump`/`pg_restore` مع الخادم (`SHOW server_version_num`) وإصدار `[BLOCKED]` (exit `2`) عند عدم التطابق أو الغياب، ودمجه في `backupRestoreDrill.ts`, `verifyBackupRestore1.ts`, و`runFoundationBattery.ts`.
   - تحديث `scripts/verifyScramVerifierFormat1.ts` للتحقق من `CREATEROLE`/`SUPERUSER` و`pg_hba_file_rules` ومسبار دور تحكمي لاكتشاف وضع `trust`/`peer` وإصدار `[BLOCKED]` (exit `2`) عند نقص المتطلبات بدل `[FAIL]` مضلل.

4. **WP-4 (تشخيص CI Run 180 وتدقيق `VERIFY_SESSION_SHIM`)**:
   - **تشخيص Run 180 (`44730466900`)**: أظهر عرض HTML العلني لإشعارات GitHub فشل المهمة `foundation` (`job/136268599641`) عند الخطوة `#step:19:3796` (`Run Foundation Test Battery`, exit `1`). تفاصيل السجل الخام ومخرجات `foundation-test-results` في API (`.../jobs`, `.../logs`, `.../summary_partial`) غير متاحة بدون توثيق (`HTTP 403` / `HTTP 404`) ولذلك لم يتم اختلاق سطور سجل غير مرئية.
   - **إعداد CI (`.github/workflows/foundation-ci.yml`)**: أضيفت خطوة التحقق من فصل `test:discovery` عن `e2e/` وخطوة التأكد من توفر `postgresql-client-16` لمطابقة خدمة `postgres:16`.
   - **تدقيق `VERIFY_SESSION_SHIM` / `installSessionShim`**: تأكد الفحص أن الظهور يقتصر حصريًا على سكربتات Playwright (`scripts/verifyCashCustodyUi1.ts`, `scripts/verifySidebarLayout1.ts`) وخطوة تشغيل البطارية في CI، ولا يوجد أي وجود له في `src/` أو `server.ts`.
