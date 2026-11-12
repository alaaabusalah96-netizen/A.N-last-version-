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
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchemaNode;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface ReferentialChecker {
  (companyId: string, path: string, value: string): Promise<void>;
}

/**
 * أنواع JSON-Schema المدعومة صريحاً.
 * أي نوع برّه القائمة = رفض، مش قبول ضمني.
 */
const SUPPORTED_JSON_TYPES = new Set([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
]);

export class ConfigValidationService {
  validateAgainstSchema(
    content: unknown,
    schema: JsonSchemaNode,
    basePath = 'content'
  ): void {
    if (schema.type && !SUPPORTED_JSON_TYPES.has(schema.type)) {
      throw new ValidationError(
        `${basePath}: نوع مخطط غير مدعوم (${schema.type}). الأنواع المدعومة: ${[...SUPPORTED_JSON_TYPES].join(', ')}`
      );
    }

    if (schema.type && !this.matchesType(content, schema.type)) {
      throw new ValidationError(`${basePath}: النوع غير مطابق للمخطط (متوقع: ${schema.type})`);
    }

    if (Array.isArray(schema.enum) && !schema.enum.includes(content)) {
      throw new ValidationError(`${basePath}: القيمة غير مسموحة (مسموح: ${schema.enum.join(', ')})`);
    }

    if (typeof content === 'string') {
      const str = content as string;
      if (schema.minLength !== undefined && str.length < schema.minLength) {
        throw new ValidationError(`${basePath}: طول القيمة أقل من الحد الأدنى (${schema.minLength})`);
      }
      if (schema.maxLength !== undefined && str.length > schema.maxLength) {
        throw new ValidationError(`${basePath}: طول القيمة أكبر من الحد الأقصى (${schema.maxLength})`);
      }
      if (schema.pattern) {
        let re: RegExp;
        try { re = new RegExp(schema.pattern); }
        catch { throw new ValidationError(`${basePath}: نمط التحقق في المخطط غير صالح (pattern)`); }
        if (!re.test(str)) {
          throw new ValidationError(`${basePath}: القيمة لا تطابق الصيغة المطلوبة (pattern)`);
        }
      }
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

    if (schema.type === 'array' && Array.isArray(content)) {
      if (schema.minItems !== undefined && content.length < schema.minItems) {
        throw new ValidationError(`${basePath}: عدد العناصر أقل من الحد الأدنى (${schema.minItems})`);
      }
      if (schema.maxItems !== undefined && content.length > schema.maxItems) {
        throw new ValidationError(`${basePath}: عدد العناصر أكبر من الحد الأقصى (${schema.maxItems})`);
      }
      if (schema.uniqueItems === true) {
        const seen = new Set(content.map((v: unknown) => JSON.stringify(v)));
        if (seen.size !== content.length) {
          throw new ValidationError(`${basePath}: العناصر مكررة — يجب أن تكون فريدة`);
        }
      }
      if (schema.items) {
        content.forEach((item, i) => this.validateAgainstSchema(item, schema.items!, `${basePath}[${i}]`));
      }
    }
  }

  /**
   * Referential integrity: checks string values that the definition marks as
   * account references (properties ending in `_account_id`) against master data.
   */
  async validateReferences(
    companyId: string,
    content: unknown,
    schema: JsonSchemaNode,
    checkAccount: ReferentialChecker,
    basePath = 'content'
  ): Promise<void> {
    if (content === null || content === undefined) return;

    // المصفوفات: انزل لعناصرها بنفس مخطط items (كانت الفجوة الأساسية)
    if (Array.isArray(content)) {
      const itemSchema = schema?.items ?? { type: 'object' };
      for (let i = 0; i < content.length; i += 1) {
        await this.validateReferences(companyId, content[i], itemSchema, checkAccount, `${basePath}[${i}]`);
      }
      return;
    }

    if (typeof content !== 'object') return;

    const obj = content as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      const path = `${basePath}.${key}`;

      if (key.endsWith('_account_id') && typeof value === 'string' && value.trim() !== '') {
        await checkAccount(companyId, path, value);
        continue;
      }

      const childSchema = schema?.properties?.[key] ?? { type: typeof value === 'object' ? 'object' : 'string' };
      if (value !== null && value !== undefined && typeof value === 'object') {
        await this.validateReferences(companyId, value, childSchema, checkAccount, path);
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
        return typeof value === 'number' && Number.isFinite(value);
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'null':
        return value === null;
      default:
        return false;
    }
  }
}

export const defaultConfigValidationService = new ConfigValidationService();
