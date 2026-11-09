/**
 * CI prep: ensure managed-PG / Data API guard simulation only targets loopback DB.
 * Restores missing module referenced by foundation-ci.yml.
 * Does not mutate Supabase production.
 */
import { buildPgConfig } from '../src/server/db/connection.js';
import pg from 'pg';

export function assertLoopbackUrl(url: string, label: string): void {
  try {
    const parseStr = url.match(/^[a-zA-Z0-9+-.]+:\/\//) ? url : `postgres://${url}`;
    const u = new URL(parseStr);
    const host = u.hostname.toLowerCase();
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isLoopback) {
      throw new Error(`${label} must be loopback (localhost/127.0.0.1/::1) in CI simulate step, got: ${host}`);
    }
  } catch (err: any) {
    if (err.message?.includes('must be loopback')) {
      throw err;
    }
    throw new Error(`Failed to parse URL for loopback check (${label}): ${err?.message || err}`);
  }
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('[ciSimulateManagedPg] FATAL: no MIGRATION_DATABASE_URL/DATABASE_URL');
    process.exit(1);
  }

  assertLoopbackUrl(url, 'CI database URL');

  // Verify connectivity to ensure loopback database service is ready
  const cfg = buildPgConfig(url, process.env);
  const client = new pg.Client(cfg);
  await client.connect();
  const r = await client.query('SELECT current_user, inet_server_addr()');
  console.log('[ciSimulateManagedPg] OK loopback connect:', r.rows[0]?.current_user);
  await client.end();
}

if (process.argv[1]?.endsWith('ciSimulateManagedPg.ts')) {
  main().catch((e) => {
    console.error('[ciSimulateManagedPg] FAIL:', e.message || e);
    process.exit(1);
  });
}
