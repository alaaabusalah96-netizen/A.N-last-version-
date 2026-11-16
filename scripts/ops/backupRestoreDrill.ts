import fs from 'fs';
import path from 'path';
import pg from 'pg';
import {
  assertLoopbackDatabaseUrl,
  assertSafePgIdentifier,
  isBinaryAvailable,
  redactLogText,
  sanitizeConnectionUrl,
} from './backupUtils.js';
import { runBackup } from './backupDb.js';
import { runRestore } from './restoreDb.js';
import { runMigrations } from '../../src/server/db/migrationRunner.js';

function replaceUrlDatabase(parsed: URL, dbName: string): string {
  const clone = new URL(parsed.toString());
  clone.pathname = `/${dbName}`;
  return clone.toString();
}

export async function runDisposableDrill(): Promise<void> {
  const adminUrl = (
    process.env.LOCAL_PG_OWNER_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();

  if (!adminUrl) {
    console.log('[BLOCKED] LOCAL_PG_OWNER_URL / MIGRATION_DATABASE_URL / DATABASE_URL not set; live backup->restore drill is BLOCKED.');
    process.exit(2);
  }

  const parsedAdmin = assertLoopbackDatabaseUrl(adminUrl, 'Backup/Restore Drill DB URL');

  if (!isBinaryAvailable('pg_dump') || !isBinaryAvailable('pg_restore')) {
    console.log('[BLOCKED] pg_dump / pg_restore binaries not installed in environment; live drill is BLOCKED.');
    process.exit(2);
  }

  const stamp = Date.now();
  const srcDb = assertSafePgIdentifier(`an_drill_src_${stamp}`);
  const dstDb = assertSafePgIdentifier(`an_drill_dst_${stamp}`);
  const workDir = path.resolve(process.cwd(), '.phase_tmp', `drill_${stamp}`);

  const adminPool = new pg.Pool({ connectionString: adminUrl });
  const srcUrl = replaceUrlDatabase(parsedAdmin, srcDb);
  const dstUrl = replaceUrlDatabase(parsedAdmin, dstDb);
  const origMigUrl = process.env.MIGRATION_DATABASE_URL;

  try {
    console.log(`[drill] Creating disposable DBs (${srcDb}, ${dstDb}) on ${sanitizeConnectionUrl(adminUrl)}`);
    await adminPool.query(`CREATE DATABASE ${srcDb}`);
    await adminPool.query(`CREATE DATABASE ${dstDb}`);

    // 1) Apply migrations to source disposable DB
    process.env.MIGRATION_DATABASE_URL = srcUrl;
    await runMigrations();

    // 2) Insert disposable verification marker inside companies table
    const srcPool = new pg.Pool({ connectionString: srcUrl });
    try {
      await srcPool.query(
        `INSERT INTO companies (code, name_ar, name_en, is_active) VALUES ($1, $2, $3, true)`,
        [`DRILL_${stamp}`, 'شركة تمرين النسخ الاحتياطي', 'Backup Drill Co']
      );
    } finally {
      await srcPool.end();
    }

    // 3) Run backup
    const { manifestPath } = await runBackup({
      databaseUrl: srcUrl,
      outputDir: workDir,
      filePrefix: 'drill_central',
    });

    // 4) Run restore into fresh target DB + post-restore verification
    const verify = await runRestore({
      manifestPath,
      targetDatabaseUrl: dstUrl,
      confirmRestore: true,
    });

    // 5) Confirm marker row survived backup->restore cycle
    const dstPool = new pg.Pool({ connectionString: dstUrl });
    try {
      const checkRes = await dstPool.query<{ code: string }>(
        'SELECT code FROM companies WHERE code = $1',
        [`DRILL_${stamp}`]
      );
      if (checkRes.rows.length !== 1) {
        throw new Error('Restored target DB did not contain backup marker company row.');
      }
    } finally {
      await dstPool.end();
    }

    console.log(
      `[PASS] Backup->Restore disposable drill succeeded (migrations=${verify.schemaMigrationsCount}, rlsTables=${verify.rlsVerifiedTables})`
    );
  } finally {
    if (origMigUrl !== undefined) {
      process.env.MIGRATION_DATABASE_URL = origMigUrl;
    } else {
      delete process.env.MIGRATION_DATABASE_URL;
    }
    await adminPool.query(`DROP DATABASE IF EXISTS ${srcDb} WITH (FORCE)`).catch((e) => {
      console.warn('[drill] Cleanup warning:', redactLogText(String(e)));
    });
    await adminPool.query(`DROP DATABASE IF EXISTS ${dstDb} WITH (FORCE)`).catch((e) => {
      console.warn('[drill] Cleanup warning:', redactLogText(String(e)));
    });
    await adminPool.end();
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

const isDirectCli = process.argv[1]?.endsWith('backupRestoreDrill.ts');
if (isDirectCli) {
  runDisposableDrill().catch((err) => {
    console.error('[drill] FAILED:', redactLogText(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
