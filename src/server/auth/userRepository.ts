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
      INSERT INTO platform_users (username, password_hash, role, is_active)
      VALUES ($1, $2, $3, true)
      RETURNING id, username, password_hash as "passwordHash", role, created_at as "createdAt", is_active as "isActive";
    `;

    const res = await executor.query<User>(sql, [
      normalizedUsername,
      input.passwordHash,
      input.role,
    ]);

    return res.rows[0];
  }

  async findByUsername(username: string): Promise<User | null> {
    const executor = await this.getExecutor();
    const normalized = username.trim().toLowerCase();

    const sql = `
      SELECT id, username, password_hash as "passwordHash", role, created_at as "createdAt", is_active as "isActive"
      FROM platform_users
      WHERE username = $1;
    `;

    const res = await executor.query<User>(sql, [normalized]);
    return res.rows[0] || null;
  }

  async findById(id: string): Promise<User | null> {
    const executor = await this.getExecutor();

    const sql = `
      SELECT id, username, password_hash as "passwordHash", role, created_at as "createdAt", is_active as "isActive"
      FROM platform_users
      WHERE id = $1;
    `;

    const res = await executor.query<User>(sql, [id]);
    return res.rows[0] || null;
  }

  async listUsers(): Promise<Omit<User, 'passwordHash'>[]> {
    const executor = await this.getExecutor();

    const sql = `
      SELECT id, username, role, created_at as "createdAt", is_active as "isActive"
      FROM platform_users
      WHERE is_active = true
      ORDER BY created_at DESC;
    `;

    const res = await executor.query<Omit<User, 'passwordHash'>>(sql);
    return res.rows;
  }

  async updatePasswordHash(username: string, newPasswordHash: string): Promise<boolean> {
    const executor = await this.getExecutor();
    const normalizedUsername = username.trim().toLowerCase();

    const sql = `
      UPDATE platform_users
      SET password_hash = $2
      WHERE username = $1 AND role = 'platform_admin' AND is_active = true;
    `;

    const res = await executor.query(sql, [normalizedUsername, newPasswordHash]);
    return (res.rowCount ?? 0) === 1;
  }

  async listUsersAdmin(): Promise<Omit<User, 'passwordHash'>[]> {
    const executor = await this.getExecutor();

    const sql = `
      SELECT id, username, role, created_at as "createdAt", is_active as "isActive"
      FROM platform_users
      ORDER BY created_at DESC;
    `;

    const res = await executor.query<Omit<User, 'passwordHash'>>(sql);
    return res.rows;
  }

  async setUserActive(userId: string, isActive: boolean): Promise<boolean> {
    const executor = await this.getExecutor();
    const sql = `
      UPDATE platform_users
      SET is_active = $2
      WHERE id = $1;
    `;
    const res = await executor.query(sql, [userId, isActive]);
    return (res.rowCount ?? 0) === 1;
  }

  async updatePasswordHashById(userId: string, newPasswordHash: string): Promise<boolean> {
    const executor = await this.getExecutor();
    const sql = `
      UPDATE platform_users
      SET password_hash = $2
      WHERE id = $1;
    `;
    const res = await executor.query(sql, [userId, newPasswordHash]);
    return (res.rowCount ?? 0) === 1;
  }
}

export const defaultUserRepository = new UserRepository();
