import { getDefaultExecutor } from './index.js';
import { DbExecutor } from './types.js';
import { tenantContextStorage } from './tenantContext.js';

/**
 * Executes a function within a database transaction scoped to a specific tenant companyId.
 * Sets app.current_tenant_id locally via set_config(..., true).
 * Fails closed if companyId is blank or whitespace.
 */
export async function withTenantTransaction<T>(
  companyId: string,
  fn: (ex: DbExecutor) => Promise<T>
): Promise<T> {
  if (!companyId || !companyId.trim()) {
    throw new Error('TENANT_CONTEXT_REQUIRED: companyId must be provided for tenant transactions');
  }

  const normalizedCompanyId = companyId.trim();
  const executor = await getDefaultExecutor();
  if (!executor) {
    throw new Error('DB_UNAVAILABLE: Database executor required for tenant transactions');
  }

  return await executor.withTransaction(async (tx) => {
    // Set transaction-local tenant context variable for RLS
    await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [normalizedCompanyId]);

    // Run within AsyncLocalStorage tenant context as well
    return await tenantContextStorage.run({ companyId: normalizedCompanyId }, async () => {
      return await fn(tx);
    });
  });
}
