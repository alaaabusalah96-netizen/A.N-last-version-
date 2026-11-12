import fs from 'node:fs';
import path from 'node:path';
import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultCustomFieldService } from '../src/server/customization/customFieldService.js';
import { ValidationError } from '../src/server/http/errors.js';

console.log('==================================================================');
console.log('=== VERIFYING AN-CUSTOM-FIELDS-8 (Dynamic Custom Fields + C7)  ===');
console.log('==================================================================');

async function expectValidationError(
  label: string,
  fn: () => Promise<unknown>,
  pattern?: RegExp
) {
  try {
    await fn();
    await check(label, false, 'Expected ValidationError but operation succeeded');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isValidation = err instanceof ValidationError;
    const patternOk = pattern ? pattern.test(msg) : true;
    await check(label, isValidation && patternOk, `${msg}`);
  }
}

async function run() {
  // ------------------------------------------------------------------
  // 1) Complementary UI existence checks (NOT behavioral proof!)
  // ------------------------------------------------------------------
  const root = process.cwd();
  const panelPath = path.join(root, 'src/components/customization/CustomFieldsPanel.tsx');
  const groupPath = path.join(root, 'src/components/customization/DynamicFieldGroup.tsx');
  const sidebarPath = path.join(root, 'src/components/shell/AppSidebar.tsx');
  const appPath = path.join(root, 'src/App.tsx');
  const itemCardPath = path.join(root, 'src/components/inventory/ItemCardPanel.tsx');
  const invWsPath = path.join(root, 'src/components/inventory/InventoryWorkspace.tsx');
  const mig034Path = path.join(root, 'database/migrations/034_custom_fields.sql');

  const panelExists = fs.existsSync(panelPath);
  const groupExists = fs.existsSync(groupPath);
  const panelSrc = panelExists ? fs.readFileSync(panelPath, 'utf8') : '';
  const sidebarSrc = fs.existsSync(sidebarPath) ? fs.readFileSync(sidebarPath, 'utf8') : '';
  const appSrc = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  const itemCardSrc = fs.existsSync(itemCardPath) ? fs.readFileSync(itemCardPath, 'utf8') : '';
  const invWsSrc = fs.existsSync(invWsPath) ? fs.readFileSync(invWsPath, 'utf8') : '';
  const mig034Src = fs.existsSync(mig034Path) ? fs.readFileSync(mig034Path, 'utf8') : '';

  await check(
    'UI-EXIST-1: CustomFieldsPanel.tsx & DynamicFieldGroup.tsx exist and enforce userCanWrite + disabled entities',
    panelExists &&
      groupExists &&
      panelSrc.includes('userCanWrite') &&
      panelSrc.includes('غير مدعوم بعد') &&
      !panelSrc.includes("userRole === '")
  );
  await check(
    "UI-EXIST-2: 'custom_fields' wired in AppSidebar.tsx & App.tsx",
    sidebarSrc.includes("'custom_fields'") &&
      sidebarSrc.includes('الحقول الإضافية') &&
      appSrc.includes("'custom_fields'") &&
      appSrc.includes('CustomFieldsPanel')
  );
  await check(
    'UI-EXIST-3: DynamicFieldGroup imported in ItemCardPanel.tsx and InventoryWorkspace.tsx with «بيانات إضافية»',
    itemCardSrc.includes('DynamicFieldGroup') &&
      itemCardSrc.includes('بيانات إضافية') &&
      invWsSrc.includes('DynamicFieldGroup') &&
      invWsSrc.includes('customValues')
  );
  await check(
    'DDL-EXIST-1: Migration 034 enables FORCE ROW LEVEL SECURITY using app.current_tenant_id + an_app',
    mig034Src.includes('FORCE ROW LEVEL SECURITY') &&
      mig034Src.includes("current_setting('app.current_tenant_id'") &&
      mig034Src.includes('TO an_app')
  );

  // ------------------------------------------------------------------
  // 2) Loopback PostgreSQL Behavioral Verification (F1 - F16)
  // ------------------------------------------------------------------
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Behavioral DB proofs F1-F16 are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(dbUrl);
  } catch (err) {
    console.error('Invalid DATABASE_URL:', err);
    blocked('DATABASE_URL is invalid URL format. F1-F16 tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)) {
    console.error(
      `[FATAL SAFETY ERROR] Non-loopback host '${parsedUrl.hostname}' refused for destructive verification.`
    );
    process.exit(1);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor. Behavioral DB proofs F1-F16 are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  let compAId: string | null = null;
  let compBId: string | null = null;

  try {
    const companyRepo = new CompanyRepository();
    const compA = await companyRepo.create({
      code: `CF_A_${suffix}`,
      nameAr: `شركة حقول أ ${suffix}`,
      createdBy: null,
    });
    const compB = await companyRepo.create({
      code: `CF_B_${suffix}`,
      nameAr: `شركة حقول ب ${suffix}`,
      createdBy: null,
    });
    compAId = compA.id;
    compBId = compB.id;

    // F1: إنشاء حقل text إلزامي على item -> ينجح، isActive=true
    const fText = await defaultCustomFieldService.createField(compAId, {
      entityType: 'item',
      fieldKey: 'origin_country',
      labelAr: 'بلد المنشأ',
      fieldType: 'text',
      isRequired: true,
      sortOrder: 10,
      helpText: 'بلد التصنيع الأصلي',
    });
    await check(
      'F1: Create required text custom field on item succeeds with isActive=true',
      Boolean(fText.id) && fText.isActive === true && fText.isRequired === true && fText.fieldType === 'text'
    );

    // F2: نفس field_key تاني -> ValidationError (unique)
    await expectValidationError(
      'F2: Duplicate field_key on same (companyId, entityType) throws ValidationError',
      () =>
        defaultCustomFieldService.createField(compAId!, {
          entityType: 'item',
          fieldKey: 'origin_country',
          labelAr: 'بلد مكرر',
          fieldType: 'text',
        })
    );

    // F3: field_key = 'Bad Key' -> ValidationError
    await expectValidationError(
      "F3: Invalid field_key ('Bad Key') throws ValidationError",
      () =>
        defaultCustomFieldService.createField(compAId!, {
          entityType: 'item',
          fieldKey: 'Bad Key',
          labelAr: 'مفتاح خاطئ',
          fieldType: 'text',
        })
    );

    // F4: field_type='select' بلا options -> ValidationError
    await expectValidationError(
      "F4: field_type='select' without options throws ValidationError",
      () =>
        defaultCustomFieldService.createField(compAId!, {
          entityType: 'item',
          fieldKey: 'grade_empty',
          labelAr: 'درجة الجودة',
          fieldType: 'select',
          options: [],
        })
    );

    // F5: entity_type='supplier' -> ValidationError /غير مدعوم/
    await expectValidationError(
      "F5: Unsupported entityType='supplier' throws ValidationError /غير مدعوم/",
      () =>
        defaultCustomFieldService.createField(compAId!, {
          entityType: 'supplier',
          fieldKey: 'tax_tier',
          labelAr: 'فئة ضريبية',
          fieldType: 'text',
        }),
      /غير مدعوم/
    );

    // Create additional optional typed fields for F6-F12 (number, date, select, boolean)
    const fNumber = await defaultCustomFieldService.createField(compAId, {
      entityType: 'item',
      fieldKey: 'net_weight_kg',
      labelAr: 'الوزن الصافي',
      fieldType: 'number',
      isRequired: false,
      sortOrder: 20,
    });
    const fDate = await defaultCustomFieldService.createField(compAId, {
      entityType: 'item',
      fieldKey: 'expiry_date',
      labelAr: 'تاريخ الانتهاء',
      fieldType: 'date',
      isRequired: false,
      sortOrder: 30,
    });
    const fSelect = await defaultCustomFieldService.createField(compAId, {
      entityType: 'item',
      fieldKey: 'quality_grade',
      labelAr: 'فئة الجودة',
      fieldType: 'select',
      options: ['A', 'B', 'C'],
      isRequired: false,
      sortOrder: 40,
    });
    const fBool = await defaultCustomFieldService.createField(compAId, {
      entityType: 'item',
      fieldKey: 'is_fragile',
      labelAr: 'قابل للكسر',
      fieldType: 'boolean',
      isRequired: false,
      sortOrder: 50,
    });

    // F9 (part 1): حفظ صنف جديد بلا الحقل الإلزامي -> ValidationError /إلزامي/
    await expectValidationError(
      'F9-CREATE: Creating an item without required custom field throws ValidationError /إلزامي/',
      () =>
        defaultItemService.createItem(compAId!, {
          code: `ITM_MISSING_${suffix}`,
          nameAr: 'صنف بدون حقل إلزامي',
          uom: 'unit',
        }),
      /إلزامي/
    );

    // Create item validly WITH the required custom field
    const itemA = await defaultItemService.createItem(compAId, {
      code: `ITM_OK_${suffix}`,
      nameAr: 'صنف مكتمل الحقول',
      uom: 'kg',
      customValues: [{ fieldId: fText.id, value: 'السعودية' }],
    });

    // F6: حفظ قيمة number بـ'abc' -> ValidationError
    await expectValidationError(
      "F6: Saving invalid number ('abc') throws ValidationError",
      () =>
        defaultCustomFieldService.setValues(compAId!, itemA.id, [
          { fieldId: fText.id, value: 'السعودية' },
          { fieldId: fNumber.id, value: 'abc' },
        ])
    );

    // F7: حفظ قيمة date بـ'2026-13-45' -> ValidationError
    await expectValidationError(
      "F7: Saving invalid calendar date ('2026-13-45') throws ValidationError",
      () =>
        defaultCustomFieldService.setValues(compAId!, itemA.id, [
          { fieldId: fText.id, value: 'السعودية' },
          { fieldId: fDate.id, value: '2026-13-45' },
        ])
    );

    // F8: حفظ قيمة select خارج options -> ValidationError
    await expectValidationError(
      'F8: Saving select value outside options throws ValidationError',
      () =>
        defaultCustomFieldService.setValues(compAId!, itemA.id, [
          { fieldId: fText.id, value: 'السعودية' },
          { fieldId: fSelect.id, value: 'Z_INVALID' },
        ])
    );

    // F9 (part 2): حفظ setValues بإفراغ الحقل الإلزامي -> ValidationError /إلزامي/
    await expectValidationError(
      'F9-UPDATE: Clearing required custom field on setValues throws ValidationError /إلزامي/',
      () =>
        defaultCustomFieldService.setValues(compAId!, itemA.id, [
          { fieldId: fText.id, value: '' },
        ]),
      /إلزامي/
    );

    // F10: حفظ القيمة ثم getValues -> ترجّع نفس القيمة بنفس النوع
    await defaultCustomFieldService.setValues(compAId, itemA.id, [
      { fieldId: fText.id, value: 'مصر' },
      { fieldId: fNumber.id, value: 12.5 },
      { fieldId: fDate.id, value: '2027-06-15' },
      { fieldId: fSelect.id, value: 'A' },
      { fieldId: fBool.id, value: true },
    ]);
    const valsAfterF10 = await defaultCustomFieldService.getValues(compAId, itemA.id);
    const byKey10 = new Map(valsAfterF10.map((v) => [v.fieldKey, v]));
    await check(
      'F10: Save typed values and getValues returns exact values with proper JS types',
      byKey10.get('origin_country')?.value === 'مصر' &&
        typeof byKey10.get('net_weight_kg')?.value === 'number' &&
        byKey10.get('net_weight_kg')?.value === 12.5 &&
        byKey10.get('expiry_date')?.value === '2027-06-15' &&
        byKey10.get('quality_grade')?.value === 'A' &&
        byKey10.get('is_fragile')?.value === true
    );

    // F11: تعديل القيمة (upsert) ثم قراءة -> القيمة الجديدة فقط، صف واحد (عدّ الصفوف = 1)
    await defaultCustomFieldService.setValues(compAId, itemA.id, [
      { fieldId: fText.id, value: 'الإمارات' },
      { fieldId: fNumber.id, value: 99.25 },
    ]);
    const valsAfterF11 = await defaultCustomFieldService.getValues(compAId, itemA.id);
    const rowCountText = await withTenantTransaction(compAId, async (tx) => {
      const r = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int as cnt FROM custom_field_values WHERE field_id = $1 AND entity_id = $2`,
        [fText.id, itemA.id]
      );
      return r.rows[0]?.cnt ?? -1;
    });
    const textRec11 = valsAfterF11.find((v) => v.fieldId === fText.id);
    const numRec11 = valsAfterF11.find((v) => v.fieldId === fNumber.id);
    await check(
      'F11: Upsert replaces previous value with a single DB row (row count === 1)',
      textRec11?.value === 'الإمارات' && numRec11?.value === 99.25 && rowCountText === 1
    );

    // F12: setActive(false) للحقل ثم getValues -> القيم لسه محفوظة، والتعريف غير نشط
    await defaultCustomFieldService.setActive(compAId, fNumber.id, false);
    const activeOnlyDefs = await defaultCustomFieldService.getDefinitions(compAId, 'item', false);
    const allDefs = await defaultCustomFieldService.getDefinitions(compAId, 'item', true);
    const valsAfterDeactivate = await defaultCustomFieldService.getValues(compAId, itemA.id);
    const fNumAfter = valsAfterDeactivate.find((v) => v.fieldId === fNumber.id);
    await check(
      'F12: setActive(false) preserves saved value and marks definition inactive',
      !activeOnlyDefs.some((d) => d.id === fNumber.id) &&
        allDefs.find((d) => d.id === fNumber.id)?.isActive === false &&
        fNumAfter?.value === 99.25 &&
        fNumAfter?.isActive === false
    );

    // F13: محاولة setValues بـ fieldId من شركة أخرى -> ValidationError صريح
    const fOtherComp = await defaultCustomFieldService.createField(compBId, {
      entityType: 'item',
      fieldKey: 'other_field',
      labelAr: 'حقل شركة أخرى',
      fieldType: 'text',
    });
    await expectValidationError(
      'F13: Submitting another company fieldId in setValues throws explicit ValidationError',
      () =>
        defaultCustomFieldService.setValues(compAId!, itemA.id, [
          { fieldId: fOtherComp.id, value: 'cross-company' },
        ])
    );

    // F14: تحديث field_key أو field_type -> ValidationError /غير قابل للتعديل/
    await expectValidationError(
      'F14-KEY: Attempting to update fieldKey throws ValidationError /غير قابل للتعديل/',
      () =>
        defaultCustomFieldService.updateField(compAId!, fText.id, {
          fieldKey: 'new_key',
        } as unknown as Record<string, unknown>),
      /غير قابل للتعديل/
    );
    await expectValidationError(
      'F14-TYPE: Attempting to update fieldType throws ValidationError /غير قابل للتعديل/',
      () =>
        defaultCustomFieldService.updateField(compAId!, fText.id, {
          fieldType: 'number',
        } as unknown as Record<string, unknown>),
      /غير قابل للتعديل/
    );

    // F15: استعلام مباشر custom_field_values كمستخدم تطبيقي لشركة أخرى -> صفر صفوف (RLS)
    const rlsCrossCount = await withTenantTransaction(compBId, async (tx) => {
      const roleInfo = await tx.query<{ rolsuper: boolean; rolbypassrls: boolean; cur: string }>(
        `SELECT current_user as cur, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const info = roleInfo.rows[0];
      if (info && (info.rolsuper || info.rolbypassrls)) {
        // Drop down to restricted app role inside the transaction if connected as owner/superuser
        await tx.query('SET LOCAL ROLE an_app');
      }
      const res = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int as cnt FROM custom_field_values WHERE entity_id = $1`,
        [itemA.id]
      );
      return res.rows[0]?.cnt ?? -1;
    });
    await check(
      'F15: Direct query on custom_field_values as app role under Company B tenant sees 0 rows of Company A',
      rlsCrossCount === 0
    );
  } catch (err) {
    await check(
      'Unhandled exception during custom fields verification',
      false,
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    // F16: تنظيف كامل في finally -> كل الصفوف المنشأة محذوفة (عدّ = 0)
    const cleanupIds = [compAId, compBId].filter((id): id is string => Boolean(id));
    let remainingRows = -1;
    if (cleanupIds.length > 0) {
      for (const cid of cleanupIds) {
        try {
          await withTenantTransaction(cid, async (tx) => {
            await tx.query('DELETE FROM custom_field_values WHERE company_id = $1', [cid]);
            await tx.query('DELETE FROM custom_field_definitions WHERE company_id = $1', [cid]);
            await tx.query('DELETE FROM inv_items WHERE company_id = $1', [cid]);
            await tx.query('DELETE FROM audit_logs WHERE company_id = $1', [cid]);
          });
          await executor.query('DELETE FROM companies WHERE id = $1', [cid]);
        } catch (cleanupErr) {
          console.error(`Cleanup error for company ${cid}:`, cleanupErr);
        }
      }

      try {
        const verifyClean = await executor.query<{ cnt: number }>(
          `SELECT (
            (SELECT COUNT(*) FROM custom_field_definitions WHERE company_id = ANY($1::uuid[])) +
            (SELECT COUNT(*) FROM custom_field_values WHERE company_id = ANY($1::uuid[]))
          )::int as cnt`,
          [cleanupIds]
        );
        remainingRows = verifyClean.rows[0]?.cnt ?? -1;
      } catch (verifyErr) {
        // Fallback under tenant transactions if direct executor hits RLS
        console.error('Direct cleanup count query note:', verifyErr);
        let sum = 0;
        for (const cid of cleanupIds) {
          sum += await withTenantTransaction(cid, async (tx) => {
            const r = await tx.query<{ cnt: number }>(
              `SELECT (
                (SELECT COUNT(*) FROM custom_field_definitions WHERE company_id = $1) +
                (SELECT COUNT(*) FROM custom_field_values WHERE company_id = $1)
              )::int as cnt`,
              [cid]
            );
            return r.rows[0]?.cnt ?? 0;
          });
        }
        remainingRows = sum;
      }
    } else {
      remainingRows = 0;
    }

    await check(
      `F16: Complete cleanup in finally block verified (remaining custom_field_* rows = ${remainingRows})`,
      remainingRows === 0
    );
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('Fatal error in verifyCustomFields8:', err);
  process.exit(1);
});
