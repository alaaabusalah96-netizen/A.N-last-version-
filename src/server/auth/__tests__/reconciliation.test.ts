import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../authService.js';
import { UserStore } from '../userStore.js';
import { SessionStore } from '../sessionStore.js';

describe('AuthService Reconciliation', () => {
  let authService: AuthService;
  let mockUserStore: any;
  let mockSessionStore: any;

  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    
    mockUserStore = {
      findByUsername: vi.fn(),
      updatePasswordHash: vi.fn(),
      createUser: vi.fn(),
      findById: vi.fn(),
    };
    mockSessionStore = {};
    
    authService = new AuthService(mockUserStore as unknown as UserStore, mockSessionStore as unknown as SessionStore);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should skip reconciliation if credentials are missing', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = '';
    process.env.PLATFORM_ADMIN_PASSWORD = '';
    
    const result = await authService.bootstrapPlatformAdminFromEnv();
    expect(result).toBe(false);
    expect(mockUserStore.findByUsername).not.toHaveBeenCalled();
  });

  it('should fail if only username is provided', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = '';
    
    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('Both PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD must be configured');
  });

  it('should fail if password is too short', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'short';
    
    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('must be at least 12 characters long');
  });

  it('should reconcile password if hashes mismatch', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';
    
    mockUserStore.findByUsername.mockResolvedValue({
      username: 'admin',
      role: 'platform_admin',
      isActive: true,
      passwordHash: 'old-hash'
    });
    mockUserStore.updatePasswordHash.mockResolvedValue(true);
    
    const result = await authService.bootstrapPlatformAdminFromEnv();
    expect(result).toBe(true);
    expect(mockUserStore.updatePasswordHash).toHaveBeenCalled();
  });

  it('should fail if account is inactive', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';
    
    mockUserStore.findByUsername.mockResolvedValue({
      username: 'admin',
      role: 'platform_admin',
      isActive: false,
      passwordHash: 'some-hash'
    });
    
    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('is inactive');
    expect(mockUserStore.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('should fail if role is not platform_admin', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';
    
    mockUserStore.findByUsername.mockResolvedValue({
      username: 'admin',
      role: 'user',
      isActive: true,
      passwordHash: 'some-hash'
    });
    
    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('already exists with role \'user\'');
    expect(mockUserStore.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('should fail if database update affects zero rows', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';
    
    mockUserStore.findByUsername.mockResolvedValue({
      username: 'admin',
      role: 'platform_admin',
      isActive: true,
      passwordHash: 'old-hash'
    });
    mockUserStore.updatePasswordHash.mockResolvedValue(false);
    
    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('Zero rows affected');
  });

  it('should NOT create a new admin if it does not exist', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';
    
    mockUserStore.findByUsername.mockResolvedValue(null);
    
    const result = await authService.bootstrapPlatformAdminFromEnv();
    expect(result).toBe(false);
    expect(mockUserStore.createUser).not.toHaveBeenCalled();
  });
});

describe('AuthService Explicit CLI Bootstrap (createInitialPlatformAdminFromEnv)', () => {
  let mockUserStore: any;
  let mockSessionStore: any;
  let mockUserRepo: any;
  let authService: AuthService;
  const originalEnv = process.env;

  beforeEach(() => {
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

  it('should return already_exists for the same platform_admin username without creating another user', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin@example.com';
    process.env.PLATFORM_ADMIN_PASSWORD = 'SuperSecurePassword123!';

    mockUserRepo.findByUsername.mockResolvedValue({
      id: 'uuid-existing-admin',
      username: 'admin@example.com',
      role: 'platform_admin',
      isActive: true,
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$fake',
    });

    const res = await authService.createInitialPlatformAdminFromEnv();
    expect(res).toEqual({
      status: 'already_exists',
      userId: 'uuid-existing-admin',
      username: 'admin@example.com',
    });
    expect(mockUserRepo.createUser).not.toHaveBeenCalled();
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
