import { defaultUserRepository } from '../auth/userRepository.js';
import { defaultMembershipStore } from '../org/membershipStore.js';
import { defaultAuditService } from '../audit/auditService.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { defaultRoleService } from '../rbac/roleService.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { RoleName } from '../rbac/roles.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { AuthenticatedRequest } from '../auth/authMiddleware.js';

export class UserAdminService {
  async listUsers(actor: AuthenticatedRequest['user'], companyId?: string): Promise<any[]> {
    if (!actor) throw new ForbiddenError('Authentication required');

    // Platform admin without companyId can list globally
    if (actor.role === 'platform_admin' && !companyId) {
      return await defaultUserRepository.listUsersAdmin();
    }

    // All tenant actors (and platform_admin filtering by company) must provide companyId
    if (!companyId) {
      throw new ValidationError('companyId is required for company-scoped user listing');
    }

    const isAllowed = await defaultRbacService.hasPermission(actor, PERMISSIONS.USER_READ, companyId);
    if (!isAllowed) throw new ForbiddenError('Missing USER_READ permission');

    // C5: Filter users by membership in the company
    return await defaultUserRepository.listUsersByCompany(companyId);
  }

  async createUser(
    actor: AuthenticatedRequest['user'],
    input: { username: string; passwordHash: string; companyId?: string; role?: RoleName; roleId?: string | null }
  ): Promise<any> {
    if (!actor) throw new ForbiddenError('Authentication required');

    if (input.role === 'platform_admin' && actor.role !== 'platform_admin') {
      throw new ForbiddenError('Only platform admin can create platform admins');
    }

    // For non-platform admins, companyId is required and must have USER_WRITE
    if (actor.role !== 'platform_admin' && !input.companyId) {
      throw new ValidationError('companyId is required for user creation by non-platform admins');
    }

    const isAllowed = await defaultRbacService.hasPermission(actor, PERMISSIONS.USER_WRITE, input.companyId);
    if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');

    let validatedRoleId: string | null = null;
    if (input.roleId) {
      if (!input.companyId || input.role === 'platform_admin') {
        throw new ValidationError('لا يمكن تعيين دور شركة ديناميكي بدون تحديد شركة');
      }
      const validatedRole = await defaultRoleService.validateAssignableRole(input.companyId, input.roleId);
      validatedRoleId = validatedRole.id;
    }

    const user = await defaultUserRepository.createUser({
      username: input.username,
      passwordHash: input.passwordHash,
      role: (input.role === 'platform_admin' ? 'platform_admin' : 'user') as 'platform_admin' | 'user',
    });

    if (input.companyId) {
      await defaultMembershipStore.addMember(
        user.id,
        input.companyId,
        (input.role === 'company_admin' ? 'company_admin' : 'company_user') as RoleName,
        true,
        validatedRoleId
      );
      defaultRbacService.invalidate(input.companyId, user.id);
    }

    await defaultAuditService.record({
      actorUserId: actor.id,
      companyId: input.companyId || null,
      action: 'USER_CREATE',
      entityType: 'user',
      entityId: user.id,
      metadata: { username: user.username, role: user.role, roleId: validatedRoleId }
    });
    return user;
  }

  async addMembership(
    actor: AuthenticatedRequest['user'],
    input: { userId: string; companyId: string; role: RoleName; roleId?: string | null }
  ): Promise<void> {
    if (!actor) throw new ForbiddenError('Authentication required');

    const isAllowed = await defaultRbacService.hasPermission(actor, PERMISSIONS.USER_WRITE, input.companyId);
    if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');

    if (input.role === 'platform_admin') {
      throw new ForbiddenError('Cannot assign platform_admin role via membership');
    }

    let validatedRoleId: string | null = null;
    if (input.roleId) {
      const validatedRole = await defaultRoleService.validateAssignableRole(input.companyId, input.roleId);
      validatedRoleId = validatedRole.id;
    }

    await defaultMembershipStore.addMember(input.userId, input.companyId, input.role, true, validatedRoleId);
    defaultRbacService.invalidate(input.companyId, input.userId);

    await defaultAuditService.record({
      actorUserId: actor.id,
      companyId: input.companyId,
      action: 'MEMBERSHIP_ADD',
      entityType: 'membership',
      entityId: input.userId,
      metadata: { role: input.role, roleId: validatedRoleId }
    });
  }

  async setMembershipActive(
    actor: AuthenticatedRequest['user'],
    membershipId: string,
    companyId: string,
    isActive: boolean,
    userId?: string
  ): Promise<boolean> {
    if (!actor) throw new ForbiddenError('Authentication required');
    if (!companyId) throw new ValidationError('companyId is required');

    const isAllowed = await defaultRbacService.hasPermission(actor, PERMISSIONS.USER_WRITE, companyId);
    if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');

    // C3: Scoped update with companyId and optional userId to prevent IDOR
    const success = await defaultMembershipStore.setStatusById(membershipId, companyId, isActive, userId);
    if (!success) {
      throw new NotFoundError('Membership not found in this company');
    }

    await defaultAuditService.record({
      actorUserId: actor.id,
      companyId,
      action: 'MEMBERSHIP_SET_ACTIVE',
      entityType: 'membership',
      entityId: membershipId,
      metadata: { isActive, userId }
    });
    return success;
  }

  async setUserActive(
    actor: AuthenticatedRequest['user'],
    userId: string,
    isActive: boolean,
    companyId?: string
  ): Promise<boolean> {
    if (!actor) throw new ForbiddenError('Authentication required');

    // Target protection check
    const target = await defaultUserRepository.findById(userId);
    if (!target) throw new NotFoundError('User not found');

    if (target.role === 'platform_admin' && actor.role !== 'platform_admin') {
      throw new ForbiddenError('Only platform admin can modify platform admin users');
    }

    // Scope check: non-platform admin must provide companyId where they have USER_WRITE and target is a member
    if (actor.role !== 'platform_admin') {
      if (!companyId) {
        throw new ValidationError('companyId is required for company admins to modify user active status');
      }
      const isAllowed = await defaultRbacService.hasPermission(actor, PERMISSIONS.USER_WRITE, companyId);
      if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');

      const membership = await defaultMembershipStore.getMembership(userId, companyId);
      if (!membership || !membership.isActive) {
        throw new ForbiddenError('Cannot modify user outside your company membership');
      }
    } else if (companyId) {
      // Platform admin optional check
      const isAllowed = await defaultRbacService.hasPermission(actor, PERMISSIONS.USER_WRITE, companyId);
      if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');
    }

    const success = await defaultUserRepository.setUserActive(userId, isActive);
    if (success) {
      await defaultAuditService.record({
        actorUserId: actor.id,
        companyId: companyId || null,
        action: 'USER_SET_ACTIVE',
        entityType: 'user',
        entityId: userId,
        metadata: { isActive }
      });
    }
    return success;
  }

  async resetPassword(
    actor: AuthenticatedRequest['user'],
    userId: string,
    newPasswordHash: string,
    companyId?: string
  ): Promise<boolean> {
    if (!actor) throw new ForbiddenError('Authentication required');

    // Target protection check
    const target = await defaultUserRepository.findById(userId);
    if (!target) throw new NotFoundError('User not found');

    if (target.role === 'platform_admin' && actor.role !== 'platform_admin') {
      throw new ForbiddenError('Only platform admin can reset platform admin password');
    }

    // Scope check: non-platform admin must provide companyId where they have USER_WRITE and target is a member
    if (actor.role !== 'platform_admin') {
      if (!companyId) {
        throw new ValidationError('companyId is required for company admins to reset passwords');
      }
      const isAllowed = await defaultRbacService.hasPermission(actor, PERMISSIONS.USER_WRITE, companyId);
      if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');

      const membership = await defaultMembershipStore.getMembership(userId, companyId);
      if (!membership || !membership.isActive) {
        throw new ForbiddenError('Cannot reset password for user outside your company membership');
      }
    } else if (companyId) {
      const isAllowed = await defaultRbacService.hasPermission(actor, PERMISSIONS.USER_WRITE, companyId);
      if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');
    }

    const success = await defaultUserRepository.updatePasswordHashById(userId, newPasswordHash);
    if (success) {
      await defaultAuditService.record({
        actorUserId: actor.id,
        companyId: companyId || null,
        action: 'PASSWORD_RESET',
        entityType: 'user',
        entityId: userId
      });
    }
    return success;
  }
}

export const defaultUserAdminService = new UserAdminService();
