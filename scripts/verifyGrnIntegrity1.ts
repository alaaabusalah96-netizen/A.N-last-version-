import fs from 'fs';
import path from 'path';
import { GrnService } from '../src/server/purchasing/grnService.js';
import { ValidationError } from '../src/server/http/errors.js';
import { tenantContextStorage } from '../src/server/db/tenantContext.js';

async function run() {
  console.log('=== Verifying GRN Integrity & Config Platform Mapping (WP-3) ===');
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

  const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf8');

  // Static checks
  const grnServiceSrc = read('src/server/purchasing/grnService.ts');
  check('S1', grnServiceSrc.includes('resolveGlMapping'), 'grnService.ts contains resolveGlMapping');
  check('S2', grnServiceSrc.includes('accounting.grn_mapping'), 'grnService.ts contains accounting.grn_mapping');
  check('S3', grnServiceSrc.includes('glSource'), 'grnService.ts contains glSource in audit metadata');

  const postGrnIdx = grnServiceSrc.indexOf('async postGrn');
  const postGrnBody = grnServiceSrc.slice(postGrnIdx);
  const resolveGlIdx = postGrnBody.indexOf('await this.resolveGlMapping');
  const incBalIdx = postGrnBody.indexOf('incrementBalance');
  check('S4', resolveGlIdx !== -1 && incBalIdx !== -1 && resolveGlIdx < incBalIdx,
    'resolveGlMapping precedes incrementBalance in postGrn');

  const lineCostCheckIdx = postGrnBody.indexOf('تكلفة الوحدة يجب أن تكون أكبر من صفر قبل الترحيل المحاسبي');
  const allocSeqIdx = postGrnBody.indexOf('allocateSequenceNumber');
  check('S5', lineCostCheckIdx !== -1 && allocSeqIdx !== -1 && lineCostCheckIdx < allocSeqIdx,
    'per-line unitCost check precedes allocateSequenceNumber');

  const grnRepoSrc = read('src/server/purchasing/grnRepository.ts');
  check('S6', !grnRepoSrc.includes('unitCost: Number('), 'grnRepository.ts does not use unitCost: Number(');

  const mig028Src = read('database/migrations/028_grn_unit_cost_guard.sql');
  check('S7', mig028Src.includes('chk_purch_grn_lines_unit_cost_nonneg'),
    'migration 028 exists and defines chk_purch_grn_lines_unit_cost_nonneg');

  // Runtime checks using fake dependencies
  const C = '11111111-1111-1111-1111-111111111111';

  function createFakes() {
    let incBalCalled = false;
    let recordedAudit: any = null;

    const grnRepo = {
      createDraft: async (_cid: string, input: any) => ({
        id: 'grn-1',
        companyId: C,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        status: 'draft',
        lines: input.lines,
        createdAt: '2026-11-12T00:00:00.000Z',
      }),
      findByIdForUpdate: async () => ({ id: 'grn-1', status: 'draft' }),
      findById: async () => null as any,
      markPosted: async () => {},
    };

    const supplierRepo = {
      findById: async () => ({ id: 'sup-1', isActive: true }),
    };

    const warehouseRepo = {
      findById: async () => ({ id: 'wh-1', isActive: true }),
    };

    const itemRepo = {
      findById: async () => ({ id: 'item-1', code: 'ITM1', nameAr: 'صنف 1', isActive: true }),
    };

    const stockRepo = {
      incrementBalance: async () => { incBalCalled = true; },
      createMovement: async () => {},
    };

    const auditService = {
      record: async (rec: any) => { recordedAudit = rec; },
    };

    const journalRepo = {
      allocateSequenceNumber: async () => 'GRN-0001',
    };

    const settingsRepo = {
      getByCompanyId: async (): Promise<any> => ({
        inventoryAccountId: 'inv-acc',
        purchasesClearingAccountId: 'clr-acc',
      }),
    };

    const configService = {
      resolveConfig: async () => ({
        content: {
          inventory_account_id: 'cfg-inv',
          purchases_clearing_account_id: 'cfg-clr',
        },
      }),
    };

    return {
      grnRepo,
      supplierRepo,
      warehouseRepo,
      itemRepo,
      stockRepo,
      auditService,
      journalRepo,
      settingsRepo,
      configService,
      getIncBalCalled: () => incBalCalled,
      getRecordedAudit: () => recordedAudit,
    };
  }

  const dummyTx = { query: async () => ({ rows: [], rowCount: 0 }) } as any;

  // T1: createGrn with unitCost: -100 -> throws ValidationError
  await tenantContextStorage.run({ companyId: C, executor: dummyTx }, async () => {
    const fakes = createFakes();
    const svc = new GrnService(
      fakes.grnRepo as any, fakes.supplierRepo as any, fakes.warehouseRepo as any,
      fakes.itemRepo as any, fakes.stockRepo as any, fakes.auditService as any,
      fakes.journalRepo as any, fakes.settingsRepo as any, fakes.configService as any
    );
    let threw = false;
    try {
      await svc.createGrn(C, {
        supplierId: 'sup-1',
        warehouseId: 'wh-1',
        lines: [{ itemId: 'item-1', qty: 5, unitCost: -100 }],
      });
    } catch (e: any) {
      threw = e instanceof ValidationError;
    }
    check('T1', threw, 'createGrn with negative unitCost throws ValidationError');
  });

  // T2: createGrn with unitCost: 0 -> passes in draft
  await tenantContextStorage.run({ companyId: C, executor: dummyTx }, async () => {
    const fakes = createFakes();
    const svc = new GrnService(
      fakes.grnRepo as any, fakes.supplierRepo as any, fakes.warehouseRepo as any,
      fakes.itemRepo as any, fakes.stockRepo as any, fakes.auditService as any,
      fakes.journalRepo as any, fakes.settingsRepo as any, fakes.configService as any
    );
    let threw = false;
    try {
      await svc.createGrn(C, {
        supplierId: 'sup-1',
        warehouseId: 'wh-1',
        lines: [{ itemId: 'item-1', qty: 5, unitCost: 0 }],
      });
    } catch {
      threw = true;
    }
    check('T2', !threw, 'createGrn with unitCost: 0 passes in draft');
  });

  // T3: createGrn with unitCost: NaN -> throws ValidationError
  await tenantContextStorage.run({ companyId: C, executor: dummyTx }, async () => {
    const fakes = createFakes();
    const svc = new GrnService(
      fakes.grnRepo as any, fakes.supplierRepo as any, fakes.warehouseRepo as any,
      fakes.itemRepo as any, fakes.stockRepo as any, fakes.auditService as any,
      fakes.journalRepo as any, fakes.settingsRepo as any, fakes.configService as any
    );
    let threw = false;
    try {
      await svc.createGrn(C, {
        supplierId: 'sup-1',
        warehouseId: 'wh-1',
        lines: [{ itemId: 'item-1', qty: 5, unitCost: NaN }],
      });
    } catch (e: any) {
      threw = e instanceof ValidationError;
    }
    check('T3', threw, 'createGrn with NaN unitCost throws ValidationError');
  });

  // T4: postGrn with lines (qty=5, cost=100) and (qty=1, cost=0) -> throws before incrementBalance
  await tenantContextStorage.run({ companyId: C, executor: dummyTx }, async () => {
    const fakes = createFakes();
    fakes.grnRepo.findById = async () => ({
      id: 'grn-1',
      companyId: C,
      supplierId: 'sup-1',
      warehouseId: 'wh-1',
      status: 'draft',
      createdAt: '2026-11-12T00:00:00.000Z',
      lines: [
        { itemId: 'item-1', qty: 5, unitCost: 100, lineNo: 1 },
        { itemId: 'item-1', qty: 1, unitCost: 0, lineNo: 2 },
      ],
    }) as any;

    const svc = new GrnService(
      fakes.grnRepo as any, fakes.supplierRepo as any, fakes.warehouseRepo as any,
      fakes.itemRepo as any, fakes.stockRepo as any, fakes.auditService as any,
      fakes.journalRepo as any, fakes.settingsRepo as any, fakes.configService as any
    );
    let threw = false;
    try {
      await svc.postGrn(C, 'grn-1');
    } catch (e: any) {
      threw = e instanceof ValidationError && e.message.includes('تكلفة الوحدة يجب أن تكون أكبر من صفر');
    }
    check('T4', threw && !fakes.getIncBalCalled(),
      'postGrn with a zero unitCost line throws ValidationError before incrementBalance is invoked');
  });

  // T5: resolveGlMapping returns config_platform mapping
  {
    const fakes = createFakes();
    const svc = new GrnService(
      fakes.grnRepo as any, fakes.supplierRepo as any, fakes.warehouseRepo as any,
      fakes.itemRepo as any, fakes.stockRepo as any, fakes.auditService as any,
      fakes.journalRepo as any, fakes.settingsRepo as any, fakes.configService as any
    );
    const gl = await (svc as any).resolveGlMapping(C);
    check('T5', gl.source === 'config_platform' && gl.inventoryAccountId === 'cfg-inv',
      'resolveGlMapping uses config_platform mapping when available');
  }

  // T6: resolveGlMapping falls back to company_settings when configService throws
  {
    const fakes = createFakes();
    fakes.configService.resolveConfig = async () => { throw new Error('Not found'); };
    const svc = new GrnService(
      fakes.grnRepo as any, fakes.supplierRepo as any, fakes.warehouseRepo as any,
      fakes.itemRepo as any, fakes.stockRepo as any, fakes.auditService as any,
      fakes.journalRepo as any, fakes.settingsRepo as any, fakes.configService as any
    );
    const gl = await (svc as any).resolveGlMapping(C);
    check('T6', gl.source === 'company_settings' && gl.inventoryAccountId === 'inv-acc',
      'resolveGlMapping falls back to company_settings when configService throws');
  }

  // T7: resolveGlMapping throws ValidationError when both config and settings are absent
  {
    const fakes = createFakes();
    fakes.configService.resolveConfig = async () => { throw new Error('Not found'); };
    fakes.settingsRepo.getByCompanyId = async () => null;
    const svc = new GrnService(
      fakes.grnRepo as any, fakes.supplierRepo as any, fakes.warehouseRepo as any,
      fakes.itemRepo as any, fakes.stockRepo as any, fakes.auditService as any,
      fakes.journalRepo as any, fakes.settingsRepo as any, fakes.configService as any
    );
    let threw = false;
    try {
      await (svc as any).resolveGlMapping(C);
    } catch (e: any) {
      threw = e instanceof ValidationError;
    }
    check('T7', threw,
      'resolveGlMapping throws ValidationError when both config_platform and company_settings lack GL mapping');
  }

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
