import crypto from 'crypto';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: 'platform_admin' | 'user';
  companyId?: string | null;
  createdAt: string;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  role: 'platform_admin' | 'user';
  companyId?: string | null;
}

/**
 * In-Memory User Store (V1 Core Identity)
 * Encapsulates user retrieval and creation behind a clean interface.
 */
export class UserStore {
  private users: Map<string, User> = new Map();

  async createUser(input: CreateUserInput): Promise<User> {
    const normalizedUsername = input.username.trim().toLowerCase();
    const existing = await this.findByUsername(normalizedUsername);
    if (existing) {
      throw new Error(`User with username '${normalizedUsername}' already exists`);
    }

    const user: User = {
      id: crypto.randomUUID(),
      username: normalizedUsername,
      passwordHash: input.passwordHash,
      role: input.role,
      companyId: input.companyId ?? null,
      createdAt: new Date().toISOString(),
    };

    this.users.set(user.id, user);
    return user;
  }

  async findByUsername(username: string): Promise<User | null> {
    const normalized = username.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.username === normalized) {
        return user;
      }
    }
    return null;
  }

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async listUsers(): Promise<Omit<User, 'passwordHash'>[]> {
    return Array.from(this.users.values()).map(({ passwordHash: _, ...safeUser }) => safeUser);
  }

  clear(): void {
    this.users.clear();
  }
}

export const defaultUserStore = new UserStore();
