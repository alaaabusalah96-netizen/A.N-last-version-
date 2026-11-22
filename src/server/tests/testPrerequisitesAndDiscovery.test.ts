import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  checkPgToolCompatibility,
  classifyPgHbaAuthMode,
  discoverTestSuites,
  evaluateScramLiveAuthProbe,
  parsePgMajorVersion,
  parseServerMajorVersionNum,
} from '../../../scripts/helpers/pgPrerequisites.js';

describe('WP-3 Test Discovery Separation & PostgreSQL Prerequisites', () => {
  it('parses pg_dump / pg_restore major versions and server_version_num accurately', () => {
    expect(parsePgMajorVersion('pg_dump (PostgreSQL) 16.4 (Debian 16.4-1.pgdg120+1)')).toBe(16);
    expect(parsePgMajorVersion('pg_restore (PostgreSQL) 14.13')).toBe(14);
    expect(parsePgMajorVersion('')).toBeNull();
    expect(parseServerMajorVersionNum(160004)).toBe(16);
    expect(parseServerMajorVersionNum('150008')).toBe(15);
    expect(parseServerMajorVersionNum(null)).toBeNull();
  });

  it('reports BLOCKED when pg_dump/pg_restore major version mismatches PostgreSQL server major version', () => {
    const mismatch = checkPgToolCompatibility({
      serverVersionNum: 160004,
      pgDumpVersionOut: 'pg_dump (PostgreSQL) 14.13',
      pgRestoreVersionOut: 'pg_restore (PostgreSQL) 14.13',
    });
    expect(mismatch.status).toBe('BLOCKED');
    expect(mismatch.reason).toContain('PG_TOOL_VERSION_MISMATCH');
    expect(mismatch.serverMajor).toBe(16);
    expect(mismatch.pgDumpMajor).toBe(14);

    const missing = checkPgToolCompatibility({
      serverVersionNum: 160004,
      pgDumpVersionOut: null,
      pgRestoreVersionOut: null,
    });
    expect(missing.status).toBe('BLOCKED');
    expect(missing.reason).toContain('PG_TOOLS_MISSING');

    const matching = checkPgToolCompatibility({
      serverVersionNum: 160004,
      pgDumpVersionOut: 'pg_dump (PostgreSQL) 16.4',
      pgRestoreVersionOut: 'pg_restore (PostgreSQL) 16.4',
    });
    expect(matching.status).toBe('PASS');
    expect(matching.pgDumpMajor).toBe(16);
  });

  it('classifies trust/peer pg_hba modes and SCRAM live auth probe as BLOCKED instead of misleading FAIL', () => {
    const trustHba = classifyPgHbaAuthMode([
      { type: 'host', database: ['all'], user_name: ['all'], auth_method: 'trust' },
    ]);
    expect(trustHba.status).toBe('BLOCKED');
    expect(trustHba.passwordAuthActive).toBe(false);

    const scramHba = classifyPgHbaAuthMode([
      { type: 'host', database: ['all'], user_name: ['all'], auth_method: 'scram-sha-256' },
    ]);
    expect(scramHba.status).toBe('PASS');
    expect(scramHba.passwordAuthActive).toBe(true);

    const trustProbe = evaluateScramLiveAuthProbe({
      correctConnected: true,
      wrongRejected: false,
      controlRoleWrongPasswordConnected: true,
      hbaClassification: null,
    });
    expect(trustProbe.status).toBe('BLOCKED');

    const realFailureProbe = evaluateScramLiveAuthProbe({
      correctConnected: true,
      wrongRejected: false,
      controlRoleWrongPasswordConnected: false,
      hbaClassification: scramHba,
    });
    expect(realFailureProbe.status).toBe('FAIL');

    const passingProbe = evaluateScramLiveAuthProbe({
      correctConnected: true,
      wrongRejected: true,
      controlRoleWrongPasswordConnected: false,
      hbaClassification: scramHba,
    });
    expect(passingProbe.status).toBe('PASS');
  });

  it('discovers src unit test files cleanly while strictly excluding Playwright e2e specs', () => {
    const manifest = discoverTestSuites(process.cwd());
    expect(manifest.totalUnitFiles).toBeGreaterThanOrEqual(28);
    expect(manifest.totalE2eFiles).toBeGreaterThanOrEqual(1);
    expect(manifest.overlap).toEqual([]);
    expect(manifest.unitFiles.some((f) => f.startsWith('e2e/'))).toBe(false);
    expect(manifest.e2eFiles).toContain('e2e/smoke.spec.ts');

    const vitestCfg = fs.readFileSync(path.join(process.cwd(), 'vitest.config.ts'), 'utf8');
    expect(vitestCfg).toContain("'e2e/**'");
    expect(vitestCfg).toContain("'src/**/*.test.ts'");
  });

  it('ensures verifyInvAtomicBalance1 mismatch fixture runs inside tenant tx, avoids DISABLE TRIGGER, and isolates teardown errors', () => {
    const scriptSrc = fs.readFileSync(
      path.join(process.cwd(), 'scripts/verifyInvAtomicBalance1.ts'),
      'utf8'
    );
    expect(scriptSrc).not.toMatch(/DISABLE\s+TRIGGER/i);
    expect(scriptSrc).toContain('harmonizeStockAndValuationOnExecutor');
    expect(scriptSrc).toContain('seedDeliberateValuationMismatchOnExecutor');
    expect(scriptSrc).toContain('countRemainingTestInventoryRows');
    expect(scriptSrc).toContain('TEARDOWN_FAIL');

    // Mismatch warehouse seed helper must be invoked AFTER set_config in the mismatch section
    const mismatchIdx = scriptSrc.indexOf('seedDeliberateValuationMismatchOnExecutor({');
    const precedingTxSetConfig = scriptSrc.lastIndexOf("SELECT set_config('app.current_tenant_id'", mismatchIdx);
    const precedingBegin = scriptSrc.lastIndexOf("await appClient1.query('BEGIN;');", mismatchIdx);
    expect(mismatchIdx).toBeGreaterThan(-1);
    expect(precedingBegin).toBeGreaterThan(-1);
    expect(precedingTxSetConfig).toBeGreaterThan(precedingBegin);
    expect(mismatchIdx).toBeGreaterThan(precedingTxSetConfig);
  });

  it('confirms VERIFY_SESSION_SHIM and installSessionShim remain strictly confined to test scripts and CI, absent from src and server.ts', () => {
    const rootDir = process.cwd();
    const serverSrc = fs.readFileSync(path.join(rootDir, 'server.ts'), 'utf8');
    expect(serverSrc).not.toContain('VERIFY_SESSION_SHIM');
    expect(serverSrc).not.toContain('installSessionShim');

    function collectTsFiles(dir: string, acc: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'tests') {
            collectTsFiles(full, acc);
          }
        } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
          acc.push(full);
        }
      }
      return acc;
    }

    const appFiles = collectTsFiles(path.join(rootDir, 'src'));
    for (const file of appFiles) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toContain('VERIFY_SESSION_SHIM');
      expect(content).not.toContain('installSessionShim');
    }
  });
});
