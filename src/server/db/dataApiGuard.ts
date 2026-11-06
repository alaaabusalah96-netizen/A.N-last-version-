import { DbExecutor } from './types.js';

export interface DataApiGuardOptions {
  requireRoles?: boolean;
}

function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/password=[^\s]+/gi, 'password=[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@[^\s]+/gi, 'postgresql://[REDACTED_AUTH]@[HOST]');
}

export async function assertNoDataApiExposure(
  executor: DbExecutor,
  options: DataApiGuardOptions = {}
): Promise<string[]> {
  if (!executor || typeof executor.query !== 'function') {
    throw new Error('[dataApiGuard] FATAL: Invalid executor provided — check failed closed.');
  }

  const requireRoles = options.requireRoles ?? true;
  const untrustedRoles = ['anon', 'authenticated'];
  const violations: string[] = [];

  try {
    for (const role of untrustedRoles) {
      // 1. Role existence check
      const roleCheck = await executor.query<{ exists: boolean }>(
        'SELECT to_regrole($1) IS NOT NULL as exists;',
        [role]
      );

      const exists = Boolean(roleCheck.rows[0]?.exists);
      if (!exists) {
        if (requireRoles) {
          throw new Error(`[dataApiGuard] FATAL: Required Data API role '${role}' is missing.`);
        }
        continue;
      }

      // 2. Schema CREATE privilege check
      const schemaCheck = await executor.query<{ has_create: boolean }>(
        "SELECT has_schema_privilege($1, 'public', 'CREATE') as has_create;",
        [role]
      );
      if (schemaCheck.rows[0]?.has_create) {
        violations.push(`Role '${role}' has unauthorized CREATE privilege on schema public.`);
      }

      // 3. Public tables and views privilege check (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER)
      const tablePrivs = await executor.query<{ tablename: string; priv: string }>(
        `SELECT c.relname as tablename, p.priv
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'v', 'm', 'p')
           AND has_table_privilege($1, c.oid, p.priv);`,
        [role]
      );

      for (const row of tablePrivs.rows) {
        violations.push(`Role '${role}' has unauthorized ${row.priv} privilege on table/view '${row.tablename}'.`);
      }

      // 4. Public sequences privilege check (USAGE, SELECT, UPDATE)
      const seqPrivs = await executor.query<{ seqname: string; priv: string }>(
        `SELECT c.relname as seqname, p.priv
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) as p(priv)
         WHERE n.nspname = 'public'
           AND c.relkind = 'S'
           AND has_sequence_privilege($1, c.oid, p.priv);`,
        [role]
      );

      for (const row of seqPrivs.rows) {
        violations.push(`Role '${role}' has unauthorized ${row.priv} privilege on sequence '${row.seqname}'.`);
      }

      // 5. Public routines privilege check (EXECUTE)
      // Check ALL routines in schema public (including trigger and event-trigger functions)
      const funcPrivs = await executor.query<{ proname: string }>(
        `SELECT p.proname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND has_function_privilege($1, p.oid, 'EXECUTE');`,
        [role]
      );

      for (const row of funcPrivs.rows) {
        violations.push(`Role '${role}' has unauthorized EXECUTE privilege on routine '${row.proname}'.`);
      }
    }

    return violations;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('[dataApiGuard]')) {
      throw err;
    }
    throw new Error(`[dataApiGuard] FATAL: Data API guard query failed (fail-closed): ${sanitizeError(err)}`);
  }
}
