import { check, summary } from './lib/testkit.js';
import { DbExecutor, QueryResult } from '../src/server/db/types.js';
import { assertNoDataApiExposure } from '../src/server/db/dataApiGuard.js';

console.log('--- Running Data API Guard Verification (F10-5 / Behavioral Mock) ---');

function createMockExecutor(handler: (sql: string, params?: unknown[]) => Promise<any[]> | any[]): DbExecutor {
  return {
    query: async <T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
      const rows = await handler(sql, params);
      return {
        rows: rows as T[],
        rowCount: rows.length,
      };
    },
    withTransaction: async <T>(fn: (ex: DbExecutor) => Promise<T>): Promise<T> => {
      return fn(createMockExecutor(handler));
    },
    health: async () => ({ ok: true }),
    close: async () => {},
  };
}

async function runTests() {
  // Test 1: No exposure returns zero violations
  {
    const ex = createMockExecutor((sql) => {
      if (sql.includes('to_regrole')) return [{ exists: true }];
      if (sql.includes('has_schema_privilege')) return [{ has_create: false }];
      if (sql.includes('has_table_privilege')) return [];
      if (sql.includes('has_sequence_privilege')) return [];
      if (sql.includes('has_function_privilege')) return [];
      return [];
    });

    const violations = await assertNoDataApiExposure(ex);
    await check('1. No exposure returns zero violations', violations.length === 0);
  }

  // Test 2: anon SELECT on a table is detected
  {
    const ex = createMockExecutor((sql, params) => {
      if (sql.includes('to_regrole')) return [{ exists: true }];
      if (sql.includes('has_schema_privilege')) return [{ has_create: false }];
      if (sql.includes('has_table_privilege')) {
        const role = params?.[0];
        if (role === 'anon') {
          return [{ tablename: 'companies', priv: 'SELECT' }];
        }
        return [];
      }
      return [];
    });

    const violations = await assertNoDataApiExposure(ex);
    const hasAnonSelect = violations.some((v) => v.includes("Role 'anon'") && v.includes('SELECT') && v.includes('companies'));
    await check('2. anon SELECT on a table is detected', hasAnonSelect);
  }

  // Test 3: authenticated INSERT on a table is detected
  {
    const ex = createMockExecutor((sql, params) => {
      if (sql.includes('to_regrole')) return [{ exists: true }];
      if (sql.includes('has_schema_privilege')) return [{ has_create: false }];
      if (sql.includes('has_table_privilege')) {
        const role = params?.[0];
        if (role === 'authenticated') {
          return [{ tablename: 'platform_users', priv: 'INSERT' }];
        }
        return [];
      }
      return [];
    });

    const violations = await assertNoDataApiExposure(ex);
    const hasAuthInsert = violations.some((v) => v.includes("Role 'authenticated'") && v.includes('INSERT') && v.includes('platform_users'));
    await check('3. authenticated INSERT on a table is detected', hasAuthInsert);
  }

  // Test 4: Sequence USAGE is detected
  {
    const ex = createMockExecutor((sql, params) => {
      if (sql.includes('to_regrole')) return [{ exists: true }];
      if (sql.includes('has_schema_privilege')) return [{ has_create: false }];
      if (sql.includes('has_table_privilege')) return [];
      if (sql.includes('has_sequence_privilege')) {
        const role = params?.[0];
        if (role === 'anon') {
          return [{ seqname: 'companies_id_seq', priv: 'USAGE' }];
        }
        return [];
      }
      return [];
    });

    const violations = await assertNoDataApiExposure(ex);
    const hasSeqUsage = violations.some((v) => v.includes("Role 'anon'") && v.includes('USAGE') && v.includes('companies_id_seq'));
    await check('4. Sequence USAGE is detected', hasSeqUsage);
  }

  // Test 5: Callable function EXECUTE is detected
  {
    const ex = createMockExecutor((sql, params) => {
      if (sql.includes('to_regrole')) return [{ exists: true }];
      if (sql.includes('has_schema_privilege')) return [{ has_create: false }];
      if (sql.includes('has_table_privilege')) return [];
      if (sql.includes('has_sequence_privilege')) return [];
      if (sql.includes('has_function_privilege')) {
        const role = params?.[0];
        if (role === 'authenticated') {
          return [{ proname: 'custom_admin_func' }];
        }
        return [];
      }
      return [];
    });

    const violations = await assertNoDataApiExposure(ex);
    const hasFuncExec = violations.some((v) => v.includes("Role 'authenticated'") && v.includes('EXECUTE') && v.includes('custom_admin_func'));
    await check('5. Callable function EXECUTE is detected', hasFuncExec);
  }

  // Test 6: Schema CREATE is detected
  {
    const ex = createMockExecutor((sql, params) => {
      if (sql.includes('to_regrole')) return [{ exists: true }];
      if (sql.includes('has_schema_privilege')) {
        const role = params?.[0];
        if (role === 'anon') {
          return [{ has_create: true }];
        }
        return [{ has_create: false }];
      }
      return [];
    });

    const violations = await assertNoDataApiExposure(ex);
    const hasSchemaCreate = violations.some((v) => v.includes("Role 'anon'") && v.includes('CREATE'));
    await check('6. Schema CREATE is detected', hasSchemaCreate);
  }

  // Test 7: Missing required managed roles fail when requireRoles=true
  {
    const ex = createMockExecutor((sql) => {
      if (sql.includes('to_regrole')) return [{ exists: false }];
      return [];
    });

    let threwMissing = false;
    try {
      await assertNoDataApiExposure(ex, { requireRoles: true });
    } catch (err: any) {
      threwMissing = err.message.includes("Required Data API role 'anon' is missing");
    }
    await check('7. Missing required managed roles fail when requireRoles=true', threwMissing);

    // Optional requireRoles=false succeeds without throwing
    let threwOptional = false;
    try {
      const v = await assertNoDataApiExposure(ex, { requireRoles: false });
      threwOptional = v.length > 0;
    } catch {
      threwOptional = true;
    }
    await check('Missing managed roles ignored when requireRoles=false', !threwOptional);
  }

  // Test 8: Query failure throws a fatal fail-closed error
  {
    const ex = createMockExecutor(() => {
      throw new Error('Database connection reset');
    });

    let threwQueryFail = false;
    try {
      await assertNoDataApiExposure(ex);
    } catch (err: any) {
      threwQueryFail = err.message.includes('[dataApiGuard] FATAL: Data API guard query failed (fail-closed)');
    }
    await check('8. Query failure throws a fatal fail-closed error', threwQueryFail);
  }

  // Test 9: service_role is not treated as an untrusted public client role
  {
    const rolesQueried: string[] = [];
    const ex = createMockExecutor((sql, params) => {
      if (params?.[0]) rolesQueried.push(String(params[0]));
      if (sql.includes('to_regrole')) return [{ exists: true }];
      if (sql.includes('has_schema_privilege')) return [{ has_create: false }];
      return [];
    });

    await assertNoDataApiExposure(ex);
    const testedServiceRole = rolesQueried.includes('service_role');
    await check('9. service_role is not treated as an untrusted public client role', !testedServiceRole);
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
