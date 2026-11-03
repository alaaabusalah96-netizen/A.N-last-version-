import pg from 'pg';
import { DatabaseEngine } from '../DatabaseEngine.js';
import { DbExecutor, QueryResult } from '../types.js';

const { Pool } = pg;

export function resolveSslConfig(env: Record<string, string | undefined>): pg.ConnectionConfig['ssl'] | undefined {
  const isProd = env.NODE_ENV === 'production';

  if (env.DATABASE_SSL === 'disable') {
    if (isProd && env.ALLOW_INSECURE_DB_SSL !== '1') {
      throw new Error(
        'Insecure database connection rejected: DATABASE_SSL=disable is strictly forbidden in production unless ALLOW_INSECURE_DB_SSL=1 is explicitly set'
      );
    }
    if (isProd && env.ALLOW_INSECURE_DB_SSL === '1') {
      console.warn('[db] WARNING: ALLOW_INSECURE_DB_SSL=1 is set. Proceeding with insecure SSL connection in production.');
    }
    return undefined;
  }

  if (isProd || env.DATABASE_SSL === 'require') {
    return { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' };
  }

  return undefined;
}

class PostgresExecutor implements DbExecutor {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async withTransaction<T>(fn: (ex: DbExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let hasError = false;

    try {
      await client.query('BEGIN');
      const txExecutor: DbExecutor = {
        query: async <R = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<R>> => {
          const res = await client.query(sql, params);
          return {
            rows: res.rows as R[],
            rowCount: res.rowCount ?? res.rows.length,
          };
        },
        withTransaction: async <R>(nestedFn: (nestedEx: DbExecutor) => Promise<R>): Promise<R> => {
          return nestedFn(txExecutor);
        },
        health: async () => {
          await client.query('SELECT 1');
          return { ok: true };
        },
        close: async () => {
          // No-op inside transaction client
        },
      };

      const result = await fn(txExecutor);
      await client.query('COMMIT');
      return result;
    } catch (originalErr) {
      hasError = true;
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[db] Error rolling back transaction:', rollbackErr);
      }
      throw originalErr;
    } finally {
      client.release(hasError);
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, detail: 'PostgreSQL connection healthy' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: message };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class PostgresqlAdapter implements DatabaseEngine {
  readonly id = 'postgresql';

  async connect(config: Record<string, string>): Promise<DbExecutor> {
    const connectionString =
      config.connectionString ||
      process.env.DATABASE_URL ||
      config.url;

    if (!connectionString) {
      throw new Error('DATABASE_URL or config.connectionString is required to connect to PostgreSQL');
    }

    const sslConfig = resolveSslConfig(process.env);

    const pool = new Pool({
      connectionString,
      ssl: sslConfig,
      max: config.max ? parseInt(config.max, 10) : 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
      application_name: 'an-erp-platform',
    });

    pool.on('error', (err) => {
      console.error('[db] Idle client error on pool:', err instanceof Error ? err.message : String(err));
    });

    return new PostgresExecutor(pool);
  }
}
