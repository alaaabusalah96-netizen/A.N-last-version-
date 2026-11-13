import { User } from '../auth/userStore.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { CompanyMembership, defaultMembershipStore, MembershipStore } from '../org/membershipStore.js';
import { PermissionCode } from './permissions.js';
import { defaultRoleRepository, RoleRepository } from './roleRepository.js';
import { ROLE_PERMISSIONS, RoleName } from './roles.js';

export type TenantRunner = <T>(companyId: string, fn: (ex: DbExecutor) => Promise<T>) => Promise<T>;

interface CachedPermissionSet {
  permissions: PermissionCode[];
  expiresAt: number;
}

export class RbacService {
  private cache = new Map<string, CachedPermissionSet>();
  private readonly ttlMs = 30_000;

  constructor(
    private membershipStore: MembershipStore = defaultMembershipStore,
    private roleRepo: RoleRepository = defaultRoleRepository,
    private runWithTenant: TenantRunner = withTenantTransaction
  ) {}

  invalidate(companyId?: string, userId?: string): void {
    if (!companyId) {
      this.cache.clear();
      return;
    }
    if (userId) {
      this.cache.delete(`${companyId}:${userId}`);
      return;
    }
    const prefix = `${companyId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Resolves effective permissions for a single company membership:
   * - If `membership.roleId` is NULL: documented legacy compatibility path -> static ROLE_PERMISSIONS[membership.role].
   * - If `membership.roleId` is present: STRICT FAIL-CLOSED dynamic contract:
   *   - Returns permissions of active DB role in the same company.
   *   - Returns [] if role is missing, inactive, or any DB/lookup failure occurs (never falls back to ROLE_PERMISSIONS).
   */
  async resolveMembershipPermissions(
    userId: string,
    membership: CompanyMembership
  ): Promise<PermissionCode[]> {
    // Documented backward-compatible path ONLY when membership.role_id is NULL
    if (!membership.roleId) {
      return ROLE_PERMISSIONS[membership.role as RoleName] || [];
    }

    const cacheKey = `${membership.companyId}:${userId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.permissions;
    }

    try {
      const perms = await this.runWithTenant(membership.companyId, async (tx) => {
        const role = await this.roleRepo.findById(membership.companyId, membership.roleId!, tx);
        if (!role || role.isActive === false) {
          return [] as PermissionCode[];
        }
        return await this.roleRepo.listPermissions(membership.roleId!, tx);
      });

      this.cache.set(cacheKey, {
        permissions: perms,
        expiresAt: Date.now() + this.ttlMs,
      });
      return perms;
    } catch (err) {
      // STRICT FAIL-CLOSED: When role_id is assigned and lookup fails, deny all permissions (never fall back to static map)
      console.error('[rbacService] Fail-closed: dynamic role lookup failed for assigned role_id; denying permissions:', err);
      return [];
    }
  }

  /**
   * Evaluates if a user has a specific permission.
   *
   * Note on Platform Admin:
   * - A platform_admin possesses all platform permissions across all companies by design.
   *
   * Non-Platform Users:
   * - If companyId IS provided: user must hold an active (isActive !== false) membership
   *   in that company, and their role (dynamic role_id -> role_permissions if assigned,
   *   otherwise static ROLE_PERMISSIONS fallback) must grant the permission.
   * - If companyId is NOT provided: user is granted access if ANY active membership
   *   grants the permission.
   */
  async hasPermission(
    user: Omit<User, 'passwordHash'>,
    permission: PermissionCode,
    companyId?: string
  ): Promise<boolean> {
    if (!user) return false;

    // Platform admins always retain full static permissions regardless of DB state
    if (user.role === 'platform_admin') {
      const allowed = ROLE_PERMISSIONS.platform_admin;
      return allowed.includes(permission);
    }

    // Explicit companyId provided
    if (companyId) {
      // Resolve membership through the injected tenant runner so the read
      // happens on the same tenant-scoped executor as the permission lookup.
      // A direct membershipStore call without an executor falls through to
      // getDefaultExecutor() (a separate connection) which cannot observe
      // rows created inside the caller's transaction — producing null/stale
      // membership and false permission denials (R3/R4/R8 class of failure).
      const membership = await this.runWithTenant(companyId, (tx) =>
        this.membershipStore.getMembership(user.id, companyId, tx)
      );
      if (!membership || membership.isActive === false) {
        return false;
      }

      const rolePerms = await this.resolveMembershipPermissions(user.id, membership);
      return rolePerms.includes(permission);
    }

    // No companyId provided: check if any of the user's active memberships grants the permission
    const memberships = await this.membershipStore.listByUser(user.id);
    for (const membership of memberships) {
      if (membership.isActive === false) continue;
      const rolePerms = await this.resolveMembershipPermissions(user.id, membership);
      if (rolePerms.includes(permission)) {
        return true;
      }
    }

    return false;
  }
}

export const defaultRbacService = new RbacService();
