import crypto from 'crypto';
import fs from 'fs';
import { execFileSync } from 'child_process';

export interface BackupManifest {
  formatVersion: 1;
  createdAt: string;
  dbMode: 'central';
  backupFile: string;
  byteSize: number;
  sha256: string;
  schemaMigrationsCount: number | null;
  latestMigration: string | null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Redacts user credentials and query secrets from any PostgreSQL URL before logging.
 */
export function sanitizeConnectionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) parsed.username = 'REDACTED_TOKEN';
    if (parsed.password) parsed.password = 'REDACTED_TOKEN';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/pass|secret|token|key|auth/i.test(key)) {
        parsed.searchParams.set(key, 'REDACTED_TOKEN');
      }
    }
    return parsed.toString().replace(/REDACTED_TOKEN/g, '[REDACTED]');
  } catch {
    return 'postgresql://[REDACTED]';
  }
}

/**
 * Redacts credentials/secrets inside arbitrary error or log strings.
 */
export function redactLogText(input: string): string {
  return input
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, (match) => sanitizeConnectionUrl(match))
    .replace(/(password|secret|token|apiKey|csrfSecret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

/**
 * Enforces Hard Rule 4: destructive drill operations must target loopback PostgreSQL only.
 */
export function assertLoopbackDatabaseUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid database URL.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `[SAFETY GUARD] ${label} targets non-loopback host '${hostname}'. Destructive backup/restore drills are restricted to localhost / 127.0.0.1 / ::1.`
    );
  }
  return parsed;
}

export function assertSafePgIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier rejected: '${identifier}'`);
  }
  return identifier;
}

export function computeFileSha256(filePath: string): { sha256: string; byteSize: number } {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return {
    sha256: hash.digest('hex'),
    byteSize: buf.byteLength,
  };
}

export function buildBackupManifest(params: {
  backupFile: string;
  sha256: string;
  byteSize: number;
  schemaMigrationsCount: number | null;
  latestMigration: string | null;
}): BackupManifest {
  return {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    dbMode: 'central',
    backupFile: params.backupFile,
    byteSize: params.byteSize,
    sha256: params.sha256,
    schemaMigrationsCount: params.schemaMigrationsCount,
    latestMigration: params.latestMigration,
  };
}

export function verifyBackupManifest(
  manifest: BackupManifest,
  backupFilePath: string
): { valid: boolean; reason?: string } {
  if (manifest.formatVersion !== 1) {
    return { valid: false, reason: `Unsupported manifest formatVersion: ${String(manifest.formatVersion)}` };
  }
  if (!fs.existsSync(backupFilePath)) {
    return { valid: false, reason: `Backup artifact missing: ${backupFilePath}` };
  }
  const actual = computeFileSha256(backupFilePath);
  if (actual.byteSize !== manifest.byteSize) {
    return {
      valid: false,
      reason: `Backup byteSize mismatch (expected ${manifest.byteSize}, got ${actual.byteSize})`,
    };
  }
  if (actual.sha256 !== manifest.sha256) {
    return {
      valid: false,
      reason: `Backup SHA-256 checksum mismatch (expected ${manifest.sha256}, got ${actual.sha256})`,
    };
  }
  return { valid: true };
}

export function isBinaryAvailable(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if (err instanceof Error) {
      return false;
    }
    return false;
  }
}
