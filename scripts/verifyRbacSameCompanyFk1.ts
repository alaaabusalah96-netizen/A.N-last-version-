import fs from 'node:fs';
import path from 'node:path';
import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { DbExecutor } from '../src/server/db/types.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';

class RollbackTestSentinel extends Error {
  constructor() {
    super('ROLLBACK_TEST_TRANSACTION');
  }
}

console.log('=====================================================================');
console.log('=== VERIFYING AN-FIX-RBAC-FK-11 (Same-Company Role Composite FKs) ===');
console.log('=====================================================================');

async function run() {
  const root = process.cwd();
  const mig035Path = path.join(root, 'database/migrations/035_rbac_same_company_fk.sql');
  const mig035Exists = fs.existsSync(mig035Path);
  const mig035Sql = mig035Exists ? fs.readFileSync(mig035Path, 'utf8') : '';

  // S0a/S0b/S0c: Migration 035 declares unique index/constraint + both composite FKs + legacy cleanup
  await check(
    'S0a: Migration 035 declares uq_roles_company_id on roles (company_id, id)',
    mig035Exists &&
      mig035Sql.includes('uq_roles_company_id') &&
      /roles\s*\(\s*company_id\s*,\s*id\s*\)/i.test(mig035Sql)
  );

  await check(
    'S0b: Migration 035 pre-cleans legacy company_memberships and declares fk_memberships_role_same_company ON DELETE RESTRICT',
    mig035Exists &&
      /UPDATE\s+company_memberships/i.test(mig035Sql) &&
      mig035Sql.includes('fk_memberships_role_same_company') &&
      /FOREIGN\s+KEY\s*\(\s*company_id\s*,\s*role_id\s*\)/i.test(mig035Sql) &&
      /ON\s+DELETE\s+RESTRICT/i.test(mig035Sql)
  );

  await check(
    'S0c: Migration 035 pre-cleans legacy user_org_scope and declares fk_user_org_scope_role_same_company ON DELETE RESTRICT',
    mig035Exists &&
      /UPDATE\s+user_org_scope/i.test(mig035Sql) &&
      mig035Sql.includes('fk_user_org_scope_role_same_company') &&
      /REFERENCES\s+roles\s*\(\s*company_id\s*,\s*id\s*\)/i.test(mig035Sql)
  );

  // ---- Loopback PostgreSQL Behavioral Proofs (F1 - F5) ----
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. F1-F5 loopback PostgreSQL behavioral FK proofs are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(dbUrl);
  } catch {
    blocked('DATABASE_URL is invalid URL format. F1-F5 behavioral FK proofs are BLOCKED.');
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
    blocked('Unable to connect to database executor. F1-F5 behavioral FK proofs are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  let companyAId: string | null = null;
  let companyBId: string | null = null;
  const createdUserIds: string[] = [];

  try {
    await executor.withTransaction(async (outerTx: DbExecutor) => {
      // Confirm constraints actually exist in PostgreSQL catalog
      const conRes = await outerTx.query<{ conname: string }>(
        `SELECT conname
         FROM pg_constraint
         WHERE conname IN (
           'uq_roles_company_id',
           'fk_memberships_role_same_company',
           'fk_user_org_scope_role_same_company'
         )`
      );
      if (conRes.rows.length !== 3) {
        throw new Error(
          `Expected 3 RBAC FK/unique constraints in pg_constraint, found ${conRes.rows.length}: ${conRes.rows
            .map((r) => r.conname)
            .join(', ')}`
        );
      }

      let spCounter = 0;
      const runInTenant = async <T>(cid: string, fn: () => Promise<T>): Promise<T> => {
        const sp = `sp_fk_${++spCounter}`;
        await outerTx.query(`SAVEPOINT ${sp}`);
        try {
          await outerTx.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [cid]);
          const res = await fn();
          await outerTx.query(`RELEASE SAVEPOINT ${sp}`);
          return res;
        } catch (err) {
          await outerTx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await outerTx.query(`RELEASE SAVEPOINT ${sp}`);
          throw err;
        }
      };

      const companyRepo = new CompanyRepository();
      const compA = await companyRepo.create(
        {
          code: `FK_A_${suffix}`,
          nameAr: `شركة قيد أ ${suffix}`,
          createdBy: null,
        },
        outerTx
      );
      companyAId = compA.id;

      const compB = await companyRepo.create(
        {
          code: `FK_B_${suffix}`,
          nameAr: `شركة قيد ب ${suffix}`,
          createdBy: null,
        },
        outerTx
      );
      companyBId = compB.id;

      const insertUser = async (uname: string): Promise<string> => {
        const uRes = await outerTx.query<{ id: string }>(
          `INSERT INTO platform_users (username, password_hash, role, is_active)
           VALUES ($1, $2, 'user', true)
           RETURNING id`,
          [uname, 'dummy_hash_fk_test_11']
        );
        const uid = uRes.rows[0].id;
        createdUserIds.push(uid);
        return uid;
      };

      const user1Id = await insertUser(`fk_user_1_${suffix}`);
      const user2Id = await insertUser(`fk_user_2_${suffix}`);

      const roleCodeSafe = suffix.replace(/[^a-z0-9_]/gi, '_').toLowerCase();

      // Create Role A and Branch A (org_unit_id NOT NULL required for user_org_scope) in Company A
      const roleAId = await runInTenant(companyAId, async () => {
        const r = await outerTx.query<{ id: string }>(
          `INSERT INTO roles (company_id, code, name_ar, org_level)
           VALUES ($1, $2, 'دور شركة أ', 'company')
           RETURNING id`,
          [companyAId, `fk_role_a_${roleCodeSafe}`]
        );
        return r.rows[0].id;
      });

      const branchAId = await runInTenant(companyAId, async () => {
        const u = await outerTx.query<{ id: string }>(
          `INSERT INTO org_units (company_id, code, name_ar, unit_type, path)
           VALUES ($1, $2, 'فرع أ', 'branch', $3)
           RETURNING id`,
          [companyAId, `BR_FK_A_${suffix}`, `/BR_FK_A_${suffix}/`]
        );
        return u.rows[0].id;
      });

      // Create Role B in Company B
      const roleBId = await runInTenant(companyBId, async () => {
        const r = await outerTx.query<{ id: string }>(
          `INSERT INTO roles (company_id, code, name_ar, org_level)
           VALUES ($1, $2, 'دور شركة ب', 'company')
           RETURNING id`,
          [companyBId, `fk_role_b_${roleCodeSafe}`]
        );
        return r.rows[0].id;
      });

      // F1: Direct INSERT with cross-company role_id into company_memberships -> rejected (23503)
      let f1Code: string | undefined;
      let f1Constraint: string | undefined;
      try {
        await runInTenant(companyAId, async () => {
          await outerTx.query(
            `INSERT INTO company_memberships (user_id, company_id, role, role_id, is_active)
             VALUES ($1, $2, 'company_user', $3, true)`,
            [user1Id, companyAId, roleBId]
          );
        });
      } catch (err: any) {
        f1Code = err?.code;
        f1Constraint = err?.constraint;
      }
      await check(
        'F1: Direct INSERT with cross-company role_id into company_memberships rejected with SQLSTATE 23503',
        f1Code === '23503' && f1Constraint === 'fk_memberships_role_same_company',
        `code=${f1Code ?? 'none'}, constraint=${f1Constraint ?? 'none'}`
      );

      // F2: INSERT with same-company role_id into company_memberships and user_org_scope succeeds
      let f2Succeeded = false;
      try {
        await runInTenant(companyAId, async () => {
          await outerTx.query(
            `INSERT INTO company_memberships (user_id, company_id, role, role_id, is_active)
             VALUES ($1, $2, 'company_user', $3, true)`,
            [user1Id, companyAId, roleAId]
          );
          await outerTx.query(
            `INSERT INTO user_org_scope (company_id, user_id, org_unit_id, role_id, access_level)
             VALUES ($1, $2, $3, $4, 'read')`,
            [companyAId, user1Id, branchAId, roleAId]
          );
        });
        f2Succeeded = true;
      } catch (err) {
        console.error('F2 unexpected error:', err);
      }
      await check(
        'F2: Direct INSERT with same-company role_id into company_memberships and user_org_scope accepted',
        f2Succeeded
      );

      // F3: Direct INSERT with cross-company role_id into user_org_scope -> rejected (23503)
      let f3Code: string | undefined;
      let f3Constraint: string | undefined;
      try {
        await runInTenant(companyAId, async () => {
          await outerTx.query(
            `INSERT INTO user_org_scope (company_id, user_id, org_unit_id, role_id, access_level)
             VALUES ($1, $2, $3, $4, 'read')`,
            [companyAId, user2Id, branchAId, roleBId]
          );
        });
      } catch (err: any) {
        f3Code = err?.code;
        f3Constraint = err?.constraint;
      }
      await check(
        'F3: Direct INSERT with cross-company role_id into user_org_scope rejected with SQLSTATE 23503',
        f3Code === '23503' && f3Constraint === 'fk_user_org_scope_role_same_company',
        `code=${f3Code ?? 'none'}, constraint=${f3Constraint ?? 'none'}`
      );

      // F4: Deleting a role referenced by membership/scope is blocked (ON DELETE RESTRICT -> 23503)
      let f4Code: string | undefined;
      try {
        await runInTenant(companyAId, async () => {
          await outerTx.query(`DELETE FROM roles WHERE id = $1`, [roleAId]);
        });
      } catch (err: any) {
        f4Code = err?.code;
      }
      await check(
        'F4: Deleting role referenced by membership/scope is blocked (ON DELETE RESTRICT, SQLSTATE 23503)',
        f4Code === '23503',
        `code=${f4Code ?? 'none'}`
      );

      throw new RollbackTestSentinel();
    });
  } catch (err) {
    if (!(err instanceof RollbackTestSentinel)) {
      await check(
        'Unhandled exception during verifyRbacSameCompanyFk1 DB tests',
        false,
        err instanceof Error ? err.message : String(err)
      );
    }
  } finally {
    // F5: Rollback leaves 0 leftover rows
    try {
      const companyIds = ([companyAId, companyBId] as Array<string | null>).filter((id): id is string => Boolean(id));
      let remaining = 0;
      if (companyIds.length > 0) {
        const compCount = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM companies WHERE id = ANY($1::uuid[])`,
          [companyIds]
        );
        remaining += Number(compCount.rows[0]?.cnt || 0);

        const memCount = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM company_memberships WHERE company_id = ANY($1::uuid[])`,
          [companyIds]
        );
        remaining += Number(memCount.rows[0]?.cnt || 0);
      }
      if (createdUserIds.length > 0) {
        const userCount = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM platform_users WHERE id = ANY($1::uuid[])`,
          [createdUserIds]
        );
        remaining += Number(userCount.rows[0]?.cnt || 0);
      }
      await check(
        'F5: Transaction rollback left 0 leftover rows across companies, company_memberships, and platform_users',
        remaining === 0,
        `remaining=${remaining}`
      );
    } catch (cleanupErr) {
      await check(
        'F5 cleanup verification error',
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
