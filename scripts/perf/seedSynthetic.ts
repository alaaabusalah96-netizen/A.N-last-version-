import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { hashPassword } from '../../src/server/auth/passwordHash.js';
import { runMigrations } from '../../src/server/db/migrationRunner.js';
import { bootstrapRoles } from '../ciBootstrapRoles.js';
import {
  assertLoopbackDatabaseUrl,
  assertSafePgIdentifier,
  redactLogText,
  sanitizeConnectionUrl,
} from '../ops/backupUtils.js';

export interface PerfVolumeConfig {
  companies: number;
  users: number;
  postableAccounts: number;
  warehouses: number;
  items: number;
  customers: number;
  suppliers: number;
  months: number;
  journalEntries: number;
  salesInvoices: number;
  purchaseReceipts: number;
}

export interface PerfSeedMetadata {
  dbName: string;
  companyId: string;
  companyCode: string;
  username: string;
  volumes: PerfVolumeConfig;
  sampleIds: {
    debitAccountId: string;
    creditAccountId: string;
    customerIds: string[];
    itemIds: string[];
    warehouseIds: string[];
  };
  seededAt: string;
}

const DEFAULT_PERF_PASSWORD = 'PerfBaseline#2026!';
const DEFAULT_APP_ROLE_PASSWORD = 'PerfAppRole#2026!';

function parseIntEnv(name: string, fallback: number, min: number = 1): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const val = Number.parseInt(raw, 10);
  if (!Number.isFinite(val) || val < min) {
    throw new Error(`Invalid integer for ${name}: '${raw}' (must be >= ${min})`);
  }
  return val;
}

export function resolveVolumeConfig(): PerfVolumeConfig {
  return {
    companies: 1,
    users: 2,
    postableAccounts: parseIntEnv('PERF_ACCOUNTS', 50, 10),
    warehouses: parseIntEnv('PERF_WAREHOUSES', 3, 1),
    items: parseIntEnv('PERF_ITEMS', 200, 5),
    customers: parseIntEnv('PERF_CUSTOMERS', 40, 2),
    suppliers: parseIntEnv('PERF_SUPPLIERS', 20, 2),
    months: parseIntEnv('PERF_MONTHS', 6, 1),
    journalEntries: parseIntEnv('PERF_JOURNAL_ENTRIES', 5000, 10),
    salesInvoices: parseIntEnv('PERF_SALES_INVOICES', 2000, 10),
    purchaseReceipts: parseIntEnv('PERF_PURCHASE_RECEIPTS', 2000, 10),
  };
}

export function resolvePerfDbName(cliArg?: string): string {
  const raw = (cliArg || process.env.PERF_DB_NAME || 'perf_an_erp').trim();
  const safe = assertSafePgIdentifier(raw);
  if (!safe.startsWith('perf_')) {
    throw new Error(`[SAFETY GUARD] Disposable perf database name must start with 'perf_' (got '${safe}').`);
  }
  return safe;
}

function replaceUrlDatabase(parsed: URL, dbName: string): string {
  const clone = new URL(parsed.toString());
  clone.pathname = `/${dbName}`;
  return clone.toString();
}

function formatDateIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

function monthRange(year: number, monthIndex0: number): { code: string; startDate: string; endDate: string } {
  const start = new Date(Date.UTC(year, monthIndex0, 1));
  const end = new Date(Date.UTC(year, monthIndex0 + 1, 0));
  const m = String(start.getUTCMonth() + 1).padStart(2, '0');
  return {
    code: `${start.getUTCFullYear()}-${m}`,
    startDate: formatDateIso(start),
    endDate: formatDateIso(end),
  };
}

async function execBatchInsert(
  client: pg.Client,
  sqlPrefix: string,
  colsPerRow: number,
  rows: unknown[][],
  sqlSuffix: string = '',
  chunkSize: number = 400
): Promise<void> {
  if (rows.length === 0) return;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let r = 0; r < chunk.length; r++) {
      const row = chunk[r];
      const placeholders: string[] = [];
      for (let c = 0; c < colsPerRow; c++) {
        values.push(row[c]);
        placeholders.push(`$${values.length}`);
      }
      tuples.push(`(${placeholders.join(', ')})`);
    }
    const sql = `${sqlPrefix} VALUES ${tuples.join(', ')} ${sqlSuffix}`;
    await client.query(sql, values);
  }
}

async function ensurePerfAppRolePrivileges(client: pg.Client, dbName: string): Promise<void> {
  const appPass = process.env.PERF_APP_DB_PASSWORD || process.env.APP_DB_PASSWORD || DEFAULT_APP_ROLE_PASSWORD;
  const roleRes = await client.query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'an_app'`
  );

  if (roleRes.rows.length === 0) {
    const createStmt = await client.query<{ stmt: string }>(
      `SELECT format('CREATE ROLE %I WITH LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', 'an_app', $1::text) AS stmt`,
      [appPass]
    );
    await client.query(createStmt.rows[0].stmt);
  } else if (!roleRes.rows[0].rolsuper && !roleRes.rows[0].rolbypassrls && !roleRes.rows[0].rolcanlogin) {
    const alterStmt = await client.query<{ stmt: string }>(
      `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', 'an_app', $1::text) AS stmt`,
      [appPass]
    );
    await client.query(alterStmt.rows[0].stmt);
  }

  const dbGrant = await client.query<{ stmt: string }>(
    `SELECT format('GRANT CONNECT ON DATABASE %I TO an_app', $1::text) AS stmt`,
    [dbName]
  );
  await client.query(dbGrant.rows[0].stmt);
  await client.query(`GRANT USAGE ON SCHEMA public TO an_app`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO an_app`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO an_app`);
  await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM an_app`);
  await client.query(`REVOKE ALL ON TABLE schema_migrations FROM an_app`);
  await client.query(`GRANT SELECT ON TABLE schema_migrations TO an_app`);
}

function parseCliArgs(argv: string[]): { adminUrl?: string; dbName?: string } {
  const out: { adminUrl?: string; dbName?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--admin-url' && argv[i + 1]) {
      out.adminUrl = argv[++i];
    } else if (arg === '--db-name' && argv[i + 1]) {
      out.dbName = argv[++i];
    }
  }
  return out;
}

export async function runSeedSynthetic(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const volumes = resolveVolumeConfig();
  const perfDbName = resolvePerfDbName(cli.dbName);

  console.log('=== A.N ERP Performance Baseline — Synthetic Dataset Seeder ===');
  console.log('Declared Volume Constants:');
  console.log(JSON.stringify({ dbName: perfDbName, ...volumes }, null, 2));

  const adminUrl = (
    cli.adminUrl ||
    process.env.PERF_ADMIN_URL ||
    process.env.LOCAL_PG_OWNER_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();

  if (!adminUrl) {
    console.log(
      '[BLOCKED] No loopback PostgreSQL admin URL found (set PERF_ADMIN_URL or LOCAL_PG_OWNER_URL or loopback MIGRATION_DATABASE_URL). Synthetic perf seeding is BLOCKED.'
    );
    process.exit(2);
  }

  // Fail closed on non-loopback hosts (never seed or drop remote/Supabase DBs)
  const parsedAdmin = assertLoopbackDatabaseUrl(adminUrl, 'Perf Seed Admin DB URL');
  const sanitizedAdmin = sanitizeConnectionUrl(adminUrl);
  const targetDbUrl = replaceUrlDatabase(parsedAdmin, perfDbName);

  console.log(`[perf:seed] Target loopback host: ${sanitizedAdmin}`);
  console.log(`[perf:seed] Recreating disposable database: ${perfDbName}`);

  const adminClient = new pg.Client({ connectionString: adminUrl });
  try {
    await adminClient.connect();
  } catch (err: unknown) {
    const msg = redactLogText(err instanceof Error ? err.message : String(err));
    console.log(`[BLOCKED] Loopback PostgreSQL is unreachable (${msg}). Synthetic perf seeding is BLOCKED.`);
    process.exit(2);
  }

  try {
    await adminClient.query(`DROP DATABASE IF EXISTS ${perfDbName} WITH (FORCE)`);
    await adminClient.query(`CREATE DATABASE ${perfDbName}`);
  } finally {
    await adminClient.end().catch(() => {});
  }

  const origMigUrl = process.env.MIGRATION_DATABASE_URL;
  const origNodeEnv = process.env.NODE_ENV;
  process.env.MIGRATION_DATABASE_URL = targetDbUrl;
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'test';
  }

  try {
    console.log('[perf:seed] Bootstrapping stub roles & running database migrations...');
    await bootstrapRoles();
    await runMigrations();
  } finally {
    if (origMigUrl !== undefined) {
      process.env.MIGRATION_DATABASE_URL = origMigUrl;
    } else {
      delete process.env.MIGRATION_DATABASE_URL;
    }
    if (origNodeEnv !== undefined) {
      process.env.NODE_ENV = origNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  }

  const db = new pg.Client({ connectionString: targetDbUrl });
  await db.connect();

  try {
    await ensurePerfAppRolePrivileges(db, perfDbName);

    const perfPassword = process.env.PERF_PASSWORD || DEFAULT_PERF_PASSWORD;
    const passwordHash = await hashPassword(perfPassword);
    const adminUserId = crypto.randomUUID();
    const operatorUserId = crypto.randomUUID();
    const companyId = crypto.randomUUID();

    console.log('[perf:seed] Inserting users, company, chart of accounts, settings, and periods...');
    await db.query('BEGIN');

    // 1. Users (2 users)
    await db.query(
      `INSERT INTO platform_users (id, username, password_hash, role, is_active)
       VALUES
         ($1, 'perf_admin', $3, 'platform_admin', true),
         ($2, 'perf_operator', $3, 'user', true)`,
      [adminUserId, operatorUserId, passwordHash]
    );

    // 2. Company (1 company)
    await db.query(
      `INSERT INTO companies (id, code, name_ar, name_en, is_active, database_mode, created_by)
       VALUES ($1, 'PERF_CO_01', 'شركة القياس المرجعي للأداء', 'Perf Baseline Trading Co', true, 'central', $2)`,
      [companyId, adminUserId]
    );

    await db.query(
      `INSERT INTO company_memberships (user_id, company_id, role, is_active)
       VALUES ($1, $2, 'company_admin', true), ($3, $2, 'company_user', true)`,
      [adminUserId, companyId, operatorUserId]
    );

    // 3. Accounts: 5 header accounts + N postable accounts (default 50)
    const headerDefs = [
      { code: '1000', nameAr: 'الأصول', nameEn: 'Assets', type: 'asset' },
      { code: '2000', nameAr: 'الخصوم', nameEn: 'Liabilities', type: 'liability' },
      { code: '3000', nameAr: 'حقوق الملكية', nameEn: 'Equity', type: 'equity' },
      { code: '4000', nameAr: 'الإيرادات', nameEn: 'Revenue', type: 'revenue' },
      { code: '5000', nameAr: 'المصروفات', nameEn: 'Expenses', type: 'expense' },
    ];
    const headerIds = new Map<string, string>();
    const accountRows: unknown[][] = [];

    for (const h of headerDefs) {
      const id = crypto.randomUUID();
      headerIds.set(h.type, id);
      accountRows.push([id, companyId, h.code, h.nameAr, h.nameEn, h.type, null, false, true]);
    }

    const corePostable = [
      { code: '1100', nameAr: 'النقدية بالصندوق', nameEn: 'Cash on Hand', type: 'asset' },
      { code: '1110', nameAr: 'النقدية بالبنك', nameEn: 'Cash at Bank', type: 'asset' },
      { code: '1200', nameAr: 'العملاء / الذمم المدينة', nameEn: 'Accounts Receivable', type: 'asset' },
      { code: '1300', nameAr: 'حساب المخزون', nameEn: 'Inventory Asset', type: 'asset' },
      { code: '2100', nameAr: 'الموردون / الذمم الدائنة', nameEn: 'Accounts Payable', type: 'liability' },
      { code: '2200', nameAr: 'المشتريات المعلقة (GRNI)', nameEn: 'Purchases Clearing', type: 'liability' },
      { code: '2300', nameAr: 'ضريبة القيمة المضافة المستحقة', nameEn: 'Output VAT Payable', type: 'liability' },
      { code: '3100', nameAr: 'رأس المال', nameEn: 'Share Capital', type: 'equity' },
      { code: '3200', nameAr: 'الأرصدة الافتتاحية', nameEn: 'Opening Balance Equity', type: 'equity' },
      { code: '4100', nameAr: 'إيراد المبيعات', nameEn: 'Sales Revenue', type: 'revenue' },
      { code: '5100', nameAr: 'مصروفات عمومية وإدارية', nameEn: 'G&A Expenses', type: 'expense' },
      { code: '5200', nameAr: 'تكلفة البضاعة المباعة', nameEn: 'Cost of Goods Sold', type: 'expense' },
      { code: '5300', nameAr: 'فروق جرد المخزون', nameEn: 'Inventory Adjustment', type: 'expense' },
    ];

    const postableByCode = new Map<string, string>();
    const postableAccountIds: string[] = [];

    for (const acc of corePostable) {
      const id = crypto.randomUUID();
      postableByCode.set(acc.code, id);
      postableAccountIds.push(id);
      accountRows.push([
        id,
        companyId,
        acc.code,
        acc.nameAr,
        acc.nameEn,
        acc.type,
        headerIds.get(acc.type) || null,
        true,
        true,
      ]);
    }

    const extraCount = Math.max(0, volumes.postableAccounts - corePostable.length);
    const typeCycle: Array<{ type: string; baseCode: number; label: string }> = [
      { type: 'asset', baseCode: 1400, label: 'حساب أصل تحليلي' },
      { type: 'liability', baseCode: 2400, label: 'حساب التزام تحليلي' },
      { type: 'equity', baseCode: 3300, label: 'حساب حقوق ملكية' },
      { type: 'revenue', baseCode: 4200, label: 'حساب إيراد تحليلي' },
      { type: 'expense', baseCode: 5400, label: 'حساب مصروف تحليلي' },
    ];
    for (let i = 0; i < extraCount; i++) {
      const t = typeCycle[i % typeCycle.length];
      const seq = Math.floor(i / typeCycle.length) + 1;
      const code = `${t.baseCode + seq}`;
      const id = crypto.randomUUID();
      postableAccountIds.push(id);
      accountRows.push([
        id,
        companyId,
        code,
        `${t.label} ${seq}`,
        `Perf ${t.type} ${seq}`,
        t.type,
        headerIds.get(t.type) || null,
        true,
        true,
      ]);
    }

    await execBatchInsert(
      db,
      `INSERT INTO accounts (id, company_id, code, name_ar, name_en, account_type, parent_id, is_postable, is_active)`,
      9,
      accountRows
    );

    // 4. Company settings (wire all GL mapping accounts)
    await db.query(
      `INSERT INTO company_settings (
         company_id, default_currency_code, timezone, fiscal_year_start_month, fiscal_year_start_day,
         display_name_finance, locale,
         inventory_account_id, purchases_clearing_account_id, accounts_payable_account_id,
         accounts_receivable_account_id, sales_revenue_account_id, cogs_account_id,
         vat_payable_account_id, inventory_adjustment_account_id, opening_balance_equity_account_id,
         updated_by
       ) VALUES ($1, 'EGP', 'Africa/Cairo', 1, 1, 'Perf Finance', 'ar-EG', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        companyId,
        postableByCode.get('1300'),
        postableByCode.get('2200'),
        postableByCode.get('2100'),
        postableByCode.get('1200'),
        postableByCode.get('4100'),
        postableByCode.get('5200'),
        postableByCode.get('2300'),
        postableByCode.get('5300'),
        postableByCode.get('3200'),
        adminUserId,
      ]
    );

    // Cash register for collections
    const cashRegisterId = crypto.randomUUID();
    await db.query(
      `INSERT INTO cash_registers (id, company_id, code, name_ar, name_en, gl_account_id, is_active, opening_balance, created_by)
       VALUES ($1, $2, 'REG-01', 'الخزينة الرئيسية', 'Main Cash Register', $3, true, 100000.00, $4)`,
      [cashRegisterId, companyId, postableByCode.get('1100'), adminUserId]
    );

    // 5. Open accounting periods spanning past N months + current + next 2 months
    const now = new Date();
    const periodInfos: Array<{ id: string; code: string; startDate: string; endDate: string }> = [];
    for (let offset = -(volumes.months + 1); offset <= 2; offset++) {
      const refDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
      const range = monthRange(refDate.getUTCFullYear(), refDate.getUTCMonth());
      const pid = crypto.randomUUID();
      periodInfos.push({ id: pid, ...range });
    }
    await execBatchInsert(
      db,
      `INSERT INTO accounting_periods (id, company_id, code, start_date, end_date, is_closed)`,
      6,
      periodInfos.map((p) => [p.id, companyId, p.code, p.startDate, p.endDate, false])
    );

    // 6. Warehouses, Items, Costing Profile, Initial Stock & Valuation Balances
    const warehouseIds: string[] = [];
    const warehouseRows: unknown[][] = [];
    for (let w = 1; w <= volumes.warehouses; w++) {
      const id = crypto.randomUUID();
      warehouseIds.push(id);
      warehouseRows.push([id, companyId, `WH-${String(w).padStart(2, '0')}`, `مستودع ${w}`, `Warehouse ${w}`, true]);
    }
    await execBatchInsert(
      db,
      `INSERT INTO inv_warehouses (id, company_id, code, name_ar, name_en, is_active)`,
      6,
      warehouseRows
    );

    const itemIds: string[] = [];
    const itemRows: unknown[][] = [];
    for (let it = 1; it <= volumes.items; it++) {
      const id = crypto.randomUUID();
      itemIds.push(id);
      itemRows.push([
        id,
        companyId,
        `ITM-${String(it).padStart(4, '0')}`,
        `صنف قياس أداء ${it}`,
        `Perf Item ${it}`,
        'pcs',
        true,
      ]);
    }
    await execBatchInsert(
      db,
      `INSERT INTO inv_items (id, company_id, code, name_ar, name_en, uom, is_active)`,
      7,
      itemRows
    );

    const costingProfileId = crypto.randomUUID();
    await db.query(
      `INSERT INTO inv_costing_profiles (id, company_id, name, costing_method, is_default, is_active)
       VALUES ($1, $2, 'المتوسط المرجح المرجعي', 'PERPETUAL_MOVING_AVERAGE', true, true)`,
      [costingProfileId, companyId]
    );

    await execBatchInsert(
      db,
      `INSERT INTO inv_item_costing_profiles (company_id, item_id, profile_id, assigned_by)`,
      4,
      itemIds.map((itemId) => [companyId, itemId, costingProfileId, adminUserId])
    );

    const stockBalanceRows: unknown[][] = [];
    const valBalanceRows: unknown[][] = [];
    for (let w = 0; w < warehouseIds.length; w++) {
      for (let i = 0; i < itemIds.length; i++) {
        const qty = 5000 + ((w + i) % 500);
        const unitCost = 25 + (i % 75);
        const totalCost = qty * unitCost;
        stockBalanceRows.push([companyId, warehouseIds[w], itemIds[i], qty.toFixed(4)]);
        valBalanceRows.push([
          companyId,
          warehouseIds[w],
          itemIds[i],
          qty.toFixed(4),
          totalCost.toFixed(4),
          unitCost.toFixed(4),
        ]);
      }
    }
    await execBatchInsert(
      db,
      `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty)`,
      4,
      stockBalanceRows
    );
    await execBatchInsert(
      db,
      `INSERT INTO inv_valuation_balances (company_id, warehouse_id, item_id, quantity, total_cost, unit_cost)`,
      6,
      valBalanceRows
    );

    // 7. Customers (40) and Suppliers (20)
    const customerIds: string[] = [];
    const customerRows: unknown[][] = [];
    for (let c = 1; c <= volumes.customers; c++) {
      const id = crypto.randomUUID();
      customerIds.push(id);
      customerRows.push([
        id,
        companyId,
        `CUST-${String(c).padStart(4, '0')}`,
        `عميل تجاري ${c}`,
        `Perf Customer ${c}`,
        '01000000000',
        500000,
        true,
      ]);
    }
    await execBatchInsert(
      db,
      `INSERT INTO sales_customers (id, company_id, code, name_ar, name_en, phone, credit_limit, is_active)`,
      8,
      customerRows
    );

    const supplierIds: string[] = [];
    const supplierRows: unknown[][] = [];
    for (let s = 1; s <= volumes.suppliers; s++) {
      const id = crypto.randomUUID();
      supplierIds.push(id);
      supplierRows.push([
        id,
        companyId,
        `SUPP-${String(s).padStart(4, '0')}`,
        `مورد تجاري ${s}`,
        `Perf Supplier ${s}`,
        true,
      ]);
    }
    await execBatchInsert(
      db,
      `INSERT INTO purch_suppliers (id, company_id, code, name_ar, name_en, is_active)`,
      6,
      supplierRows
    );

    await db.query('COMMIT');

    // Helper: find matching period_id for a given ISO date
    const findPeriodId = (isoDate: string): string => {
      for (const p of periodInfos) {
        if (isoDate >= p.startDate && isoDate <= p.endDate) return p.id;
      }
      return periodInfos[periodInfos.length - 1].id;
    };

    const maxDaysSpan = volumes.months * 30;

    // 8. Journal Entries + Lines (5,000 entries -> ~10,000+ lines)
    // Must insert as 'draft', insert lines, then update to 'posted' so DB immutability/balance triggers pass.
    console.log(`[perf:seed] Seeding ${volumes.journalEntries} posted journal entries across ${volumes.months} months...`);
    const jeChunk = 500;
    for (let offset = 0; offset < volumes.journalEntries; offset += jeChunk) {
      const count = Math.min(jeChunk, volumes.journalEntries - offset);
      const jeRows: unknown[][] = [];
      const jlRows: unknown[][] = [];
      const postIds: string[] = [];
      const postNos: string[] = [];
      const postPeriods: string[] = [];

      for (let i = 0; i < count; i++) {
        const seq = offset + i + 1;
        const entryId = crypto.randomUUID();
        const ageDays = seq % maxDaysSpan;
        const entryDate = formatDateIso(daysAgo(ageDays));
        const periodId = findPeriodId(entryDate);
        const amount = (100 + ((seq * 17) % 4500)).toFixed(2);
        const accDebit = postableAccountIds[seq % postableAccountIds.length];
        const accCredit = postableAccountIds[(seq + 7) % postableAccountIds.length];

        jeRows.push([entryId, companyId, entryDate, `قيد مرجعي رقم ${seq}`, 'draft', periodId, adminUserId]);
        jlRows.push([companyId, entryId, accDebit, amount, '0.00', `مدين قيد ${seq}`]);
        jlRows.push([companyId, entryId, accCredit, '0.00', amount, `دائن قيد ${seq}`]);

        postIds.push(entryId);
        postNos.push(`JE-${String(seq).padStart(6, '0')}`);
        postPeriods.push(periodId);
      }

      await db.query('BEGIN');
      await execBatchInsert(
        db,
        `INSERT INTO journal_entries (id, company_id, entry_date, memo, status, period_id, created_by)`,
        7,
        jeRows,
        '',
        500
      );
      await execBatchInsert(
        db,
        `INSERT INTO journal_lines (company_id, entry_id, account_id, debit, credit, line_memo)`,
        6,
        jlRows,
        '',
        500
      );
      await db.query(
        `UPDATE journal_entries je
         SET status = 'posted',
             entry_no = v.entry_no,
             period_id = v.period_id::uuid,
             posted_at = NOW(),
             posted_by = $4
         FROM UNNEST($1::uuid[], $2::text[], $3::uuid[]) AS v(id, entry_no, period_id)
         WHERE je.id = v.id AND je.company_id = $5`,
        [postIds, postNos, postPeriods, adminUserId, companyId]
      );
      await db.query('COMMIT');
    }

    // 9. Purchase Receipts (2,000 posted GRNs + GRN lines + stock/valuation movements)
    console.log(`[perf:seed] Seeding ${volumes.purchaseReceipts} purchase receipts (GRN)...`);
    const grnChunk = 500;
    for (let offset = 0; offset < volumes.purchaseReceipts; offset += grnChunk) {
      const count = Math.min(grnChunk, volumes.purchaseReceipts - offset);
      const grnRows: unknown[][] = [];
      const grnLineRows: unknown[][] = [];
      const stockMovRows: unknown[][] = [];
      const valMovRows: unknown[][] = [];

      for (let i = 0; i < count; i++) {
        const seq = offset + i + 1;
        const grnId = crypto.randomUUID();
        const lineId = crypto.randomUUID();
        const supplierId = supplierIds[seq % supplierIds.length];
        const warehouseId = warehouseIds[seq % warehouseIds.length];
        const itemId = itemIds[seq % itemIds.length];
        const ageDays = seq % maxDaysSpan;
        const createdAt = daysAgo(ageDays).toISOString();
        const qty = 5 + (seq % 20);
        const unitCost = 25 + (seq % 75);
        const totalCost = qty * unitCost;
        const grnNo = `GRN-${String(seq).padStart(6, '0')}`;

        grnRows.push([
          grnId,
          companyId,
          supplierId,
          warehouseId,
          'posted',
          grnNo,
          createdAt,
          adminUserId,
          `سند استلام مرجعي ${seq}`,
          adminUserId,
          createdAt,
        ]);
        grnLineRows.push([lineId, grnId, companyId, itemId, qty.toFixed(4), unitCost.toFixed(4), 1]);
        stockMovRows.push([
          companyId,
          warehouseId,
          itemId,
          'receive',
          qty.toFixed(4),
          `استلام ${grnNo}`,
          adminUserId,
          createdAt,
        ]);
        valMovRows.push([
          companyId,
          warehouseId,
          itemId,
          'RECEIVE',
          qty.toFixed(4),
          unitCost.toFixed(4),
          totalCost.toFixed(4),
          'GRN',
          grnId,
          lineId,
          adminUserId,
          createdAt,
        ]);
      }

      await db.query('BEGIN');
      await execBatchInsert(
        db,
        `INSERT INTO purch_grn (id, company_id, supplier_id, warehouse_id, status, grn_no, posted_at, posted_by, memo, created_by, created_at)`,
        11,
        grnRows,
        '',
        500
      );
      await execBatchInsert(
        db,
        `INSERT INTO purch_grn_lines (id, grn_id, company_id, item_id, qty, unit_cost, line_no)`,
        7,
        grnLineRows,
        '',
        500
      );
      await execBatchInsert(
        db,
        `INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo, created_by, created_at)`,
        8,
        stockMovRows,
        '',
        500
      );
      await execBatchInsert(
        db,
        `INSERT INTO inv_valuation_movements (company_id, warehouse_id, item_id, movement_type, qty, unit_cost, total_cost, source_type, source_id, source_line_id, created_by, created_at)`,
        12,
        valMovRows,
        '',
        500
      );
      await db.query('COMMIT');
    }

    // 10. Sales Invoices (2,000 posted sales invoices + lines + partial collections for realistic AR Aging)
    console.log(`[perf:seed] Seeding ${volumes.salesInvoices} sales invoices + partial collections...`);
    const invChunk = 500;
    for (let offset = 0; offset < volumes.salesInvoices; offset += invChunk) {
      const count = Math.min(invChunk, volumes.salesInvoices - offset);
      const invRows: unknown[][] = [];
      const invLineRows: unknown[][] = [];
      const colRows: unknown[][] = [];
      const postIds: string[] = [];
      const postNos: string[] = [];

      for (let i = 0; i < count; i++) {
        const seq = offset + i + 1;
        const invoiceId = crypto.randomUUID();
        const customerId = customerIds[seq % customerIds.length];
        const itemId = itemIds[seq % itemIds.length];
        const ageDays = seq % maxDaysSpan;
        const invDate = daysAgo(ageDays);
        const dueDate = daysAgo(Math.max(0, ageDays - 15));
        const qty = 2 + (seq % 10);
        const unitPrice = 50 + (seq % 120);
        const subtotal = qty * unitPrice;
        const taxRate = 14;
        const taxAmount = Math.round(subtotal * 14) / 100;
        const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;
        const invoiceNo = `SINV-${String(seq).padStart(6, '0')}`;

        // Insert as draft first, attach lines, then update to posted (respects trg_sales_invoice_lines_posted_guard)
        invRows.push([
          invoiceId,
          companyId,
          customerId,
          formatDateIso(invDate),
          formatDateIso(dueDate),
          'draft',
          subtotal.toFixed(4),
          taxAmount.toFixed(4),
          totalAmount.toFixed(4),
          `فاتورة مبيعات مرجعية ${seq}`,
          adminUserId,
          invDate.toISOString(),
        ]);
        invLineRows.push([
          invoiceId,
          companyId,
          itemId,
          qty.toFixed(4),
          unitPrice.toFixed(4),
          taxRate.toFixed(2),
          taxAmount.toFixed(4),
          totalAmount.toFixed(4),
          1,
        ]);

        postIds.push(invoiceId);
        postNos.push(invoiceNo);

        // ~40% of invoices receive partial collections so AR aging exercises collection aggregation JOIN
        if (seq % 5 < 2) {
          const collected = Math.round(totalAmount * 0.5 * 100) / 100;
          colRows.push([
            companyId,
            customerId,
            invoiceId,
            cashRegisterId,
            `COL-${String(seq).padStart(6, '0')}`,
            formatDateIso(invDate),
            collected.toFixed(4),
            'posted',
            `تحصيل جزئي ${seq}`,
            invDate.toISOString(),
            adminUserId,
            adminUserId,
          ]);
        }
      }

      await db.query('BEGIN');
      await execBatchInsert(
        db,
        `INSERT INTO sales_invoices (id, company_id, customer_id, invoice_date, due_date, status, subtotal, tax_amount, total_amount, memo, created_by, created_at)`,
        12,
        invRows,
        '',
        500
      );
      await execBatchInsert(
        db,
        `INSERT INTO sales_invoice_lines (invoice_id, company_id, item_id, qty, unit_price, tax_rate, tax_amount, line_total, line_no)`,
        9,
        invLineRows,
        '',
        500
      );
      await db.query(
        `UPDATE sales_invoices si
         SET status = 'posted',
             invoice_no = v.invoice_no,
             posted_at = NOW(),
             posted_by = $3
         FROM UNNEST($1::uuid[], $2::text[]) AS v(id, invoice_no)
         WHERE si.id = v.id AND si.company_id = $4`,
        [postIds, postNos, adminUserId, companyId]
      );
      if (colRows.length > 0) {
        await execBatchInsert(
          db,
          `INSERT INTO sales_collections (company_id, customer_id, invoice_id, register_id, collection_no, collection_date, amount, status, memo, posted_at, posted_by, created_by)`,
          12,
          colRows,
          '',
          500
        );
      }
      await db.query('COMMIT');
    }

    // 11. Advance accounting_sequences past seeded counts so live HTTP posting allocates clean numbers
    await db.query(
      `INSERT INTO accounting_sequences (company_id, doc_type, prefix, next_value)
       VALUES
         ($1, 'journal_entry', 'JE', $2),
         ($1, 'goods_receipt', 'GRN', $3),
         ($1, 'sales_invoice', 'SINV', $4),
         ($1, 'sales_collection', 'COL', $5)
       ON CONFLICT (company_id, doc_type)
       DO UPDATE SET next_value = EXCLUDED.next_value, updated_at = NOW()`,
      [
        companyId,
        volumes.journalEntries + 1,
        volumes.purchaseReceipts + 1,
        volumes.salesInvoices + 1,
        volumes.salesInvoices + 1,
      ]
    );

    // 12. Run ANALYZE so planner statistics match the seeded volumes (EXPLAIN baseline integrity)
    console.log('[perf:seed] Running ANALYZE across database...');
    await db.query('ANALYZE');

    // 13. Print actual row counts per table
    const countTables = [
      'companies',
      'platform_users',
      'accounts',
      'accounting_periods',
      'inv_warehouses',
      'inv_items',
      'inv_stock_balances',
      'inv_valuation_balances',
      'inv_stock_movements',
      'inv_valuation_movements',
      'sales_customers',
      'purch_suppliers',
      'journal_entries',
      'journal_lines',
      'purch_grn',
      'purch_grn_lines',
      'sales_invoices',
      'sales_invoice_lines',
      'sales_collections',
    ];

    const actualCounts: Record<string, number> = {};
    for (const tbl of countTables) {
      const safeTbl = assertSafePgIdentifier(tbl);
      const res = await db.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM ${safeTbl}`);
      actualCounts[safeTbl] = Number.parseInt(res.rows[0]?.cnt || '0', 10);
    }

    console.log('\nActual Row Counts Per Table:');
    console.table(actualCounts);

    const reportDir = path.resolve(process.cwd(), '.test-reports/perf');
    fs.mkdirSync(reportDir, { recursive: true });
    const meta: PerfSeedMetadata = {
      dbName: perfDbName,
      companyId,
      companyCode: 'PERF_CO_01',
      username: 'perf_admin',
      volumes,
      sampleIds: {
        debitAccountId: postableByCode.get('5100')!,
        creditAccountId: postableByCode.get('1110')!,
        customerIds: customerIds.slice(0, 10),
        itemIds: itemIds.slice(0, 10),
        warehouseIds,
      },
      seededAt: new Date().toISOString(),
    };
    const metaPath = path.join(reportDir, 'seed-meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    console.log(`[perf:seed] Wrote non-secret seed metadata to ${metaPath}`);
  } finally {
    await db.end().catch(() => {});
  }
}

const isDirectCli = process.argv[1]?.endsWith('seedSynthetic.ts');
if (isDirectCli) {
  runSeedSynthetic().catch((err) => {
    const msg = redactLogText(err instanceof Error ? err.message : String(err));
    console.error('[perf:seed] FAILED:', msg);
    process.exit(1);
  });
}
