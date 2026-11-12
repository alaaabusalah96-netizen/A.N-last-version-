/**
 * Database abstraction types and interfaces
 * Engine-agnostic data layer contracts
 */

export type DatabaseMode = 'central' | 'per_company' | 'on_prem';

export const DATABASE_MODES: readonly DatabaseMode[] = ['central', 'per_company', 'on_prem'];

export interface TenantDbRef {
  companyId: string;
  mode: DatabaseMode;
  connectionKey: string;
}

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface DbExecutor {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  withTransaction<T>(fn: (ex: DbExecutor) => Promise<T>): Promise<T>;
  health(): Promise<{ ok: boolean; detail?: string }>;
  close(): Promise<void>;
}
