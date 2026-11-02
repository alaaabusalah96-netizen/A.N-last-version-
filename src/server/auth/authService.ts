import { hashPassword, verifyPassword } from './passwordHash.js';
import { defaultUserStore, User, UserStore } from './userStore.js';
import { defaultSessionStore, Session, SessionStore } from './sessionStore.js';

export interface LoginResult {
  session: Session;
  user: Omit<User, 'passwordHash'>;
}

export class AuthService {
  constructor(
    private userStore: UserStore = defaultUserStore,
    private sessionStore: SessionStore = defaultSessionStore
  ) {}

  async login(username: string, plainPassword: string): Promise<LoginResult> {
    if (!username || !plainPassword) {
      throw new Error('Username and password are required');
    }

    const user = await this.userStore.findByUsername(username);
    if (!user) {
      throw new Error('Invalid username or password');
    }

    const isValid = await verifyPassword(plainPassword, user.passwordHash);
    if (!isValid) {
      throw new Error('Invalid username or password');
    }

    const session = this.sessionStore.createSession(user.id);
    const { passwordHash: _, ...safeUser } = user;

    return { session, user: safeUser };
  }

  logout(sessionId: string): boolean {
    if (!sessionId) return false;
    return this.sessionStore.revokeSession(sessionId);
  }

  async getSessionUser(sessionId: string): Promise<Omit<User, 'passwordHash'> | null> {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) return null;

    const user = await this.userStore.findById(session.userId);
    if (!user) return null;

    const { passwordHash: _, ...safeUser } = user;
    return safeUser;
  }

  /**
   * Initializes initial platform administrator account securely from environment variables.
   * Never logs credentials or uses hardcoded passwords.
   */
  async bootstrapPlatformAdminFromEnv(): Promise<boolean> {
    const username = process.env.PLATFORM_ADMIN_USERNAME;
    const password = process.env.PLATFORM_ADMIN_PASSWORD;

    if (!username || !password || username.trim() === '' || password.trim() === '') {
      // Quietly skip if not configured in environment
      return false;
    }

    const existing = await this.userStore.findByUsername(username);
    if (existing) {
      return false;
    }

    const passwordHash = await hashPassword(password);
    await this.userStore.createUser({
      username,
      passwordHash,
      role: 'platform_admin',
      companyId: null,
    });

    console.log(`[auth] Platform admin '${username}' initialized from environment variables.`);
    return true;
  }
}

export const defaultAuthService = new AuthService();
