import { hashPassword, verifyPassword } from './passwordHash.js';
import { defaultUserStore, User, UserStore } from './userStore.js';
import { defaultSessionStore, Session, SessionStore } from './sessionStore.js';
import { InvalidCredentialsError, ValidationError } from '../http/errors.js';

export interface LoginResult {
  session: Session;
  user: Omit<User, 'passwordHash'>;
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
    private sessionStore: SessionStore = defaultSessionStore
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

    if (!user) {
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
   * Initializes initial platform administrator account securely from environment variables.
   * Requires password length >= 12 characters.
   */
  async bootstrapPlatformAdminFromEnv(): Promise<boolean> {
    const isProd = process.env.NODE_ENV === 'production';
    const username = process.env.PLATFORM_ADMIN_USERNAME;
    const password = process.env.PLATFORM_ADMIN_PASSWORD;

    if (!username || !password || username.trim() === '' || password.trim() === '') {
      return false;
    }

    if (password.length < 12) {
      const msg = '[auth] FATAL: PLATFORM_ADMIN_PASSWORD must be at least 12 characters long';
      if (isProd) {
        throw new Error(msg);
      }
      console.warn(msg);
      return false;
    }

    const normalizedUsername = username.trim().toLowerCase();

    try {
      const existing = await this.userStore.findByUsername(normalizedUsername);
      if (existing) {
        return false;
      }

      const passwordHash = await hashPassword(password);
      await this.userStore.createUser({
        username: normalizedUsername,
        passwordHash,
        role: 'platform_admin',
        companyId: null,
      });

      console.log(`[auth] Platform admin '${normalizedUsername}' initialized from environment variables.`);
      return true;
    } catch (err: unknown) {
      console.error('[auth] Bootstrap platform admin error:', err);
      if (isProd) {
        throw err;
      }
      return false;
    }
  }
}

export const defaultAuthService = new AuthService();
