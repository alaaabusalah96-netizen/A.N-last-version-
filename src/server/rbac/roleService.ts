import { defaultAuditService } from '../audit/auditService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { PERMISSIONS } from './permissions.js';
import { defaultRbacService, TenantRunner } from './rbacService.js';
import { defaultRoleRepository, RoleOrgLevel, RoleRecord, RoleRepository } from './roleRepository.js';
import { ROLE_PERMISSIONS, RoleName } from './roles.js';

export interface CreateRoleInput {
  code: string;
  nameAr: string;
  description?: string | null;
  orgLevel?: RoleOrgLevel;
  cloneFromCode?: string;
}

export interface UpdateRoleInput {
  nameAr?: string;
  description?: string | null;
  orgLevel?: RoleOrgLevel;
}

const VALID_ORG_LEVELS: RoleOrgLevel[] = ['company', 'branch', 'department'];
const VALID_PERMISSION_SET = new Set<string>(Object.values(PERMISSIONS));
const ROLE_CODE_REGEX = /^[a-z][a-z0-9_]*$/;

const SYSTEM_ROLE_LABELS: Array<{ code: RoleName; nameAr: string }> = [
  { code: 'platform_admin', nameAr: 'مدير منصة' },
  { code: 'company_admin', nameAr: 'مدير شركة' },
  { code: 'company_user', nameAr: 'مستخدم' },
];

export class RoleService {
  constructor(
    private repo: RoleRepository = defaultRoleRepository,
    private onInvalidate: (companyId: string) => void = (cid) => defaultRbacService.invalidate(cid),
    private runWithTenant: TenantRunner = withTenantTransaction
  ) {}

  async bootstrapCompanyRoles(companyId: string, _actorId?: string, executor?: DbExecutor): Promise<void> {
    const run = async (tx: DbExecutor) => {
      for (const sysRole of SYSTEM_ROLE_LABELS) {
        let role = await this.repo.findByCode(companyId, sysRole.code, tx);
        if (!role) {
          role = await this.repo.insertRole(
            companyId,
            {
              code: sysRole.code,
              nameAr: sysRole.nameAr,
              orgLevel: 'company',
              isSystem: true,
            },
            tx
          );
        }
        const existingPerms = await this.repo.listPermissions(role.id, tx);
        if (existingPerms.length === 0) {
          const defaultPerms = ROLE_PERMISSIONS[sysRole.code] || [];
          if (defaultPerms.length > 0) {
            await this.repo.replacePermissions(role.id, defaultPerms, tx);
          }
        }
      }
    };

    if (executor) {
      await run(executor);
    } else {
      await this.runWithTenant(companyId, run);
    }
  }

  async ensureSeeded(companyId: string, tx: DbExecutor): Promise<void> {
    const existing = await this.repo.listByCompany(companyId, tx);
    const needsBootstrap =
      existing.length === 0 ||
      SYSTEM_ROLE_LABELS.some((sys) => {
        const found = existing.find((r) => r.code === sys.code);
        return !found || (found.permissions !== undefined && found.permissions.length === 0);
      });

    if (needsBootstrap) {
      await this.bootstrapCompanyRoles(companyId, undefined, tx);
    }
  }

  async listRoles(companyId: string): Promise<RoleRecord[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.runWithTenant(companyId, async (tx) => {
      await this.ensureSeeded(companyId, tx);
      return await this.repo.listByCompany(companyId, tx);
    });
  }

  async createRole(companyId: string, input: CreateRoleInput, actorId: string): Promise<RoleRecord> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!actorId || typeof actorId !== 'string') {
      throw new ValidationError('actorId is required');
    }
    if (!input || !input.code || typeof input.code !== 'string') {
      throw new ValidationError('كود الدور مطلوب');
    }

    const normalizedCode = input.code.trim();
    if (!ROLE_CODE_REGEX.test(normalizedCode)) {
      throw new ValidationError('صيغة كود الدور غير صحيحة — يجب أن تبدأ بحرف إنجليزي صغير وتحتوي على أحرف صغيرة أو أرقام أو _ فقط');
    }
    if (!input.nameAr || typeof input.nameAr !== 'string' || !input.nameAr.trim()) {
      throw new ValidationError('الاسم العربي للدور مطلوب');
    }

    const orgLevel: RoleOrgLevel = input.orgLevel || 'company';
    if (!VALID_ORG_LEVELS.includes(orgLevel)) {
      throw new ValidationError('المستوى التنظيمي غير صالح (company / branch / department)');
    }

    if (input.cloneFromCode === 'platform_admin') {
      throw new ValidationError('صلاحيات مدير المنصة غير قابلة للنسخ');
    }

    return await this.runWithTenant(companyId, async (tx) => {
      await this.ensureSeeded(companyId, tx);

      const duplicate = await this.repo.findByCode(companyId, normalizedCode, tx);
      if (duplicate) {
        throw new ValidationError(`كود الدور '${normalizedCode}' موجود مسبقاً في هذه الشركة`);
      }

      let clonedPerms: string[] = [];
      if (input.cloneFromCode && input.cloneFromCode.trim()) {
        const sourceCode = input.cloneFromCode.trim();
        if (sourceCode === 'platform_admin') {
          throw new ValidationError('صلاحيات مدير المنصة غير قابلة للنسخ');
        }
        const sourceRole = await this.repo.findByCode(companyId, sourceCode, tx);
        if (!sourceRole) {
          throw new ValidationError(`الدور المصدر للنسخ غير موجود: ${sourceCode}`);
        }
        clonedPerms = await this.repo.listPermissions(sourceRole.id, tx);
      }

      const created = await this.repo.insertRole(
        companyId,
        {
          code: normalizedCode,
          nameAr: input.nameAr.trim(),
          description: input.description ?? null,
          orgLevel,
          isSystem: false,
        },
        tx
      );

      if (clonedPerms.length > 0) {
        await this.repo.replacePermissions(created.id, clonedPerms, tx);
      }

      await defaultAuditService.record(
        {
          actorUserId: actorId,
          companyId,
          action: 'role.create',
          entityType: 'role',
          entityId: created.id,
          metadata: { code: created.code, cloneFromCode: input.cloneFromCode || null },
        },
        { mode: 'best_effort', executor: tx }
      );

      this.onInvalidate(companyId);
      return { ...created, permissions: clonedPerms, permissionsCount: clonedPerms.length, usersCount: 0 };
    });
  }

  async updateRole(companyId: string, roleId: string, input: UpdateRoleInput, actorId: string): Promise<RoleRecord> {
    if (!companyId || !roleId) {
      throw new ValidationError('companyId and roleId are required');
    }
    if (!actorId || typeof actorId !== 'string') {
      throw new ValidationError('actorId is required');
    }

    const raw = (input || {}) as Record<string, unknown>;
    if (raw.code !== undefined) {
      throw new ValidationError('كود الدور غير قابل للتعديل بعد الإنشاء');
    }
    if (input?.orgLevel !== undefined && !VALID_ORG_LEVELS.includes(input.orgLevel)) {
      throw new ValidationError('المستوى التنظيمي غير صالح (company / branch / department)');
    }
    if (input?.nameAr !== undefined && (typeof input.nameAr !== 'string' || !input.nameAr.trim())) {
      throw new ValidationError('الاسم العربي للدور لا يمكن أن يكون فارغاً');
    }

    return await this.runWithTenant(companyId, async (tx) => {
      const existing = await this.repo.findById(companyId, roleId, tx);
      if (!existing) {
        throw new NotFoundError('الدور غير موجود');
      }

      const updated = await this.repo.updateRole(companyId, roleId, input || {}, tx);
      await defaultAuditService.record(
        {
          actorUserId: actorId,
          companyId,
          action: 'role.update',
          entityType: 'role',
          entityId: roleId,
          metadata: { ...input },
        },
        { mode: 'best_effort', executor: tx }
      );
      return updated;
    });
  }

  async setPermissions(
    companyId: string,
    roleId: string,
    codes: string[],
    actorId: string,
    actorRole?: string
  ): Promise<string[]> {
    if (!companyId || !roleId) {
      throw new ValidationError('companyId and roleId are required');
    }
    if (!actorId || typeof actorId !== 'string') {
      throw new ValidationError('actorId is required');
    }
    if (!Array.isArray(codes)) {
      throw new ValidationError('قائمة الصلاحيات يجب أن تكون مصفوفة');
    }

    const uniqueCodes: string[] = [];
    for (const c of codes) {
      if (typeof c !== 'string' || !VALID_PERMISSION_SET.has(c)) {
        throw new ValidationError(`كود الصلاحية غير معروف في الكتالوج: ${String(c)}`);
      }
      if (!uniqueCodes.includes(c)) {
        uniqueCodes.push(c);
      }
    }

    return await this.runWithTenant(companyId, async (tx) => {
      const role = await this.repo.findById(companyId, roleId, tx);
      if (!role) {
        throw new NotFoundError('الدور غير موجود');
      }

      if (role.code === 'company_admin' && uniqueCodes.length === 0) {
        throw new ValidationError('مدير الشركة لا يمكن أن يبقى بلا صلاحيات — يمنع قفل الشركة على نفسها');
      }

      if (role.isSystem && actorRole && actorRole !== 'platform_admin') {
        throw new ForbiddenError('تعديل صلاحيات الأدوار النظامية متاح لمدير المنصة (platform_admin) فقط');
      }

      const saved = await this.repo.replacePermissions(roleId, uniqueCodes, tx);

      await defaultAuditService.record(
        {
          actorUserId: actorId,
          companyId,
          action: 'role.permissions.set',
          entityType: 'role',
          entityId: roleId,
          metadata: { code: role.code, count: saved.length },
        },
        { mode: 'best_effort', executor: tx }
      );

      this.onInvalidate(companyId);
      return saved;
    });
  }

  async setActive(
    companyId: string,
    roleId: string,
    isActive: boolean,
    actorId: string
  ): Promise<RoleRecord> {
    if (!companyId || !roleId) {
      throw new ValidationError('companyId and roleId are required');
    }
    if (typeof isActive !== 'boolean') {
      throw new ValidationError('isActive يجب أن يكون قيمة منطقية');
    }
    if (!actorId || typeof actorId !== 'string') {
      throw new ValidationError('actorId is required');
    }

    return await this.runWithTenant(companyId, async (tx) => {
      const role = await this.repo.findById(companyId, roleId, tx);
      if (!role) {
        throw new NotFoundError('الدور غير موجود');
      }

      if (!isActive && role.isSystem) {
        throw new ValidationError('لا يمكن تعطيل دور نظامي أساسي');
      }

      if (!isActive) {
        const activeMembers = await this.repo.countActiveMembers(companyId, roleId, tx);
        if (activeMembers > 0) {
          throw new ValidationError(`لا يمكن تعطيل الدور لأن هناك ${activeMembers} عضو/أعضاء نشطين مرتبطين به`);
        }
      }

      const updated = await this.repo.setActive(companyId, roleId, isActive, tx);

      await defaultAuditService.record(
        {
          actorUserId: actorId,
          companyId,
          action: 'role.set_active',
          entityType: 'role',
          entityId: roleId,
          metadata: { isActive },
        },
        { mode: 'best_effort', executor: tx }
      );

      this.onInvalidate(companyId);
      return updated;
    });
  }

  /**
   * حذف الأدوار مرفوض في هذه الحزمة حفاظاً على الأثر التدقيقي وقيد ON DELETE RESTRICT.
   */
  async deleteRole(_companyId: string, _roleId: string): Promise<never> {
    throw new ValidationError('حذف الدور غير مسموح حفاظاً على الأثر التدقيقي — استخدم التعطيل بدلاً من الحذف');
  }
}

export const defaultRoleService = new RoleService();
