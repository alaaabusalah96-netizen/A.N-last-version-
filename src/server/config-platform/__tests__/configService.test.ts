import { describe, it, expect, vi } from 'vitest';
import { ConfigValidationService, JsonSchemaNode } from '../configValidationService.js';
import { ConfigService } from '../configService.js';
import { ValidationError, NotFoundError, ConflictError } from '../../http/errors.js';
import * as transactionManager from '../../db/transactionManager.js';

// Mock only the DB boundary: run the service callback against a throwaway executor.
// The fake repository below ignores the executor, so the real service logic
// (validation gates, versioning, pointer flips) is what gets exercised.
vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((_companyId: string, fn: (ex: any) => Promise<any>) =>
    fn({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })
  ),
}));

const validation = new ConfigValidationService();

describe('ConfigValidationService (A4) — structural integrity', () => {
  const schema: JsonSchemaNode = {
    type: 'object',
    additionalProperties: false,
    properties: {
      inventory_account_id: { type: 'string' },
      purchases_clearing_account_id: { type: 'string' },
      threshold: { type: 'number', minimum: 0, maximum: 100 },
    },
    required: ['inventory_account_id', 'purchases_clearing_account_id'],
  };

  it('accepts valid content', () => {
    expect(() =>
      validation.validateAgainstSchema(
        { inventory_account_id: 'a', purchases_clearing_account_id: 'b', threshold: 5 },
        schema
      )
    ).not.toThrow();
  });

  it('rejects missing required field (Arabic error)', () => {
    expect(() => validation.validateAgainstSchema({ inventory_account_id: 'a' }, schema))
      .toThrow(/حقل إلزامي مفقود/);
  });

  it('rejects unknown field when additionalProperties=false', () => {
    expect(() =>
      validation.validateAgainstSchema(
        { inventory_account_id: 'a', purchases_clearing_account_id: 'b', evil: 'x' },
        schema
      )
    ).toThrow(/حقل غير معرف/);
  });

  it('rejects wrong type', () => {
    expect(() =>
      validation.validateAgainstSchema(
        { inventory_account_id: 5, purchases_clearing_account_id: 'b' },
        schema
      )
    ).toThrow(/النوع غير مطابق/);
  });

  it('rejects out-of-range number', () => {
    expect(() =>
      validation.validateAgainstSchema(
        { inventory_account_id: 'a', purchases_clearing_account_id: 'b', threshold: 150 },
        schema
      )
    ).toThrow(/الحد الأقصى/);
  });
});

function makeFakeRepo() {
  const definitions = new Map<string, any>();
  const registry: any[] = [];
  const drafts = new Map<string, any>();

  return {
    _definitions: definitions,
    _registry: registry,
    _drafts: drafts,
    async listDefinitions() {
      return [...definitions.values()];
    },
    async findDefinitionByKey(key: string) {
      return definitions.get(key) || null;
    },
    async insertDefinition(input: any) {
      const row = {
        id: `def-${definitions.size + 1}`,
        key: input.key,
        domain: input.domain,
        labelAr: input.labelAr ?? null,
        isSystem: Boolean(input.isSystem),
        schema: input.schema,
        defaultValue: input.defaultValue,
        description: input.description ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      definitions.set(input.key, row);
      return row;
    },
    async updateDefinitionMeta(key: string, input: any) {
      const existing = definitions.get(key);
      if (!existing) throw new NotFoundError('not found');
      const updated = {
        ...existing,
        labelAr: input.labelAr !== undefined ? input.labelAr : existing.labelAr,
        description: input.description !== undefined ? input.description : existing.description,
        domain: input.domain !== undefined ? input.domain : existing.domain,
        updatedAt: new Date().toISOString(),
      };
      definitions.set(key, updated);
      return updated;
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

const GRN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    inventory_account_id: { type: 'string' },
    purchases_clearing_account_id: { type: 'string' },
  },
  required: ['inventory_account_id', 'purchases_clearing_account_id'],
};

function makeService(fakeRepo: any) {
  const knownAccounts = new Set(['acc-1', 'acc-2', 'acc-9', 'a', 'b']);
  const checker = async (_cid: string, path: string, value: string) => {
    if (!knownAccounts.has(value)) {
      throw new ValidationError(`${path}: الحساب المحاسبي المشار إليه غير موجود`);
    }
  };
  return new ConfigService(fakeRepo, validation, () => checker);
}

describe('ConfigService (A2/A3) — Draft → Publish → Rollback lifecycle', () => {
  const C = '11111111-1111-1111-1111-111111111111';

  function seed(fakeRepo: any) {
    fakeRepo._definitions.set('accounting.grn_mapping', {
      id: 'def-1',
      key: 'accounting.grn_mapping',
      schema: GRN_SCHEMA,
      defaultValue: { inventory_account_id: '', purchases_clearing_account_id: '' },
      description: null,
      createdAt: '',
      updatedAt: '',
    });
  }

  it('saveDraft rejects non-object content', async () => {
    const fake = makeFakeRepo();
    seed(fake);
    const svc = makeService(fake);
    await expect(
      svc.saveDraft(C, 'accounting.grn_mapping', { content: [1, 2] as any }, 'user-1')
    ).rejects.toThrow(ValidationError);
  });

  it('saveDraft rejects content violating schema (extra field)', async () => {
    const fake = makeFakeRepo();
    seed(fake);
    const svc = makeService(fake);
    await expect(
      svc.saveDraft(C, 'accounting.grn_mapping', { content: { inventory_account_id: 'a', rogue: 1 } }, 'user-1')
    ).rejects.toThrow(ValidationError);
  });

  it('publishDraft requires changeSummary (audit discipline)', async () => {
    const fake = makeFakeRepo();
    seed(fake);
    const svc = makeService(fake);
    await fake.upsertDraft(C, 'def-1', { inventory_account_id: 'a', purchases_clearing_account_id: 'b' }, 'draft', 'u');
    await expect(
      svc.publishDraft(C, 'accounting.grn_mapping', { changeSummary: '   ' }, 'user-1')
    ).rejects.toThrow(ValidationError);
  });

  it('publishDraft without draft → NotFound', async () => {
    const fake = makeFakeRepo();
    seed(fake);
    const svc = makeService(fake);
    await expect(
      svc.publishDraft(C, 'accounting.grn_mapping', { changeSummary: 'x' }, 'user-1')
    ).rejects.toThrow(NotFoundError);
  });

  it('publishDraft with unknown account reference → ValidationError (A4 referential gate)', async () => {
    const fake = makeFakeRepo();
    seed(fake);
    const svc = makeService(fake);
    await svc.saveDraft(C, 'accounting.grn_mapping', { content: { inventory_account_id: 'ghost', purchases_clearing_account_id: 'b' } }, 'user-1');
    await expect(
      svc.publishDraft(C, 'accounting.grn_mapping', { changeSummary: 'bad ref' }, 'user-1')
    ).rejects.toThrow(ValidationError);
  });

  it('full lifecycle: publish v1, publish v2, rollback to v1 as v3 — draft cleared, is_active flips', async () => {
    const fake = makeFakeRepo();
    seed(fake);
    const svc = makeService(fake);

    // v1
    await svc.saveDraft(C, 'accounting.grn_mapping', { content: { inventory_account_id: 'acc-1', purchases_clearing_account_id: 'acc-2' } }, 'user-1');
    const v1 = await svc.publishDraft(C, 'accounting.grn_mapping', { changeSummary: 'initial mapping' }, 'user-1');
    expect(v1.versionNo).toBe(1);
    expect(v1.isActive).toBe(true);
    expect(await fake.findDraft(C, 'def-1')).toBeNull();

    // v2
    await svc.saveDraft(C, 'accounting.grn_mapping', { content: { inventory_account_id: 'acc-9', purchases_clearing_account_id: 'acc-2' } }, 'user-1');
    const v2 = await svc.publishDraft(C, 'accounting.grn_mapping', { changeSummary: 'switch inventory account' }, 'user-1');
    expect(v2.versionNo).toBe(2);
    expect(v1.isActive).toBe(false);
    expect(v2.isActive).toBe(true);

    // rollback to v1 → creates v3 (never un-publish)
    const v3 = await svc.rollback(C, 'accounting.grn_mapping', { targetVersionNo: 1, changeSummary: 'revert' }, 'user-1');
    expect(v3.versionNo).toBe(3);
    expect(v3.content).toEqual(v1.content);
    expect(v3.changeSummary).toContain('rollback to v1');
    expect(v2.isActive).toBe(false);
    expect(v3.isActive).toBe(true);

    // resolution returns published content
    const resolved = await svc.resolveConfig(C, 'accounting.grn_mapping');
    expect(resolved.source).toBe('company_published');
    expect(resolved.versionNo).toBe(3);
  });

  it('rollback to already-active version → Conflict', async () => {
    const fake = makeFakeRepo();
    seed(fake);
    const svc = makeService(fake);
    await svc.saveDraft(C, 'accounting.grn_mapping', { content: { inventory_account_id: 'a', purchases_clearing_account_id: 'b' } }, 'user-1');
    await svc.publishDraft(C, 'accounting.grn_mapping', { changeSummary: 'v1' }, 'user-1');
    await expect(
      svc.rollback(C, 'accounting.grn_mapping', { targetVersionNo: 1, changeSummary: 'noop' }, 'user-1')
    ).rejects.toThrow(ConflictError);
  });

  it('resolveConfig falls back to platform default when nothing published', async () => {
    const fake = makeFakeRepo();
    seed(fake);
    const svc = makeService(fake);
    const resolved = await svc.resolveConfig(C, 'accounting.grn_mapping');
    expect(resolved.source).toBe('platform_default');
    expect(resolved.versionNo).toBeNull();
    expect(resolved.content).toEqual({ inventory_account_id: '', purchases_clearing_account_id: '' });
  });

  it('unknown definition key → NotFound', async () => {
    const fake = makeFakeRepo();
    seed(fake);
    const svc = makeService(fake);
    await expect(svc.resolveConfig(C, 'nope.nope')).rejects.toThrow(NotFoundError);
  });
});

describe('ConfigService (AN-CONFIG-CENTER-4) — Definition Catalog Management', () => {
  it('createDefinition accepts valid key, schema, and matching defaultValue', async () => {
    const fake = makeFakeRepo();
    const svc = makeService(fake);
    const def = await svc.createDefinition({
      key: 'inventory.valuation_method',
      domain: 'inventory',
      labelAr: 'طريقة التقييم',
      schema: { type: 'object', properties: { method: { type: 'string' } }, required: ['method'] },
      defaultValue: { method: 'FIFO' },
      isSystem: false,
    }, 'admin-1');
    expect(def.key).toBe('inventory.valuation_method');
    expect(def.domain).toBe('inventory');
    expect(def.isSystem).toBe(false);
  });

  it('createDefinition rejects malformed key format', async () => {
    const fake = makeFakeRepo();
    const svc = makeService(fake);
    await expect(
      svc.createDefinition({
        key: 'BadKey',
        domain: 'general',
        schema: { type: 'object', properties: {} },
        defaultValue: {},
      }, 'admin-1')
    ).rejects.toThrow(ValidationError);
  });

  it('createDefinition rejects duplicate key', async () => {
    const fake = makeFakeRepo();
    fake._definitions.set('accounting.grn_mapping', {
      id: 'def-1',
      key: 'accounting.grn_mapping',
      domain: 'accounting',
      labelAr: 'GRN',
      isSystem: true,
      schema: GRN_SCHEMA,
      defaultValue: { inventory_account_id: '', purchases_clearing_account_id: '' },
      description: null,
      createdAt: '',
      updatedAt: '',
    });
    const svc = makeService(fake);
    await expect(
      svc.createDefinition({
        key: 'accounting.grn_mapping',
        domain: 'accounting',
        schema: { type: 'object', properties: {} },
        defaultValue: {},
      }, 'admin-1')
    ).rejects.toThrow(/موجود/);
  });

  it('createDefinition rejects defaultValue violating schema', async () => {
    const fake = makeFakeRepo();
    const svc = makeService(fake);
    await expect(
      svc.createDefinition({
        key: 'inventory.batch_mode',
        domain: 'inventory',
        schema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
        defaultValue: { enabled: 'not-a-boolean' },
      }, 'admin-1')
    ).rejects.toThrow(ValidationError);
  });

  it('updateDefinitionMeta rejects changing schema or key or defaultValue after creation', async () => {
    const fake = makeFakeRepo();
    const svc = makeService(fake);
    await svc.createDefinition({
      key: 'inventory.valuation_method',
      domain: 'inventory',
      schema: { type: 'object', properties: { method: { type: 'string' } } },
      defaultValue: { method: 'FIFO' },
    }, 'admin-1');

    await expect(
      svc.updateDefinitionMeta('inventory.valuation_method', { schema: { type: 'object' } } as any, 'admin-1')
    ).rejects.toThrow(/غير قابل للتعديل/);
  });

  it('archiveDefinition always throws ValidationError (audit integrity)', async () => {
    const fake = makeFakeRepo();
    const svc = makeService(fake);
    await expect(svc.archiveDefinition('system.general')).rejects.toThrow(/غير مسموح/);
  });
});
