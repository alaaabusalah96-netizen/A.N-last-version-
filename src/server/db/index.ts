import { DatabaseEngine } from './DatabaseEngine.js';
import { ConnectionRegistry, defaultRegistry } from './ConnectionRegistry.js';
import { TenantDatabaseResolver, defaultResolver } from './TenantDatabaseResolver.js';
import { PostgresqlAdapter } from './adapters/PostgresqlAdapter.js';
import { assertSafeDbRole } from './roleGuard.js';
import { DatabaseMode, DbExecutor, QueryResult, TenantDbRef } from './types.js';

export * from './types.js';
export * from './DatabaseEngine.js';
export * from './ConnectionRegistry.js';
export * from './TenantDatabaseResolver.js';
export * from './tenantContext.js';
export { PostgresqlAdapter, PostgresExecutor } from './adapters/PostgresqlAdapter.js';

const executorCache: Map<string, DbExecutor> = new Map();

/**
 * Returns the default DbExecutor using PostgreSQL adapter and ConnectionRegistry.
 * Returns null if DATABASE_URL is not configured in development mode.
 * Throws DB_UNAVAILABLE in production if DATABASE_URL is missing or fails to connect.
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

  if (executorCache.has('default')) {
    return executorCache.get('default')!;
  }

  if (!defaultRegistry.has('default')) {
    defaultRegistry.register('default', { connectionString: databaseUrl });
  }

  const config = defaultRegistry.get('default') || { connectionString: databaseUrl };
  const adapter = new PostgresqlAdapter();

  try {
    const executor = await adapter.connect(config);
    await assertSafeDbRole(executor);
    executorCache.set('default', executor);
    return executor;
  } catch (err: unknown) {
    console.error('[db] Failed to initialize default PostgreSQL executor:', err);
    if (isProd) {
      throw new Error('DB_UNAVAILABLE: Failed to connect to default PostgreSQL database in production');
    }
    return null;
  }
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

  // 2) Check cache
  if (executorCache.has(ref.connectionKey)) {
    return executorCache.get(ref.connectionKey)!;
  }

  // 3) Resolve config from registry or fallback to central DATABASE_URL
  let config = defaultRegistry.get(ref.connectionKey);
  if (!config && ref.connectionKey === 'default') {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl && databaseUrl.trim() !== '') {
      config = { connectionString: databaseUrl };
      defaultRegistry.register('default', config);
    }
  }

  if (!config) {
    throw new Error(`DB_UNAVAILABLE: No database configuration found for tenant connection key '${ref.connectionKey}'`);
  }

  // 4) Connect via adapter, guard role, and cache
  const adapter = new PostgresqlAdapter();
  try {
    const executor = await adapter.connect(config);
    try {
      await assertSafeDbRole(executor);
    } catch (guardErr) {
      await executor.close();
      throw guardErr;
    }
    executorCache.set(ref.connectionKey, executor);
    return executor;
  } catch (err: unknown) {
    console.error(`[db] Failed to initialize/guard executor for connection key: '${ref.connectionKey}'`, err);
    throw err instanceof Error && err.message.includes('dbRoleGuard')
      ? err
      : new Error(`DB_UNAVAILABLE: Failed to connect to database for tenant key '${ref.connectionKey}'`);
  }
}

/**
 * Closes all cached database executors and clears the cache
 */
export async function closeAllExecutors(): Promise<void> {
  for (const [key, executor] of executorCache.entries()) {
    try {
      await executor.close();
    } catch (err) {
      console.error(`[db] Error closing executor for key '${key}':`, err);
    }
  }
  executorCache.clear();
}
