import { hashPassword, verifyPassword } from './passwordHash.js';
import { defaultUserStore, User, UserStore } from './userStore.js';
import { defaultUserRepository, UserRepository } from './userRepository.js';
import { defaultSessionStore, Session, SessionStore } from './sessionStore.js';
import { InvalidCredentialsError, ValidationError } from '../http/errors.js';
import { DbExecutor } from '../db/types.js';

export interface LoginResult {
  session: Session;
  user: Omit<User, 'passwordHash'>;
}

export interface ParsedPlatformAdminEnvCredentials {
  username: string;
  password: string;
}

export interface ExplicitBootstrapResult {
  status: 'created' | 'already_exists';
  userId: string;
  username: string;
}

type BootstrapRepoPort = Pick<
  UserRepository,
  'countPlatformAdmins' | 'findByUsername' | 'createUser' | 'withTransaction'
>;

export function parsePlatformAdminEnvCredentials(
  requireConfigured: true
): ParsedPlatformAdminEnvCredentials;
export function parsePlatformAdminEnvCredentials(
  requireConfigured: false
): ParsedPlatformAdminEnvCredentials | null;
export function parsePlatformAdminEnvCredentials(
  requireConfigured: boolean
): ParsedPlatformAdminEnvCredentials | null {
  const rawUsername = process.env.PLATFORM_ADMIN_USERNAME;
  const rawPassword = process.env.PLATFORM_ADMIN_PASSWORD;

  const hasUsername = Boolean(rawUsername && rawUsername.trim() !== '');
  const hasPassword = Boolean(rawPassword && rawPassword.trim() !== '');

  if ((hasUsername && !hasPassword) || (!hasUsername && hasPassword)) {
    throw new Error(
      '[auth] FATAL: Both PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD must be configured together for administrator bootstrap'
    );
  }

  if (!hasUsername || !hasPassword) {
    if (requireConfigured) {
      throw new Error(
        '[auth] FATAL: Both PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD environment variables are required'
      );
    }
    return null;
  }

  const username = rawUsername!.trim().toLowerCase();
  const password = rawPassword!;

  if (username.length === 0 || username.length > 150) {
    throw new Error('[auth] FATAL: PLATFORM_ADMIN_USERNAME must be between 1 and 150 characters');
  }

  if (password.length < 12) {
    throw new Error('[auth] FATAL: PLATFORM_ADMIN_PASSWORD must be at least 12 characters long');
  }

  return { username, password };
}

// Pre-computed dummy Argon2 hash for constant-time comparison when username is missing
let DUMMY_PASSWORD_HASH: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!DUMMY_PASSWORD_HASH) {
    DUMMY_PASSWORD_HASH = await hashPassword('dummy_constant_time_comparison_password');
  }
  return DUMMY_PASSWORD_HASH;
}

export class AuthService {
  constructor(
    private userStore: UserStore = defaultUserStore,
    private sessionStore: SessionStore = defaultSessionStore,
    private userRepo: BootstrapRepoPort = defaultUserRepository
  ) {}

  async login(username: string, plainPassword: string): Promise<LoginResult> {
    if (!username || typeof username !== 'string' || !plainPassword || typeof plainPassword !== 'string') {
      throw new ValidationError('Username and password are required');
    }

    const normalizedUsername = username.trim().toLowerCase();

    if (normalizedUsername.length > 150 || plainPassword.length < 8 || plainPassword.length > 1024) {
      throw new InvalidCredentialsError();
    }

    const user = await this.userStore.findByUsername(normalizedUsername);

    if (!user || !user.isActive) {
      // Execute constant-time dummy password verification to prevent username enumeration via timing
      const dummyHash = await getDummyHash();
      await verifyPassword(plainPassword, dummyHash);
      throw new InvalidCredentialsError();
    }

    const isValid = await verifyPassword(plainPassword, user.passwordHash);
    if (!isValid) {
      throw new InvalidCredentialsError();
    }

    const session = await this.sessionStore.createSession(user.id);
    const { passwordHash: _, ...safeUser } = user;

    return { session, user: safeUser };
  }

  async logout(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    return await this.sessionStore.revokeSession(sessionId);
  }

  async revokeAllSessionsForUser(userId: string): Promise<number> {
    if (!userId) return 0;
    return await this.sessionStore.revokeAllForUser(userId);
  }

  async getSessionUser(sessionId: string): Promise<Omit<User, 'passwordHash'> | null> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) return null;

    const user = await this.userStore.findById(session.userId);
    if (!user) return null;

    const { passwordHash: _, ...safeUser } = user;
    return safeUser;
  }

  /**
   * Verifies an existing platform_admin on server startup without mutating credentials.
   * Strictly non-creating when no account exists (use explicit CLI `bootstrap:admin`)
   * and strictly non-mutating when the administrator already exists.
   */
  async bootstrapPlatformAdminFromEnv(): Promise<boolean> {
    const credentials = parsePlatformAdminEnvCredentials(false);
    if (!credentials) {
      return false; // Neither configured; startup check not requested
    }

    const { username, password } = credentials;

    try {
      const existing = await this.userStore.findByUsername(username);

      if (existing) {
        if (existing.role !== 'platform_admin') {
          throw new Error(
            `[auth] FATAL: Bootstrap conflict — user '${username}' already exists with role '${existing.role}', not 'platform_admin'`
          );
        }

        if (!existing.isActive) {
          throw new Error(`[auth] FATAL: Bootstrap failed — platform admin account '${username}' is inactive`);
        }

        // Non-mutating check: never overwrite an existing administrator's password_hash on startup
        const isMatch = await verifyPassword(password, existing.passwordHash || '');
        if (!isMatch) {
          console.warn(
            `[auth] WARNING: Existing platform admin '${username}' password hash does not match current PLATFORM_ADMIN_PASSWORD. Startup password overwrite is disabled; preserving existing password hash.`
          );
        } else {
          console.log(`[auth] Platform admin '${username}' verified (existing credentials preserved).`);
        }

        return true;
      }

      // Strictly comply with 'Do not create a new admin account automatically'
      console.warn(`[auth] WARNING: Platform admin account '${username}' does not exist. Automatic creation is disabled.`);
      return false;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('[auth] FATAL:')) {
        throw err;
      }
      const sanitizedMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`[auth] FATAL: Bootstrap failure for platform admin '${username}': ${sanitizedMsg}`);
    }
  }

  /**
   * Explicit one-time CLI bootstrap for the first platform_admin user.
   * Creates a platform_admin ONLY when count(platform_admin) === 0.
   * Refuses silent promotion of existing non-platform_admin users and never logs secrets.
   */
  async createInitialPlatformAdminFromEnv(): Promise<ExplicitBootstrapResult> {
    const { username, password } = parsePlatformAdminEnvCredentials(true);

    const runCreate = async (tx?: DbExecutor): Promise<ExplicitBootstrapResult> => {
      if (tx) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('bootstrap_platform_admin'))");
      }

      const existing = await this.userRepo.findByUsername(username, tx);
      if (existing) {
        if (existing.role !== 'platform_admin') {
          throw new Error(
            `[auth] FATAL: Bootstrap conflict — user '${username}' already exists with role '${existing.role}'. Silent promotion is forbidden.`
          );
        }
        if (existing.isActive === false) {
          throw new Error(
            `[auth] FATAL: Bootstrap failed — platform admin account '${username}' already exists but is inactive`
          );
        }
        return {
          status: 'already_exists',
          userId: existing.id,
          username: existing.username,
        };
      }

      const adminCount = await this.userRepo.countPlatformAdmins(tx);
      if (adminCount > 0) {
        throw new Error(
          `[auth] FATAL: Bootstrap rejected — a platform_admin account already exists (count=${adminCount}). Explicit CLI creation is allowed only when zero platform admins exist.`
        );
      }

      const passwordHash = await hashPassword(password);
      const created = await this.userRepo.createUser(
        {
          username,
          passwordHash,
          role: 'platform_admin',
        },
        tx
      );

      return {
        status: 'created',
        userId: created.id,
        username: created.username,
      };
    };

    try {
      if (typeof this.userRepo.withTransaction === 'function') {
        return await this.userRepo.withTransaction((tx) => runCreate(tx));
      }
      return await runCreate(undefined);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('[auth] FATAL:')) {
        throw err;
      }
      const sanitizedMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`[auth] FATAL: Explicit platform admin creation failed for '${username}': ${sanitizedMsg}`);
    }
  }
}

export const defaultAuthService = new AuthService();
