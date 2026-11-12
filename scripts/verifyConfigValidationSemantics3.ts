import fs from 'fs';
import path from 'path';
import { ConfigService } from '../src/server/config-platform/configService.js';
import { ConfigValidationService, JsonSchemaNode } from '../src/server/config-platform/configValidationService.js';
import {
  createAccountRoleChecker,
  validateCrossField,
  GRN_MAPPING_KEY,
} from '../src/server/config-platform/configAccountRoles.js';
import { ValidationError } from '../src/server/http/errors.js';
import { Account } from '../src/server/accounting/accountTypes.js';
import { tenantContextStorage } from '../src/server/db/tenantContext.js';

const dummyExecutor: any = {
  query: async () => ({ rows: [], rowCount: 0 }),
  withTransaction: async (cb: any) => cb(dummyExecutor),
};

function withCtx<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContextStorage.run({ companyId, executor: dummyExecutor }, fn);
}

function makeFakeRepo() {
  const definitions = new Map<string, any>();
  const registry: any[] = [];
  const drafts = new Map<string, any>();
  let publishCallCount = 0;

  return {
    _definitions: definitions,
    _registry: registry,
    _drafts: drafts,
    get publishCallCount() { return publishCallCount; },
    async listDefinitions() {
      return [...definitions.values()];
    },
    async findDefinitionByKey(key: string) {
      return definitions.get(key) || null;
    },
    async listActiveByCompany(companyId: string) {
      return registry.filter((r) => r.companyId === companyId && r.isActive);
    },
    async findActive(companyId: string, definitionId: string) {
      return registry.find((r) => r.companyId === companyId && r.configDefinitionId === definitionId && r.isActive) || null;
    },
    async findVersionByNo(companyId: string, definitionId: string, versionNo: number) {
      return registry.find((r) => r.companyId === companyId && r.configDefinitionId === definitionId && r.versionNo === versionNo) || null;
    },
    async listVersions(companyId: string, definitionId: string) {
      return registry
        .filter((r) => r.companyId === companyId && r.configDefinitionId === definitionId)
        .sort((a, b) => b.versionNo - a.versionNo);
    },
    async insertPublishedVersion(companyId: string, definitionId: string, versionNo: number, content: any, changeSummary: string, publishedBy: string | null) {
      publishCallCount++;
      for (const r of registry) {
        if (r.companyId === companyId && r.configDefinitionId === definitionId) r.isActive = false;
      }
      const row = {
        id: `v-${versionNo}`,
        companyId,
        configDefinitionId: definitionId,
        versionNo,
        isActive: true,
        content,
        changeSummary,
        publishedBy,
        publishedAt: new Date().toISOString(),
      };
      registry.push(row);
      return row;
    },
    async nextVersionNo(companyId: string, definitionId: string) {
      return registry.filter((r) => r.companyId === companyId && r.configDefinitionId === definitionId).length + 1;
    },
    async findDraft(companyId: string, definitionId: string) {
      return drafts.get(`${companyId}:${definitionId}`) || null;
    },
    async upsertDraft(companyId: string, definitionId: string, content: any, status: any, updatedBy: string | null) {
      const row = {
        id: 'draft-1',
        companyId,
        configDefinitionId: definitionId,
        status,
        content,
        updatedBy,
        updatedAt: new Date().toISOString(),
      };
      drafts.set(`${companyId}:${definitionId}`, row);
      return row;
    },
    async deleteDraft(companyId: string, definitionId: string) {
      return drafts.delete(`${companyId}:${definitionId}`);
    },
  } as any;
}

async function run() {
  console.log('=== Verifying Config Validation Semantics & Dry-run (AN-CONFIG-VALIDATION-3) ===');
  let passed = 0;
  let failed = 0;

  function check(name: string, condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${name}: ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name}: ${message}`);
      failed++;
    }
  }

  const validator = new ConfigValidationService();

  // V1: pattern schema rejects invalid string
  const uuidSchema: JsonSchemaNode = { type: 'string', pattern: '^[0-9a-f-]{36}$' };
  try {
    validator.validateAgainstSchema('abc', uuidSchema);
    check('V1', false, 'pattern schema did not reject invalid string');
  } catch (err) {
    check('V1', err instanceof ValidationError && /pattern/.test(err.message), 'pattern schema rejected invalid string');
  }

  // V2: pattern schema accepts valid UUID
  try {
    validator.validateAgainstSchema('123e4567-e89b-12d3-a456-426614174000', uuidSchema);
    check('V2', true, 'pattern schema accepted valid string');
  } catch (err) {
    check('V2', false, `pattern schema rejected valid string: ${err}`);
  }

  // V3: minLength check
  const minLenSchema: JsonSchemaNode = { type: 'string', minLength: 3 };
  try {
    validator.validateAgainstSchema('ab', minLenSchema);
    check('V3', false, 'minLength did not reject short string');
  } catch (err) {
    check('V3', err instanceof ValidationError && /الحد الأدنى/.test(err.message), 'minLength rejected short string');
  }

  // V4: maxItems check
  const maxItemsSchema: JsonSchemaNode = { type: 'array', maxItems: 1 };
  try {
    validator.validateAgainstSchema(['a', 'b'], maxItemsSchema);
    check('V4', false, 'maxItems did not reject oversized array');
  } catch (err) {
    check('V4', err instanceof ValidationError && /الحد الأقصى/.test(err.message), 'maxItems rejected oversized array');
  }

  // V5: uniqueItems check
  const uniqueSchema: JsonSchemaNode = { type: 'array', uniqueItems: true };
  try {
    validator.validateAgainstSchema(['a', 'a'], uniqueSchema);
    check('V5', false, 'uniqueItems did not reject duplicate items');
  } catch (err) {
    check('V5', err instanceof ValidationError && /مكررة/.test(err.message), 'uniqueItems rejected duplicate items');
  }

  // V6: invalid regex pattern throws Arabic error without crash
  const badPatternSchema: JsonSchemaNode = { type: 'string', pattern: '[' };
  try {
    validator.validateAgainstSchema('abc', badPatternSchema);
    check('V6', false, 'bad pattern schema did not throw');
  } catch (err) {
    check('V6', err instanceof ValidationError && /نمط التحقق/.test(err.message), 'invalid pattern throws Arabic ValidationError without crashing');
  }

  // V7: validateCrossField with same account twice
  try {
    validateCrossField(GRN_MAPPING_KEY, { inventory_account_id: 'acc-1', purchases_clearing_account_id: 'acc-1' }, true);
    check('V7', false, 'validateCrossField did not reject identical accounts');
  } catch (err) {
    check('V7', err instanceof ValidationError && /نفس الحساب/.test(err.message), 'validateCrossField rejected identical accounts');
  }

  // V8: validateCrossField in publish mode with empty field
  try {
    validateCrossField(GRN_MAPPING_KEY, { inventory_account_id: 'acc-1', purchases_clearing_account_id: '' }, true);
    check('V8', false, 'validateCrossField did not reject empty field in publish mode');
  } catch (err) {
    check('V8', err instanceof ValidationError && /غير مكتمل/.test(err.message), 'validateCrossField rejected empty field in publish mode');
  }

  // V9: validateCrossField with two different valid accounts
  try {
    validateCrossField(GRN_MAPPING_KEY, { inventory_account_id: 'acc-1', purchases_clearing_account_id: 'acc-2' }, true);
    check('V9', true, 'validateCrossField accepted two distinct valid accounts');
  } catch (err) {
    check('V9', false, `validateCrossField unexpectedly rejected distinct accounts: ${err}`);
  }

  // V10-V12: ConfigService.validateContent dry-run testing
  const C = 'company-test-1';
  const ACCOUNTS: Record<string, Account> = {
    'inv-ok':  { id: 'inv-ok',  companyId: C, code: '1300', nameAr: 'مخزون', nameEn: null, accountType: 'asset', parentId: null, isPostable: true, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    'inv-head':{ id: 'inv-head',companyId: C, code: '1000', nameAr: 'الأصول', nameEn: null, accountType: 'asset', parentId: null, isPostable: false, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    'clr-ok':  { id: 'clr-ok',  companyId: C, code: '2150', nameAr: 'مشتريات معلقة', nameEn: null, accountType: 'liability', parentId: null, isPostable: true, isActive: true, createdAt: new Date(), updatedAt: new Date() },
  };

  const lookup = async (_cid: string, id: string) => ACCOUNTS[id] || null;
  const fake = makeFakeRepo();
  fake._definitions.set(GRN_MAPPING_KEY, {
    id: 'def-1',
    key: GRN_MAPPING_KEY,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inventory_account_id: { type: 'string' },
        purchases_clearing_account_id: { type: 'string' },
      },
      required: ['inventory_account_id', 'purchases_clearing_account_id'],
    },
    defaultValue: { inventory_account_id: 'inv-ok', purchases_clearing_account_id: 'clr-ok' },
  });

  const svc = new ConfigService(
    fake,
    validator,
    (key: string) => createAccountRoleChecker(key, lookup)
  );

  await withCtx(C, async () => {
    // V10: validateContent with valid content -> ok === true
    const v10 = await svc.validateContent(C, GRN_MAPPING_KEY, { inventory_account_id: 'inv-ok', purchases_clearing_account_id: 'clr-ok' });
    check('V10', v10.ok === true, 'validateContent returns ok === true for valid content');

    // V11: validateContent with header account -> ok === false
    const v11 = await svc.validateContent(C, GRN_MAPPING_KEY, { inventory_account_id: 'inv-head', purchases_clearing_account_id: 'clr-ok' });
    check('V11', v11.ok === false && !!v11.message && v11.message.includes('قابلاً للترحيل'), 'validateContent returns ok === false and error message for non-postable account');

    // V12: validateContent does NOT write to database
    check('V12', fake.publishCallCount === 0 && fake._registry.length === 0, 'validateContent is completely read-only and performed zero DB writes');
  });

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
