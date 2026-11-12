import fs from 'fs';
import path from 'path';
import {
  GL_EVENT_CATALOG,
  findGlEvent,
  wiredGlEvents,
} from '../src/server/accounting/glEventCatalog.js';
import { GlMappingService } from '../src/server/accounting/glMappingService.js';
import { roleRulesFor } from '../src/server/config-platform/configAccountRoles.js';
import { Account } from '../src/server/accounting/accountTypes.js';
import { ValidationError, NotFoundError } from '../src/server/http/errors.js';

async function run() {
  console.log('=== Verifying GL Mapping Events & Catalog (AN-ACCT-MAPPING-7) ===');
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

  async function expectReject(
    name: string,
    fn: () => Promise<unknown>,
    expectedType: any,
    pattern: RegExp | null,
    message: string
  ) {
    try {
      await fn();
      check(name, false, `${message} — لم يُرفض`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const typeOk = err instanceof expectedType;
      const patternOk = pattern ? pattern.test(msg) : true;
      check(name, typeOk && patternOk, `${message} (${msg})`);
    }
  }

  const C = '11111111-1111-1111-1111-111111111111';
  const dummyTx: any = { query: async () => ({ rows: [], rowCount: 0 }) };

  const ACCOUNTS: Record<string, Account> = {
    'inv-ok': {
      id: 'inv-ok',
      companyId: C,
      code: '1300',
      nameAr: 'مخزون',
      nameEn: null,
      accountType: 'asset',
      parentId: null,
      isPostable: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    'inv-head': {
      id: 'inv-head',
      companyId: C,
      code: '1000',
      nameAr: 'الأصول',
      nameEn: null,
      accountType: 'asset',
      parentId: null,
      isPostable: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    'inv-rev': {
      id: 'inv-rev',
      companyId: C,
      code: '4100',
      nameAr: 'مبيعات',
      nameEn: null,
      accountType: 'revenue',
      parentId: null,
      isPostable: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    'clr-ok': {
      id: 'clr-ok',
      companyId: C,
      code: '2150',
      nameAr: 'مشتريات معلقة',
      nameEn: null,
      accountType: 'liability',
      parentId: null,
      isPostable: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };

  const fakeConfigService = {
    resolveConfig: async () => ({
      key: 'accounting.grn_mapping',
      definitionId: 'def-grn',
      source: 'company_published' as const,
      versionNo: 1,
      content: {
        inventory_account_id: 'inv-ok',
        purchases_clearing_account_id: 'clr-ok',
      },
    }),
  };

  const fakeAccountRepo: any = {
    findById: async (_cid: string, accountId: string) => ACCOUNTS[accountId] || null,
  };

  const mappingService = new GlMappingService(fakeConfigService, fakeAccountRepo);

  // G1: findGlEvent('accounting.grn_mapping').status === 'wired'
  const grnDef = findGlEvent('accounting.grn_mapping');
  check('G1', grnDef !== null && grnDef.status === 'wired', "findGlEvent('accounting.grn_mapping').status === 'wired'");

  // G2: كل حدث status='wired' عنده wiringPoint غير فاضي
  const wired = wiredGlEvents();
  const g2Ok =
    wired.length > 0 &&
    wired.every((e) => typeof e.wiringPoint === 'string' && e.wiringPoint.trim().length > 0);
  check('G2', g2Ok, "كل حدث status='wired' يملك wiringPoint غير فارغ");

  // G3: كل حدث status='not_implemented' عنده fields فاضية
  const unwired = GL_EVENT_CATALOG.filter((e) => e.status === 'not_implemented');
  const g3Ok = unwired.length > 0 && unwired.every((e) => Array.isArray(e.fields) && e.fields.length === 0);
  check('G3', g3Ok, "كل حدث status='not_implemented' يملك fields فاضية");

  // G4: GlMappingService.resolve لحدث not_implemented -> ValidationError /بلا مسار ترحيل/
  await expectReject(
    'G4',
    () => mappingService.resolve(C, 'accounting.sales_mapping'),
    ValidationError,
    /بلا مسار ترحيل/,
    'resolve لحدث not_implemented يرمي ValidationError /بلا مسار ترحيل/'
  );

  // G5: resolve لحدث مجهول -> NotFoundError
  await expectReject(
    'G5',
    () => mappingService.resolve(C, 'accounting.unknown_event_xyz'),
    NotFoundError,
    null,
    'resolve لحدث مجهول يرمي NotFoundError'
  );

  // G6: assertUsable بحقلين متساويين -> ValidationError /نفس الحساب/
  await expectReject(
    'G6',
    () =>
      mappingService.assertUsable(
        C,
        grnDef!,
        { inventory_account_id: 'inv-ok', purchases_clearing_account_id: 'inv-ok' },
        dummyTx
      ),
    ValidationError,
    /نفس الحساب/,
    'assertUsable بحقلين متساويين يرمي ValidationError /نفس الحساب/'
  );

  // G7: assertUsable بحقل ناقص -> ValidationError /ناقص/
  await expectReject(
    'G7',
    () =>
      mappingService.assertUsable(
        C,
        grnDef!,
        { inventory_account_id: 'inv-ok' },
        dummyTx
      ),
    ValidationError,
    /ناقص/,
    'assertUsable بحقل ناقص يرمي ValidationError /ناقص/'
  );

  // G8: assertUsable بحساب isPostable=false -> ValidationError /قابل للترحيل/
  await expectReject(
    'G8',
    () =>
      mappingService.assertUsable(
        C,
        grnDef!,
        { inventory_account_id: 'inv-head', purchases_clearing_account_id: 'clr-ok' },
        dummyTx
      ),
    ValidationError,
    /قابل للترحيل/,
    'assertUsable بحساب غير قابل للترحيل يرمي ValidationError /قابل للترحيل/'
  );

  // G9: assertUsable بنوع غلط -> ValidationError /لازم يكون/
  await expectReject(
    'G9',
    () =>
      mappingService.assertUsable(
        C,
        grnDef!,
        { inventory_account_id: 'inv-rev', purchases_clearing_account_id: 'clr-ok' },
        dummyTx
      ),
    ValidationError,
    /لازم يكون/,
    'assertUsable بنوع حساب خاطئ يرمي ValidationError /لازم يكون/'
  );

  // G10: assertUsable بحسابين صالحين -> لا يرمي
  let g10Ok = false;
  try {
    await mappingService.assertUsable(
      C,
      grnDef!,
      { inventory_account_id: 'inv-ok', purchases_clearing_account_id: 'clr-ok' },
      dummyTx
    );
    g10Ok = true;
  } catch (err) {
    console.error('G10 unexpected error:', err);
  }
  check('G10', g10Ok, 'assertUsable بحسابين صالحين ينفذ بدون أخطاء');

  // G11: ACCOUNT_ROLE_RULES مولّدة من الكتالوج: roleRulesFor('accounting.grn_mapping').length === 2
  const grnRules = roleRulesFor('accounting.grn_mapping');
  const g11Ok =
    grnRules.length === 2 &&
    fs.readFileSync(path.resolve('src/server/config-platform/configAccountRoles.ts'), 'utf8').includes('GL_EVENT_CATALOG');
  check('G11', g11Ok, "ACCOUNT_ROLE_RULES مولّدة من GL_EVENT_CATALOG و roleRulesFor('accounting.grn_mapping').length === 2");

  // G12: عدد مفاتيح الإعداد المزروعة بعد 033 = نفس عدد ما قبل (لا تعريفات جديدة)
  const migDir = path.resolve('database/migrations');
  const migFiles = fs
    .readdirSync(migDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const extractSeededKeys = (files: string[]): Set<string> => {
    const keys = new Set<string>();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
      if (/INSERT\s+INTO\s+config_definitions/i.test(sql)) {
        const matches = sql.matchAll(/'([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)'/g);
        for (const m of matches) {
          keys.add(m[1]);
        }
      }
    }
    return keys;
  };
  const before033 = migFiles.filter((f) => !f.startsWith('033_'));
  const upTo033 = migFiles.filter((f) => f <= '033_~');
  const seededBefore033 = extractSeededKeys(before033);
  const seededAfter033 = extractSeededKeys(upTo033);
  const mig033Path = path.join(migDir, '033_accounting_mapping_events.sql');
  const mig033Src = fs.existsSync(mig033Path) ? fs.readFileSync(mig033Path, 'utf8') : '';
  const g12Ok =
    fs.existsSync(mig033Path) &&
    !/INSERT\s+INTO\s+config_definitions/i.test(mig033Src) &&
    seededBefore033.size === seededAfter033.size;
  check(
    'G12',
    g12Ok,
    `عدد مفاتيح الإعداد المزروعة قبل 033 (${seededBefore033.size}) يساوي العدد بعد 033 (${seededAfter033.size})`
  );

  // G13: وجود GlMappingPanel.tsx + استيراده في AccountingWorkspace.tsx + usableAccounts مستوردة من src/lib/accountRules.ts (مش معرّفة مرتين)
  const rulesPath = path.resolve('src/lib/accountRules.ts');
  const panelPath = path.resolve('src/components/accounting/GlMappingPanel.tsx');
  const wsPath = path.resolve('src/components/accounting/AccountingWorkspace.tsx');
  const cfgPanelPath = path.resolve('src/components/config/ConfigPlatformPanel.tsx');

  const rulesExists = fs.existsSync(rulesPath);
  const panelExists = fs.existsSync(panelPath);
  const wsSrc = fs.readFileSync(wsPath, 'utf8');
  const panelSrc = panelExists ? fs.readFileSync(panelPath, 'utf8') : '';
  const cfgPanelSrc = fs.readFileSync(cfgPanelPath, 'utf8');

  const g13Ok =
    rulesExists &&
    panelExists &&
    wsSrc.includes('GlMappingPanel') &&
    panelSrc.includes("accountRules") &&
    panelSrc.includes('usableAccounts') &&
    cfgPanelSrc.includes("accountRules") &&
    cfgPanelSrc.includes('usableAccounts(') &&
    !/function\s+usableAccounts\b/.test(cfgPanelSrc) &&
    !/function\s+usableAccounts\b/.test(panelSrc);
  check(
    'G13',
    g13Ok,
    'GlMappingPanel.tsx موجود ومستورد في AccountingWorkspace.tsx و usableAccounts معرفة مرة واحدة في src/lib/accountRules.ts'
  );

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
