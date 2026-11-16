import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { closeAllExecutors } from '../src/server/db/index.js';

console.log('============================================================================');
console.log('=== VERIFYING AN-FOUNDATION-HARDEN-1: CASH CUSTODY FK HARDENING (043)    ===');
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

export function normalizePgColsArray(raw: string[] | string | null | undefined): string[] {
  if (Array.isArray(raw)) {
    return raw.map((c) => String(c).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const unwrapped =
      trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed.slice(1, -1) : trimmed;
    if (!unwrapped) return [];
    return unwrapped
      .split(',')
      .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
  }
  return [];
}

async function run() {
  const rootDir = process.cwd();

  // S1: Migration 038 untouched & retains its original definition
  const mig038Path = path.join(rootDir, 'database/migrations/038_cash_custody_core.sql');
  const mig038 = fs.existsSync(mig038Path) ? fs.readFileSync(mig038Path, 'utf8') : '';
  await check(
    'S1: Migration 038_cash_custody_core.sql remains present and untouched (no DDL rewrite)',
    Boolean(mig038) &&
      mig038.includes('CREATE TABLE IF NOT EXISTS cash_registers') &&
      mig038.includes('custody_receivable_account_id')
  );

  // S2: Forward migration 043_cash_custody_fk_harden.sql exists with no EXCEPTION WHEN OTHERS
  const mig043Path = path.join(rootDir, 'database/migrations/043_cash_custody_fk_harden.sql');
  const mig043Exists = fs.existsSync(mig043Path);
  const mig043 = mig043Exists ? fs.readFileSync(mig043Path, 'utf8') : '';
  const mig043NoComments = mig043
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\r\n]*/g, '');
  const noWhenOthers = !/\bEXCEPTION\s+WHEN\s+OTHERS\b/i.test(mig043NoComments);
  const cleansOrphans =
    /UPDATE\s+(public\.)?company_settings\s+cs/i.test(mig043) &&
    /SET\s+custody_receivable_account_id\s*=\s*NULL/i.test(mig043) &&
    /NOT\s+EXISTS\s*\(/i.test(mig043);
  const addsCompositeFk =
    /ADD\s+CONSTRAINT\s+company_settings_custody_account_company_fk/i.test(mig043) &&
    /FOREIGN\s+KEY\s*\(\s*custody_receivable_account_id\s*,\s*company_id\s*\)/i.test(mig043) &&
    /REFERENCES\s+(public\.)?accounts\s*\(\s*id\s*,\s*company_id\s*\)/i.test(mig043) &&
    /ON\s+DELETE\s+SET\s+NULL\s*\(\s*custody_receivable_account_id\s*\)/i.test(mig043);

  await check(
    'S2: Migration 043_cash_custody_fk_harden.sql exists without EXCEPTION WHEN OTHERS',
    mig043Exists && noWhenOthers
  );
  await check(
    'S3: Migration 043 repairs cross-company orphans to NULL before enforcing composite FK',
    cleansOrphans
  );
  await check(
    'S4: Migration 043 drops single-col FK and enforces composite FK ON DELETE SET NULL (custody_receivable_account_id)',
    addsCompositeFk && mig043.includes('pg_constraint')
  );

  // S5: PostgreSQL name[] text serialization "{col1,col2}" normalizes cleanly to array
  const parsedFromString = normalizePgColsArray('{custody_receivable_account_id,company_id}');
  const parsedFromArray = normalizePgColsArray(['custody_receivable_account_id', 'company_id']);
  await check(
    'S5: normalizePgColsArray parses both PostgreSQL "{a,b}" string and string[] safely',
    parsedFromString.length === 2 &&
      parsedFromString[0] === 'custody_receivable_account_id' &&
      parsedFromString[1] === 'company_id' &&
      parsedFromArray.length === 2 &&
      parsedFromArray[0] === 'custody_receivable_account_id'
  );

  // Live loopback PostgreSQL verification
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live Cash Custody FK hardening proof is BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  if (!isLoopbackUrl(dbUrl)) {
    blocked('Refusing destructive FK verification against non-loopback DATABASE_URL.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const migUrl = process.env.MIGRATION_DATABASE_URL;
  if (migUrl && migUrl.trim() !== '' && !isLoopbackUrl(migUrl)) {
    blocked('Refusing destructive FK verification with non-loopback MIGRATION_DATABASE_URL.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const client = new pg.Client(buildPgConfig(dbUrl, process.env));
  const createdCompanyIds: string[] = [];

  try {
    await client.connect();

    // T1: Inspect pg_constraint on company_settings -> accounts
    const fkRes = await client.query<{
      conname: string;
      confdeltype: string;
      convalidated: boolean;
      cols: string[] | string;
    }>(`
      SELECT
        c.conname,
        c.confdeltype::text AS confdeltype,
        c.convalidated,
        ARRAY(
          SELECT a.attname
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          ORDER BY k.ord
        ) AS cols
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      WHERE ns.nspname = 'public'
        AND cl.relname = 'company_settings'
        AND c.contype = 'f'
        AND c.confrelid = 'public.accounts'::regclass;
    `);

    const normalizedFks = fkRes.rows.map((r) => ({
      ...r,
      cols: normalizePgColsArray(r.cols),
    }));
    const custodyFks = normalizedFks.filter((r) => r.cols.includes('custody_receivable_account_id'));
    const singleColCustodyFk = custodyFks.find((r) => r.cols.length === 1);
    const compositeCustodyFk = custodyFks.find(
      (r) =>
        r.conname === 'company_settings_custody_account_company_fk' &&
        r.cols.length === 2 &&
        r.cols[0] === 'custody_receivable_account_id' &&
        r.cols[1] === 'company_id' &&
        r.confdeltype === 'n' &&
        r.convalidated
    );

    await check(
      'T1: Catalog has validated composite FK company_settings_custody_account_company_fk (SET NULL) and zero single-column FK on custody_receivable_account_id',
      Boolean(compositeCustodyFk) && !singleColCustodyFk,
      `fks=${JSON.stringify(custodyFks)}`
    );

    // T2: Live cross-company FK rejection (SQLSTATE 23503) & same-company + ON DELETE SET NULL proof
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const compARes = await client.query<{ id: string }>(
      "INSERT INTO companies (code, name_ar) VALUES ($1, 'شركة عهدة أ') RETURNING id;",
      [`CFKA_${suffix}`.slice(0, 20)]
    );
    const compBRes = await client.query<{ id: string }>(
      "INSERT INTO companies (code, name_ar) VALUES ($1, 'شركة عهدة ب') RETURNING id;",
      [`CFKB_${suffix}`.slice(0, 20)]
    );
    const compAId = compARes.rows[0].id;
    const compBId = compBRes.rows[0].id;
    createdCompanyIds.push(compAId, compBId);

    const accAId = crypto.randomUUID();
    const accBId = crypto.randomUUID();

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [compAId]);
    await client.query(
      "INSERT INTO accounts (id, company_id, code, name_ar, account_type, is_postable) VALUES ($1, $2, '1251', 'عهد أ', 'asset', true);",
      [accAId, compAId]
    );
    await client.query('COMMIT');

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [compBId]);
    await client.query(
      "INSERT INTO accounts (id, company_id, code, name_ar, account_type, is_postable) VALUES ($1, $2, '1252', 'عهد ب', 'asset', true);",
      [accBId, compBId]
    );
    await client.query('COMMIT');

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [compAId]);

    let crossRejectedCode = '';
    await client.query('SAVEPOINT sp_cross_fk');
    try {
      await client.query(
        'INSERT INTO company_settings (company_id, custody_receivable_account_id) VALUES ($1, $2);',
        [compAId, accBId]
      );
      await client.query('RELEASE SAVEPOINT sp_cross_fk');
    } catch (err: any) {
      crossRejectedCode = err?.code || '';
      await client.query('ROLLBACK TO SAVEPOINT sp_cross_fk');
    }

    await check(
      'T2: Assigning another company account to company_settings.custody_receivable_account_id fails with SQLSTATE 23503',
      crossRejectedCode === '23503',
      `sqlstate=${crossRejectedCode || 'NONE'}`
    );

    // Same-company insert succeeds
    await client.query(
      'INSERT INTO company_settings (company_id, custody_receivable_account_id) VALUES ($1, $2);',
      [compAId, accAId]
    );

    // Deleting referenced account sets custody_receivable_account_id = NULL without error or deleting company_settings
    await client.query('DELETE FROM accounts WHERE id = $1 AND company_id = $2;', [accAId, compAId]);
    const afterDelRes = await client.query<{
      company_id: string;
      custody_receivable_account_id: string | null;
    }>(
      'SELECT company_id, custody_receivable_account_id FROM company_settings WHERE company_id = $1;',
      [compAId]
    );
    await client.query('COMMIT');

    await check(
      'T3: Deleting same-company referenced account sets ONLY custody_receivable_account_id = NULL while preserving company_settings row',
      afterDelRes.rows.length === 1 &&
        afterDelRes.rows[0].company_id === compAId &&
        afterDelRes.rows[0].custody_receivable_account_id === null
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await check('Live Cash Custody FK Hardening unexpected error', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = migUrl && isLoopbackUrl(migUrl) ? migUrl : dbUrl;
    if (createdCompanyIds.length > 0 && cleanupUrl && isLoopbackUrl(cleanupUrl)) {
      const cleanupClient = new pg.Client(buildPgConfig(cleanupUrl, process.env));
      try {
        await cleanupClient.connect();
        await cleanupClient.query('BEGIN');
        await cleanupClient.query('DELETE FROM company_settings WHERE company_id = ANY($1::uuid[])', [createdCompanyIds]);
        await cleanupClient.query('DELETE FROM accounts WHERE company_id = ANY($1::uuid[])', [createdCompanyIds]);
        await cleanupClient.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [createdCompanyIds]);
        await cleanupClient.query('COMMIT');
      } catch (cleanupErr) {
        await cleanupClient.query('ROLLBACK').catch(() => {});
        console.warn('[verifyCashFkHardening1] Cleanup note:', cleanupErr);
      } finally {
        await cleanupClient.end().catch(() => {});
      }
    }
    await client.end().catch(() => {});
    await closeAllExecutors().catch(() => {});
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyCashFkHardening1] Fatal error:', err);
  process.exit(1);
});
