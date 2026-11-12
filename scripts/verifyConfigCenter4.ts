import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { ConfigService } from '../src/server/config-platform/configService.js';
import { ValidationError, NotFoundError } from '../src/server/http/errors.js';
import { ConfigDefinition, CreateDefinitionInput } from '../src/server/config-platform/configTypes.js';
import { DbExecutor } from '../src/server/db/types.js';

class MockConfigRepository {
  private defs: Map<string, ConfigDefinition> = new Map();

  constructor() {
    this.defs.set('system.general', {
      id: 'def-1',
      key: 'system.general',
      domain: 'system',
      labelAr: 'إعدادات عامة',
      isSystem: true,
      schema: { type: 'object', properties: { site_name: { type: 'string' } } },
      defaultValue: { site_name: 'A.N ERP' },
      description: 'General system settings',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    this.defs.set('accounting.grn_mapping', {
      id: 'def-2',
      key: 'accounting.grn_mapping',
      domain: 'accounting',
      labelAr: 'ربط استلام البضائع بالدليل',
      isSystem: true,
      schema: {
        type: 'object',
        properties: {
          inventory_account_id: { type: 'string' },
          purchases_clearing_account_id: { type: 'string' },
        },
      },
      defaultValue: { inventory_account_id: '', purchases_clearing_account_id: '' },
      description: 'GRN accounts mapping',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async listDefinitions(_executor?: DbExecutor): Promise<ConfigDefinition[]> {
    return Array.from(this.defs.values());
  }

  async findDefinitionByKey(key: string, _executor?: DbExecutor): Promise<ConfigDefinition | null> {
    return this.defs.get(key) || null;
  }

  async insertDefinition(input: CreateDefinitionInput, _executor?: DbExecutor): Promise<ConfigDefinition> {
    const id = `def-${Date.now()}`;
    const def: ConfigDefinition = {
      id,
      key: input.key,
      domain: input.domain,
      labelAr: input.labelAr || null,
      isSystem: Boolean(input.isSystem),
      schema: input.schema,
      defaultValue: input.defaultValue,
      description: input.description || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.defs.set(input.key, def);
    return def;
  }

  async updateDefinitionMeta(key: string, input: { labelAr?: string | null; description?: string | null; domain?: string }, _executor?: DbExecutor): Promise<ConfigDefinition> {
    const existing = this.defs.get(key);
    if (!existing) throw new NotFoundError('Not found');
    const updated: ConfigDefinition = {
      ...existing,
      labelAr: input.labelAr !== undefined ? (input.labelAr ?? null) : existing.labelAr,
      description: input.description !== undefined ? (input.description ?? null) : existing.description,
      domain: input.domain !== undefined ? input.domain : existing.domain,
      updatedAt: new Date().toISOString(),
    };
    this.defs.set(key, updated);
    return updated;
  }
}

async function runTests() {
  console.log('==================================================');
  console.log('=== VERIFYING AN-CONFIG-CENTER-4 (Catalog Mgmt) ===');
  console.log('==================================================');

  let passed = 0;
  let failed = 0;

  const mockRepo = new MockConfigRepository() as any;
  const service = new ConfigService(mockRepo);
  const actorId = 'user-admin-123';

  // C1: createDefinition key 'BadKey' -> ValidationError
  try {
    await service.createDefinition({
      key: 'BadKey',
      domain: 'general',
      schema: { type: 'object', properties: {} },
      defaultValue: {},
    }, actorId);
    console.error('C1 FAIL: expected ValidationError for BadKey');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('C1 PASS: BadKey rejected with ValidationError');
      passed++;
    } else {
      console.error('C1 FAIL: unexpected error type:', err);
      failed++;
    }
  }

  // C2: duplicate key 'accounting.grn_mapping' -> ValidationError /موجود/
  try {
    await service.createDefinition({
      key: 'accounting.grn_mapping',
      domain: 'accounting',
      schema: { type: 'object', properties: {} },
      defaultValue: {},
    }, actorId);
    console.error('C2 FAIL: expected ValidationError for duplicate key');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError && /موجود/.test(err.message)) {
      console.log('C2 PASS: duplicate key rejected with ValidationError (/موجود/)');
      passed++;
    } else {
      console.error('C2 FAIL: unexpected error:', err);
      failed++;
    }
  }

  // C3: defaultValue invalid against schema -> ValidationError
  try {
    await service.createDefinition({
      key: 'inventory.valuation',
      domain: 'inventory',
      schema: { type: 'object', properties: { method: { type: 'string' } }, required: ['method'] },
      defaultValue: { wrong_field: 123 },
    }, actorId);
    console.error('C3 FAIL: expected ValidationError for invalid defaultValue against schema');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('C3 PASS: invalid defaultValue rejected with ValidationError');
      passed++;
    } else {
      console.error('C3 FAIL: unexpected error type:', err);
      failed++;
    }
  }

  // C4: valid create -> returns definition with domain and isSystem=false
  try {
    const newDef = await service.createDefinition({
      key: 'inventory.valuation_method',
      domain: 'inventory',
      labelAr: 'طريقة تقييم المخزون',
      schema: { type: 'object', properties: { method: { type: 'string' } } },
      defaultValue: { method: 'FIFO' },
      isSystem: false,
    }, actorId);

    assert.strictEqual(newDef.key, 'inventory.valuation_method');
    assert.strictEqual(newDef.domain, 'inventory');
    assert.strictEqual(newDef.isSystem, false);
    assert.strictEqual(newDef.labelAr, 'طريقة تقييم المخزون');
    console.log('C4 PASS: valid definition created with domain and isSystem=false');
    passed++;
  } catch (err) {
    console.error('C4 FAIL:', err);
    failed++;
  }

  // C5: updateDefinitionMeta attempting to change schema -> ValidationError /غير قابل للتعديل/
  try {
    await service.updateDefinitionMeta('inventory.valuation_method', {
      schema: { type: 'object', properties: { method: { type: 'number' } } },
    } as any, actorId);
    console.error('C5 FAIL: expected ValidationError when attempting to modify schema');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError && /غير قابل للتعديل/.test(err.message)) {
      console.log('C5 PASS: schema modification rejected with ValidationError (/غير قابل للتعديل/)');
      passed++;
    } else {
      console.error('C5 FAIL: unexpected error:', err);
      failed++;
    }
  }

  // C6: updateDefinitionMeta changing labelAr -> succeeds and updates value
  try {
    const updated = await service.updateDefinitionMeta('inventory.valuation_method', {
      labelAr: 'طريقة التقييم المحدثة',
      domain: 'inventory',
    }, actorId);
    assert.strictEqual(updated.labelAr, 'طريقة التقييم المحدثة');
    console.log('C6 PASS: updateDefinitionMeta updated labelAr');
    passed++;
  } catch (err) {
    console.error('C6 FAIL:', err);
    failed++;
  }

  // C7: archiveDefinition -> ValidationError /غير مسموح/
  try {
    await service.archiveDefinition('inventory.valuation_method');
    console.error('C7 FAIL: expected ValidationError from archiveDefinition');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError && /غير مسموح/.test(err.message)) {
      console.log('C7 PASS: archiveDefinition blocked with ValidationError (/غير مسموح/)');
      passed++;
    } else {
      console.error('C7 FAIL: unexpected error:', err);
      failed++;
    }
  }

  // C8: ConfigDefinitionsPanel.tsx exists and fetches /api/config/definitions
  try {
    const panelPath = path.resolve(process.cwd(), 'src/components/config/ConfigDefinitionsPanel.tsx');
    assert(fs.existsSync(panelPath), 'ConfigDefinitionsPanel.tsx must exist');
    const content = fs.readFileSync(panelPath, 'utf8');
    assert(content.includes('/api/config/definitions'), 'Must fetch /api/config/definitions');
    console.log('C8 PASS: ConfigDefinitionsPanel exists and calls /api/config/definitions');
    passed++;
  } catch (err) {
    console.error('C8 FAIL:', err);
    failed++;
  }

  // C9: AppSidebar.tsx has config_definitions and App.tsx has route branch
  try {
    const sidebarPath = path.resolve(process.cwd(), 'src/components/shell/AppSidebar.tsx');
    const appPath = path.resolve(process.cwd(), 'src/App.tsx');
    const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
    const appContent = fs.readFileSync(appPath, 'utf8');

    assert(sidebarContent.includes("'config_definitions'"), 'Sidebar must include config_definitions');
    assert(appContent.includes("'config_definitions'"), 'App must include config_definitions route branch');
    console.log('C9 PASS: AppSidebar and App wired for config_definitions');
    passed++;
  } catch (err) {
    console.error('C9 FAIL:', err);
    failed++;
  }

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Unexpected error in verification script:', err);
  process.exit(1);
});
