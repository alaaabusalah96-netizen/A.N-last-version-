import { defaultUserRepository, UserRepository } from './userRepository.js';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: 'platform_admin' | 'user';
  createdAt: string;
  isActive?: boolean;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  role: 'platform_admin' | 'user';
}

/**
 * User Store (Delegates to PostgreSQL UserRepository — No Map fallback)
 */
export class UserStore {
  constructor(private repo: UserRepository = defaultUserRepository) {}

  async createUser(input: CreateUserInput): Promise<User> {
    return this.repo.createUser(input);
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.repo.findByUsername(username);
  }

  async findById(id: string): Promise<User | null> {
    return this.repo.findById(id);
  }

  async listUsers(): Promise<Omit<User, 'passwordHash'>[]> {
    return this.repo.listUsers();
  }

  clear(): void {
    // No-op for database-backed store
  }
}

export const defaultUserStore = new UserStore();
