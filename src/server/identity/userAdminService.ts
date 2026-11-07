import { defaultUserRepository } from '../auth/userRepository.js';
import { defaultMembershipStore } from '../org/membershipStore.js';
import { defaultAuditService } from '../audit/auditService.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { RoleName } from '../rbac/roles.js';
import { ForbiddenError } from '../http/errors.js';
import { AuthenticatedRequest } from '../auth/authMiddleware.js';

export class UserAdminService {
  async listUsers(actor: AuthenticatedRequest['user'], companyId?: string): Promise<any[]> {
    const isAllowed = await defaultRbacService.hasPermission(actor!, PERMISSIONS.USER_READ, companyId);
    if (!isAllowed) throw new ForbiddenError('Missing USER_READ permission');

    return await defaultUserRepository.listUsersAdmin();
  }

  async createUser(
    actor: AuthenticatedRequest['user'],
    input: { username: string; passwordHash: string; companyId?: string; role?: RoleName }
  ): Promise<any> {
    const isAllowed = await defaultRbacService.hasPermission(actor!, PERMISSIONS.USER_WRITE, input.companyId);
    if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');

    if (input.role === 'platform_admin' && actor?.role !== 'platform_admin') {
      throw new ForbiddenError('Only platform admin can create platform admins');
    }

    const user = await defaultUserRepository.createUser({
      username: input.username,
      passwordHash: input.passwordHash,
      role: (input.role === 'platform_admin' ? 'platform_admin' : 'user') as 'platform_admin' | 'user',
    });

    if (input.companyId) {
      await defaultMembershipStore.addMember(user.id, input.companyId, (input.role === 'company_admin' ? 'company_admin' : 'company_user') as RoleName, true);
    }

    await defaultAuditService.record({
      actorUserId: actor!.id,
      companyId: input.companyId || null,
      action: 'USER_CREATE',
      entityType: 'user',
      entityId: user.id,
      metadata: { username: user.username, role: user.role }
    });
    return user;
  }

  async addMembership(actor: AuthenticatedRequest['user'], input: { userId: string; companyId: string; role: RoleName }): Promise<void> {
    const isAllowed = await defaultRbacService.hasPermission(actor!, PERMISSIONS.USER_WRITE, input.companyId);
    if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');

    if (input.role === 'platform_admin') {
      throw new ForbiddenError('Cannot assign platform_admin role via membership');
    }

    await defaultMembershipStore.addMember(input.userId, input.companyId, input.role, true);

    await defaultAuditService.record({
      actorUserId: actor!.id,
      companyId: input.companyId,
      action: 'MEMBERSHIP_ADD',
      entityType: 'membership',
      entityId: input.userId,
      metadata: { role: input.role }
    });
  }

  async setMembershipActive(actor: AuthenticatedRequest['user'], membershipId: string, companyId: string, isActive: boolean): Promise<boolean> {
    const isAllowed = await defaultRbacService.hasPermission(actor!, PERMISSIONS.USER_WRITE, companyId);
    if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');

    const success = await defaultMembershipStore.setStatusById(membershipId, isActive);
    if (success) {
      await defaultAuditService.record({
        actorUserId: actor!.id,
        companyId,
        action: 'MEMBERSHIP_SET_ACTIVE',
        entityType: 'membership',
        entityId: membershipId,
        metadata: { isActive }
      });
    }
    return success;
  }

  async setUserActive(actor: AuthenticatedRequest['user'], userId: string, isActive: boolean): Promise<boolean> {
    const isAllowed = await defaultRbacService.hasPermission(actor!, PERMISSIONS.USER_WRITE);
    if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');

    const success = await defaultUserRepository.setUserActive(userId, isActive);
    if (success) {
      await defaultAuditService.record({
        actorUserId: actor!.id,
        action: 'USER_SET_ACTIVE',
        entityType: 'user',
        entityId: userId,
        metadata: { isActive }
      });
    }
    return success;
  }

  async resetPassword(actor: AuthenticatedRequest['user'], userId: string, newPasswordHash: string): Promise<boolean> {
    const isAllowed = await defaultRbacService.hasPermission(actor!, PERMISSIONS.USER_WRITE);
    if (!isAllowed) throw new ForbiddenError('Missing USER_WRITE permission');

    const success = await defaultUserRepository.updatePasswordHashById(userId, newPasswordHash);
    if (success) {
      await defaultAuditService.record({
        actorUserId: actor!.id,
        action: 'PASSWORD_RESET',
        entityType: 'user',
        entityId: userId
      });
    }
    return success;
  }
}

export const defaultUserAdminService = new UserAdminService();
