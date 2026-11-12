import { describe, it, expect } from 'vitest';
import { ConfigValidationService, JsonSchemaNode } from '../configValidationService.js';
import { ValidationError } from '../../http/errors.js';

describe('ConfigValidationService — extended schema features (WP-1)', () => {
  const validator = new ConfigValidationService();

  it('فحص pattern صالح وغير صالح', () => {
    const schema: JsonSchemaNode = { type: 'string', pattern: '^[0-9a-f-]{36}$' };
    expect(() => validator.validateAgainstSchema('123e4567-e89b-12d3-a456-426614174000', schema)).not.toThrow();
    expect(() => validator.validateAgainstSchema('invalid-uuid', schema)).toThrow(/pattern/);
  });

  it('نمط غير صالح في المخطط نفسه يرمي رسالة عربية بدلاً من السقوط', () => {
    const badSchema: JsonSchemaNode = { type: 'string', pattern: '[' };
    expect(() => validator.validateAgainstSchema('text', badSchema)).toThrow(/نمط التحقق في المخطط غير صالح/);
  });

  it('فحص minLength و maxLength', () => {
    const schema: JsonSchemaNode = { type: 'string', minLength: 3, maxLength: 10 };
    expect(() => validator.validateAgainstSchema('ab', schema)).toThrow(/أقل من الحد الأدنى/);
    expect(() => validator.validateAgainstSchema('12345678901', schema)).toThrow(/أكبر من الحد الأقصى/);
    expect(() => validator.validateAgainstSchema('hello', schema)).not.toThrow();
  });

  it('فحص minItems و maxItems', () => {
    const schema: JsonSchemaNode = { type: 'array', minItems: 2, maxItems: 4 };
    expect(() => validator.validateAgainstSchema([1], schema)).toThrow(/أقل من الحد الأدنى/);
    expect(() => validator.validateAgainstSchema([1, 2, 3, 4, 5], schema)).toThrow(/أكبر من الحد الأقصى/);
    expect(() => validator.validateAgainstSchema([1, 2, 3], schema)).not.toThrow();
  });

  it('فحص uniqueItems', () => {
    const schema: JsonSchemaNode = { type: 'array', uniqueItems: true };
    expect(() => validator.validateAgainstSchema([1, 2, 3], schema)).not.toThrow();
    expect(() => validator.validateAgainstSchema([1, 2, 2], schema)).toThrow(/العناصر مكررة/);
  });
});
