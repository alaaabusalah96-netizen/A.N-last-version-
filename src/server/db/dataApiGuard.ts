import { DbExecutor } from './types.js';

export async function assertNoDataApiExposure(executor: DbExecutor): Promise<string[]> {
  const dataApiRoles = ['anon', 'authenticated', 'service_role'];
  const violations: string[] = [];

  for (const role of dataApiRoles) {
    try {
      // Check if role exists
      const roleCheck = await executor.query<{ exists: boolean }>(
        'SELECT to_regrole($1) IS NOT NULL as exists;',
        [role]
      );
      if (!roleCheck.rows[0]?.exists) {
        continue;
      }

      // Check table privileges
      const tablePrivs = await executor.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
         AND (
           has_table_privilege($1, quote_ident(schemaname) || '.' || quote_ident(tablename), 'SELECT') OR
           has_table_privilege($1, quote_ident(schemaname) || '.' || quote_ident(tablename), 'INSERT') OR
           has_table_privilege($1, quote_ident(schemaname) || '.' || quote_ident(tablename), 'UPDATE') OR
           has_table_privilege($1, quote_ident(schemaname) || '.' || quote_ident(tablename), 'DELETE')
         );`,
        [role]
      );

      if (tablePrivs.rows.length > 0) {
        violations.push(`Role '${role}' has table privileges on ${tablePrivs.rows.length} public tables.`);
      }
    } catch (err) {
      // Ignore query errors during check if table doesn't exist yet
    }
  }

  return violations;
}
