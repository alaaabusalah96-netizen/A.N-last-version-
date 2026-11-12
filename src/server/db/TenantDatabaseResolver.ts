import { DatabaseMode, TenantDbRef, DATABASE_MODES } from './types.js';

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
    const raw = (process.env.DB_MODE || '').trim();
    if (raw === '') {
      this.defaultMode = 'central';
      return;
    }
    const envMode = raw.toLowerCase();
    if (envMode === 'hybrid') {
      throw new Error("DB_MODE_INVALID: mode 'hybrid' is not supported — choose central, per_company or on_prem");
    }
    if (!DATABASE_MODES.includes(envMode as DatabaseMode)) {
      throw new Error(`DB_MODE_INVALID: unsupported DB_MODE '${raw}' — choose central, per_company or on_prem`);
    }
    this.defaultMode = envMode as DatabaseMode;
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

  hasTenantRoute(companyId: string): boolean {
    return this.overrides.has(companyId);
  }

  getMode(): DatabaseMode {
    return this.defaultMode;
  }

  clearTenantRoutes(): void {
    this.overrides.clear();
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

    if (this.defaultMode === 'central') {
      return { companyId, mode: 'central', connectionKey: 'default' };
    }

    throw new Error(
      `TENANT_DB_ROUTE_MISSING: DB_MODE='${this.defaultMode}' requires an explicit database route `
      + `for company '${companyId}'. Refusing to fall back to the central connection.`
    );
  }
}

// Global default resolver instance
export const defaultResolver = new TenantDatabaseResolver();
