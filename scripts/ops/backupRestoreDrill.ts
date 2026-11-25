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
import { checkPgToolCompatibility } from '../helpers/pgPrerequisites.js';

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
  let createdDbs = false;

  try {
    const verRes = await adminPool.query<{ server_version_num: string }>('SHOW server_version_num;');
    const toolCompat = checkPgToolCompatibility({
      serverVersionNum: verRes.rows[0]?.server_version_num,
    });
    if (toolCompat.status !== 'PASS') {
      console.error(`[BLOCKED] ${toolCompat.reason}`);
      await adminPool.end();
      process.exit(2);
    }

    console.log(`[drill] ${toolCompat.reason}`);
    console.log(`[drill] Creating disposable DBs (${srcDb}, ${dstDb}) on ${sanitizeConnectionUrl(adminUrl)}`);
    await adminPool.query(`CREATE DATABASE ${srcDb}`);
    await adminPool.query(`CREATE DATABASE ${dstDb}`);
    createdDbs = true;

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

    // 6) Deeper source-vs-target equality: row counts, FK orphans, read-only smoke
    const eqSrcPool = new pg.Pool({ connectionString: srcUrl });
    const eqDstPool = new pg.Pool({ connectionString: dstUrl });
    try {
      for (const t of ['companies', 'accounts', 'journal_entries', 'journal_lines', 'schema_migrations']) {
        const srcCnt = await eqSrcPool.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM ${t}`);
        const dstCnt = await eqDstPool.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM ${t}`);
        if (srcCnt.rows[0]?.cnt !== dstCnt.rows[0]?.cnt) {
          throw new Error(`Row count mismatch on ${t}: source=${srcCnt.rows[0]?.cnt} restored=${dstCnt.rows[0]?.cnt}`);
        }
      }
      console.log('[PASS] Row counts match between source and restored target');

      const orphans = await eqDstPool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM journal_lines jl LEFT JOIN journal_entries je ON jl.entry_id = je.id WHERE je.id IS NULL`
      );
      if (orphans.rows[0]?.cnt !== '0') {
        throw new Error(`FK integrity failed on restored target: ${orphans.rows[0]?.cnt} orphan journal_lines`);
      }
      console.log('[PASS] FK integrity verified on restored target (0 orphan journal_lines)');

      const tbSql = `SELECT account_id, SUM(debit)::text AS d, SUM(credit)::text AS c FROM journal_lines GROUP BY account_id ORDER BY account_id`;
      const tbSrc = await eqSrcPool.query(tbSql);
      const tbDst = await eqDstPool.query(tbSql);
      if (JSON.stringify(tbSrc.rows) !== JSON.stringify(tbDst.rows)) {
        throw new Error('Read-only smoke failed: trial-balance aggregation differs between source and restored target');
      }
      console.log('[PASS] Read-only smoke on restored target matches source (trial-balance aggregation)');
    } finally {
      await eqSrcPool.end();
      await eqDstPool.end();
    }

    // 7) Corrupt-dump route test: tampered payload must be rejected before touching the target
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { backupFile: string };
    const corruptDir = path.join(workDir, 'corrupt');
    fs.mkdirSync(corruptDir, { recursive: true });
    const corruptManifestPath = path.join(corruptDir, path.basename(manifestPath));
    fs.copyFileSync(manifestPath, corruptManifestPath);
    const corruptDumpPath = path.join(corruptDir, manifest.backupFile);
    fs.copyFileSync(path.join(path.dirname(manifestPath), manifest.backupFile), corruptDumpPath);
    const fd = fs.openSync(corruptDumpPath, 'r+');
    fs.writeSync(fd, Buffer.from([0xde, 0xad]), 0, 2, 100);
    fs.closeSync(fd);
    let corruptRejected = false;
    try {
      await runRestore({ manifestPath: corruptManifestPath, targetDatabaseUrl: dstUrl, confirmRestore: true, confirmNonEmptyTarget: true });
    } catch (e) {
      corruptRejected = /SHA-256|checksum/i.test(e instanceof Error ? e.message : String(e));
    }
    if (!corruptRejected) {
      throw new Error('runRestore did not reject the tampered backup payload with a checksum error');
    }
    const intactCheck = await (async () => {
      const pool = new pg.Pool({ connectionString: dstUrl });
      try {
        return await pool.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM companies WHERE code = $1', [`DRILL_${stamp}`]);
      } finally {
        await pool.end();
      }
    })();
    if (intactCheck.rows[0]?.cnt !== '1') {
      throw new Error('Restored target was modified by the rejected corrupt-dump restore attempt');
    }
    console.log('[PASS] Corrupt dump rejected by restore route before touching target');

    // 8) Wrong-target safety: restore into a non-empty database must be refused without double confirmation
    let wrongTargetRejected = false;
    try {
      await runRestore({ manifestPath, targetDatabaseUrl: srcUrl, confirmRestore: true });
    } catch (e) {
      wrongTargetRejected = /not empty/i.test(e instanceof Error ? e.message : String(e));
    }
    if (!wrongTargetRejected) {
      throw new Error('runRestore did not refuse a non-empty target without --confirm-non-empty-target');
    }
    const srcIntact = await (async () => {
      const pool = new pg.Pool({ connectionString: srcUrl });
      try {
        return await pool.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM companies WHERE code = $1', [`DRILL_${stamp}`]);
      } finally {
        await pool.end();
      }
    })();
    if (srcIntact.rows[0]?.cnt !== '1') {
      throw new Error('Source database was modified by the refused wrong-target restore attempt');
    }
    console.log('[PASS] Wrong-target (non-empty) restore refused; source database untouched');

    console.log(
      `[PASS] Backup->Restore disposable drill succeeded (migrations=${verify.schemaMigrationsCount}, rlsTables=${verify.rlsVerifiedTables}, corruptDumpRejected=1, wrongTargetRejected=1)`
    );
  } finally {
    if (origMigUrl !== undefined) {
      process.env.MIGRATION_DATABASE_URL = origMigUrl;
    } else {
      delete process.env.MIGRATION_DATABASE_URL;
    }
    if (createdDbs) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${srcDb} WITH (FORCE)`).catch((e) => {
        console.warn('[drill] Cleanup warning:', redactLogText(String(e)));
      });
      await adminPool.query(`DROP DATABASE IF EXISTS ${dstDb} WITH (FORCE)`).catch((e) => {
        console.warn('[drill] Cleanup warning:', redactLogText(String(e)));
      });
    }
    await adminPool.end().catch(() => {});
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
