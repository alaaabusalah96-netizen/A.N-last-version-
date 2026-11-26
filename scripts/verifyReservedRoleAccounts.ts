import { randomUUID } from 'crypto';
import pg from 'pg';
import { defaultBankAccountService } from '../src/server/banking/bankAccountService.js';
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';
import { buildReservedRoleResolver } from '../src/server/accounting/reservedRoleAccounts.js';
import { usableAccounts } from '../src/lib/accountRules.js';

function assert(c: boolean, l: string) {
  if (!c) throw new Error(`ASSERTION FAILED: ${l}`);
  console.log(`[PASS] ${l}`);
}

async function msgOf(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

async function run() {
  console.log('=== VERIFY RESERVED ROLE ACCOUNTS (bank + cash box) ===');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) { console.log('[SKIP] no DB url'); return; }
  const pool = new pg.Pool({ connectionString: url });
  const created: string[] = [];
  let companyId = '';
  let savedSettings: any = null;
  try {
    const comp = await pool.query(`SELECT c.id FROM companies c WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.account_type='asset' AND a.is_postable AND a.is_active) LIMIT 1`);
    if (comp.rows.length === 0) { console.log('[SKIP] no company with accounts'); return; }
    companyId = comp.rows[0].id as string;
    const pick = async (code: string, name: string, type = 'asset') => {
      const ex = await pool.query(`SELECT id, code, name_ar FROM accounts WHERE company_id=$1 AND code=$2`, [companyId, code]);
      if (ex.rows[0]) return { id: ex.rows[0].id as string, code, nameAr: ex.rows[0].name_ar as string };
      const id = randomUUID();
      await pool.query(`INSERT INTO accounts (id, company_id, code, name_ar, account_type, is_postable, is_active) VALUES ($1,$2,$3,$4,$5,true,true)`, [id, companyId, code, name, type]);
      created.push(id);
      return { id, code, nameAr: name };
    };
    const inv = await pick('VRA-INV', 'مخزون البضاعة');
    const cashFree = await pick('VRA-CASH', 'خزينة فرعية');
    const mapped = await pick('VRA-MAP', 'حساب عام');

    savedSettings = (await pool.query(`SELECT inventory_account_id FROM company_settings WHERE company_id=$1`, [companyId])).rows[0] ?? null;
    // 1) Inventory account by NAME (settings not set) is reserved.
    await pool.query(`UPDATE company_settings SET inventory_account_id=NULL WHERE company_id=$1`, [companyId]);
    let resolve = await buildReservedRoleResolver(companyId);
    assert(resolve(inv) === 'المخزون', 'inventory account detected by name even when settings are empty');
    assert(resolve(cashFree) === null, 'plain cash account is not reserved');
    // 2) Account mapped in settings to the inventory role is reserved, with that role named in the message.
    await pool.query(`UPDATE company_settings SET inventory_account_id=$2 WHERE company_id=$1`, [companyId, mapped.id]);
    resolve = await buildReservedRoleResolver(companyId);
    assert(resolve(mapped) === 'المخزون', 'account mapped as inventory in settings is reserved');

    const bankMsg = await msgOf(() => defaultBankAccountService.createAccount(companyId, { code: 'VRA-B1', nameAr: 'بنك اختبار', bankName: 'Test', glAccountId: inv.id } as any));
    assert(!!bankMsg && bankMsg.includes('المخزون') && bankMsg.includes(inv.code), 'bank save on inventory account is rejected naming the real role (inventory)');
    const bankMsg2 = await msgOf(() => defaultBankAccountService.createAccount(companyId, { code: 'VRA-B2', nameAr: 'بنك اختبار', bankName: 'Test', glAccountId: mapped.id } as any));
    assert(!!bankMsg2 && bankMsg2.includes('المخزون'), 'bank save on settings-mapped account is rejected naming the role');
    const cashMsg = await msgOf(() => defaultCashRegisterService.createRegister(companyId, { code: 'VRA-C1', nameAr: 'صندوق اختبار', glAccountId: inv.id } as any));
    assert(!!cashMsg && cashMsg.includes('المخزون'), 'cash box on inventory account is rejected naming the real role');

    // 3) The list the UI uses hides reserved accounts for both pickers.
    const asOptions = [inv, mapped, cashFree].map((a) => ({ id: a.id, code: a.code, nameAr: a.nameAr, isActive: true, isPostable: true, accountType: 'asset', reservedRole: resolve(a) }));
    const codes = usableAccounts(asOptions, 'cash_register_gl_account').map((a) => a.code);
    assert(codes.length === 1 && codes[0] === 'VRA-CASH', 'picker keeps only the free cash account');
  } finally {
    if (companyId) {
      await pool.query(`UPDATE company_settings SET inventory_account_id=$2 WHERE company_id=$1`, [companyId, savedSettings?.inventory_account_id ?? null]);
      await pool.query(`DELETE FROM fin_bank_accounts WHERE company_id=$1 AND code LIKE 'VRA-%'`, [companyId]).catch(() => {});
      if (created.length) await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [created]).catch(() => {});
    }
    await pool.end();
  }
  console.log('PASS: verifyReservedRoleAccounts completed successfully.');
}
run().catch((e) => { console.error(e); process.exit(1); });
