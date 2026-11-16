import fs from 'fs';
import path from 'path';
import {
  assertLoopbackDatabaseUrl,
  assertSafePgIdentifier,
  buildBackupManifest,
  computeFileSha256,
  isBinaryAvailable,
  redactLogText,
  sanitizeConnectionUrl,
  verifyBackupManifest,
} from './ops/backupUtils.js';
import { runDisposableDrill } from './ops/backupRestoreDrill.js';

let passed = 0;
let failed = 0;

function check(id: string, condition: boolean, label: string) {
  if (condition) {
    console.log(`[PASS] ${id}: ${label}`);
    passed++;
  } else {
    console.error(`[FAIL] ${id}: ${label}`);
    failed++;
  }
}

async function run() {
  console.log('=== VERIFY AN-OPS-BACKUP-RESTORE-1 (Backup, Restore & Disposable Drill Tooling) ===');
  const rootDir = process.cwd();

  const requiredFiles = [
    'docs/ops/BACKUP.md',
    'scripts/ops/backupUtils.ts',
    'scripts/ops/backupDb.ts',
    'scripts/ops/restoreDb.ts',
    'scripts/ops/backupRestoreDrill.ts',
  ];
  for (let i = 0; i < requiredFiles.length; i++) {
    const f = requiredFiles[i];
    check(`F${i + 1}`, fs.existsSync(path.join(rootDir, f)), `Required file exists: ${f}`);
  }

  // 1) Credential redaction tests (Hard Rule 4: no secrets in logs)
  const rawUrl = 'postgresql://an_admin:SuperSecretPass123@127.0.0.1:5432/an_foundation?sslmode=require';
  const redactedUrl = sanitizeConnectionUrl(rawUrl);
  check(
    'S1',
    !redactedUrl.includes('SuperSecretPass123') && redactedUrl.includes('[REDACTED]'),
    'sanitizeConnectionUrl strips credentials cleanly'
  );

  const rawLog = `Failed connecting to ${rawUrl} with password=TopSecretValue`;
  const redactedLog = redactLogText(rawLog);
  check(
    'S2',
    !redactedLog.includes('SuperSecretPass123') && !redactedLog.includes('TopSecretValue'),
    'redactLogText redacts embedded URLs and password tokens'
  );

  // 2) Loopback safety guard tests
  let loopbackOk = false;
  try {
    assertLoopbackDatabaseUrl('postgresql://postgres:pass@127.0.0.1:5432/an_test', 'test');
    assertLoopbackDatabaseUrl('postgresql://postgres:pass@localhost:5432/an_test', 'test');
    loopbackOk = true;
  } catch {
    loopbackOk = false;
  }
  check('S3', loopbackOk, 'assertLoopbackDatabaseUrl allows localhost and 127.0.0.1');

  let remoteRejected = false;
  try {
    assertLoopbackDatabaseUrl('postgresql://postgres:pass@prod.db.internal:5432/an_prod', 'test');
  } catch {
    remoteRejected = true;
  }
  check('S4', remoteRejected, 'assertLoopbackDatabaseUrl rejects non-loopback hostnames');

  // 3) SQL identifier injection prevention
  let badIdentRejected = false;
  try {
    assertSafePgIdentifier('an_drill; DROP TABLE companies;--');
  } catch {
    badIdentRejected = true;
  }
  check('S5', badIdentRejected, 'assertSafePgIdentifier rejects unsafe SQL identifiers');

  // 4) SHA-256 manifest creation, verification, and tamper detection
  const tmpDir = path.join(rootDir, '.phase_tmp', `verify_backup_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const sampleDump = path.join(tmpDir, 'sample.dump');
    fs.writeFileSync(sampleDump, 'PGDMP-TEST-PAYLOAD-AN-ERP-PLATFORM-001', 'utf8');

    const { sha256, byteSize } = computeFileSha256(sampleDump);
    const manifest = buildBackupManifest({
      backupFile: 'sample.dump',
      sha256,
      byteSize,
      schemaMigrationsCount: 46,
      latestMigration: '046_finance_ext.sql',
    });

    const validResult = verifyBackupManifest(manifest, sampleDump);
    check('M1', validResult.valid === true, 'verifyBackupManifest accepts intact backup payload');

    // Tamper 1 byte -> must fail verification
    fs.writeFileSync(sampleDump, 'PGDMP-TEST-PAYLOAD-AN-ERP-PLATFORM-999', 'utf8');
    const tamperResult = verifyBackupManifest(manifest, sampleDump);
    check(
      'M2',
      tamperResult.valid === false && Boolean(tamperResult.reason?.includes('SHA-256')),
      'verifyBackupManifest rejects tampered backup payload with SHA-256 mismatch'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
    process.exit(1);
  }

  // 5) Live disposable backup -> restore drill on loopback PostgreSQL (when available)
  const drillUrl = (
    process.env.LOCAL_PG_OWNER_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();

  if (!drillUrl || !isBinaryAvailable('pg_dump') || !isBinaryAvailable('pg_restore')) {
    console.log(
      '[BLOCKED] Local PostgreSQL URL or pg_dump/pg_restore binaries unavailable in sandbox; live backup->restore drill is BLOCKED.'
    );
    console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: 1`);
    process.exit(2);
  }

  await runDisposableDrill();
  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed} (including live drill)`);
}

run().catch((err) => {
  console.error('[verifyBackupRestore1] FAIL:', redactLogText(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
