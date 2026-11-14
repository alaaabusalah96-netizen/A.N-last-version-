import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { AccountService } from '../src/server/accounting/accountService.js';
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { GL_EVENT_CATALOG } from '../src/server/accounting/glEventCatalog.js';
import { PERMISSIONS, PERMISSION_CATALOG } from '../src/server/rbac/permissions.js';
import { ROLE_PERMISSIONS } from '../src/server/rbac/roles.js';
import { usableAccounts } from '../src/lib/accountRules.js';
import { ValidationError, NotFoundError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-CASH-CUSTODY-CORE-20 (Cash & Custody Core Foundation) ===');
console.log('========================================================================');

function assertLoopbackUrl(raw: string, varName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${varName} is invalid URL format`);
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
  }
  return parsed;
}

async function run() {
  const rootDir = process.cwd();

  // C1: Core files & mount check
  const requiredFiles = [
    'database/migrations/038_cash_custody_core.sql',
    'src/server/cash/cashTypes.ts',
    'src/server/cash/cashRegisterRepository.ts',
    'src/server/cash/cashRegisterService.ts',
    'src/server/routes/cashRoutes.ts',
  ];
  const allFilesExist = requiredFiles.every((f) => fs.existsSync(path.join(rootDir, f)));
  const appSrc = fs.readFileSync(path.join(rootDir, 'src/server/app.ts'), 'utf8');
  const appMounted = appSrc.includes("app.use('/api/cash'");
  await check('C1: Migration 038, cash module files exist, and app.ts mounts /api/cash', allFilesExist && appMounted);

  // C2: Migration 038 RLS, POLICY TO an_app, GRANT, REVOKE check
  const mig038 = fs.readFileSync(path.join(rootDir, 'database/migrations/038_cash_custody_core.sql'), 'utf8');
  const c2Tables = ['cash_registers', 'custody_records', 'custody_movements'];
  const c2Ok = c2Tables.every(
    (tbl) =>
      mig038.includes(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`) &&
      mig038.includes(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`) &&
      mig038.includes(`${tbl}_tenant_isolation`) &&
      mig038.includes(`ON ${tbl}`) &&
      mig038.includes(`TO an_app`) &&
      new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON (TABLE )?${tbl} TO an_app`).test(mig038) &&
      new RegExp(`REVOKE ALL ON (TABLE )?${tbl} FROM PUBLIC, anon, authenticated`).test(mig038)
  );
  await check('C2: Migration 038 defines ENABLE+FORCE RLS, tenant_isolation TO an_app, GRANT and REVOKE for all 3 tables', c2Ok);

  // C3: table_ownership.json check
  const ownershipJson: Array<{ table: string; scope: string }> = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'database/table_ownership.json'), 'utf8')
  );
  const ownershipMap = new Map(ownershipJson.map((entry) => [entry.table, entry]));
  const c3Ok = c2Tables.every((tbl) => ownershipMap.get(tbl)?.scope === 'tenant');
  await check('C3: database/table_ownership.json registers all 3 tables with scope=tenant', c3Ok);

  // C4: glEventCatalog check
  const custodyEvent = GL_EVENT_CATALOG.find((e) => e.eventKey === 'accounting.custody_mapping');
  const c4Ok =
    Boolean(custodyEvent) &&
    custodyEvent!.status === 'wired' &&
    custodyEvent!.fields.some((f) => f.field === 'custody_receivable_account_id' && f.allowedTypes.includes('asset') && f.requirePostable);
  await check('C4: glEventCatalog has accounting.custody_mapping (wired) with custody_receivable_account_id', c4Ok);

  // C5: permissions & roles check
  const expectedPerms = [
    'cash:read',
    'cash:write',
    'custody:request',
    'custody:approve',
    'custody:disburse',
    'custody:settle',
  ];
  const permValues = Object.values(PERMISSIONS);
  const catalogCodes = PERMISSION_CATALOG.filter((p) => p.group === 'الخزينة').map((p) => p.code);
  const c5PermsOk = expectedPerms.every((code) => permValues.includes(code as any) && catalogCodes.includes(code));
  const c5RolesOk =
    expectedPerms.every(
      (code) =>
        ROLE_PERMISSIONS.platform_admin.includes(code as any) &&
        ROLE_PERMISSIONS.company_admin.includes(code as any)
    ) &&
    ROLE_PERMISSIONS.company_user.includes('cash:read' as any) &&
    ROLE_PERMISSIONS.company_user.includes('custody:request' as any) &&
    !ROLE_PERMISSIONS.company_user.includes('custody:approve' as any) &&
    !ROLE_PERMISSIONS.company_user.includes('custody:disburse' as any) &&
    !ROLE_PERMISSIONS.company_user.includes('custody:settle' as any);
  await check('C5: permissions.ts & roles.ts define the 6 cash/custody codes in الخزينة group with proper role assignments', c5PermsOk && c5RolesOk);

  // C13: CompanySettingsPanel UI visibility static check
  const companySettingsPanelSrc = fs.readFileSync(path.join(rootDir, 'src/components/companies/CompanySettingsPanel.tsx'), 'utf8');
  const c13Ok =
    companySettingsPanelSrc.includes('custodyReceivableAccountId') &&
    companySettingsPanelSrc.includes('حساب ذمة عهد الموظفين') &&
    companySettingsPanelSrc.includes('<select');
  await check('C13: CompanySettingsPanel.tsx contains custodyReceivableAccountId, Arabic label, and <select>', c13Ok);

  // C14: src/lib/accountRules.ts rule check
  const accountRulesSrc = fs.readFileSync(path.join(rootDir, 'src/lib/accountRules.ts'), 'utf8');
  const filteredRuleAccounts = usableAccounts(
    [
      { id: '1', code: '1100', nameAr: 'أصل مرحل', accountType: 'asset', isPostable: true, isActive: true },
      { id: '2', code: '1000', nameAr: 'أصل رئيسي', accountType: 'asset', isPostable: false, isActive: true },
      { id: '3', code: '4100', nameAr: 'إيراد', accountType: 'revenue', isPostable: true, isActive: true },
    ],
    'custody_receivable_account_id'
  );
  const c14Ok =
    accountRulesSrc.includes('custody_receivable_account_id') &&
    accountRulesSrc.includes("allowedTypes: ['asset']") &&
    accountRulesSrc.includes('requirePostable: true') &&
    filteredRuleAccounts.length === 1 &&
    filteredRuleAccounts[0].id === '1';
  await check('C14: src/lib/accountRules.ts defines custody_receivable_account_id rule (asset, requirePostable: true)', c14Ok);

  // C15: ConfigPlatformPanel.tsx structured form & account loading check
  const configPanelSrc = fs.readFileSync(path.join(rootDir, 'src/components/config/ConfigPlatformPanel.tsx'), 'utf8');
  const custodyFieldOccurrences = (configPanelSrc.match(/custody_receivable_account_id/g) || []).length;
  const custodyKeyOccurrences = (configPanelSrc.match(/accounting\.custody_mapping/g) || []).length;
  const notRestrictedToGrnOnly =
    !configPanelSrc.includes("if (!selectedCompanyId || selectedKey !== 'accounting.grn_mapping')") &&
    configPanelSrc.includes('STRUCTURED_KEYS');
  const c15Ok = custodyKeyOccurrences >= 3 && custodyFieldOccurrences >= 3 && notRestrictedToGrnOnly;
  await check('C15: ConfigPlatformPanel.tsx supports accounting.custody_mapping across account loading, draft, and UI form', c15Ok);

  // C16: No client/route balance arithmetic
  const cashRoutesSrc = fs.readFileSync(path.join(rootDir, 'src/server/routes/cashRoutes.ts'), 'utf8');
  const c16Files = [companySettingsPanelSrc, configPanelSrc, cashRoutesSrc];
  const hasOpeningPlus = c16Files.some((src) => /\bopening(Balance)?\s*\+/.test(src));
  const hasMoneyReduce = cashRoutesSrc.includes('reduce(') || companySettingsPanelSrc.includes('.reduce(');
  const c16Ok = !hasOpeningPlus && !hasMoneyReduce;
  await check('C16: No monetary balance calculations in UI components or cashRoutes.ts', c16Ok);

  // C17: RolesPanel.tsx group & codes visibility + save wiring check
  const rolesPanelSrc = fs.readFileSync(path.join(rootDir, 'src/components/rbac/RolesPanel.tsx'), 'utf8');
  const matrixSrc = fs.readFileSync(path.join(rootDir, 'src/components/rbac/PermissionMatrix.tsx'), 'utf8');
  const c17Ok =
    rolesPanelSrc.includes('الخزينة') &&
    expectedPerms.every((code) => rolesPanelSrc.includes(code)) &&
    matrixSrc.includes('/api/rbac/permissions') &&
    matrixSrc.includes('/permissions');
  await check('C17: RolesPanel.tsx & PermissionMatrix.tsx expose الخزينة group + 6 codes via /api/rbac/permissions and save endpoint', c17Ok);

  // Database tests: C6..C12 & C18
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live DB tests C6..C12 and C18 are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
    if (process.env.MIGRATION_DATABASE_URL && process.env.MIGRATION_DATABASE_URL.trim() !== '') {
      assertLoopbackUrl(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
    }
  } catch (err) {
    blocked(err instanceof Error ? err.message : String(err));
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor. C6..C12 and C18 are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  let cleanupFailed = false;

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();
    const accountService = new AccountService();

    const userA = await userRepo.createUser({
      username: `cash_usr_a_${unique}`,
      passwordHash: 'dummy_cash_hash_20',
      role: 'platform_admin',
    });
    const userB = await userRepo.createUser({
      username: `cash_usr_b_${unique}`,
      passwordHash: 'dummy_cash_hash_20',
      role: 'platform_admin',
    });
    userIds.push(userA.id, userB.id);

    const compA = await companyRepo.create({
      code: `CSHA-${unique}`.slice(0, 20),
      nameAr: `شركة الخزينة أ ${unique}`,
      createdBy: userA.id,
    });
    const compB = await companyRepo.create({
      code: `CSHB-${unique}`.slice(0, 20),
      nameAr: `شركة الخزينة ب ${unique}`,
      createdBy: userB.id,
    });
    companyIds.push(compA.id, compB.id);

    const { accounts: accountsA } = await accountService.seedDefaultCoa(compA.id);
    const { accounts: accountsB } = await accountService.seedDefaultCoa(compB.id);

    const cashAccountA = accountsA.find((a) => a.code === '1100')!; // asset, postable
    const receivableAccountA = accountsA.find((a) => a.code === '1200')!; // asset, postable
    const liabilityAccountA = accountsA.find((a) => a.code === '2100')!; // liability, postable
    const revenueAccountA = accountsA.find((a) => a.code === '4100')!; // revenue, postable
    const headerAssetAccountA = accountsA.find((a) => a.code === '1000')!; // asset, NOT postable

    // Also create a second postable asset account for company_settings / distinct register checks
    const custodyRecAccountA = await accountService.createAccount(compA.id, {
      code: '1250',
      nameAr: 'ذمم عهد الموظفين',
      accountType: 'asset',
      parentId: headerAssetAccountA.id,
      isPostable: true,
    });

    // C6: Create cash register with valid postable asset GL account
    const regA = await defaultCashRegisterService.createRegister(
      compA.id,
      {
        code: `MAIN-CASH-${unique}`.slice(0, 30),
        nameAr: 'الخزينة الرئيسية',
        glAccountId: cashAccountA.id,
        openingBalance: 500,
      },
      userA.id
    );
    const c6Ok = Boolean(regA.id) && regA.openingBalance === 500 && regA.glAccountId === cashAccountA.id;
    await check('C6: Creating cash register on valid asset postable GL account succeeds and returns id', c6Ok);

    // C7: Create cash register with revenue account -> ValidationError
    let c7Rejected = false;
    try {
      await defaultCashRegisterService.createRegister(
        compA.id,
        {
          code: `REV-CASH-${unique}`.slice(0, 30),
          nameAr: 'صندوق إيراد خطأ',
          glAccountId: revenueAccountA.id,
        },
        userA.id
      );
    } catch (err) {
      if (err instanceof ValidationError) c7Rejected = true;
    }
    await check('C7: Creating cash register on revenue account throws ValidationError', c7Rejected);

    // C8: Create cash register with non-postable header account -> ValidationError
    let c8Rejected = false;
    try {
      await defaultCashRegisterService.createRegister(
        compA.id,
        {
          code: `HDR-CASH-${unique}`.slice(0, 30),
          nameAr: 'صندوق حساب رئيسي غير مرحل',
          glAccountId: headerAssetAccountA.id,
        },
        userA.id
      );
    } catch (err) {
      if (err instanceof ValidationError) c8Rejected = true;
    }
    await check('C8: Creating cash register on non-postable header account throws ValidationError', c8Rejected);

    // C9: Create second cash register on same GL account -> ValidationError
    let c9Rejected = false;
    try {
      await defaultCashRegisterService.createRegister(
        compA.id,
        {
          code: `DUP-CASH-${unique}`.slice(0, 30),
          nameAr: 'صندوق مكرر على نفس الحساب',
          glAccountId: cashAccountA.id,
        },
        userA.id
      );
    } catch (err) {
      if (err instanceof ValidationError) c9Rejected = true;
    }
    await check('C9: Creating second cash register on same GL account throws ValidationError', c9Rejected);

    // C10: Cross-company isolation: getRegister(compB, regA.id) -> NotFoundError
    let c10Rejected = false;
    try {
      await defaultCashRegisterService.getRegister(compB.id, regA.id);
    } catch (err) {
      if (err instanceof NotFoundError) c10Rejected = true;
    }
    await check('C10: getRegister(companyB, registerOfA) throws NotFoundError (tenant isolation)', c10Rejected);

    // C11: getBalance = opening + in - out after inserting 2 direct SQL movements inside tx (out 100, in 30, opening 500 -> 430)
    const dummyCustodyId = crypto.randomUUID();
    await withTenantTransaction(compA.id, async (tx) => {
      await tx.query(
        `INSERT INTO custody_records (id, company_id, custody_no, employee_user_id, register_id, amount, purpose, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
        [dummyCustodyId, compA.id, `CUST-TST-${unique}`.slice(0, 30), userA.id, regA.id, 100, 'اختبار حساب الرصيد']
      );
      await tx.query(
        `INSERT INTO custody_movements (id, company_id, custody_id, register_id, movement_type, direction, amount, created_by)
         VALUES ($1, $2, $3, $4, 'disburse', 'out', 100, $5)`,
        [crypto.randomUUID(), compA.id, dummyCustodyId, regA.id, userA.id]
      );
      await tx.query(
        `INSERT INTO custody_movements (id, company_id, custody_id, register_id, movement_type, direction, amount, created_by)
         VALUES ($1, $2, $3, $4, 'settle_return', 'in', 30, $5)`,
        [crypto.randomUUID(), compA.id, dummyCustodyId, regA.id, userA.id]
      );
    });
    const balanceRes = await defaultCashRegisterService.getBalance(compA.id, regA.id);
    const c11Ok =
      balanceRes.openingBalance === 500 &&
      balanceRes.totalOut === 100 &&
      balanceRes.totalIn === 30 &&
      balanceRes.currentBalance === 430;
    await check('C11: getBalance returns 430 (opening 500 - out 100 + in 30)', c11Ok);

    // C12: Reading cash_registers under company B context via an_app returns 0 rows (RLS check)
    const rlsRowsInB = await withTenantTransaction(compB.id, async (tx) => {
      const res = await tx.query('SELECT id FROM cash_registers WHERE id = $1', [regA.id]);
      return res.rows.length;
    });
    const rlsRowsNoContext = await executor.query('SELECT id FROM cash_registers WHERE id = $1', [regA.id]);
    const c12Ok = rlsRowsInB === 0 && rlsRowsNoContext.rows.length === 0;
    await check('C12: Direct SELECT on cash_registers via an_app in wrong/no tenant context returns 0 rows (RLS enforced)', c12Ok);

    // C18: Round-trip for custodyReceivableAccountId in company_settings + intact existing fields + reject invalid account
    await defaultCompanySettingsService.upsertSettings(userA.id, compA.id, {
      inventoryAccountId: receivableAccountA.id,
      purchasesClearingAccountId: liabilityAccountA.id,
      custodyReceivableAccountId: custodyRecAccountA.id,
    });
    const fetchedSettings = await defaultCompanySettingsService.getSettings(compA.id);
    const roundTripOk =
      fetchedSettings.inventoryAccountId === receivableAccountA.id &&
      fetchedSettings.purchasesClearingAccountId === liabilityAccountA.id &&
      fetchedSettings.custodyReceivableAccountId === custodyRecAccountA.id;

    let revCustodyRejected = false;
    try {
      await defaultCompanySettingsService.upsertSettings(userA.id, compA.id, {
        custodyReceivableAccountId: revenueAccountA.id,
      });
    } catch (err) {
      if (err instanceof ValidationError) revCustodyRejected = true;
    }

    let hdrCustodyRejected = false;
    try {
      await defaultCompanySettingsService.upsertSettings(userA.id, compA.id, {
        custodyReceivableAccountId: headerAssetAccountA.id,
      });
    } catch (err) {
      if (err instanceof ValidationError) hdrCustodyRejected = true;
    }

    // Ensure non-updating upsert preserves existing fields too (present-flag $n alignment check)
    await defaultCompanySettingsService.upsertSettings(userA.id, compA.id, {
      displayNameFinance: 'المدير المالي',
    });
    const preservedSettings = await defaultCompanySettingsService.getSettings(compA.id);
    const preservedOk =
      preservedSettings.inventoryAccountId === receivableAccountA.id &&
      preservedSettings.purchasesClearingAccountId === liabilityAccountA.id &&
      preservedSettings.custodyReceivableAccountId === custodyRecAccountA.id &&
      preservedSettings.displayNameFinance === 'المدير المالي';

    await check(
      'C18: company_settings round-trip for custodyReceivableAccountId preserves existing fields and rejects non-asset/non-postable accounts',
      roundTripOk && revCustodyRejected && hdrCustodyRejected && preservedOk
    );

    // suppress unused variable check for accountsB
    void accountsB;
  } catch (err) {
    await check('Cash & Custody Core verification unexpected error', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');

        await client.query('DELETE FROM custody_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_records WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM cash_registers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM company_settings WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_periods WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_sequences WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounts WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('COMMIT');
        console.log(`[cleanup] Test companies and cash/custody records purged cleanly.`);
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('[cleanup] Failed cleaning up verifyCashCustodyCore1:', cleanupErr);
      } finally {
        await client.end();
      }
    }
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  if (cleanupFailed) {
    console.error('[cleanup] Cleanup failed. Failing test to prevent silent leakage.');
    process.exit(1);
  }
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyCashCustodyCore1] Fatal error:', err);
  process.exit(1);
});
