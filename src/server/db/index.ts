import { ConnectionRegistry, defaultRegistry } from './ConnectionRegistry.js';
import { TenantDatabaseResolver, defaultResolver } from './TenantDatabaseResolver.js';
import { PostgresqlAdapter } from './adapters/PostgresqlAdapter.js';
import { assertSafeDbRole } from './roleGuard.js';
import { DbExecutor } from './types.js';

export * from './types.js';
export * from './DatabaseEngine.js';
export * from './ConnectionRegistry.js';
export * from './TenantDatabaseResolver.js';
export * from './tenantContext.js';
export { PostgresqlAdapter, PostgresExecutor } from './adapters/PostgresqlAdapter.js';

const executorPromiseCache: Map<string, Promise<DbExecutor>> = new Map();

async function createGuardedExecutor(config: { connectionString: string }): Promise<DbExecutor> {
  const adapter = new PostgresqlAdapter();
  const executor = await adapter.connect(config);
  try {
    await assertSafeDbRole(executor);
    const healthResult = await executor.health();
    if (!healthResult.ok) {
      throw new Error(`Database health check failed during initialization: ${healthResult.detail || 'unknown error'}`);
    }
    return executor;
  } catch (err) {
    try {
      await executor.close();
    } catch (closeErr) {
      console.error('[db] Error closing failed executor:', closeErr);
    }
    throw err;
  }
}

/**
 * Returns the default DbExecutor using PostgreSQL adapter and ConnectionRegistry.
 * Returns null if DATABASE_URL is not configured in non-production mode.
 * Throws DB_UNAVAILABLE in production if DATABASE_URL is missing or fails to connect/guard.
 */
export async function getDefaultExecutor(): Promise<DbExecutor | null> {
  const isProd = process.env.NODE_ENV === 'production';
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl || databaseUrl.trim() === '') {
    if (isProd) {
      throw new Error('DB_UNAVAILABLE: DATABASE_URL is strictly required in production mode');
    }
    return null;
  }

  const cacheKey = 'default';
  if (executorPromiseCache.has(cacheKey)) {
    return executorPromiseCache.get(cacheKey)!;
  }

  if (!defaultRegistry.has('default')) {
    defaultRegistry.register('default', { connectionString: databaseUrl });
  }

  const rawConfig = defaultRegistry.get('default') || { connectionString: databaseUrl };
  const config = {
    connectionString: rawConfig.connectionString || (rawConfig as any).url || databaseUrl,
  };

  const promise = createGuardedExecutor(config).catch((err) => {
    executorPromiseCache.delete(cacheKey);
    throw err;
  });

  executorPromiseCache.set(cacheKey, promise);
  return promise;
}

/**
 * Resolves and provides a DbExecutor for a specific company/tenant.
 * Routes through TenantDatabaseResolver and ConnectionRegistry.
 *
 * FAIL-CLOSED: Throws TENANT_CONTEXT_REQUIRED if companyId is blank or whitespace.
 */
export async function getExecutorForCompany(companyId: string): Promise<DbExecutor> {
  if (!companyId || !companyId.trim()) {
    throw new Error('TENANT_CONTEXT_REQUIRED: companyId must be provided and non-empty');
  }

  const normalizedCompanyId = companyId.trim();

  // 1) Resolve tenant reference
  const ref = defaultResolver.resolve(normalizedCompanyId);

  if (ref.mode !== 'central' && ref.connectionKey === 'default') {
    throw new Error(
      `TENANT_DB_ROUTE_MISSING: company '${normalizedCompanyId}' resolved to the central connection `
      + `while DB_MODE='${ref.mode}'. This is a fail-closed guard.`
    );
  }

  // 2) Check cache
  if (executorPromiseCache.has(ref.connectionKey)) {
    return executorPromiseCache.get(ref.connectionKey)!;
  }

  // 3) Resolve config from registry or fallback to central DATABASE_URL
  let rawConfig = defaultRegistry.get(ref.connectionKey);
  if (!rawConfig && ref.connectionKey === 'default' && ref.mode === 'central') {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl && databaseUrl.trim() !== '') {
      rawConfig = { connectionString: databaseUrl };
      defaultRegistry.register('default', rawConfig);
    }
  }

  if (!rawConfig) {
    throw new Error(`DB_UNAVAILABLE: No database configuration found for tenant connection key '${ref.connectionKey}'`);
  }

  const config = {
    connectionString: rawConfig.connectionString || (rawConfig as any).url || process.env.DATABASE_URL || '',
  };

  const cacheKey = ref.connectionKey;
  const promise = createGuardedExecutor(config).catch((err) => {
    executorPromiseCache.delete(cacheKey);
    throw err;
  });

  executorPromiseCache.set(cacheKey, promise);
  return promise;
}

/**
 * Closes all cached database executors and clears the cache
 */
export async function closeAllExecutors(): Promise<void> {
  const promises = Array.from(executorPromiseCache.values());
  executorPromiseCache.clear();

  const executors = await Promise.allSettled(promises);
  for (const result of executors) {
    if (result.status === 'fulfilled') {
      try {
        await result.value.close();
      } catch (err) {
        console.error('[db] Error closing executor during shutdown:', err);
      }
    }
  }
}
