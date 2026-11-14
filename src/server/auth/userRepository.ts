import { getDefaultExecutor } from '../db/index.js';
import { tenantContextStorage } from '../db/tenantContext.js';
import { DbExecutor } from '../db/types.js';
import { User, CreateUserInput } from './userStore.js';

export class UserRepository {
  private async getExecutor(customExecutor?: DbExecutor): Promise<DbExecutor> {
    if (customExecutor) return customExecutor;
    const ctxExecutor = tenantContextStorage.getCurrentExecutor();
    if (ctxExecutor) return ctxExecutor;
    const executor = await getDefaultExecutor();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: Database executor not available for UserRepository');
    }
    return executor;
  }

  async withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const executor = await this.getExecutor();
    return await executor.withTransaction(fn);
  }

  async createUser(input: CreateUserInput, customExecutor?: DbExecutor): Promise<User> {
    const executor = await this.getExecutor(customExecutor);
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

  async findByUsername(username: string, customExecutor?: DbExecutor): Promise<User | null> {
    const executor = await this.getExecutor(customExecutor);
    const normalized = username.trim().toLowerCase();

    const sql = `
      SELECT id, username, password_hash as "passwordHash", role, created_at as "createdAt", is_active as "isActive"
      FROM platform_users
      WHERE username = $1;
    `;

    const res = await executor.query<User>(sql, [normalized]);
    return res.rows[0] || null;
  }

  async findById(id: string, customExecutor?: DbExecutor): Promise<User | null> {
    const executor = await this.getExecutor(customExecutor);

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

  async listUsersByCompany(companyId: string): Promise<Omit<User, 'passwordHash'>[]> {
    const executor = await this.getExecutor();

    const sql = `
      SELECT u.id, u.username, u.role, u.created_at as "createdAt", u.is_active as "isActive"
      FROM platform_users u
      INNER JOIN company_memberships m ON u.id = m.user_id
      WHERE m.company_id = $1
      ORDER BY u.created_at DESC;
    `;

    const res = await executor.query<Omit<User, 'passwordHash'>>(sql, [companyId]);
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
