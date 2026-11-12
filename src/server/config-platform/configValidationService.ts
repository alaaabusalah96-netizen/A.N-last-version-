import { ValidationError } from '../http/errors.js';

/**
 * A4 — Validation Engine (metadata-driven, no eval / no user code).
 * Structural integrity: JSON-Schema subset (type, properties, required,
 * additionalProperties, enum, minimum/maximum). Referential integrity:
 * pluggable master-data checks (accounts).
 */

export interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaNode;
}

export interface ReferentialChecker {
  (companyId: string, path: string, value: string): Promise<void>;
}

export class ConfigValidationService {
  validateAgainstSchema(
    content: Record<string, unknown>,
    schema: JsonSchemaNode,
    basePath = 'content'
  ): void {
    if (schema.type && !this.matchesType(content, schema.type)) {
      throw new ValidationError(`${basePath}: النوع غير مطابق للمخطط (متوقع: ${schema.type})`);
    }

    if (Array.isArray(schema.enum) && !schema.enum.includes(content)) {
      throw new ValidationError(`${basePath}: القيمة غير مسموحة (مسموح: ${schema.enum.join(', ')})`);
    }

    if (typeof content === 'number' && schema.minimum !== undefined && content < schema.minimum) {
      throw new ValidationError(`${basePath}: القيمة أقل من الحد الأدنى (${schema.minimum})`);
    }
    if (typeof content === 'number' && schema.maximum !== undefined && content > schema.maximum) {
      throw new ValidationError(`${basePath}: القيمة أكبر من الحد الأقصى (${schema.maximum})`);
    }

    if (schema.type === 'object' && content && typeof content === 'object' && !Array.isArray(content)) {
      const obj = content as Record<string, unknown>;
      const props = schema.properties || {};
      const additionalAllowed = schema.additionalProperties !== false;

      for (const req of schema.required || []) {
        if (!(req in obj)) {
          throw new ValidationError(`${basePath}.${req}: حقل إلزامي مفقود`);
        }
      }

      if (!additionalAllowed) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) {
            throw new ValidationError(`${basePath}.${key}: حقل غير معرف في المخطط ولا مسموح (additionalProperties=false)`);
          }
        }
      }

      for (const [key, childSchema] of Object.entries(props)) {
        if (key in obj) {
          this.validateAgainstSchema(obj[key] as Record<string, unknown>, childSchema as JsonSchemaNode, `${basePath}.${key}`);
        }
      }
    }

    if (schema.type === 'array' && Array.isArray(content) && schema.items) {
      content.forEach((item, i) => this.validateAgainstSchema(item, schema.items!, `${basePath}[${i}]`));
    }
  }

  /**
   * Referential integrity: checks string values that the definition marks as
   * account references (properties ending in `_account_id`) against master data.
   */
  async validateReferences(
    companyId: string,
    content: Record<string, unknown>,
    schema: JsonSchemaNode,
    checkAccount: ReferentialChecker,
    basePath = 'content'
  ): Promise<void> {
    if (!content || typeof content !== 'object' || Array.isArray(content)) return;

    for (const [key, value] of Object.entries(content)) {
      const path = `${basePath}.${key}`;
      if (key.endsWith('_account_id') && typeof value === 'string' && value.trim() !== '') {
        await checkAccount(companyId, path, value);
        continue;
      }
      const childSchema = schema.properties?.[key];
      if (childSchema && value && typeof value === 'object') {
        await this.validateReferences(companyId, value as Record<string, unknown>, childSchema, checkAccount, path);
      }
    }
  }

  private matchesType(value: unknown, type: string): boolean {
    switch (type) {
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'array':
        return Array.isArray(value);
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      default:
        return true;
    }
  }
}

export const defaultConfigValidationService = new ConfigValidationService();
