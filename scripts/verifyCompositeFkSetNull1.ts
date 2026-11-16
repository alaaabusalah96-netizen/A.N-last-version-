import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';

console.log('============================================================================');
console.log('=== VERIFYING AN-INT-DB-FK-1: COMPOSITE FK ON DELETE SET NULL (047)      ===');
console.log('============================================================================');

function isLoopbackUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(host);
  } catch {
    return false;
  }
}

interface ExpectedFk {
  table: string;
  conname: string;
  nullableCol: string;
}

const EXPECTED_FKS: ExpectedFk[] = [
  { table: 'company_settings', conname: 'fk_company_settings_ap_account', nullableCol: 'accounts_payable_account_id' },
  { table: 'purch_returns', conname: 'fk_purch_returns_invoice', nullableCol: 'invoice_id' },
  { table: 'company_settings', conname: 'fk_company_settings_ar_account', nullableCol: 'accounts_receivable_account_id' },
  { table: 'company_settings', conname: 'fk_company_settings_sales_rev_account', nullableCol: 'sales_revenue_account_id' },
  { table: 'sales_invoices', conname: 'fk_sales_invoices_delivery', nullableCol: 'delivery_id' },
  { table: 'sales_invoice_lines', conname: 'fk_sales_invoice_lines_delivery_line', nullableCol: 'delivery_line_id' },
  { table: 'fin_bank_statement_lines', conname: 'fk_fin_bank_stmt_lines_jl', nullableCol: 'matched_journal_line_id' },
  { table: 'fin_bank_statement_lines', conname: 'fk_fin_bank_stmt_lines_recon', nullableCol: 'reconciliation_id' },
];

function normalizePgCols(raw: string[] | string | null | undefined): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const t = raw.trim();
    const inner = t.startsWith('{') && t.endsWith('}') ? t.slice(1, -1) : t;
    return inner
      ? inner.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
      : [];
  }
  return [];
}

async function run() {
  const rootDir = process.cwd();
  const mig047Path = path.join(rootDir, 'database/migrations/047_composite_fk_set_null_columns.sql');
  const exists = fs.existsSync(mig047Path);
  const sql = exists ? fs.readFileSync(mig047Path, 'utf8') : '';
  const sqlNoComments = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');

  await check('S1: Migration 047_composite_fk_set_null_columns.sql exists', exists);
  await check(
    'S2: Migration 047 does NOT contain EXCEPTION WHEN OTHERS',
    Boolean(sql) && !/\bEXCEPTION\s+WHEN\s+OTHERS\b/i.test(sqlNoComments)
  );

  for (const fk of EXPECTED_FKS) {
    const hasDrop = new RegExp(`DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${fk.conname}\\b`, 'i').test(sql);
    const hasAdd = new RegExp(
      `ADD\\s+CONSTRAINT\\s+${fk.conname}[\\s\\S]*?ON\\s+DELETE\\s+SET\\s+NULL\\s*\\(\\s*${fk.nullableCol}\\s*\\)`,
      'i'
    ).test(sql);
    await check(
      `S3(${fk.conname}): Drops and re-adds with ON DELETE SET NULL (${fk.nullableCol})`,
      hasDrop && hasAdd
    );
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live pg_catalog verification for 047 is BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  if (!isLoopbackUrl(dbUrl)) {
    blocked('Refusing live verification against non-loopback DATABASE_URL.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const client = new pg.Client(buildPgConfig(dbUrl, process.env));
  try {
    await client.connect();
    const res = await client.query<{
      conname: string;
      relname: string;
      confdeltype: string;
      convalidated: boolean;
      delcols: string[] | string | null;
    }>(
      `
      SELECT
        c.conname,
        cl.relname,
        c.confdeltype::text AS confdeltype,
        c.convalidated,
        ARRAY(
          SELECT a.attname
          FROM unnest(COALESCE(c.confdelsetcols, ARRAY[]::smallint[])) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          ORDER BY k.ord
        ) AS delcols
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      WHERE ns.nspname = 'public'
        AND c.contype = 'f'
        AND c.conname = ANY($1::text[])
      `,
      [EXPECTED_FKS.map((f) => f.conname)]
    );

    const byName = new Map(res.rows.map((r) => [r.conname, { ...r, delcols: normalizePgCols(r.delcols) }]));
    for (const fk of EXPECTED_FKS) {
      const row = byName.get(fk.conname);
      await check(
        `L(${fk.conname}): Validated ON DELETE SET NULL strictly targets [${fk.nullableCol}]`,
        Boolean(
          row &&
            row.relname === fk.table &&
            row.confdeltype === 'n' &&
            row.convalidated &&
            row.delcols.length === 1 &&
            row.delcols[0] === fk.nullableCol
        ),
        row ? JSON.stringify(row) : 'MISSING_FROM_CATALOG'
      );
    }
  } finally {
    await client.end().catch(() => {});
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyCompositeFkSetNull1] Fatal error:', err);
  process.exit(1);
});
