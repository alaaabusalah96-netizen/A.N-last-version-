import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import pg from 'pg';
import {
  buildBackupManifest,
  computeFileSha256,
  isBinaryAvailable,
  redactLogText,
  sanitizeConnectionUrl,
} from './backupUtils.js';

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

export async function runBackup(options?: {
  databaseUrl?: string;
  outputDir?: string;
  filePrefix?: string;
}): Promise<{ dumpPath: string; manifestPath: string }> {
  const dbUrl = (
    options?.databaseUrl ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();

  if (!dbUrl) {
    throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required to run backup.');
  }

  if (!isBinaryAvailable('pg_dump')) {
    throw new Error('pg_dump binary is not available in PATH.');
  }

  const outputDir = path.resolve(process.cwd(), options?.outputDir || 'backups');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = options?.filePrefix || 'an_erp_central';
  const fileName = `${prefix}_${stamp}.dump`;
  const dumpPath = path.join(outputDir, fileName);
  const manifestPath = `${dumpPath}.manifest.json`;

  console.log(`[backupDb] Starting pg_dump from ${sanitizeConnectionUrl(dbUrl)} -> ${dumpPath}`);

  execFileSync(
    'pg_dump',
    ['--format=custom', '--no-owner', '--no-privileges', `--file=${dumpPath}`, dbUrl],
    { stdio: 'inherit' }
  );

  let schemaMigrationsCount: number | null = null;
  let latestMigration: string | null = null;
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const migRes = await pool.query<{ cnt: string; latest: string | null }>(
      'SELECT COUNT(*)::text AS cnt, MAX(version) AS latest FROM schema_migrations'
    );
    if (migRes.rows[0]) {
      schemaMigrationsCount = Number(migRes.rows[0].cnt);
      latestMigration = migRes.rows[0].latest;
    }
  } catch (err) {
    console.warn('[backupDb] Could not query schema_migrations metadata:', redactLogText(String(err)));
  } finally {
    await pool.end();
  }

  const { sha256, byteSize } = computeFileSha256(dumpPath);
  const manifest = buildBackupManifest({
    backupFile: fileName,
    sha256,
    byteSize,
    schemaMigrationsCount,
    latestMigration,
  });

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[backupDb] Completed: ${fileName} (${byteSize} bytes, sha256=${sha256})`);
  console.log(`[backupDb] Manifest written: ${manifestPath}`);

  return { dumpPath, manifestPath };
}

const isDirectCli = process.argv[1]?.endsWith('backupDb.ts');
if (isDirectCli) {
  const args = process.argv.slice(2);
  const outputDir = getArgValue(args, '--output-dir') || 'backups';
  const sourceEnv = getArgValue(args, '--source-env');
  const databaseUrl = sourceEnv ? process.env[sourceEnv] : undefined;

  runBackup({ outputDir, databaseUrl }).catch((err) => {
    console.error('[backupDb] FAILED:', redactLogText(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
