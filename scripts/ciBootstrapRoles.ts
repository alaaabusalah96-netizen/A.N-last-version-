import pg from 'pg';
import { buildPgConfig } from '../src/server/db/connection.js';

export async function bootstrapRoles(): Promise<void> {
  const connectionString =
    process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('[ciBootstrapRoles] FATAL: MIGRATION_DATABASE_URL or DATABASE_URL is required.');
    process.exit(1);
  }

  const pgConfig = buildPgConfig(connectionString, process.env);
  const client = new pg.Client(pgConfig);

  console.log('[ciBootstrapRoles] Connecting to database to bootstrap stub Supabase roles...');
  await client.connect();

  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
          RAISE NOTICE 'Created stub role: anon';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
          RAISE NOTICE 'Created stub role: authenticated';
        END IF;
      END
      $$;
    `);
    console.log('[ciBootstrapRoles] Successfully verified / created stub roles: anon, authenticated (NOLOGIN).');
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith('ciBootstrapRoles.ts')) {
  bootstrapRoles().catch((err) => {
    console.error('[ciBootstrapRoles] FATAL execution error:', err.message);
    process.exit(1);
  });
}
