import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../authService.js';
import { UserStore } from '../userStore.js';
import { SessionStore } from '../sessionStore.js';
import { hashPassword, verifyPassword } from '../passwordHash.js';
import { InvalidCredentialsError, ForbiddenError, ValidationError } from '../../http/errors.js';
import { UserAdminService } from '../../identity/userAdminService.js';
import { defaultUserRepository } from '../userRepository.js';
import { defaultRbacService } from '../../rbac/rbacService.js';
import { defaultMembershipStore } from '../../org/membershipStore.js';
import { defaultAuditService } from '../../audit/auditService.js';

describe('AuthService Startup Bootstrap Verification (Non-Mutating)', () => {
  let authService: AuthService;
  let mockUserStore: any;
  let mockSessionStore: any;

  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };

    mockUserStore = {
      findByUsername: vi.fn(),
      updatePasswordHash: vi.fn(),
      createUser: vi.fn(),
      findById: vi.fn(),
    };
    mockSessionStore = {
      createSession: vi.fn(),
    };

    authService = new AuthService(mockUserStore as unknown as UserStore, mockSessionStore as unknown as SessionStore);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should skip startup verification if credentials are missing', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = '';
    process.env.PLATFORM_ADMIN_PASSWORD = '';

    const result = await authService.bootstrapPlatformAdminFromEnv();
    expect(result).toBe(false);
    expect(mockUserStore.findByUsername).not.toHaveBeenCalled();
    expect(mockUserStore.updatePasswordHash).not.toHaveBeenCalled();
    expect(mockUserStore.createUser).not.toHaveBeenCalled();
  });

  it('should fail if only username is provided', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = '';

    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow(
      'Both PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD must be configured'
    );
  });

  it('should fail if password is too short', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'short';

    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('must be at least 12 characters long');
  });

  it('should preserve existing platform_admin passwordHash when env password matches', async () => {
    const existingSecret = 'ExistingProdAdminPass!2026';
    const existingHash = await hashPassword(existingSecret);
    const adminRecord = {
      id: 'admin-uuid-1',
      username: 'admin',
      role: 'platform_admin',
      isActive: true,
      passwordHash: existingHash,
    };

    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = existingSecret;
    mockUserStore.findByUsername.mockResolvedValue(adminRecord);

    const result = await authService.bootstrapPlatformAdminFromEnv();
    expect(result).toBe(true);
    expect(adminRecord.passwordHash).toBe(existingHash);
    expect(mockUserStore.updatePasswordHash).not.toHaveBeenCalled();
    expect(mockUserStore.createUser).not.toHaveBeenCalled();
  });

  it('should NOT overwrite existing platform_admin passwordHash when env password differs', async () => {
    const existingHash = await hashPassword('ExistingProdAdminPass!2026');
    const adminRecord = {
      id: 'admin-uuid-1',
      username: 'admin',
      role: 'platform_admin',
      isActive: true,
      passwordHash: existingHash,
    };

    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'DifferentPreviewEnvPassword!999';
    mockUserStore.findByUsername.mockResolvedValue(adminRecord);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await authService.bootstrapPlatformAdminFromEnv();

    expect(result).toBe(true);
    expect(adminRecord.passwordHash).toBe(existingHash);
    expect(mockUserStore.updatePasswordHash).not.toHaveBeenCalled();
    expect(mockUserStore.createUser).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Startup password overwrite is disabled; preserving existing password hash')
    );
  });

  it('should prevent Preview and Production boots with different secrets from mutating shared admin passwordHash', async () => {
    const canonicalPassword = 'CanonicalSharedAdminPass!2026';
    const canonicalHash = await hashPassword(canonicalPassword);

    // Simulated shared database state containing the canonical administrator record
    const sharedDbAdmin = {
      id: 'shared-admin-1',
      username: 'admin',
      role: 'platform_admin' as const,
      isActive: true,
      passwordHash: canonicalHash,
    };

    const isolatedUserStore = {
      findByUsername: vi.fn(async (username: string) => (username === 'admin' ? { ...sharedDbAdmin } : null)),
      updatePasswordHash: vi.fn(async () => {
        throw new Error('updatePasswordHash must never be called on server startup');
      }),
      createUser: vi.fn(async () => {
        throw new Error('createUser must never be called on server startup');
      }),
      findById: vi.fn(),
    };

    const previewAuth = new AuthService(
      isolatedUserStore as unknown as UserStore,
      mockSessionStore as unknown as SessionStore
    );
    const productionAuth = new AuthService(
      isolatedUserStore as unknown as UserStore,
      mockSessionStore as unknown as SessionStore
    );

    // Repeated Preview & Production server boots with diverging PLATFORM_ADMIN_PASSWORD secrets
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'PreviewOnlyDifferentSecret!123';
    expect(await previewAuth.bootstrapPlatformAdminFromEnv()).toBe(true);

    process.env.PLATFORM_ADMIN_PASSWORD = 'ProductionOnlyDifferentSecret!456';
    expect(await productionAuth.bootstrapPlatformAdminFromEnv()).toBe(true);

    process.env.PLATFORM_ADMIN_PASSWORD = 'AnotherRestartEnvSecret!789';
    expect(await previewAuth.bootstrapPlatformAdminFromEnv()).toBe(true);

    expect(sharedDbAdmin.passwordHash).toBe(canonicalHash);
    expect(await verifyPassword(canonicalPassword, sharedDbAdmin.passwordHash)).toBe(true);
    expect(isolatedUserStore.updatePasswordHash).not.toHaveBeenCalled();
    expect(isolatedUserStore.createUser).not.toHaveBeenCalled();
  });

  it('should keep real admin login working after repeated startups with mismatched env passwords', async () => {
    const canonicalPassword = 'CanonicalAdminLoginPass!2026';
    const canonicalHash = await hashPassword(canonicalPassword);
    const sharedDbAdmin = {
      id: 'shared-admin-2',
      username: 'admin',
      role: 'platform_admin' as const,
      isActive: true,
      passwordHash: canonicalHash,
    };

    mockUserStore.findByUsername.mockImplementation(async (username: string) =>
      username === 'admin' ? sharedDbAdmin : null
    );
    mockSessionStore.createSession.mockResolvedValue({
      id: 'sess-123',
      userId: 'shared-admin-2',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'MismatchedPreviewSecret!2026';
    await authService.bootstrapPlatformAdminFromEnv();

    process.env.PLATFORM_ADMIN_PASSWORD = 'MismatchedProductionSecret!2026';
    await authService.bootstrapPlatformAdminFromEnv();

    // Canonical password still logs in cleanly
    const loginResult = await authService.login('admin', canonicalPassword);
    expect(loginResult.user.id).toBe('shared-admin-2');
    expect(loginResult.session.id).toBe('sess-123');

    // Mismatched env secret does NOT authenticate as the existing admin
    await expect(authService.login('admin', 'MismatchedPreviewSecret!2026')).rejects.toThrow(InvalidCredentialsError);
    expect(mockUserStore.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('should fail if account is inactive without mutating passwordHash', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';

    mockUserStore.findByUsername.mockResolvedValue({
      username: 'admin',
      role: 'platform_admin',
      isActive: false,
      passwordHash: 'some-hash',
    });

    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('is inactive');
    expect(mockUserStore.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('should fail if role is not platform_admin without mutating passwordHash', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';

    mockUserStore.findByUsername.mockResolvedValue({
      username: 'admin',
      role: 'user',
      isActive: true,
      passwordHash: 'some-hash',
    });

    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow("already exists with role 'user'");
    expect(mockUserStore.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('should NOT create a new admin if it does not exist', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';

    mockUserStore.findByUsername.mockResolvedValue(null);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await authService.bootstrapPlatformAdminFromEnv();
    expect(result).toBe(false);
    expect(mockUserStore.createUser).not.toHaveBeenCalled();
    expect(mockUserStore.updatePasswordHash).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Automatic creation is disabled'));
  });
});

describe('AuthService Explicit CLI Bootstrap (createInitialPlatformAdminFromEnv)', () => {
  let mockUserStore: any;
  let mockSessionStore: any;
  let mockUserRepo: any;
  let authService: AuthService;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    mockUserStore = {
      findByUsername: vi.fn(),
      updatePasswordHash: vi.fn(),
      createUser: vi.fn(),
      findById: vi.fn(),
    };
    mockSessionStore = {};
    mockUserRepo = {
      findByUsername: vi.fn(),
      countPlatformAdmins: vi.fn(),
      createUser: vi.fn(),
      updatePasswordHash: vi.fn(),
      withTransaction: vi.fn(async (fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) })),
    };
    authService = new AuthService(
      mockUserStore as unknown as UserStore,
      mockSessionStore as unknown as SessionStore,
      mockUserRepo
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should reject when credentials are missing', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = '';
    process.env.PLATFORM_ADMIN_PASSWORD = '';

    await expect(authService.createInitialPlatformAdminFromEnv()).rejects.toThrow(
      'Both PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD environment variables are required'
    );
    expect(mockUserRepo.createUser).not.toHaveBeenCalled();
  });

  it('should reject when password is shorter than 12 characters', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'AdminUser';
    process.env.PLATFORM_ADMIN_PASSWORD = 'short-pass';

    await expect(authService.createInitialPlatformAdminFromEnv()).rejects.toThrow(
      'must be at least 12 characters long'
    );
    expect(mockUserRepo.createUser).not.toHaveBeenCalled();
  });

  it('should create platform_admin with trimmed lowercase username and Argon2id hash when count is 0', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = '  Platform.Admin@Example.Com  ';
    process.env.PLATFORM_ADMIN_PASSWORD = 'SuperSecurePassword123!';

    mockUserRepo.findByUsername.mockResolvedValue(null);
    mockUserRepo.countPlatformAdmins.mockResolvedValue(0);
    mockUserRepo.createUser.mockImplementation(async (input: any) => ({
      id: 'uuid-admin-1',
      username: input.username,
      passwordHash: input.passwordHash,
      role: input.role,
      isActive: true,
      createdAt: new Date().toISOString(),
    }));

    const res = await authService.createInitialPlatformAdminFromEnv();
    expect(res).toEqual({
      status: 'created',
      userId: 'uuid-admin-1',
      username: 'platform.admin@example.com',
    });
    expect(mockUserRepo.createUser).toHaveBeenCalledTimes(1);
    const createdArg = mockUserRepo.createUser.mock.calls[0][0];
    expect(createdArg.username).toBe('platform.admin@example.com');
    expect(createdArg.role).toBe('platform_admin');
    expect(createdArg.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('should return already_exists for the same platform_admin username without mutating passwordHash or creating another user', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin@example.com';
    process.env.PLATFORM_ADMIN_PASSWORD = 'DifferentPasswordAttempt123!';

    const originalHash = '$argon2id$v=19$m=65536,t=3,p=1$original_existing_hash';
    const existingAdmin = {
      id: 'uuid-existing-admin',
      username: 'admin@example.com',
      role: 'platform_admin',
      isActive: true,
      passwordHash: originalHash,
    };
    mockUserRepo.findByUsername.mockResolvedValue(existingAdmin);

    const res = await authService.createInitialPlatformAdminFromEnv();
    expect(res).toEqual({
      status: 'already_exists',
      userId: 'uuid-existing-admin',
      username: 'admin@example.com',
    });
    expect(existingAdmin.passwordHash).toBe(originalHash);
    expect(mockUserRepo.createUser).not.toHaveBeenCalled();
    expect(mockUserRepo.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('should reject creation when another platform_admin already exists (count > 0)', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'second-admin@example.com';
    process.env.PLATFORM_ADMIN_PASSWORD = 'SuperSecurePassword123!';

    mockUserRepo.findByUsername.mockResolvedValue(null);
    mockUserRepo.countPlatformAdmins.mockResolvedValue(1);

    await expect(authService.createInitialPlatformAdminFromEnv()).rejects.toThrow(
      'a platform_admin account already exists'
    );
    expect(mockUserRepo.createUser).not.toHaveBeenCalled();
  });

  it('should reject silent promotion when username exists with non-platform_admin role', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'regular.user@example.com';
    process.env.PLATFORM_ADMIN_PASSWORD = 'SuperSecurePassword123!';

    mockUserRepo.findByUsername.mockResolvedValue({
      id: 'uuid-regular',
      username: 'regular.user@example.com',
      role: 'user',
      isActive: true,
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$fake',
    });

    await expect(authService.createInitialPlatformAdminFromEnv()).rejects.toThrow(
      'Silent promotion is forbidden'
    );
    expect(mockUserRepo.createUser).not.toHaveBeenCalled();
  });
});

describe('Explicit Password Change Governance (UserAdminService.resetPassword)', () => {
  let userAdminService: UserAdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    userAdminService = new UserAdminService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject unauthenticated callers', async () => {
    await expect(
      userAdminService.resetPassword(undefined, 'target-user-id', '$argon2id$new_hash')
    ).rejects.toThrow(ForbiddenError);
  });

  it('should forbid non-platform_admin from resetting a platform_admin password', async () => {
    vi.spyOn(defaultUserRepository, 'findById').mockResolvedValue({
      id: 'target-platform-admin',
      username: 'admin',
      role: 'platform_admin',
      isActive: true,
      passwordHash: '$argon2id$existing',
      createdAt: new Date().toISOString(),
    });
    const updateSpy = vi.spyOn(defaultUserRepository, 'updatePasswordHashById');
    const auditSpy = vi.spyOn(defaultAuditService, 'record');

    await expect(
      userAdminService.resetPassword(
        { id: 'company-admin-1', username: 'cadmin', role: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
        'target-platform-admin',
        '$argon2id$new_hash',
        'company-1'
      )
    ).rejects.toThrow('Only platform admin can reset platform admin password');

    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('should require companyId and USER_WRITE + active membership for company admins', async () => {
    vi.spyOn(defaultUserRepository, 'findById').mockResolvedValue({
      id: 'target-user-1',
      username: 'staff',
      role: 'user',
      isActive: true,
      passwordHash: '$argon2id$existing',
      createdAt: new Date().toISOString(),
    });
    vi.spyOn(defaultRbacService, 'hasPermission').mockResolvedValue(false);
    const updateSpy = vi.spyOn(defaultUserRepository, 'updatePasswordHashById');

    await expect(
      userAdminService.resetPassword(
        { id: 'actor-1', username: 'cadmin', role: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
        'target-user-1',
        '$argon2id$new_hash'
      )
    ).rejects.toThrow(ValidationError);

    await expect(
      userAdminService.resetPassword(
        { id: 'actor-1', username: 'cadmin', role: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
        'target-user-1',
        '$argon2id$new_hash',
        'company-1'
      )
    ).rejects.toThrow('Missing USER_WRITE permission');

    vi.spyOn(defaultRbacService, 'hasPermission').mockResolvedValue(true);
    vi.spyOn(defaultMembershipStore, 'getMembership').mockResolvedValue(null);

    await expect(
      userAdminService.resetPassword(
        { id: 'actor-1', username: 'cadmin', role: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
        'target-user-1',
        '$argon2id$new_hash',
        'company-1'
      )
    ).rejects.toThrow('Cannot reset password for user outside your company membership');

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('should allow authenticated platform_admin to reset password and record PASSWORD_RESET audit event', async () => {
    vi.spyOn(defaultUserRepository, 'findById').mockResolvedValue({
      id: 'target-platform-admin',
      username: 'admin',
      role: 'platform_admin',
      isActive: true,
      passwordHash: '$argon2id$old_hash',
      createdAt: new Date().toISOString(),
    });
    const updateSpy = vi.spyOn(defaultUserRepository, 'updatePasswordHashById').mockResolvedValue(true);
    const auditSpy = vi.spyOn(defaultAuditService, 'record').mockResolvedValue(undefined as any);

    const newHash = await hashPassword('ExplicitNewAdminPass!2026');
    const result = await userAdminService.resetPassword(
      { id: 'platform-admin-actor', username: 'admin', role: 'platform_admin', createdAt: '2026-01-01T00:00:00.000Z' },
      'target-platform-admin',
      newHash
    );

    expect(result).toBe(true);
    expect(updateSpy).toHaveBeenCalledWith('target-platform-admin', newHash);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'platform-admin-actor',
        companyId: null,
        action: 'PASSWORD_RESET',
        entityType: 'user',
        entityId: 'target-platform-admin',
      })
    );
  });
});
