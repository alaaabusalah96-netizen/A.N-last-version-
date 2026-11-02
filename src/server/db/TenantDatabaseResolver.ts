import { DatabaseMode, TenantDbRef } from './types.js';

/**
 * Tenant-to-Database Resolver
 * Resolves the database reference (connectionKey and storage mode) for a given company/tenant.
 *
 * In V1 Default:
 * - mode defaults to 'central' (or from process.env.DB_MODE)
 * - connectionKey defaults to 'default'
 *
 * Guaranteed isolation behavior:
 * - Every query and transaction must use the resolved TenantDbRef.
 * - Central mode enforces tenant isolation by mandating companyId in queries or session variables.
 * - In dedicated/per_company or on_prem modes, connectionKey routes to isolated connection pools.
 */
export class TenantDatabaseResolver {
  private defaultMode: DatabaseMode;
  private overrides: Map<string, TenantDbRef> = new Map();

  constructor() {
    const envMode = (process.env.DB_MODE || 'central').toLowerCase();
    if (['central', 'per_company', 'on_prem', 'hybrid'].includes(envMode)) {
      this.defaultMode = envMode as DatabaseMode;
    } else {
      this.defaultMode = 'central';
    }
  }

  /**
   * Set explicit tenant routing override (e.g. for dedicated tenant DB or on-premises connection).
   */
  setTenantRoute(companyId: string, ref: TenantDbRef): void {
    if (!companyId) {
      throw new Error('companyId is required for tenant routing override');
    }
    this.overrides.set(companyId, ref);
  }

  /**
   * Resolve company/tenant to database reference.
   */
  resolve(companyId: string): TenantDbRef {
    if (!companyId) {
      throw new Error('Tenant resolution requires a non-empty companyId');
    }

    const override = this.overrides.get(companyId);
    if (override) {
      return override;
    }

    return {
      companyId,
      mode: this.defaultMode,
      connectionKey: 'default',
    };
  }
}

// Global default resolver instance
export const defaultResolver = new TenantDatabaseResolver();
