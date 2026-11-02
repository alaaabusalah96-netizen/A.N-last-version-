import pg from 'pg';
import { DatabaseEngine } from '../DatabaseEngine.js';
import { DbExecutor, QueryResult } from '../types.js';

const { Pool } = pg;

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
          // No-op inside transaction client; client released at end of withTransaction
        },
      };

      const result = await fn(txExecutor);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
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

    const sslConfig = (() => {
      if (process.env.DATABASE_SSL === 'disable') return undefined;
      if (process.env.NODE_ENV === 'production' || process.env.DATABASE_SSL === 'require') {
        return { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' };
      }
      return undefined;
    })();

    const pool = new Pool({
      connectionString,
      ssl: sslConfig,
      max: config.max ? parseInt(config.max, 10) : 10,
    });

    return new PostgresExecutor(pool);
  }
}
