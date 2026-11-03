import { getDefaultExecutor } from '../db/index.js';
import { User, CreateUserInput } from './userStore.js';

export class UserRepository {
  private async getExecutor() {
    const executor = await getDefaultExecutor();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: Database executor not available for UserRepository');
    }
    return executor;
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const executor = await this.getExecutor();
    const normalizedUsername = input.username.trim().toLowerCase();

    const sql = `
      INSERT INTO platform_users (username, password_hash, role, company_id, is_active)
      VALUES ($1, $2, $3, $4, true)
      RETURNING id, username, password_hash as "passwordHash", role, company_id as "companyId", created_at as "createdAt";
    `;

    const res = await executor.query<User>(sql, [
      normalizedUsername,
      input.passwordHash,
      input.role,
      input.companyId ?? null,
    ]);

    return res.rows[0];
  }

  async findByUsername(username: string): Promise<User | null> {
    const executor = await this.getExecutor();
    const normalized = username.trim().toLowerCase();

    const sql = `
      SELECT id, username, password_hash as "passwordHash", role, company_id as "companyId", created_at as "createdAt", is_active as "isActive"
      FROM platform_users
      WHERE username = $1 AND is_active = true;
    `;

    const res = await executor.query<User>(sql, [normalized]);
    return res.rows[0] || null;
  }

  async findById(id: string): Promise<User | null> {
    const executor = await this.getExecutor();

    const sql = `
      SELECT id, username, password_hash as "passwordHash", role, company_id as "companyId", created_at as "createdAt", is_active as "isActive"
      FROM platform_users
      WHERE id = $1 AND is_active = true;
    `;

    const res = await executor.query<User>(sql, [id]);
    return res.rows[0] || null;
  }

  async listUsers(): Promise<Omit<User, 'passwordHash'>[]> {
    const executor = await this.getExecutor();

    const sql = `
      SELECT id, username, role, company_id as "companyId", created_at as "createdAt"
      FROM platform_users
      WHERE is_active = true
      ORDER BY created_at DESC;
    `;

    const res = await executor.query<Omit<User, 'passwordHash'>>(sql);
    return res.rows;
  }
}

export const defaultUserRepository = new UserRepository();
