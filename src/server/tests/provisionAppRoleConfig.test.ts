import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

describe('provisionAppRole configuration hardening', () => {
  it('exits with code 1 before any DB client/connection when DATABASE_URL is set and MIGRATION_DATABASE_URL is missing', () => {
    const tsxBin = path.resolve(
      process.cwd(),
      process.platform === 'win32' ? 'node_modules/.bin/tsx.cmd' : 'node_modules/.bin/tsx'
    );
    const scriptPath = path.resolve(process.cwd(), 'scripts/provisionAppRole.ts');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://an_app:secret@127.0.0.1:1/postgres',
      APP_DB_PASSWORD: 'a-very-strong-password-16chars',
    };
    delete env.MIGRATION_DATABASE_URL;

    const result = spawnSync(tsxBin, [scriptPath], {
      env,
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '[provision] ERROR: MIGRATION_DATABASE_URL is required. DATABASE_URL cannot be used as a fallback.'
    );
    expect(result.stderr).not.toContain('ECONNREFUSED');
    expect(result.stderr).not.toContain('[provision] FAILED');
  });

  it('static check confirms scripts/provisionAppRole.ts contains no MIGRATION_DATABASE_URL || DATABASE_URL fallback', () => {
    const filePath = path.resolve(process.cwd(), 'scripts/provisionAppRole.ts');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('const migrationDbUrl = process.env.MIGRATION_DATABASE_URL;');
    expect(source).not.toMatch(/MIGRATION_DATABASE_URL\s*\|\|\s*process\.env\.DATABASE_URL/);
    expect(source).toContain(
      'MIGRATION_DATABASE_URL is required. DATABASE_URL cannot be used as a fallback.'
    );
  });
});
