import { AsyncLocalStorage } from 'async_hooks';
import type { DbExecutor } from './types.js';

export interface TenantContext {
  companyId: string;
  userId?: string;
  executor?: DbExecutor;
}

const asyncLocalStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Tenant Context Storage
 * Provides tenant context propagation across asynchronous database and application calls.
 */
export const tenantContextStorage = {
  run<R>(context: TenantContext, fn: () => R): R {
    return asyncLocalStorage.run(context, fn);
  },

  getCurrent(): TenantContext | undefined {
    return asyncLocalStorage.getStore();
  },

  getCurrentCompanyId(): string | undefined {
    return asyncLocalStorage.getStore()?.companyId;
  },

  getCurrentExecutor(): DbExecutor | undefined {
    return asyncLocalStorage.getStore()?.executor;
  },
};

