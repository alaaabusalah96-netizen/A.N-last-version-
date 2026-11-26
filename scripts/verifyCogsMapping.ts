import fs from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import pg from 'pg';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { ROLE_PERMISSIONS } from '../src/server/rbac/roles.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';

function assert(c: boolean, l: string) {
  if (!c) throw new Error(`ASSERTION FAILED: ${l}`);
  console.log(`[PASS] ${l}`);
}

async function run() {
  console.log('=== VERIFY COGS MAPPING + accounting.mapping.write ===');
  const root = process.cwd();
  assert(PERMISSIONS.ACCOUNTING_MAPPING_WRITE === 'accounting.mapping.write', 'permission code defined');
  assert(ROLE_PERMISSIONS.company_admin.includes(PERMISSIONS.ACCOUNTING_MAPPING_WRITE), 'company_admin has mapping.write');
  assert(ROLE_PERMISSIONS.platform_admin.includes(PERMISSIONS.ACCOUNTING_MAPPING_WRITE), 'platform_admin has mapping.write');
  assert(!ROLE_PERMISSIONS.company_user.includes(PERMISSIONS.ACCOUNTING_MAPPING_WRITE), 'company_user lacks mapping.write');
  const routes = fs.readFileSync(path.join(root, 'src/server/routes/companySettingsRoutes.ts'), 'utf8');
  assert(/put\('\/settings\/mapping'[\s\S]*?requirePermission\(PERMISSIONS\.ACCOUNTING_MAPPING_WRITE\)/.test(routes), 'mapping route guarded by mapping.write');
  const mig = fs.readFileSync(path.join(root, 'database/migrations/069_accounting_mapping_write_permission.sql'), 'utf8');
  assert(/ON CONFLICT DO NOTHING/.test(mig) && !/DELETE|DROP/i.test(mig), 'migration 069 is additive and idempotent');

  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) { console.log('[SKIP] no DB url'); return; }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const comp = await pool.query(`SELECT c.id FROM companies c WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.account_type='expense' AND a.is_postable AND a.is_active) AND EXISTS (SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.account_type='asset' AND a.is_postable AND a.is_active) LIMIT 1`);
    if (comp.rows.length === 0) { console.log('[SKIP] no company with accounts'); return; }
    const companyId = comp.rows[0].id as string;
    const exp = (await pool.query(`SELECT id FROM accounts WHERE company_id=$1 AND account_type='expense' AND is_postable AND is_active LIMIT 1`, [companyId])).rows[0].id as string;
    const ast = (await pool.query(`SELECT id FROM accounts WHERE company_id=$1 AND account_type='asset' AND is_postable AND is_active LIMIT 1`, [companyId])).rows[0].id as string;
    const before = (await pool.query(`SELECT cogs_account_id FROM company_settings WHERE company_id=$1`, [companyId])).rows[0]?.cogs_account_id ?? null;
    const actor = ((await pool.query(`SELECT id FROM platform_users LIMIT 1`)).rows[0]?.id as string) || randomUUID();
    let rejected = false;
    try { await defaultCompanySettingsService.upsertSettings(actor, companyId, { cogsAccountId: ast }); } catch { rejected = true; }
    assert(rejected, 'asset account rejected as COGS account');
    const s = await defaultCompanySettingsService.upsertSettings(actor, companyId, { cogsAccountId: exp });
    assert(s.cogsAccountId === exp, 'expense account saved as COGS account');
    const g = await defaultCompanySettingsService.getSettings(companyId);
    assert(g.cogsAccountId === exp, 'COGS account read back');
    await pool.query(`UPDATE company_settings SET cogs_account_id=$2 WHERE company_id=$1`, [companyId, before]);
  } finally {
    await pool.end();
  }
  console.log('PASS: verifyCogsMapping completed successfully.');
}
run().catch((e) => { console.error(e); process.exit(1); });
