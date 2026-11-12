import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultCustomFieldRepository, CustomFieldRepository, extractTypedValue } from './customFieldRepository.js';
import {
  CreateCustomFieldInput,
  CustomEntityType,
  CustomFieldDefinition,
  CustomFieldType,
  CustomFieldValueInput,
  CustomFieldValueRecord,
  TypedCustomFieldValue,
  UpdateCustomFieldInput,
} from './customFieldTypes.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';

const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STRICT_NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const VALID_FIELD_TYPES: readonly CustomFieldType[] = ['text', 'number', 'date', 'boolean', 'select'];
const SUPPORTED_ENTITY_TYPES: readonly CustomEntityType[] = ['item'];

function isValidCalendarDate(dateStr: string): boolean {
  if (!ISO_DATE_PATTERN.test(dateStr)) return false;
  const [yStr, mStr, dStr] = dateStr.split('-');
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const d = parseInt(dStr, 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function normalizeOptions(rawOptions: unknown): string[] {
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    throw new ValidationError('حقل الاختيار (select) يتطلب مصفوفة خيارات غير فارغة');
  }
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const item of rawOptions) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ValidationError('كل خيار في حقل القائمة المنسدلة يجب أن يكون نصًا غير فارغ');
    }
    const trimmed = item.trim();
    if (seen.has(trimmed)) {
      throw new ValidationError(`الخيار (${trimmed}) مكرر في قائمة الخيارات`);
    }
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned;
}

export class CustomFieldService {
  constructor(
    private repo: CustomFieldRepository = defaultCustomFieldRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async getDefinitions(
    companyId: string,
    entityType: CustomEntityType | string = 'item',
    includeInactive = false,
    customExecutor?: DbExecutor
  ): Promise<CustomFieldDefinition[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!SUPPORTED_ENTITY_TYPES.includes(entityType as CustomEntityType)) {
      throw new ValidationError(
        `الكيان ${entityType} غير مدعوم في هذه النسخة — الحقول تُدعم حاليًا على الأصناف فقط`
      );
    }
    return await this.repo.listDefinitions(companyId, entityType as CustomEntityType, includeInactive, customExecutor);
  }

  async createField(
    companyId: string,
    input: CreateCustomFieldInput,
    actorId?: string,
    customExecutor?: DbExecutor
  ): Promise<CustomFieldDefinition> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input || typeof input !== 'object') {
      throw new ValidationError('بيانات الحقل الإضافي مطلوبة');
    }

    const entityType = String(input.entityType || 'item').trim();
    if (!SUPPORTED_ENTITY_TYPES.includes(entityType as CustomEntityType)) {
      throw new ValidationError(
        `الكيان ${entityType} غير مدعوم في هذه النسخة — الحقول تُدعم حاليًا على الأصناف فقط`
      );
    }

    const fieldKey = String(input.fieldKey || '').trim();
    if (!FIELD_KEY_PATTERN.test(fieldKey) || fieldKey.length > 60) {
      throw new ValidationError('مفتاح الحقل غير صالح — يجب أن يبدأ بحرف إنجليزي صغير ويحتوي أحرفًا صغيرة أو أرقامًا أو _ فقط');
    }

    const labelAr = String(input.labelAr || '').trim();
    if (!labelAr || labelAr.length > 150) {
      throw new ValidationError('التسمية العربية للحقل مطلوبة (1–150 حرف)');
    }

    const fieldType = String(input.fieldType || '') as CustomFieldType;
    if (!VALID_FIELD_TYPES.includes(fieldType)) {
      throw new ValidationError(`نوع الحقل غير صالح (${input.fieldType})`);
    }

    const options = fieldType === 'select' ? normalizeOptions(input.options) : null;
    const isRequired = Boolean(input.isRequired);
    const isActive = input.isActive !== undefined ? Boolean(input.isActive) : true;
    const sortOrder = Number.isInteger(input.sortOrder) ? Number(input.sortOrder) : 0;
    const helpText = input.helpText && typeof input.helpText === 'string' && input.helpText.trim() !== ''
      ? input.helpText.trim()
      : null;

    const run = async (tx: DbExecutor) => {
      const existing = await this.repo.findDefinitionByKey(companyId, entityType as CustomEntityType, fieldKey, tx);
      if (existing) {
        throw new ValidationError(`مفتاح الحقل (${fieldKey}) مستخدم مسبقًا لهذا الكيان`);
      }

      const created = await this.repo.createDefinition(
        companyId,
        {
          entityType: entityType as CustomEntityType,
          fieldKey,
          labelAr,
          fieldType,
          options,
          isRequired,
          isActive,
          sortOrder,
          helpText,
        },
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTOM_FIELD_CREATE',
          entityType: 'custom_field_definition',
          entityId: created.id,
          metadata: { entityType, fieldKey, fieldType, isRequired },
        },
        { executor: tx }
      );

      return created;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async updateField(
    companyId: string,
    fieldId: string,
    input: UpdateCustomFieldInput & Record<string, unknown>,
    actorId?: string,
    customExecutor?: DbExecutor
  ): Promise<CustomFieldDefinition & { outOfOptionsValuesCount?: number }> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!fieldId || !isUuid(fieldId)) {
      throw new ValidationError('معرّف الحقل غير صالح');
    }
    if (!input || typeof input !== 'object') {
      throw new ValidationError('بيانات التحديث مطلوبة');
    }

    if (
      input.fieldKey !== undefined ||
      input.field_key !== undefined ||
      input.fieldType !== undefined ||
      input.field_type !== undefined
    ) {
      throw new ValidationError('مفتاح الحقل ونوعه غير قابل للتعديل بعد الإنشاء');
    }

    const run = async (tx: DbExecutor) => {
      const existing = await this.repo.findDefinitionById(companyId, fieldId, tx);
      if (!existing) {
        throw new NotFoundError('تعريف الحقل الإضافي غير موجود');
      }

      const patch: {
        labelAr?: string;
        options?: string[] | null;
        isRequired?: boolean;
        isActive?: boolean;
        sortOrder?: number;
        helpText?: string | null;
      } = {};

      if (input.labelAr !== undefined) {
        const lbl = String(input.labelAr).trim();
        if (!lbl || lbl.length > 150) {
          throw new ValidationError('التسمية العربية للحقل غير صالحة (1–150 حرف)');
        }
        patch.labelAr = lbl;
      }

      let outOfOptionsValuesCount = 0;
      if (input.options !== undefined) {
        if (existing.fieldType !== 'select') {
          throw new ValidationError('الخيارات (options) متاحة فقط لحقول القائمة المنسدلة (select)');
        }
        const opts = normalizeOptions(input.options);
        patch.options = opts;
        outOfOptionsValuesCount = await this.repo.countOutOfOptionsValues(companyId, fieldId, opts, tx);
      }

      if (input.isRequired !== undefined) patch.isRequired = Boolean(input.isRequired);
      if (input.isActive !== undefined) patch.isActive = Boolean(input.isActive);
      if (input.sortOrder !== undefined) {
        if (!Number.isInteger(input.sortOrder)) {
          throw new ValidationError('ترتيب الحقل يجب أن يكون عددًا صحيحًا');
        }
        patch.sortOrder = input.sortOrder;
      }
      if (input.helpText !== undefined) {
        patch.helpText =
          input.helpText !== null && String(input.helpText).trim() !== ''
            ? String(input.helpText).trim()
            : null;
      }

      const updated = await this.repo.updateDefinition(companyId, fieldId, patch, tx);
      if (!updated) {
        throw new NotFoundError('تعريف الحقل الإضافي غير موجود');
      }

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTOM_FIELD_UPDATE',
          entityType: 'custom_field_definition',
          entityId: updated.id,
          metadata: {
            fieldKey: updated.fieldKey,
            outOfOptionsValuesCount,
          },
        },
        { executor: tx }
      );

      return outOfOptionsValuesCount > 0 ? { ...updated, outOfOptionsValuesCount } : updated;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async setActive(
    companyId: string,
    fieldId: string,
    isActive: boolean,
    actorId?: string,
    customExecutor?: DbExecutor
  ): Promise<CustomFieldDefinition> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!fieldId || !isUuid(fieldId)) {
      throw new ValidationError('معرّف الحقل غير صالح');
    }

    const run = async (tx: DbExecutor) => {
      const updated = await this.repo.setDefinitionActive(companyId, fieldId, Boolean(isActive), tx);
      if (!updated) {
        throw new NotFoundError('تعريف الحقل الإضافي غير موجود');
      }
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTOM_FIELD_TOGGLE',
          entityType: 'custom_field_definition',
          entityId: updated.id,
          metadata: { fieldKey: updated.fieldKey, isActive: Boolean(isActive) },
        },
        { executor: tx }
      );
      return updated;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  validateValue(def: CustomFieldDefinition, raw: unknown): TypedCustomFieldValue {
    const isEmpty =
      raw === undefined ||
      raw === null ||
      (typeof raw === 'string' && raw.trim() === '');

    if (isEmpty) {
      if (def.isRequired) {
        throw new ValidationError(`الحقل «${def.labelAr}» إلزامي`);
      }
      return {
        isEmpty: true,
        valueText: null,
        valueNumber: null,
        valueDate: null,
        valueBoolean: null,
      };
    }

    switch (def.fieldType) {
      case 'text': {
        if (typeof raw !== 'string') {
          throw new ValidationError(`الحقل «${def.labelAr}» يتطلب نصًا`);
        }
        const val = raw.trim();
        if (val.length > 500) {
          throw new ValidationError(`الحقل «${def.labelAr}» يتجاوز الحد الأقصى لطول النص (500 حرف)`);
        }
        return { isEmpty: false, valueText: val, valueNumber: null, valueDate: null, valueBoolean: null };
      }

      case 'number': {
        let numVal: number;
        if (typeof raw === 'number') {
          numVal = raw;
        } else if (typeof raw === 'string' && STRICT_NUMBER_PATTERN.test(raw.trim())) {
          numVal = parseFloat(raw.trim());
        } else {
          throw new ValidationError(`الحقل «${def.labelAr}» يتطلب قيمة رقمية صالحة`);
        }
        if (!Number.isFinite(numVal)) {
          throw new ValidationError(`الحقل «${def.labelAr}» يتطلب قيمة رقمية محدودة صالحة`);
        }
        return { isEmpty: false, valueText: null, valueNumber: numVal, valueDate: null, valueBoolean: null };
      }

      case 'date': {
        if (typeof raw !== 'string' || !isValidCalendarDate(raw.trim())) {
          throw new ValidationError(`الحقل «${def.labelAr}» يتطلب تاريخًا صالحًا بصيغة YYYY-MM-DD`);
        }
        return { isEmpty: false, valueText: null, valueNumber: null, valueDate: raw.trim(), valueBoolean: null };
      }

      case 'boolean': {
        if (typeof raw !== 'boolean') {
          throw new ValidationError(`الحقل «${def.labelAr}» يتطلب قيمة منطقية (true / false)`);
        }
        return { isEmpty: false, valueText: null, valueNumber: null, valueDate: null, valueBoolean: raw };
      }

      case 'select': {
        if (typeof raw !== 'string') {
          throw new ValidationError(`الحقل «${def.labelAr}» يتطلب اختيار قيمة نصية صالحة`);
        }
        const trimmed = raw.trim();
        const opts = def.options || [];
        if (!opts.includes(trimmed)) {
          throw new ValidationError(`قيمة الحقل «${def.labelAr}» (${trimmed}) غير موجودة ضمن الخيارات المعتمدة`);
        }
        return { isEmpty: false, valueText: trimmed, valueNumber: null, valueDate: null, valueBoolean: null };
      }

      default:
        throw new ValidationError(`نوع حقل غير مدعوم: ${def.fieldType}`);
    }
  }

  async validateValuesAgainstDefinitions(
    companyId: string,
    entityType: CustomEntityType,
    entityId: string | null,
    values: CustomFieldValueInput[],
    customExecutor?: DbExecutor
  ): Promise<Array<{ def: CustomFieldDefinition; typed: TypedCustomFieldValue }>> {
    if (!SUPPORTED_ENTITY_TYPES.includes(entityType)) {
      throw new ValidationError(
        `الكيان ${entityType} غير مدعوم في هذه النسخة — الحقول تُدعم حاليًا على الأصناف فقط`
      );
    }

    const list = Array.isArray(values) ? values : [];

    const run = async (tx: DbExecutor) => {
      const allCompanyDefs = await this.repo.listDefinitions(companyId, entityType, true, tx);
      const defsMap = new Map<string, CustomFieldDefinition>(allCompanyDefs.map((d) => [d.id, d]));

      const prepared: Array<{ def: CustomFieldDefinition; typed: TypedCustomFieldValue }> = [];
      const submittedByFieldId = new Map<string, TypedCustomFieldValue>();

      for (const entry of list) {
        if (!entry || typeof entry.fieldId !== 'string' || !entry.fieldId.trim()) {
          throw new ValidationError('كل قيمة حقل إضافي تتطلب fieldId صالحًا');
        }
        const def = defsMap.get(entry.fieldId);
        if (!def) {
          throw new ValidationError(
            `الحقل الإضافي غير موجود في تعريفات هذه الشركة (${entry.fieldId})`
          );
        }
        if (!def.isActive) {
          throw new ValidationError(`الحقل «${def.labelAr}» معطّل ولا يمكن تعديل قيمته`);
        }
        const typed = this.validateValue(def, entry.value);
        prepared.push({ def, typed });
        submittedByFieldId.set(def.id, typed);
      }

      // Check every active required field has a non-empty value (either submitted or previously saved)
      const activeRequired = allCompanyDefs.filter((d) => d.isActive && d.isRequired);
      if (activeRequired.length > 0) {
        const existingRows = entityId
          ? await this.repo.listValuesForEntity(companyId, entityId, tx)
          : [];
        const existingMap = new Map(existingRows.map((r) => [r.fieldId, r]));

        for (const reqDef of activeRequired) {
          const sub = submittedByFieldId.get(reqDef.id);
          if (sub) {
            // Already validated above: if empty, validateValue threw ValidationError
            continue;
          }
          const prevRow = existingMap.get(reqDef.id);
          const prevVal = extractTypedValue(reqDef.fieldType, prevRow);
          if (prevVal === null || prevVal === '') {
            throw new ValidationError(`الحقل «${reqDef.labelAr}» إلزامي`);
          }
        }
      }

      return prepared;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async setValues(
    companyId: string,
    entityId: string,
    values: CustomFieldValueInput[],
    actorId?: string,
    entityType: CustomEntityType = 'item',
    customExecutor?: DbExecutor
  ): Promise<CustomFieldValueRecord[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!entityId || !isUuid(entityId)) {
      throw new ValidationError('entityId غير صالح');
    }
    if (!Array.isArray(values)) {
      throw new ValidationError('مصفوفة قيم الحقول الإضافية مطلوبة');
    }

    const run = async (tx: DbExecutor) => {
      const prepared = await this.validateValuesAgainstDefinitions(
        companyId,
        entityType,
        entityId,
        values,
        tx
      );

      for (const item of prepared) {
        await this.repo.upsertValue(companyId, item.def.id, entityId, item.typed, tx);
      }

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTOM_FIELD_VALUES_UPSERT',
          entityType: 'custom_field_values',
          entityId,
          metadata: {
            targetEntityType: entityType,
            fieldCount: prepared.length,
            fieldKeys: prepared.map((p) => p.def.fieldKey),
          },
        },
        { executor: tx }
      );

      return await this.getValues(companyId, entityId, entityType, tx);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async getValues(
    companyId: string,
    entityId: string,
    entityType: CustomEntityType = 'item',
    customExecutor?: DbExecutor
  ): Promise<CustomFieldValueRecord[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!entityId || !isUuid(entityId)) {
      throw new ValidationError('entityId غير صالح');
    }

    const run = async (tx: DbExecutor) => {
      const [defs, rows] = await Promise.all([
        this.repo.listDefinitions(companyId, entityType, true, tx),
        this.repo.listValuesForEntity(companyId, entityId, tx),
      ]);
      const rowMap = new Map(rows.map((r) => [r.fieldId, r]));

      const result: CustomFieldValueRecord[] = [];
      for (const def of defs) {
        const rawRow = rowMap.get(def.id);
        const value = extractTypedValue(def.fieldType, rawRow);
        // Include active definitions OR inactive definitions that still retain a saved value (audit/history)
        if (def.isActive || rawRow !== undefined) {
          result.push({
            fieldId: def.id,
            fieldKey: def.fieldKey,
            labelAr: def.labelAr,
            fieldType: def.fieldType,
            options: def.options,
            value,
            isRequired: def.isRequired,
            isActive: def.isActive,
            sortOrder: def.sortOrder,
            helpText: def.helpText,
          });
        }
      }
      return result;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultCustomFieldService = new CustomFieldService();
