import { DatabaseEngine } from './DatabaseEngine.js';
import { ConnectionRegistry, defaultRegistry } from './ConnectionRegistry.js';
import { TenantDatabaseResolver, defaultResolver } from './TenantDatabaseResolver.js';
import { PostgresqlAdapter } from './adapters/PostgresqlAdapter.js';
import { DatabaseMode, DbExecutor, QueryResult, TenantDbRef } from './types.js';

export * from './types.js';
export * from './DatabaseEngine.js';
export * from './ConnectionRegistry.js';
export * from './TenantDatabaseResolver.js';
export * from './tenantContext.js';
export { PostgresqlAdapter } from './adapters/PostgresqlAdapter.js';

const executorCache: Map<string, DbExecutor> = new Map();

/**
 * Returns the default DbExecutor using PostgreSQL adapter and ConnectionRegistry.
 * Returns null if DATABASE_URL is not configured (graceful degradation in development).
 */
export async function getDefaultExecutor(): Promise<DbExecutor | null> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    return null;
  }

  if (executorCache.has('default')) {
    return executorCache.get('default')!;
  }

  // Register default connection configuration if not already present
  if (!defaultRegistry.has('default')) {
    defaultRegistry.register('default', { connectionString: databaseUrl });
  }

  const config = defaultRegistry.get('default') || { connectionString: databaseUrl };
  const adapter = new PostgresqlAdapter();

  try {
    const executor = await adapter.connect(config);
    executorCache.set('default', executor);
    return executor;
  } catch (err: unknown) {
    console.error('[db] Failed to initialize default PostgreSQL executor');
    return null;
  }
}

/**
 * Resolves and provides a DbExecutor for a specific company/tenant.
 * Routes through TenantDatabaseResolver and ConnectionRegistry.
 *
 * FAIL-CLOSED: Refuses to return a default executor if companyId is empty or whitespace.
 */
export async function getExecutorForCompany(companyId: string): Promise<DbExecutor | null> {
  if (!companyId || !companyId.trim()) {
    console.error('[db] getExecutorForCompany: companyId must be a non-empty string. Refusing fallback to default (fail-closed).');
    return null;
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
    return null;
  }

  // 4) Connect via adapter and cache
  const adapter = new PostgresqlAdapter();
  try {
    const executor = await adapter.connect(config);
    executorCache.set(ref.connectionKey, executor);
    return executor;
  } catch (err: unknown) {
    console.error(`[db] Failed to initialize executor for connection key: '${ref.connectionKey}'`);
    return null;
  }
}
