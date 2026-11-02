import { DatabaseEngine } from './DatabaseEngine.js';
import { ConnectionRegistry, defaultRegistry } from './ConnectionRegistry.js';
import { TenantDatabaseResolver, defaultResolver } from './TenantDatabaseResolver.js';
import { PostgresqlAdapter } from './adapters/PostgresqlAdapter.js';
import { DatabaseMode, DbExecutor, QueryResult, TenantDbRef } from './types.js';

export * from './types.js';
export * from './DatabaseEngine.js';
export * from './ConnectionRegistry.js';
export * from './TenantDatabaseResolver.js';
export { PostgresqlAdapter } from './adapters/PostgresqlAdapter.js';

let cachedDefaultExecutor: DbExecutor | null = null;

/**
 * Returns the default DbExecutor using PostgreSQL adapter and ConnectionRegistry.
 * Returns null if DATABASE_URL is not configured (graceful degradation in P02a).
 */
export async function getDefaultExecutor(): Promise<DbExecutor | null> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    return null;
  }

  if (cachedDefaultExecutor) {
    return cachedDefaultExecutor;
  }

  // Register default connection configuration if not already present
  if (!defaultRegistry.has('default')) {
    defaultRegistry.register('default', { connectionString: databaseUrl });
  }

  const config = defaultRegistry.get('default') || { connectionString: databaseUrl };
  const adapter = new PostgresqlAdapter();

  try {
    cachedDefaultExecutor = await adapter.connect(config);
    return cachedDefaultExecutor;
  } catch (err) {
    console.error('[db] Failed to initialize default PostgreSQL executor:', err);
    return null;
  }
}
