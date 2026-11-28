import { getDefaultExecutor } from '../db/index.js';
import { DbExecutor } from '../db/types.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../http/errors.js';
import { isUuid, isValidCompanyCode } from '../http/validators.js';
import { defaultAuditService } from '../audit/auditService.js';

export type GroupRole = 'group_admin' | 'group_viewer';

export interface CompanyGroup {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  isActive: boolean;
  createdAt: string;
  myRole?: GroupRole | 'platform_admin';
}
export interface GroupMemberCompany { companyId: string; code: string; nameAr: string; isActive: boolean; addedAt: string }
export interface GroupUser { userId: string; username: string; role: GroupRole; isActive: boolean }
export interface GroupDetail extends CompanyGroup { companies: GroupMemberCompany[]; users: GroupUser[] }

export interface Actor { id: string; role: string }

const GROUP_COLS = `g.id, g.code, g.name_ar as "nameAr", g.name_en as "nameEn", g.is_active as "isActive", g.created_at as "createdAt"`;

/**
 * Company groups (platform level). Platform admins manage groups and their companies.
 * A group admin manages the group name and the group users. A group viewer only reads.
 * Company data is never read here: each company keeps its own tenant RLS.
 */
export class CompanyGroupService {
  private async exec(): Promise<DbExecutor> {
    const e = await getDefaultExecutor();
    if (!e) throw new Error('DB_UNAVAILABLE: Database executor required for company groups');
    return e;
  }

  /** Role of the actor in the group, or null when the actor has no access. */
  async roleIn(groupId: string, actor: Actor, ex?: DbExecutor): Promise<GroupRole | 'platform_admin' | null> {
    if (actor.role === 'platform_admin') return 'platform_admin';
    const e = ex || (await this.exec());
    const r = await e.query<any>(
      `SELECT u.role FROM company_group_users u JOIN company_groups g ON g.id = u.group_id
       WHERE u.group_id = $1 AND u.user_id = $2 AND u.is_active AND g.is_active`,
      [groupId, actor.id]
    );
    return r.rows[0]?.role ?? null;
  }

  private assertUuid(v: string, label: string) {
    if (!isUuid(v)) throw new ValidationError(`${label} غير صالح`);
  }

  async create(actor: Actor, input: { code: string; nameAr: string; nameEn?: string }, ip?: string): Promise<CompanyGroup> {
    if (actor.role !== 'platform_admin') throw new ForbiddenError('إنشاء مجموعة شركات متاح لمدير المنصة فقط');
    const code = (input.code || '').trim();
    const nameAr = (input.nameAr || '').trim();
    if (!code || !isValidCompanyCode(code)) throw new ValidationError('كود المجموعة مطلوب (حروف وأرقام وشرطات، حتى 50)');
    if (!nameAr) throw new ValidationError('اسم المجموعة بالعربية مطلوب');
    const e = await this.exec();
    let created: CompanyGroup | undefined;
    await e.withTransaction(async (tx) => {
      const dup = await tx.query<any>('SELECT 1 FROM company_groups WHERE lower(code) = lower($1)', [code]);
      if (dup.rows.length) throw new ValidationError('كود المجموعة مستخدم بالفعل');
      const r = await tx.query<any>(
        `INSERT INTO company_groups (code, name_ar, name_en, created_by) VALUES ($1,$2,$3,$4)
         RETURNING id, code, name_ar as "nameAr", name_en as "nameEn", is_active as "isActive", created_at as "createdAt"`,
        [code, nameAr, (input.nameEn || '').trim() || null, actor.id]
      );
      created = r.rows[0];
      await defaultAuditService.record(
        { actorUserId: actor.id, action: 'company_group.create', entityType: 'company_group', entityId: created!.id, ipAddress: ip || 'unknown', metadata: { code, nameAr } },
        { executor: tx }
      );
    });
    return created!;
  }

  /** Groups the actor can see (all for a platform admin). */
  async listForActor(actor: Actor): Promise<CompanyGroup[]> {
    const e = await this.exec();
    if (actor.role === 'platform_admin') {
      const r = await e.query<any>(`SELECT ${GROUP_COLS} FROM company_groups g ORDER BY g.code`);
      return r.rows.map((x: any) => ({ ...x, myRole: 'platform_admin' }));
    }
    const r = await e.query<any>(
      `SELECT ${GROUP_COLS}, u.role as "myRole" FROM company_groups g
       JOIN company_group_users u ON u.group_id = g.id AND u.user_id = $1 AND u.is_active
       WHERE g.is_active ORDER BY g.code`,
      [actor.id]
    );
    return r.rows;
  }

  async get(actor: Actor, groupId: string): Promise<GroupDetail> {
    this.assertUuid(groupId, 'المجموعة');
    const e = await this.exec();
    const role = await this.roleIn(groupId, actor, e);
    if (!role) throw new NotFoundError('المجموعة غير موجودة');
    const g = await e.query<any>(`SELECT ${GROUP_COLS} FROM company_groups g WHERE g.id = $1`, [groupId]);
    if (!g.rows[0]) throw new NotFoundError('المجموعة غير موجودة');
    const [cs, us] = await Promise.all([
      e.query<any>(
        `SELECT c.id as "companyId", c.code, c.name_ar as "nameAr", c.is_active as "isActive", m.added_at as "addedAt"
         FROM company_group_members m JOIN companies c ON c.id = m.company_id WHERE m.group_id = $1 ORDER BY c.code`,
        [groupId]
      ),
      e.query<any>(
        `SELECT u.user_id as "userId", p.username, u.role, u.is_active as "isActive"
         FROM company_group_users u JOIN platform_users p ON p.id = u.user_id WHERE u.group_id = $1 ORDER BY p.username`,
        [groupId]
      ),
    ]);
    return { ...g.rows[0], myRole: role, companies: cs.rows, users: us.rows };
  }

  async update(actor: Actor, groupId: string, patch: { nameAr?: string; nameEn?: string | null; isActive?: boolean }, ip?: string): Promise<void> {
    this.assertUuid(groupId, 'المجموعة');
    const e = await this.exec();
    const role = await this.roleIn(groupId, actor, e);
    if (!role) throw new NotFoundError('المجموعة غير موجودة');
    if (role === 'group_viewer') throw new ForbiddenError('صلاحية قراءة فقط على المجموعة');
    if (patch.isActive !== undefined && role !== 'platform_admin') throw new ForbiddenError('تفعيل وإيقاف المجموعة لمدير المنصة فقط');
    const nameAr = patch.nameAr === undefined ? undefined : patch.nameAr.trim();
    if (nameAr !== undefined && !nameAr) throw new ValidationError('اسم المجموعة بالعربية مطلوب');
    await e.withTransaction(async (tx) => {
      await tx.query(
        `UPDATE company_groups SET name_ar = COALESCE($2, name_ar),
           name_en = CASE WHEN $3::boolean THEN $4 ELSE name_en END,
           is_active = COALESCE($5, is_active), updated_at = NOW() WHERE id = $1`,
        [groupId, nameAr ?? null, patch.nameEn !== undefined, patch.nameEn === undefined ? null : (patch.nameEn || '').trim() || null, patch.isActive ?? null]
      );
      await defaultAuditService.record(
        { actorUserId: actor.id, action: 'company_group.update', entityType: 'company_group', entityId: groupId, ipAddress: ip || 'unknown', metadata: { ...patch } },
        { executor: tx }
      );
    });
  }

  async addCompany(actor: Actor, groupId: string, companyId: string, ip?: string): Promise<void> {
    this.assertUuid(groupId, 'المجموعة');
    this.assertUuid(companyId, 'الشركة');
    if (actor.role !== 'platform_admin') throw new ForbiddenError('إضافة الشركات للمجموعة لمدير المنصة فقط');
    const e = await this.exec();
    await e.withTransaction(async (tx) => {
      const g = await tx.query<any>('SELECT is_active FROM company_groups WHERE id = $1', [groupId]);
      if (!g.rows[0]) throw new NotFoundError('المجموعة غير موجودة');
      if (!g.rows[0].is_active) throw new ValidationError('المجموعة موقوفة');
      const c = await tx.query<any>('SELECT is_active FROM companies WHERE id = $1', [companyId]);
      if (!c.rows[0]) throw new NotFoundError('الشركة غير موجودة');
      if (!c.rows[0].is_active) throw new ValidationError('الشركة موقوفة');
      const ex = await tx.query<any>('SELECT group_id FROM company_group_members WHERE company_id = $1', [companyId]);
      if (ex.rows[0]) throw new ValidationError(ex.rows[0].group_id === groupId ? 'الشركة ضمن هذه المجموعة بالفعل' : 'الشركة ضمن مجموعة أخرى بالفعل');
      await tx.query('INSERT INTO company_group_members (group_id, company_id, added_by) VALUES ($1,$2,$3)', [groupId, companyId, actor.id]);
      await defaultAuditService.record(
        { actorUserId: actor.id, companyId, action: 'company_group.add_company', entityType: 'company_group', entityId: groupId, ipAddress: ip || 'unknown', metadata: { companyId } },
        { executor: tx }
      );
    });
  }

  async removeCompany(actor: Actor, groupId: string, companyId: string, ip?: string): Promise<void> {
    this.assertUuid(groupId, 'المجموعة');
    this.assertUuid(companyId, 'الشركة');
    if (actor.role !== 'platform_admin') throw new ForbiddenError('إزالة الشركات من المجموعة لمدير المنصة فقط');
    const e = await this.exec();
    await e.withTransaction(async (tx) => {
      const r = await tx.query<any>('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2 RETURNING 1', [groupId, companyId]);
      if (!r.rows[0]) throw new NotFoundError('الشركة ليست ضمن هذه المجموعة');
      await defaultAuditService.record(
        { actorUserId: actor.id, companyId, action: 'company_group.remove_company', entityType: 'company_group', entityId: groupId, ipAddress: ip || 'unknown', metadata: { companyId } },
        { executor: tx }
      );
    });
  }

  /** Assign or change a group user's role. Platform admin or group admin of that group. */
  async setUser(actor: Actor, groupId: string, userId: string, role: GroupRole, isActive = true, ip?: string): Promise<void> {
    this.assertUuid(groupId, 'المجموعة');
    this.assertUuid(userId, 'المستخدم');
    if (role !== 'group_admin' && role !== 'group_viewer') throw new ValidationError('دور المجموعة غير صالح');
    const e = await this.exec();
    const mine = await this.roleIn(groupId, actor, e);
    if (!mine) throw new NotFoundError('المجموعة غير موجودة');
    if (mine === 'group_viewer') throw new ForbiddenError('صلاحية قراءة فقط على المجموعة');
    await e.withTransaction(async (tx) => {
      const u = await tx.query<any>('SELECT 1 FROM platform_users WHERE id = $1', [userId]);
      if (!u.rows[0]) throw new NotFoundError('المستخدم غير موجود');
      if (userId === actor.id && mine === 'group_admin' && (role !== 'group_admin' || !isActive)) {
        throw new ValidationError('لا يمكنك تخفيض صلاحيتك أو إيقاف نفسك');
      }
      await tx.query(
        `INSERT INTO company_group_users (group_id, user_id, role, is_active, added_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (group_id, user_id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active`,
        [groupId, userId, role, isActive, actor.id]
      );
      await defaultAuditService.record(
        { actorUserId: actor.id, action: 'company_group.set_user', entityType: 'company_group', entityId: groupId, ipAddress: ip || 'unknown', metadata: { userId, role, isActive } },
        { executor: tx }
      );
    });
  }

  /** Same as setUser, resolving the user by username (group admins do not see the user list). */
  async setUserByUsername(actor: Actor, groupId: string, username: string, role: GroupRole, ip?: string): Promise<void> {
    this.assertUuid(groupId, 'المجموعة');
    const name = (username || '').trim();
    if (!name) throw new ValidationError('اسم المستخدم مطلوب');
    const e = await this.exec();
    const mine = await this.roleIn(groupId, actor, e);
    if (!mine) throw new NotFoundError('المجموعة غير موجودة');
    const u = await e.query<any>('SELECT id FROM platform_users WHERE lower(username) = lower($1)', [name]);
    if (!u.rows[0]) throw new NotFoundError('المستخدم غير موجود');
    await this.setUser(actor, groupId, u.rows[0].id, role, true, ip);
  }

  async removeUser(actor: Actor, groupId: string, userId: string, ip?: string): Promise<void> {
    this.assertUuid(groupId, 'المجموعة');
    this.assertUuid(userId, 'المستخدم');
    const e = await this.exec();
    const mine = await this.roleIn(groupId, actor, e);
    if (!mine) throw new NotFoundError('المجموعة غير موجودة');
    if (mine === 'group_viewer') throw new ForbiddenError('صلاحية قراءة فقط على المجموعة');
    if (userId === actor.id && mine === 'group_admin') throw new ValidationError('لا يمكنك إزالة نفسك');
    await e.withTransaction(async (tx) => {
      const r = await tx.query<any>('DELETE FROM company_group_users WHERE group_id = $1 AND user_id = $2 RETURNING 1', [groupId, userId]);
      if (!r.rows[0]) throw new NotFoundError('المستخدم ليس ضمن المجموعة');
      await defaultAuditService.record(
        { actorUserId: actor.id, action: 'company_group.remove_user', entityType: 'company_group', entityId: groupId, ipAddress: ip || 'unknown', metadata: { userId } },
        { executor: tx }
      );
    });
  }
}

export const defaultCompanyGroupService = new CompanyGroupService();
