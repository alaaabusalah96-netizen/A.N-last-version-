import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import {
  CustomEntityType,
  CustomFieldDefinition,
  CustomFieldType,
  TypedCustomFieldValue,
} from './customFieldTypes.js';

interface RawDefinitionRow {
  id: string;
  companyId: string;
  entityType: CustomEntityType;
  fieldKey: string;
  labelAr: string;
  fieldType: CustomFieldType;
  options: unknown;
  isRequired: boolean;
  isActive: boolean;
  sortOrder: number;
  helpText: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RawValueRow {
  id: string;
  companyId: string;
  fieldId: string;
  entityId: string;
  valueText: string | null;
  valueNumber: string | number | null;
  valueDate: string | null;
  valueBoolean: boolean | null;
  updatedAt: string;
}

function mapDefinition(r: RawDefinitionRow): CustomFieldDefinition {
  return {
    id: r.id,
    companyId: r.companyId,
    entityType: r.entityType,
    fieldKey: r.fieldKey,
    labelAr: r.labelAr,
    fieldType: r.fieldType,
    options: Array.isArray(r.options) ? r.options.map((x) => String(x)) : null,
    isRequired: Boolean(r.isRequired),
    isActive: Boolean(r.isActive),
    sortOrder: typeof r.sortOrder === 'number' ? r.sortOrder : parseInt(String(r.sortOrder || 0), 10),
    helpText: r.helpText ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function extractTypedValue(
  fieldType: CustomFieldType,
  row: RawValueRow | undefined
): string | number | boolean | null {
  if (!row) return null;
  switch (fieldType) {
    case 'text':
    case 'select':
      return row.valueText ?? null;
    case 'number':
      if (row.valueNumber === null || row.valueNumber === undefined) return null;
      return typeof row.valueNumber === 'number' ? row.valueNumber : parseFloat(String(row.valueNumber));
    case 'date':
      return row.valueDate ? String(row.valueDate).slice(0, 10) : null;
    case 'boolean':
      return row.valueBoolean === null || row.valueBoolean === undefined ? null : Boolean(row.valueBoolean);
    default:
      return null;
  }
}

const DEF_COLUMNS = `
  id,
  company_id as "companyId",
  entity_type as "entityType",
  field_key as "fieldKey",
  label_ar as "labelAr",
  field_type as "fieldType",
  options,
  is_required as "isRequired",
  is_active as "isActive",
  sort_order as "sortOrder",
  help_text as "helpText",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

export class CustomFieldRepository {
  async listDefinitions(
    companyId: string,
    entityType?: CustomEntityType,
    includeInactive = false,
    customExecutor?: DbExecutor
  ): Promise<CustomFieldDefinition[]> {
    const run = async (executor: DbExecutor) => {
      const conditions = ['company_id = $1'];
      const params: unknown[] = [companyId];
      let idx = 2;
      if (entityType) {
        conditions.push(`entity_type = $${idx++}`);
        params.push(entityType);
      }
      if (!includeInactive) {
        conditions.push('is_active = true');
      }
      const sql = `
        SELECT ${DEF_COLUMNS}
        FROM custom_field_definitions
        WHERE ${conditions.join(' AND ')}
        ORDER BY sort_order ASC, created_at ASC
      `;
      const res = await executor.query<RawDefinitionRow>(sql, params);
      return res.rows.map(mapDefinition);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findDefinitionById(
    companyId: string,
    fieldId: string,
    customExecutor?: DbExecutor
  ): Promise<CustomFieldDefinition | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT ${DEF_COLUMNS}
        FROM custom_field_definitions
        WHERE company_id = $1 AND id = $2
      `;
      const res = await executor.query<RawDefinitionRow>(sql, [companyId, fieldId]);
      return res.rows[0] ? mapDefinition(res.rows[0]) : null;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findDefinitionByKey(
    companyId: string,
    entityType: CustomEntityType,
    fieldKey: string,
    customExecutor?: DbExecutor
  ): Promise<CustomFieldDefinition | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT ${DEF_COLUMNS}
        FROM custom_field_definitions
        WHERE company_id = $1 AND entity_type = $2 AND field_key = $3
      `;
      const res = await executor.query<RawDefinitionRow>(sql, [companyId, entityType, fieldKey]);
      return res.rows[0] ? mapDefinition(res.rows[0]) : null;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async createDefinition(
    companyId: string,
    data: {
      entityType: CustomEntityType;
      fieldKey: string;
      labelAr: string;
      fieldType: CustomFieldType;
      options: string[] | null;
      isRequired: boolean;
      isActive: boolean;
      sortOrder: number;
      helpText: string | null;
    },
    customExecutor?: DbExecutor
  ): Promise<CustomFieldDefinition> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO custom_field_definitions (
          company_id, entity_type, field_key, label_ar, field_type, options,
          is_required, is_active, sort_order, help_text
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
        RETURNING ${DEF_COLUMNS}
      `;
      const res = await executor.query<RawDefinitionRow>(sql, [
        companyId,
        data.entityType,
        data.fieldKey,
        data.labelAr,
        data.fieldType,
        data.options ? JSON.stringify(data.options) : null,
        data.isRequired,
        data.isActive,
        data.sortOrder,
        data.helpText,
      ]);
      return mapDefinition(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async updateDefinition(
    companyId: string,
    fieldId: string,
    data: {
      labelAr?: string;
      options?: string[] | null;
      isRequired?: boolean;
      isActive?: boolean;
      sortOrder?: number;
      helpText?: string | null;
    },
    customExecutor?: DbExecutor
  ): Promise<CustomFieldDefinition | null> {
    const run = async (executor: DbExecutor) => {
      const sets: string[] = ['updated_at = NOW()'];
      const params: unknown[] = [companyId, fieldId];
      let idx = 3;

      if (data.labelAr !== undefined) {
        sets.push(`label_ar = $${idx++}`);
        params.push(data.labelAr);
      }
      if (data.options !== undefined) {
        sets.push(`options = $${idx++}::jsonb`);
        params.push(data.options ? JSON.stringify(data.options) : null);
      }
      if (data.isRequired !== undefined) {
        sets.push(`is_required = $${idx++}`);
        params.push(data.isRequired);
      }
      if (data.isActive !== undefined) {
        sets.push(`is_active = $${idx++}`);
        params.push(data.isActive);
      }
      if (data.sortOrder !== undefined) {
        sets.push(`sort_order = $${idx++}`);
        params.push(data.sortOrder);
      }
      if (data.helpText !== undefined) {
        sets.push(`help_text = $${idx++}`);
        params.push(data.helpText);
      }

      const sql = `
        UPDATE custom_field_definitions
        SET ${sets.join(', ')}
        WHERE company_id = $1 AND id = $2
        RETURNING ${DEF_COLUMNS}
      `;
      const res = await executor.query<RawDefinitionRow>(sql, params);
      return res.rows[0] ? mapDefinition(res.rows[0]) : null;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async setDefinitionActive(
    companyId: string,
    fieldId: string,
    isActive: boolean,
    customExecutor?: DbExecutor
  ): Promise<CustomFieldDefinition | null> {
    return await this.updateDefinition(companyId, fieldId, { isActive }, customExecutor);
  }

  async listValuesForEntity(
    companyId: string,
    entityId: string,
    customExecutor?: DbExecutor
  ): Promise<RawValueRow[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          id,
          company_id as "companyId",
          field_id as "fieldId",
          entity_id as "entityId",
          value_text as "valueText",
          value_number as "valueNumber",
          value_date::text as "valueDate",
          value_boolean as "valueBoolean",
          updated_at as "updatedAt"
        FROM custom_field_values
        WHERE company_id = $1 AND entity_id = $2
      `;
      const res = await executor.query<RawValueRow>(sql, [companyId, entityId]);
      return res.rows;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async countOutOfOptionsValues(
    companyId: string,
    fieldId: string,
    allowedOptions: string[],
    customExecutor?: DbExecutor
  ): Promise<number> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT COUNT(*)::int as cnt
        FROM custom_field_values
        WHERE company_id = $1
          AND field_id = $2
          AND value_text IS NOT NULL
          AND NOT (value_text = ANY($3::text[]))
      `;
      const res = await executor.query<{ cnt: number }>(sql, [companyId, fieldId, allowedOptions]);
      return res.rows[0]?.cnt || 0;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async upsertValue(
    companyId: string,
    fieldId: string,
    entityId: string,
    typed: TypedCustomFieldValue,
    customExecutor?: DbExecutor
  ): Promise<void> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO custom_field_values (
          company_id, field_id, entity_id,
          value_text, value_number, value_date, value_boolean, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::date, $7, NOW())
        ON CONFLICT (company_id, field_id, entity_id)
        DO UPDATE SET
          value_text = EXCLUDED.value_text,
          value_number = EXCLUDED.value_number,
          value_date = EXCLUDED.value_date,
          value_boolean = EXCLUDED.value_boolean,
          updated_at = NOW()
      `;
      await executor.query(sql, [
        companyId,
        fieldId,
        entityId,
        typed.valueText,
        typed.valueNumber,
        typed.valueDate,
        typed.valueBoolean,
      ]);
    };
    if (customExecutor) {
      await run(customExecutor);
      return;
    }
    await withTenantTransaction(companyId, run);
  }
}

export const defaultCustomFieldRepository = new CustomFieldRepository();
