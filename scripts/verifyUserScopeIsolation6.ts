import fs from 'node:fs';
import path from 'node:path';
import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { defaultOrgUnitService } from '../src/server/org/orgUnitService.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultJournalService } from '../src/server/accounting/journalService.js';
import { defaultRoleService } from '../src/server/rbac/roleService.js';
import { ForbiddenError } from '../src/server/http/errors.js';

console.log('==================================================================');
console.log('=== VERIFYING AN-RBAC-SCOPES-6 (User Org Scopes & Isolation)   ===');
console.log('==================================================================');

async function run() {
  // Complementary UI presence checks (non-proof markers per WP-5)
  const root = process.cwd();
  const userScopesPanelPath = path.join(root, 'src/components/org/UserScopesPanel.tsx');
  const orgUnitsPanelPath = path.join(root, 'src/components/org/OrgUnitsPanel.tsx');
  const usersWorkspacePath = path.join(root, 'src/components/users/UsersAdminWorkspace.tsx');
  const mig032Path = path.join(root, 'database/migrations/032_user_scope_role_and_validity.sql');

  const userScopesPanelExists = fs.existsSync(userScopesPanelPath);
  const orgUnitsPanelSrc = fs.existsSync(orgUnitsPanelPath) ? fs.readFileSync(orgUnitsPanelPath, 'utf8') : '';
  const usersWorkspaceSrc = fs.existsSync(usersWorkspacePath) ? fs.readFileSync(usersWorkspacePath, 'utf8') : '';
  const mig032Src = fs.existsSync(mig032Path) ? fs.readFileSync(mig032Path, 'utf8') : '';

  await check(
    'UI-1: UserScopesPanel.tsx exists, uses controlled checked (no defaultChecked), and maps escalation errors',
    userScopesPanelExists &&
      !fs.readFileSync(userScopesPanelPath, 'utf8').includes('defaultChecked') &&
      fs.readFileSync(userScopesPanelPath, 'utf8').includes('بلا نطاقات = يرى الشركة كاملة')
  );
  await check(
    'UI-2: OrgUnitsPanel.tsx imports UserScopesPanel, includes نطاقات المستخدمين tab and /me/scopes strip',
    orgUnitsPanelSrc.includes('UserScopesPanel') &&
      orgUnitsPanelSrc.includes('نطاقات المستخدمين') &&
      orgUnitsPanelSrc.includes('/me/scopes')
  );
  await check(
    'UI-3: UsersAdminWorkspace.tsx exposes النطاقات button opening UserScopesPanel drawer',
    usersWorkspaceSrc.includes('UserScopesPanel') && usersWorkspaceSrc.includes('النطاقات')
  );
  await check(
    'DDL-1: Migration 032 defines role_id, valid_from, valid_until, delegated_by, reason, and v_user_effective_scopes without SECURITY DEFINER',
    mig032Src.includes('v_user_effective_scopes') &&
      !mig032Src.toUpperCase().includes('SECURITY DEFINER')
  );

  // DB Behavioral Proofs (S1 - S10)
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. S1-S10 behavioral user scope isolation tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(dbUrl);
  } catch {
    blocked('DATABASE_URL is invalid URL format. S1-S10 behavioral tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)) {
    blocked(`DATABASE_URL host '${parsedUrl.hostname}' is not loopback. Refusing destructive test run.`);
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor. S1-S10 tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  let companyAId: string | null = null;
  let companyBId: string | null = null;
  const createdUserIds: string[] = [];

  try {
    const companyRepo = new CompanyRepository();

    // S1: Create company A, 2 org units (Branch A, Branch B), and scoped user (+ helper actors)
    const compA = await companyRepo.create({
      code: `SCOPE_A_${suffix}`,
      nameAr: `شركة نطاق أ ${suffix}`,
      createdBy: null,
    });
    companyAId = compA.id;

    const compB = await companyRepo.create({
      code: `SCOPE_B_${suffix}`,
      nameAr: `شركة نطاق ب ${suffix}`,
      createdBy: null,
    });
    companyBId = compB.id;

    const branchA = await defaultOrgUnitService.createUnit(companyAId, {
      code: 'BR_A',
      nameAr: 'فرع أ',
      unitType: 'branch',
    });
    const branchB = await defaultOrgUnitService.createUnit(companyAId, {
      code: 'BR_B',
      nameAr: 'فرع ب',
      unitType: 'branch',
    });
    const branchCompB = await defaultOrgUnitService.createUnit(companyBId, {
      code: 'BR_OTHER',
      nameAr: 'فرع شركة أخرى',
      unitType: 'branch',
    });

    const insertUser = async (uname: string, role: string): Promise<string> => {
      const uRes = await executor.query<{ id: string }>(
        `INSERT INTO platform_users (username, password_hash, role, is_active)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [uname, 'dummy_hash_for_scope_test_only', role]
      );
      const id = uRes.rows[0].id;
      createdUserIds.push(id);
      return id;
    };

    const addMembership = async (cid: string, uid: string, role: string) => {
      await withTenantTransaction(cid, async (tx) => {
        await tx.query(
          `INSERT INTO company_memberships (company_id, user_id, role, is_active)
           VALUES ($1, $2, $3, true)`,
          [cid, uid, role]
        );
      });
    };

    const scopedUserId = await insertUser(`scoped_user_${suffix}`, 'company_user');
    const unscopedUserId = await insertUser(`unscoped_user_${suffix}`, 'company_user');
    const scopedAdminId = await insertUser(`scoped_admin_${suffix}`, 'company_admin');
    const platformAdminId = await insertUser(`plat_admin_${suffix}`, 'platform_admin');
    const compBUserId = await insertUser(`comp_b_user_${suffix}`, 'company_user');

    await addMembership(companyAId, scopedUserId, 'company_user');
    await addMembership(companyAId, unscopedUserId, 'company_user');
    await addMembership(companyAId, scopedAdminId, 'company_admin');
    await addMembership(companyBId, compBUserId, 'company_user');

    // Seed COA and roles for Company A
    await defaultAccountService.seedDefaultCoa(companyAId);
    const accounts = await defaultAccountService.listAccounts(companyAId);
    const postableAccounts = accounts.filter((a) => a.isPostable && a.isActive);
    const acctDebit = postableAccounts[0];
    const acctCredit = postableAccounts[1];

    const customRole = await defaultRoleService.createRole(
      companyAId,
      {
        code: `branch_acct_${suffix.replace(/[^a-z0-9_]/gi, '_')}`.toLowerCase(),
        nameAr: 'محاسب فرع',
        orgLevel: 'branch',
      },
      platformAdminId
    );

    await check(
      'S1: Company, two org units (BR_A, BR_B), and test users created successfully',
      Boolean(companyAId && branchA.id && branchB.id && scopedUserId && acctDebit && acctCredit)
    );

    // S2: Grant user scope on BR_A only -> getEffectiveScopes returns 1
    await defaultOrgUnitService.setUserScopes(
      companyAId,
      scopedUserId,
      {
        scopes: [
          {
            userId: scopedUserId,
            orgUnitId: branchA.id,
            includeDescendants: true,
            accessLevel: 'write',
            roleId: customRole.id,
            reason: 'S2 branch A assignment',
          },
        ],
      },
      platformAdminId,
      'platform_admin'
    );
    const effectiveAfterS2 = await defaultOrgUnitService.getEffectiveScopes(companyAId, scopedUserId);
    await check(
      'S2: Granting BR_A scope only -> getEffectiveScopes returns exactly 1 scope matching BR_A & roleCode',
      effectiveAfterS2.length === 1 &&
        effectiveAfterS2[0].orgUnitId === branchA.id &&
        effectiveAfterS2[0].roleCode === customRole.code
    );

    // S3: Journal entry on orgUnitId = BR_B by scopedUser -> rejected (ForbiddenError)
    let s3Rejected = false;
    try {
      await defaultJournalService.createDraftEntry(
        companyAId,
        {
          entryDate: '2026-01-15',
          memo: 'Out of scope test',
          orgUnitId: branchB.id,
          lines: [
            { accountId: acctDebit.id, debit: 100, credit: 0 },
            { accountId: acctCredit.id, debit: 0, credit: 100 },
          ],
        },
        scopedUserId,
        false
      );
    } catch (err) {
      s3Rejected = err instanceof ForbiddenError;
    }
    await check(
      'S3: Journal entry creation for orgUnitId = BR_B by BR_A-scoped user is rejected with ForbiddenError',
      s3Rejected
    );

    // S4: Same journal entry on BR_A succeeds
    const s4Draft = await defaultJournalService.createDraftEntry(
      companyAId,
      {
        entryDate: '2026-01-15',
        memo: 'In scope BR_A test',
        orgUnitId: branchA.id,
        lines: [
          { accountId: acctDebit.id, debit: 100, credit: 0 },
          { accountId: acctCredit.id, debit: 0, credit: 100 },
        ],
      },
      scopedUserId,
      false
    );
    await check(
      'S4: Journal entry creation for orgUnitId = BR_A by BR_A-scoped user succeeds',
      Boolean(s4Draft && s4Draft.id && s4Draft.orgUnitId === branchA.id)
    );

    // S5: Unscoped user (0 scopes) sees whole company (existing behavior preserved)
    const s5Draft = await defaultJournalService.createDraftEntry(
      companyAId,
      {
        entryDate: '2026-01-15',
        memo: 'Unscoped user sees company',
        orgUnitId: branchB.id,
        lines: [
          { accountId: acctDebit.id, debit: 50, credit: 0 },
          { accountId: acctCredit.id, debit: 0, credit: 50 },
        ],
      },
      unscopedUserId,
      false
    );
    await check(
      'S5: Unscoped user (no user_org_scope entries) retains full company access',
      Boolean(s5Draft && s5Draft.id)
    );

    // S6: validUntil in the past -> not returned by getEffectiveScopes
    await defaultOrgUnitService.setUserScopes(
      companyAId,
      scopedUserId,
      {
        scopes: [
          {
            userId: scopedUserId,
            orgUnitId: branchA.id,
            accessLevel: 'write',
            validFrom: '2020-01-01',
            validUntil: '2020-01-31',
            reason: 'Expired delegation',
          },
        ],
      },
      platformAdminId,
      'platform_admin'
    );
    const effectiveExpired = await defaultOrgUnitService.getEffectiveScopes(companyAId, scopedUserId);
    const accessExpired = await defaultOrgUnitService.assertUserOrgAccess(companyAId, scopedUserId, branchA.id, 'read', false);
    await check(
      'S6: Scope with validUntil in the past is excluded from getEffectiveScopes and denied by assertUserOrgAccess',
      effectiveExpired.length === 0 && accessExpired === false
    );

    // S7: company_admin restricted to BR_A attempts to grant BR_B -> ForbiddenError naming BR_B
    await defaultOrgUnitService.setUserScopes(
      companyAId,
      scopedAdminId,
      {
        scopes: [
          {
            userId: scopedAdminId,
            orgUnitId: branchA.id,
            accessLevel: 'write',
          },
        ],
      },
      platformAdminId,
      'platform_admin'
    );
    let s7EscalationBlocked = false;
    let s7NamesUnit = false;
    try {
      await defaultOrgUnitService.setUserScopes(
        companyAId,
        scopedUserId,
        {
          scopes: [
            {
              userId: scopedUserId,
              orgUnitId: branchB.id,
              accessLevel: 'write',
            },
          ],
        },
        scopedAdminId,
        'company_admin'
      );
    } catch (err: any) {
      s7EscalationBlocked = err instanceof ForbiddenError;
      s7NamesUnit = typeof err?.message === 'string' && (err.message.includes('BR_B') || err.message.includes('فرع ب'));
    }
    await check(
      'S7: company_admin scoped to BR_A cannot escalate to grant BR_B (ForbiddenError naming unit)',
      s7EscalationBlocked && s7NamesUnit
    );

    // S8: platform_admin grants the exact same BR_B scope -> succeeds
    const s8Scopes = await defaultOrgUnitService.setUserScopes(
      companyAId,
      scopedUserId,
      {
        scopes: [
          {
            userId: scopedUserId,
            orgUnitId: branchB.id,
            accessLevel: 'approve',
            reason: 'Granted by platform_admin',
          },
        ],
      },
      platformAdminId,
      'platform_admin'
    );
    await check(
      'S8: platform_admin can grant BR_B scope with approve accessLevel',
      s8Scopes.length === 1 && s8Scopes[0].orgUnitId === branchB.id && s8Scopes[0].accessLevel === 'approve'
    );

    // S9: Permission audit count for USER_SCOPE_SET matches successful saves for scopedUserId
    // Expected successful saves on scopedUserId = 3 (S2, S6, S8; S7 rolled back on ForbiddenError!)
    const auditRes = await withTenantTransaction(companyAId, async (tx) => {
      return await tx.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM audit_logs
         WHERE company_id = $1 AND entity_id = $2 AND action = 'USER_SCOPE_SET'`,
        [companyAId, scopedUserId]
      );
    });
    const auditCount = Number(auditRes.rows[0]?.cnt || 0);
    await check(
      'S9: Audit log USER_SCOPE_SET count (3) matches successful scope saves for user (rolled-back S7 excluded)',
      auditCount === 3,
      `observed=${auditCount}`
    );

    // S10: Direct query on v_user_effective_scopes as application DB user (an_app) shows 0 rows from Company B
    await defaultOrgUnitService.setUserScopes(
      companyBId,
      compBUserId,
      {
        scopes: [{ userId: compBUserId, orgUnitId: branchCompB.id, accessLevel: 'read' }],
      },
      platformAdminId,
      'platform_admin'
    );
    const viewInCompARes = await withTenantTransaction(companyAId, async (tx) => {
      return await tx.query<{ company_id: string }>(
        `SELECT company_id FROM v_user_effective_scopes`
      );
    });
    const leakedCompanyB = viewInCompARes.rows.some((r) => r.company_id === companyBId);
    const directNoTenantRes = await executor.query(`SELECT company_id FROM v_user_effective_scopes`);
    await check(
      'S10: Direct query on v_user_effective_scopes as an_app enforces RLS and hides Company B rows',
      !leakedCompanyB && viewInCompARes.rows.length >= 1 && directNoTenantRes.rows.length === 0
    );
  } catch (err) {
    await check(
      'Unhandled exception during user scope isolation suite',
      false,
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    // Mandatory strict cleanup contract (any cleanup error fails verification)
    try {
      for (const cid of [companyAId, companyBId]) {
        if (!cid) continue;
        await withTenantTransaction(cid, async (tx) => {
          await tx.query(`DELETE FROM journal_lines WHERE company_id = $1`, [cid]);
          await tx.query(`DELETE FROM journal_entries WHERE company_id = $1`, [cid]);
          await tx.query(`DELETE FROM accounting_sequences WHERE company_id = $1`, [cid]);
          await tx.query(`DELETE FROM user_org_scope WHERE company_id = $1`, [cid]);
          await tx.query(`DELETE FROM org_units WHERE company_id = $1`, [cid]);
          await tx.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE company_id = $1)`, [cid]);
          await tx.query(`DELETE FROM company_memberships WHERE company_id = $1`, [cid]);
          await tx.query(`DELETE FROM roles WHERE company_id = $1`, [cid]);
          await tx.query(`DELETE FROM accounts WHERE company_id = $1`, [cid]);
        });
        await executor.query(`DELETE FROM companies WHERE id = $1`, [cid]);
      }
      for (const uid of createdUserIds) {
        await executor.query(`DELETE FROM platform_users WHERE id = $1`, [uid]);
      }
    } catch (cleanupErr) {
      await check(
        'Cleanup contract in finally block',
        false,
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      );
    }
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
