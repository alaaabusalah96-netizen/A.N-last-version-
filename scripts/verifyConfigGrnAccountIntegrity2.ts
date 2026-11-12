import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { ConfigService } from '../src/server/config-platform/configService.js';
import { ConfigValidationService } from '../src/server/config-platform/configValidationService.js';
import {
  createAccountRoleChecker,
  findRoleRule,
  GRN_MAPPING_KEY,
} from '../src/server/config-platform/configAccountRoles.js';
import { ValidationError } from '../src/server/http/errors.js';
import { Account } from '../src/server/accounting/accountTypes.js';
import { tenantContextStorage } from '../src/server/db/tenantContext.js';
import {
  buildGeneralLedgerCsv,
  buildIncomeStatementCsv,
  buildBalanceSheetCsv,
  csvText,
} from '../src/lib/csvExport.js';

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

async function run() {
  console.log('=== Verifying Config GRN account integrity + CSV export (AN-CONFIG-GRN-INTEGRITY-2) ===');
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

  async function expectReject(name: string, fn: () => Promise<unknown>, pattern: RegExp, message: string) {
    try {
      await fn();
      check(name, false, `${message} — لم يُرفض`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check(name, err instanceof ValidationError && pattern.test(msg), `${message} (${msg})`);
    }
  }

  const C = 'company-test-1';
  const ACCOUNTS: Record<string, Account> = {
    'inv-ok':   { id: 'inv-ok',   companyId: C, code: '1300', nameAr: 'مخزون', nameEn: null, accountType: 'asset', parentId: null, isPostable: true,  isActive: true,  createdAt: new Date(), updatedAt: new Date() },
    'inv-head': { id: 'inv-head', companyId: C, code: '1000', nameAr: 'الأصول', nameEn: null, accountType: 'asset', parentId: null, isPostable: false, isActive: true,  createdAt: new Date(), updatedAt: new Date() },
    'inv-rev':  { id: 'inv-rev',  companyId: C, code: '4100', nameAr: 'مبيعات', nameEn: null, accountType: 'revenue', parentId: null, isPostable: true, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    'clr-ok':   { id: 'clr-ok',   companyId: C, code: '2150', nameAr: 'مشتريات معلقة', nameEn: null, accountType: 'liability', parentId: null, isPostable: true, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    'clr-off':  { id: 'clr-off',  companyId: C, code: '2160', nameAr: 'معلق قديم', nameEn: null, accountType: 'liability', parentId: null, isPostable: false, isActive: false, createdAt: new Date(), updatedAt: new Date() },
    'clr-head': { id: 'clr-head', companyId: C, code: '2000', nameAr: 'الالتزامات', nameEn: null, accountType: 'liability', parentId: null, isPostable: false, isActive: true, createdAt: new Date(), updatedAt: new Date() },
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
    defaultValue: { inventory_account_id: 'def-inv', purchases_clearing_account_id: 'def-clr' },
  });

  const svc = new ConfigService(
    fake,
    new ConfigValidationService(),
    (key: string) => createAccountRoleChecker(key, lookup)
  );

  await withCtx(C, async () => {
    // T1: publishDraft with header inventory account
    await fake.upsertDraft(C, 'def-1', { inventory_account_id: 'inv-head', purchases_clearing_account_id: 'clr-ok' }, 'draft', 'u1');
    await expectReject(
      'T1',
      () => svc.publishDraft(C, GRN_MAPPING_KEY, { changeSummary: 'pub T1' }, 'u1'),
      /قابلاً للترحيل/,
      'رفض حساب المخزون الرئيسي غير القابل للترحيل'
    );

    // T2: publishDraft with revenue inventory account
    await fake.upsertDraft(C, 'def-1', { inventory_account_id: 'inv-rev', purchases_clearing_account_id: 'clr-ok' }, 'draft', 'u1');
    await expectReject(
      'T2',
      () => svc.publishDraft(C, GRN_MAPPING_KEY, { changeSummary: 'pub T2' }, 'u1'),
      /لازم يكون من نوع/,
      'رفض حساب المخزون من نوع إيرادات'
    );

    // T3: publishDraft with header clearing account
    await fake.upsertDraft(C, 'def-1', { inventory_account_id: 'inv-ok', purchases_clearing_account_id: 'clr-head' }, 'draft', 'u1');
    await expectReject(
      'T3',
      () => svc.publishDraft(C, GRN_MAPPING_KEY, { changeSummary: 'pub T3' }, 'u1'),
      /قابلاً للترحيل/,
      'رفض حساب المشتريات المعلقة الرئيسي'
    );

    // T4: publishDraft with inactive clearing account
    await fake.upsertDraft(C, 'def-1', { inventory_account_id: 'inv-ok', purchases_clearing_account_id: 'clr-off' }, 'draft', 'u1');
    await expectReject(
      'T4',
      () => svc.publishDraft(C, GRN_MAPPING_KEY, { changeSummary: 'pub T4' }, 'u1'),
      /غير نشط/,
      'رفض حساب المشتريات المعلقة غير النشط'
    );

    // T5: publishDraft with ghost account
    await fake.upsertDraft(C, 'def-1', { inventory_account_id: 'ghost', purchases_clearing_account_id: 'clr-ok' }, 'draft', 'u1');
    await expectReject(
      'T5',
      () => svc.publishDraft(C, GRN_MAPPING_KEY, { changeSummary: 'pub T5' }, 'u1'),
      /غير موجود/,
      'رفض حساب غير موجود'
    );

    // T6: publishDraft with valid accounts
    await fake.upsertDraft(C, 'def-1', { inventory_account_id: 'inv-ok', purchases_clearing_account_id: 'clr-ok' }, 'draft', 'u1');
    const pub1 = await svc.publishDraft(C, GRN_MAPPING_KEY, { changeSummary: 'v1 initial' }, 'u1');
    check('T6', pub1.versionNo === 1 && pub1.isActive === true, 'نشر إصدار 1 بنجاح بحسابات صحيحة');

    // T7: resolveConfig after T6
    const res1 = await svc.resolveConfig(C, GRN_MAPPING_KEY);
    check(
      'T7',
      res1.source === 'company_published' && res1.versionNo === 1 && (res1.content as any).inventory_account_id === 'inv-ok',
      'معاينة الحل ترجع company_published v1'
    );

    // T8: Save draft v2 then publish
    await svc.saveDraft(C, GRN_MAPPING_KEY, { content: { inventory_account_id: 'inv-ok', purchases_clearing_account_id: 'clr-ok' } }, 'u1');
    const pub2 = await svc.publishDraft(C, GRN_MAPPING_KEY, { changeSummary: 'v2 update' }, 'u1');
    const res2 = await svc.resolveConfig(C, GRN_MAPPING_KEY);
    check('T8', pub2.versionNo === 2 && res2.versionNo === 2, 'نشر إصدار 2 بنجاح وحل v2');

    // T9: resolveConfig on un-published company
    const resOther = await withCtx('company-other', () => svc.resolveConfig('company-other', GRN_MAPPING_KEY));
    check(
      'T9',
      resOther.source === 'platform_default' && resOther.versionNo === null,
      'شركة بدون منشور ترجع platform_default'
    );

    // T10: rollback to v1
    const roll = await svc.rollback(C, GRN_MAPPING_KEY, { targetVersionNo: 1, changeSummary: 'rollback to v1' }, 'u1');
    const resRoll = await svc.resolveConfig(C, GRN_MAPPING_KEY);
    check('T10', roll.versionNo === 3 && resRoll.versionNo === 3, 'التراجع عن v1 ينشئ v3 بحالة نشطة');

    // T11: Save draft with invalid unknown field
    await expectReject(
      'T11',
      () => svc.saveDraft(C, GRN_MAPPING_KEY, { content: { inventory_account_id: 'inv-ok', purchases_clearing_account_id: 'clr-ok', unknown_field: 123 } }, 'u1'),
      /حقل غير معرف/,
      'حفظ مسودة بحقل غير معرف يترفض بـ ValidationError'
    );
  });

  // S1-S5 Structural/Code checks
  const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf8');
  const rolesPath = 'src/server/config-platform/configAccountRoles.ts';
  const grnSvcPath = 'src/server/purchasing/grnService.ts';
  const panelPath = 'src/components/config/ConfigPlatformPanel.tsx';

  check('S1', fs.existsSync(path.resolve(rolesPath)) && read(rolesPath).includes('ACCOUNT_ROLE_RULES'), 'configAccountRoles.ts موجود وفيه ACCOUNT_ROLE_RULES');

  const invRule = findRoleRule(GRN_MAPPING_KEY, 'inventory_account_id');
  check('S2', invRule !== null && invRule.allowedTypes.includes('asset'), 'findRoleRule يرجع قواعد حساب المخزون (asset)');

  const clrRule = findRoleRule(GRN_MAPPING_KEY, 'purchases_clearing_account_id');
  check('S3', clrRule !== null && clrRule.allowedTypes.includes('liability'), 'findRoleRule يرجع قواعد حساب المشتريات المعلقة (liability)');

  const grnSrc = read(grnSvcPath);
  const assertPos = grnSrc.indexOf('assertGlAccountsUsable');
  const incPos = grnSrc.indexOf('incrementBalance');
  check('S4', assertPos !== -1 && incPos !== -1 && assertPos < incPos, 'assertGlAccountsUsable يتفحص قبل أي كتابة على المخزون');

  const panelSrc = read(panelPath);
  check('S5', panelSrc.includes('usableAccounts('), 'ConfigPlatformPanel بيفلتر القوائم بـ usableAccounts');

  // C1-C9 CSV tests
  check('C1', csvText('=1+1') === "'=1+1", 'csvText تسبق = بـ فاصلة عليا');
  check('C2', csvText('+SUM(A1)') === "'+SUM(A1)", 'csvText تسبق + بـ فاصلة عليا');
  check('C3', csvText('-1').startsWith("'") && csvText('@x').startsWith("'"), 'csvText تسبق - و @ بـ فاصلة عليا');
  check('C4', csvText('a"b') === '"a""b"', 'csvText تضاعف علامات التنصيص وتقتبس النص');

  const glCsv = buildGeneralLedgerCsv({
    accountCode: '1100', openingBalance: '100.00', totalDebit: '50.00',
    totalCredit: '20.00', closingBalance: '130.00',
    rows: [{ entryDate: '2026-01-01', lineMemo: 'قيد', debit: '50.00', credit: '0', runningBalance: '150.00' }],
  });
  check('C5', glCsv.includes('الرصيد الافتتاحي') && glCsv.includes('100') && glCsv.includes('الرصيد الختامي'), 'buildGeneralLedgerCsv يتضمن الافتتاحي والختامي والإجماليات');

  const incCsv = buildIncomeStatementCsv({
    revenue: [{ accountCode: '4100', accountNameAr: 'مبيعات', amount: '1000.00' }],
    expenses: [{ accountCode: '5100', accountNameAr: 'إيجار', amount: '400.00' }],
    totalRevenue: '1000.00', totalExpenses: '400.00', netIncome: '600.00',
  });
  check('C6', incCsv.includes('إجمالي الإيرادات') && incCsv.includes('صافي الدخل') && incCsv.includes('600'), 'buildIncomeStatementCsv يتضمن الإجماليات وصافي الدخل');

  const balCsv = buildBalanceSheetCsv({
    assets: [], liabilities: [], equity: [],
    totalAssets: '500.00', totalLiabilities: '200.00', totalEquity: '300.00',
    totalLiabilitiesAndEquity: '500.00', isBalanced: true,
  });
  check('C7', balCsv.includes('إجمالي الأصول') && balCsv.includes('حالة التوازن') && balCsv.includes('متوازنة'), 'buildBalanceSheetCsv يتضمن الإجماليات وحالة التوازن');

  const malIncCsv = buildIncomeStatementCsv({
    revenue: [{ accountCode: '4100', accountNameAr: '=HYPERLINK("http://x")', amount: '1.00' }],
    expenses: [], totalRevenue: '1.00', totalExpenses: '0', netIncome: '1.00',
  });
  check('C8', !/(^|,)"?=HYPERLINK/.test(malIncCsv) && malIncCsv.includes("'=HYPERLINK"), 'اسم حساب خبيث لا ينشئ صيغة قابلة للتنفيذ');

  check('C9', !glCsv.includes('"50"') && !incCsv.includes('"1000"'), 'الأرقام في CSV تخرج غير مقتبسة');

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
