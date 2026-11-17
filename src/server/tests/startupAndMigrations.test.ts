import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('server startup REQUIRE_DB and migration isolation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.MIGRATION_DATABASE_URL;
    delete process.env.REQUIRE_DB;
    delete process.env.PLATFORM_ADMIN_USERNAME;
    delete process.env.PLATFORM_ADMIN_PASSWORD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function setupServerMocks(options: {
    getDefaultExecutorImpl?: () => Promise<unknown>;
    assertSafeDbRoleImpl?: () => Promise<void>;
  }) {
    const listenMock = vi.fn((_port: number, _host: string, cb?: () => void) => {
      cb?.();
      return { close: vi.fn((done?: () => void) => done?.()) };
    });
    const runMigrationsSpy = vi.fn().mockResolvedValue(undefined);
    const getDefaultExecutorMock = vi.fn(
      options.getDefaultExecutorImpl ?? (async () => null)
    );
    const assertSafeDbRoleMock = vi.fn(
      options.assertSafeDbRoleImpl ?? (async () => {})
    );

    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('../app.js', () => ({
      createApp: () => ({ listen: listenMock }),
    }));
    vi.doMock('../auth/authService.js', () => ({
      defaultAuthService: { bootstrapPlatformAdminFromEnv: vi.fn() },
    }));
    vi.doMock('../auth/sessionRepository.js', () => ({
      defaultSessionRepository: { purgeExpired: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../security/rateLimitStore.js', () => ({
      defaultRateLimitStore: { purgeOld: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../db/index.js', () => ({
      closeAllExecutors: vi.fn().mockResolvedValue(undefined),
      getDefaultExecutor: getDefaultExecutorMock,
    }));
    vi.doMock('../db/roleGuard.js', () => ({
      assertSafeDbRole: assertSafeDbRoleMock,
    }));
    vi.doMock('../db/migrationRunner.js', () => ({
      runMigrations: runMigrationsSpy,
    }));

    return {
      listenMock,
      runMigrationsSpy,
      getDefaultExecutorMock,
      assertSafeDbRoleMock,
    };
  }

  it('continues startup in development when REQUIRE_DB is unset and no DB executor is configured', async () => {
    process.env.NODE_ENV = 'development';
    const { listenMock, runMigrationsSpy } = setupServerMocks({
      getDefaultExecutorImpl: async () => null,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process, 'on').mockImplementation((() => process) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('../../../server.js');
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    expect(exitSpy).not.toHaveBeenCalled();
    expect(runMigrationsSpy).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) in development when REQUIRE_DB=1 and DB executor is missing', async () => {
    process.env.NODE_ENV = 'development';
    process.env.REQUIRE_DB = '1';
    const { listenMock } = setupServerMocks({
      getDefaultExecutorImpl: async () => null,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process, 'on').mockImplementation((() => process) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('../../../server.js');
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('DATABASE_URL is required but no database executor is available')
    );
  });

  it('calls process.exit(1) when REQUIRE_DB=true and startup guard throws', async () => {
    process.env.NODE_ENV = 'development';
    process.env.REQUIRE_DB = 'true';
    const { listenMock } = setupServerMocks({
      getDefaultExecutorImpl: async () => ({ health: async () => ({ ok: true }) }),
      assertSafeDbRoleImpl: async () => {
        throw new Error('unsafe role');
      },
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process, 'on').mockImplementation((() => process) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('../../../server.js');
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[server] Startup guard failure:',
      expect.any(Error)
    );
  });

  it('calls process.exit(1) in production when DB executor is missing even if REQUIRE_DB is unset', async () => {
    process.env.NODE_ENV = 'production';
    const { listenMock } = setupServerMocks({
      getDefaultExecutorImpl: async () => null,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process, 'on').mockImplementation((() => process) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('../../../server.js');
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('never runs migrations during startup even when MIGRATION_DATABASE_URL is set', async () => {
    process.env.NODE_ENV = 'development';
    process.env.MIGRATION_DATABASE_URL = 'postgresql://postgres:pass@localhost:5432/db';
    const { listenMock, runMigrationsSpy } = setupServerMocks({
      getDefaultExecutorImpl: async () => null,
    });

    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process, 'on').mockImplementation((() => process) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('../../../server.js');
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    expect(runMigrationsSpy).not.toHaveBeenCalled();
  });

  it('static & import-boundary check confirms server.ts does not import or invoke runMigrations and keeps package.json migrate script intact', () => {
    const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
    expect(serverSource).not.toContain('runMigrations');
    expect(serverSource).not.toContain('migrationRunner');
    expect(serverSource).not.toContain('MIGRATION_DATABASE_URL');
    expect(serverSource).toContain('requireDb');
    expect(serverSource).toContain('!healthOk && requireDb');
    expect(serverSource).toContain('else if (requireDb)');
    expect(serverSource).toContain('if (requireDb) {\n      process.exit(1);');

    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.scripts.migrate).toBe('tsx scripts/migrate.ts');
    expect(pkg.scripts['db:provision-app-role']).toBe('tsx scripts/provisionAppRole.ts');
  });
});
