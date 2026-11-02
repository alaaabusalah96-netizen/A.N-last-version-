import { DbExecutor } from './types.js';

/**
 * Standard contract for any database engine adapter.
 * Implementations (e.g. PostgresqlAdapter) must adhere to this interface.
 */
export interface DatabaseEngine {
  readonly id: string; // e.g. 'postgresql'
  connect(config: Record<string, string>): Promise<DbExecutor>;
}
