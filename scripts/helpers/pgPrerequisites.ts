import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface PgToolCompatibilityResult {
  status: 'PASS' | 'BLOCKED';
  pgDumpAvailable: boolean;
  pgRestoreAvailable: boolean;
  pgDumpMajor: number | null;
  pgRestoreMajor: number | null;
  serverMajor: number | null;
  reason: string;
}

export interface PgHbaRuleInput {
  type?: string;
  database?: string[];
  user_name?: string[];
  auth_method?: string;
  error?: string | null;
}

export interface PgHbaClassification {
  status: 'PASS' | 'BLOCKED' | 'UNKNOWN';
  passwordAuthActive: boolean;
  activeMethods: string[];
  reason: string;
}

export interface TestSuiteDiscoveryManifest {
  rootDir: string;
  unitFiles: string[];
  e2eFiles: string[];
  overlap: string[];
  totalUnitFiles: number;
  totalE2eFiles: number;
}

/**
 * Extracts the PostgreSQL major version from CLI `--version` output
 * such as "pg_dump (PostgreSQL) 16.4 (Debian 16.4-1.pgdg120+1)" or "pg_restore (PostgreSQL) 14.13".
 */
export function parsePgMajorVersion(versionOutput: string | null | undefined): number | null {
  if (!versionOutput || typeof versionOutput !== 'string') return null;
  const trimmed = versionOutput.trim();
  if (!trimmed) return null;

  const explicitPgMatch = trimmed.match(/\(PostgreSQL\)\s+(\d+)(?:\.\d+)?/i);
  if (explicitPgMatch) {
    return Number.parseInt(explicitPgMatch[1], 10);
  }

  const genericMatch = trimmed.match(/\b(\d+)(?:\.\d+)+\b/);
  if (genericMatch) {
    return Number.parseInt(genericMatch[1], 10);
  }

  return null;
}

/**
 * Converts PostgreSQL `server_version_num` (e.g. 160004 or "160004") into major version (16).
 */
export function parseServerMajorVersionNum(serverVersionNum: number | string | null | undefined): number | null {
  if (serverVersionNum === null || serverVersionNum === undefined) return null;
  const numeric = typeof serverVersionNum === 'number'
    ? serverVersionNum
    : Number.parseInt(String(serverVersionNum).trim(), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric / 10000);
}

function readBinaryVersionOutput(cmd: string): string | null {
  try {
    return execFileSync(cmd, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Verifies pg_dump and pg_restore existence and major-version compatibility against the target PG server.
 * Missing tools or major-version mismatch emit `BLOCKED` (never silent failure or misleading pass).
 */
export function checkPgToolCompatibility(params?: {
  serverVersionNum?: number | string | null;
  pgDumpVersionOut?: string | null;
  pgRestoreVersionOut?: string | null;
}): PgToolCompatibilityResult {
  const dumpOut = params && 'pgDumpVersionOut' in params
    ? (params.pgDumpVersionOut ?? null)
    : readBinaryVersionOutput('pg_dump');
  const restoreOut = params && 'pgRestoreVersionOut' in params
    ? (params.pgRestoreVersionOut ?? null)
    : readBinaryVersionOutput('pg_restore');

  const pgDumpAvailable = Boolean(dumpOut);
  const pgRestoreAvailable = Boolean(restoreOut);
  const pgDumpMajor = parsePgMajorVersion(dumpOut);
  const pgRestoreMajor = parsePgMajorVersion(restoreOut);
  const serverMajor = parseServerMajorVersionNum(params?.serverVersionNum ?? null);

  if (!pgDumpAvailable || !pgRestoreAvailable) {
    const missing: string[] = [];
    if (!pgDumpAvailable) missing.push('pg_dump');
    if (!pgRestoreAvailable) missing.push('pg_restore');
    return {
      status: 'BLOCKED',
      pgDumpAvailable,
      pgRestoreAvailable,
      pgDumpMajor,
      pgRestoreMajor,
      serverMajor,
      reason: `PG_TOOLS_MISSING: Missing required PostgreSQL client tools (${missing.join(', ')}).`,
    };
  }

  if (pgDumpMajor === null || pgRestoreMajor === null) {
    return {
      status: 'BLOCKED',
      pgDumpAvailable,
      pgRestoreAvailable,
      pgDumpMajor,
      pgRestoreMajor,
      serverMajor,
      reason: `PG_TOOL_VERSION_UNPARSABLE: Unable to parse major versions (pg_dump='${dumpOut}', pg_restore='${restoreOut}').`,
    };
  }

  if (pgDumpMajor !== pgRestoreMajor) {
    return {
      status: 'BLOCKED',
      pgDumpAvailable,
      pgRestoreAvailable,
      pgDumpMajor,
      pgRestoreMajor,
      serverMajor,
      reason: `PG_TOOL_VERSION_MISMATCH: pg_dump major (${pgDumpMajor}) != pg_restore major (${pgRestoreMajor}).`,
    };
  }

  if (serverMajor !== null && (pgDumpMajor < serverMajor || pgDumpMajor !== serverMajor)) {
    return {
      status: 'BLOCKED',
      pgDumpAvailable,
      pgRestoreAvailable,
      pgDumpMajor,
      pgRestoreMajor,
      serverMajor,
      reason: `PG_TOOL_VERSION_MISMATCH: Server is PostgreSQL ${serverMajor}, but pg_dump/pg_restore client is major ${pgDumpMajor}. Install postgresql-client-${serverMajor}.`,
    };
  }

  return {
    status: 'PASS',
    pgDumpAvailable,
    pgRestoreAvailable,
    pgDumpMajor,
    pgRestoreMajor,
    serverMajor,
    reason: serverMajor !== null
      ? `pg_dump and pg_restore major ${pgDumpMajor} match PostgreSQL server major ${serverMajor}.`
      : `pg_dump and pg_restore major ${pgDumpMajor} detected.`,
  };
}

const PASSWORD_AUTH_METHODS = new Set(['scram-sha-256', 'md5', 'password']);
const PASSWORDLESS_AUTH_METHODS = new Set(['trust', 'peer', 'ident']);

/**
 * Classifies active `pg_hba_file_rules` rows to determine whether PostgreSQL enforces
 * password verification (e.g. `scram-sha-256`) or runs in passwordless `trust` / `peer` mode.
 */
export function classifyPgHbaAuthMode(rules: PgHbaRuleInput[]): PgHbaClassification {
  const validRules = rules.filter((r) => !r.error && r.auth_method);
  const activeMethods = Array.from(
    new Set(validRules.map((r) => String(r.auth_method).toLowerCase().trim()))
  );

  if (activeMethods.length === 0) {
    return {
      status: 'UNKNOWN',
      passwordAuthActive: false,
      activeMethods: [],
      reason: 'No readable pg_hba_file_rules entries available.',
    };
  }

  const tcpRules = validRules.filter((r) => {
    const t = String(r.type || '').toLowerCase();
    return t === 'host' || t === 'hostssl' || t === 'hostnossl' || t === '';
  });
  const effectiveRules = tcpRules.length > 0 ? tcpRules : validRules;
  const effectiveMethods = Array.from(
    new Set(effectiveRules.map((r) => String(r.auth_method).toLowerCase().trim()))
  );

  const hasPasswordMethod = effectiveMethods.some((m) => PASSWORD_AUTH_METHODS.has(m));
  const onlyPasswordless = effectiveMethods.every((m) => PASSWORDLESS_AUTH_METHODS.has(m));

  if (onlyPasswordless) {
    return {
      status: 'BLOCKED',
      passwordAuthActive: false,
      activeMethods: effectiveMethods,
      reason: `PG_HBA_NON_PASSWORD_AUTH: PostgreSQL pg_hba rules use passwordless auth (${effectiveMethods.join(', ')}); password rejection tests cannot run meaningfully under trust/peer auth.`,
    };
  }

  if (hasPasswordMethod) {
    return {
      status: 'PASS',
      passwordAuthActive: true,
      activeMethods: effectiveMethods,
      reason: `Password authentication enabled (${effectiveMethods.join(', ')}).`,
    };
  }

  return {
    status: 'UNKNOWN',
    passwordAuthActive: false,
    activeMethods: effectiveMethods,
    reason: `Unclassified pg_hba auth methods: ${effectiveMethods.join(', ')}`,
  };
}

/**
 * Evaluates live SCRAM auth probe results. Distinguishes non-password `trust` environments
 * (`BLOCKED`) from genuine SCRAM verifier failures (`FAIL`).
 */
export function evaluateScramLiveAuthProbe(params: {
  correctConnected: boolean;
  wrongRejected: boolean;
  controlRoleWrongPasswordConnected: boolean;
  hbaClassification?: PgHbaClassification | null;
}): { status: 'PASS' | 'FAIL' | 'BLOCKED'; reason: string } {
  if (params.controlRoleWrongPasswordConnected || params.hbaClassification?.status === 'BLOCKED') {
    return {
      status: 'BLOCKED',
      reason: params.hbaClassification?.reason ||
        'PG_HBA_TRUST_ACTIVE: Control PostgreSQL role connected with an intentionally wrong password; server uses trust/passwordless authentication.',
    };
  }

  if (!params.correctConnected) {
    return {
      status: 'FAIL',
      reason: 'SCRAM verifier failed to authenticate with the correct password.',
    };
  }

  if (!params.wrongRejected) {
    return {
      status: 'FAIL',
      reason: 'PostgreSQL accepted the wrong password for the SCRAM test role while rejecting wrong passwords on the control role.',
    };
  }

  return {
    status: 'PASS',
    reason: 'Live PostgreSQL authenticated valid password and rejected invalid password under password-enforced auth.',
  };
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.git' ||
      entry.name === '.phase_tmp' ||
      entry.name === '.test-reports'
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Produces an inventory of unit test files under `src/` vs Playwright E2E specs under `e2e/`
 * matching `vitest.config.ts` and `playwright.config.ts`, verifying zero overlap.
 */
export function discoverTestSuites(rootDir = process.cwd()): TestSuiteDiscoveryManifest {
  const srcFiles = walkFiles(path.join(rootDir, 'src'));
  const e2eDirFiles = walkFiles(path.join(rootDir, 'e2e'));

  const unitFiles = srcFiles
    .map((f) => path.relative(rootDir, f).replace(/\\/g, '/'))
    .filter((rel) => /\.(test)\.(ts|tsx)$/i.test(rel))
    .sort();

  const e2eFiles = e2eDirFiles
    .map((f) => path.relative(rootDir, f).replace(/\\/g, '/'))
    .filter((rel) => /\.(spec|test)\.(ts|tsx)$/i.test(rel))
    .sort();

  const unitSet = new Set(unitFiles);
  const overlap = e2eFiles.filter((f) => unitSet.has(f));

  return {
    rootDir,
    unitFiles,
    e2eFiles,
    overlap,
    totalUnitFiles: unitFiles.length,
    totalE2eFiles: e2eFiles.length,
  };
}
