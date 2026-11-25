import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import pg from 'pg';
import {
  assertLoopbackDatabaseUrl,
  BackupManifest,
  isBinaryAvailable,
  redactLogText,
  sanitizeConnectionUrl,
  verifyBackupManifest,
} from './backupUtils.js';

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

export interface RestoreVerifyResult {
  schemaMigrationsCount: number;
  latestMigration: string | null;
  rlsVerifiedTables: number;
}

export async function runRestore(options: {
  manifestPath: string;
  targetDatabaseUrl?: string;
  confirmRestore?: boolean;
  confirmProductionRestore?: boolean;
  confirmNonEmptyTarget?: boolean;
}): Promise<RestoreVerifyResult> {
  if (!options.confirmRestore) {
    throw new Error('Refusing destructive restore without --confirm-restore flag.');
  }

  const targetUrl = (
    options.targetDatabaseUrl ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();

  if (!targetUrl) {
    throw new Error('Target MIGRATION_DATABASE_URL or DATABASE_URL is required for restore.');
  }

  if (!options.confirmProductionRestore) {
    assertLoopbackDatabaseUrl(targetUrl, 'Target restore URL');
  }

  if (!isBinaryAvailable('pg_restore')) {
    throw new Error('pg_restore binary is not available in PATH.');
  }

  const manifestAbs = path.resolve(process.cwd(), options.manifestPath);
  if (!fs.existsSync(manifestAbs)) {
    throw new Error(`Manifest file not found: ${manifestAbs}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8')) as BackupManifest;
  const backupFilePath = path.join(path.dirname(manifestAbs), manifest.backupFile);

  const verification = verifyBackupManifest(manifest, backupFilePath);
  if (!verification.valid) {
    throw new Error(`Pre-restore checksum verification failed: ${verification.reason}`);
  }

  console.log(`[restoreDb] SHA-256 verified (${manifest.sha256}). Checking target emptiness...`);

  // Non-empty target guard: never overwrite a database that already holds tables
  // unless the operator explicitly confirms twice.
  if (!options.confirmNonEmptyTarget) {
    const guardPool = new pg.Pool({ connectionString: targetUrl });
    try {
      const tablesRes = await guardPool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'`
      );
      if (Number(tablesRes.rows[0]?.cnt || 0) > 0) {
        throw new Error(
          'Target database is not empty; refusing restore. Pass --confirm-non-empty-target to overwrite it deliberately.'
        );
      }
    } finally {
      await guardPool.end();
    }
  }


  execFileSync(
    'pg_restore',
    ['--clean', '--if-exists', '--no-owner', '--no-privileges', `--dbname=${targetUrl}`, backupFilePath],
    { stdio: 'inherit' }
  );

  // Post-restore structural, migration & RLS verification
  const pool = new pg.Pool({ connectionString: targetUrl });
  try {
    const migRes = await pool.query<{ cnt: string; latest: string | null }>(
      'SELECT COUNT(*)::text AS cnt, MAX(version) AS latest FROM schema_migrations'
    );
    const schemaMigrationsCount = Number(migRes.rows[0]?.cnt || 0);
    const latestMigration = migRes.rows[0]?.latest || null;

    if (manifest.schemaMigrationsCount !== null && schemaMigrationsCount !== manifest.schemaMigrationsCount) {
      throw new Error(
        `Post-restore migration count mismatch: expected ${manifest.schemaMigrationsCount}, got ${schemaMigrationsCount}`
      );
    }

    const rlsRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relrowsecurity = true
         AND c.relforcerowsecurity = true`
    );
    const rlsVerifiedTables = Number(rlsRes.rows[0]?.cnt || 0);
    if (rlsVerifiedTables === 0) {
      throw new Error('Post-restore RLS check failed: zero tables with ENABLE+FORCE ROW LEVEL SECURITY found.');
    }

    console.log(
      `[restoreDb] Post-restore verification PASS: migrations=${schemaMigrationsCount}, latest=${latestMigration}, rlsTables=${rlsVerifiedTables}`
    );

    return {
      schemaMigrationsCount,
      latestMigration,
      rlsVerifiedTables,
    };
  } finally {
    await pool.end();
  }
}

const isDirectCli = process.argv[1]?.endsWith('restoreDb.ts');
if (isDirectCli) {
  const args = process.argv.slice(2);
  const manifestPath = getArgValue(args, '--manifest') || '';
  const targetEnv = getArgValue(args, '--target-env');
  const confirmRestore = args.includes('--confirm-restore');
  const confirmProductionRestore = args.includes('--confirm-production-restore');
  const confirmNonEmptyTarget = args.includes('--confirm-non-empty-target');

  if (!manifestPath) {
    console.error('Usage: tsx scripts/ops/restoreDb.ts --manifest <path.manifest.json> --confirm-restore [--confirm-production-restore] [--confirm-non-empty-target]');
    process.exit(1);
  }

  runRestore({
    manifestPath,
    targetDatabaseUrl: targetEnv ? process.env[targetEnv] : undefined,
    confirmRestore,
    confirmProductionRestore,
    confirmNonEmptyTarget,
  }).catch((err) => {
    console.error('[restoreDb] FAILED:', redactLogText(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
