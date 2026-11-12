import {
  defaultOrgUnitRepository,
  OrgUnitRepository,
  NormalizedScopeInsert,
} from './orgUnitRepository.js';
import { defaultRoleRepository, RoleRepository } from '../rbac/roleRepository.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { defaultAuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError, ConflictError, ForbiddenError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import {
  OrgUnit,
  CreateOrgUnitInput,
  UpdateOrgUnitInput,
  UserOrgScope,
  UserOrgScopeInput,
  SetUserOrgScopesInput,
  OrgScopeAccessLevel,
  OrgUnitMember,
} from './orgUnitTypes.js';

const ALLOWED_ACCESS_LEVELS: ReadonlySet<OrgScopeAccessLevel> = new Set(['read', 'write', 'approve']);

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export class OrgUnitService {
  constructor(
    private orgRepo: OrgUnitRepository = defaultOrgUnitRepository,
    private roleRepo: RoleRepository = defaultRoleRepository
  ) {}

  /**
   * List all organizational units for a company.
   */
  async listUnits(companyId: string): Promise<OrgUnit[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.orgRepo.listUnits(companyId);
  }

  /**
   * Create a new organizational unit.
   * Validates:
   * - Unique code within company
   * - If parentId is provided, parent must exist and belong to the same company
   * - Computes hierarchical path: parent.path + code + '/'
   */
  async createUnit(companyId: string, input: CreateOrgUnitInput, actorId?: string): Promise<OrgUnit> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!input.code || input.code.trim().length < 1) throw new ValidationError('Unit code is required');
    if (!input.nameAr || input.nameAr.trim().length < 1) throw new ValidationError('Unit Arabic name is required');
    if (!['branch', 'department', 'cost_center', 'division'].includes(input.unitType)) {
      throw new ValidationError('Invalid unitType (must be branch, department, cost_center, or division)');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      // Check code uniqueness
      const existing = await this.orgRepo.findByCode(companyId, input.code, tx);
      if (existing) {
        throw new ConflictError(`Organizational unit with code '${input.code}' already exists in this company`);
      }

      let computedPath = `/${input.code.trim().toUpperCase()}/`;

      if (input.parentId) {
        const parent = await this.orgRepo.findById(companyId, input.parentId, tx);
        if (!parent) {
          throw new ValidationError('Parent organizational unit not found in this company');
        }
        if (parent.companyId !== companyId) {
          throw new ValidationError('Parent organizational unit belongs to another company (intercompany forbidden)');
        }
        if (!parent.isActive) {
          throw new ValidationError('Cannot create a child unit under an inactive parent unit');
        }
        computedPath = `${parent.path}${input.code.trim().toUpperCase()}/`;
      }

      const unit = await this.orgRepo.createUnit(companyId, input, computedPath, tx);

      await defaultAuditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'ORG_UNIT_CREATE',
        entityType: 'org_unit',
        entityId: unit.id,
        metadata: {
          code: unit.code,
          nameAr: unit.nameAr,
          unitType: unit.unitType,
          path: unit.path,
        },
      }, { mode: 'required', executor: tx });

      return unit;
    });
  }

  /**
   * Update organizational unit details.
   */
  async updateUnit(companyId: string, id: string, input: UpdateOrgUnitInput, actorId?: string): Promise<OrgUnit> {
    if (!companyId || !id) throw new ValidationError('companyId and unit id are required');

    return await withTenantTransaction(companyId, async (tx) => {
      const existing = await this.orgRepo.findById(companyId, id, tx);
      if (!existing) {
        throw new NotFoundError('Organizational unit not found in this company');
      }

      const updated = await this.orgRepo.updateUnit(companyId, id, input, tx);
      if (!updated) {
        throw new NotFoundError('Failed to update organizational unit');
      }

      await defaultAuditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'ORG_UNIT_UPDATE',
        entityType: 'org_unit',
        entityId: id,
        metadata: { patch: input },
      }, { mode: 'required', executor: tx });

      return updated;
    });
  }

  /**
   * List all configured user org scopes (including expired/scheduled for management UI).
   */
  async listUserScopes(companyId: string, userId: string): Promise<UserOrgScope[]> {
    if (!companyId || !userId) throw new ValidationError('companyId and userId are required');
    return await this.orgRepo.listUserScopes(companyId, userId);
  }

  /**
   * List currently effective user org scopes from v_user_effective_scopes, ordered by unit_type then path.
   */
  async getEffectiveScopes(companyId: string, userId: string): Promise<UserOrgScope[]> {
    if (!companyId || !userId) throw new ValidationError('companyId and userId are required');
    return await this.orgRepo.listEffectiveScopes(companyId, userId);
  }

  /**
   * List active company members who have an effective scope covering the specified organizational unit.
   */
  async listUnitMembers(companyId: string, orgUnitId: string): Promise<OrgUnitMember[]> {
    if (!companyId || !orgUnitId) throw new ValidationError('companyId and orgUnitId are required');
    return await withTenantTransaction(companyId, async (tx) => {
      const unit = await this.orgRepo.findById(companyId, orgUnitId, tx);
      if (!unit) {
        throw new NotFoundError('Organizational unit not found in this company');
      }
      return await this.orgRepo.listMembersByOrgUnit(companyId, orgUnitId, tx);
    });
  }

  /**
   * Set user org scopes within a company enforcing all 7 B4 rules:
   * 1. Target org unit must exist in the same company and be active.
   * 2. accessLevel ∈ {read, write, approve}.
   * 3. validUntil >= validFrom (when both provided).
   * 4. Anti-escalation: if actorRole !== 'platform_admin', every granted unit must fall within actor's own active scope (unless actor has zero configured scopes = company-wide). Otherwise ForbiddenError naming the unit.
   * 5. roleId (if passed) must exist as an active role in the same company.
   * 6. Single atomic tenant transaction: delete old + insert new + audit.
   * 7. Mandatory audit: 'USER_SCOPE_SET' with count & values.
   */
  async setUserScopes(
    companyId: string,
    userId: string,
    input: SetUserOrgScopesInput | UserOrgScopeInput[],
    actorId?: string,
    actorRole?: string
  ): Promise<UserOrgScope[]> {
    if (!companyId || !userId) throw new ValidationError('companyId and userId are required');

    const rawScopes = Array.isArray(input) ? input : input?.scopes;
    if (!Array.isArray(rawScopes)) {
      throw new ValidationError('scopes array is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      // Validate target user is an active member of this company
      const isMember = await this.orgRepo.checkUserCompanyMembership(companyId, userId, tx);
      if (!isMember) {
        throw new ValidationError(`Target user ${userId} is not an active member of company ${companyId}`);
      }

      // Check actor's scope boundary when actor is not platform_admin (Rule 4: Anti-escalation)
      let actorHasRestriction = false;
      let actorEffectiveScopes: UserOrgScope[] = [];
      if (actorId && actorRole !== 'platform_admin') {
        const actorAllScopes = await this.orgRepo.listUserScopes(companyId, actorId, tx);
        if (actorAllScopes.length > 0) {
          actorHasRestriction = true;
          actorEffectiveScopes = await this.orgRepo.listEffectiveScopes(companyId, actorId, tx);
        }
      }

      const seenUnitIds = new Set<string>();
      const normalizedScopes: NormalizedScopeInsert[] = [];

      for (const sc of rawScopes) {
        if (!sc || !sc.orgUnitId || !isUuid(sc.orgUnitId)) {
          throw new ValidationError('Valid orgUnitId UUID is required for each scope item');
        }
        if (seenUnitIds.has(sc.orgUnitId)) {
          throw new ValidationError(`Duplicate organizational unit in scopes payload: ${sc.orgUnitId}`);
        }
        seenUnitIds.add(sc.orgUnitId);

        // Rule 1: Unit exists in same company and is active
        const unit = await this.orgRepo.findById(companyId, sc.orgUnitId, tx);
        if (!unit) {
          throw new ValidationError(`الوحدة التنظيمية ${sc.orgUnitId} غير موجودة في هذه الشركة`);
        }
        if (!unit.isActive) {
          throw new ValidationError(`الوحدة التنظيمية ${unit.code} (${unit.nameAr}) معطّلة ولا يمكن إسناد نطاق إليها`);
        }

        // Rule 4: Anti-escalation check (non-platform_admin grantor cannot grant unit outside their own active scope)
        if (actorHasRestriction) {
          const unitAllowed = actorEffectiveScopes.some((actorScope) => {
            if (actorScope.orgUnitId === unit.id) return true;
            if (actorScope.includeDescendants && actorScope.path && unit.path.startsWith(actorScope.path)) {
              return true;
            }
            return false;
          });
          if (!unitAllowed) {
            throw new ForbiddenError(
              `لا يمكنك منح نطاق للوحدة ${unit.code} (${unit.nameAr}) لأنها خارج نطاقك المصرّح به`
            );
          }
        }

        // Rule 2: accessLevel ∈ {read, write, approve}
        const accessLevel = (sc.accessLevel || 'read') as OrgScopeAccessLevel;
        if (!ALLOWED_ACCESS_LEVELS.has(accessLevel)) {
          throw new ValidationError(
            `مستوى الصلاحية غير صالح للوحدة ${unit.code} (${unit.nameAr}): يجب أن يكون read أو write أو approve`
          );
        }

        // Rule 3: validFrom / validUntil format & validUntil >= validFrom
        const validFrom = sc.validFrom && String(sc.validFrom).trim() !== '' ? String(sc.validFrom).trim() : null;
        const validUntil = sc.validUntil && String(sc.validUntil).trim() !== '' ? String(sc.validUntil).trim() : null;

        if (validFrom && !isValidIsoDate(validFrom)) {
          throw new ValidationError(`تاريخ بداية السريان غير صالح للوحدة ${unit.code} (YYYY-MM-DD)`);
        }
        if (validUntil && !isValidIsoDate(validUntil)) {
          throw new ValidationError(`تاريخ نهاية السريان غير صالح للوحدة ${unit.code} (YYYY-MM-DD)`);
        }
        if (validFrom && validUntil && validUntil < validFrom) {
          throw new ValidationError(
            `تاريخ انتهاء السريان (${validUntil}) يجب أن يكون أكبر من أو يساوي تاريخ البداية (${validFrom}) للوحدة ${unit.code}`
          );
        }

        // Rule 5: roleId (or roleCode) if provided must be an active role in the same company
        let resolvedRoleId: string | null = null;
        if (sc.roleId && String(sc.roleId).trim() !== '') {
          const rid = String(sc.roleId).trim();
          if (!isUuid(rid)) {
            throw new ValidationError(`معرّف الدور غير صالح للوحدة ${unit.code}`);
          }
          const role = await this.roleRepo.findById(companyId, rid, tx);
          if (!role) {
            throw new ValidationError(`الدور المحدد للوحدة ${unit.code} غير موجود في هذه الشركة`);
          }
          if (!role.isActive) {
            throw new ValidationError(`الدور '${role.nameAr}' (${role.code}) معطّل ولا يمكن ربطه بالنطاق`);
          }
          resolvedRoleId = role.id;
        } else if (sc.roleCode && String(sc.roleCode).trim() !== '') {
          const rcode = String(sc.roleCode).trim();
          const role = await this.roleRepo.findByCode(companyId, rcode, tx);
          if (!role) {
            throw new ValidationError(`الدور '${rcode}' للوحدة ${unit.code} غير موجود في هذه الشركة`);
          }
          if (!role.isActive) {
            throw new ValidationError(`الدور '${role.nameAr}' (${role.code}) معطّل ولا يمكن ربطه بالنطاق`);
          }
          resolvedRoleId = role.id;
        }

        const reason = sc.reason && String(sc.reason).trim() !== '' ? String(sc.reason).trim() : null;

        normalizedScopes.push({
          orgUnitId: unit.id,
          includeDescendants: sc.includeDescendants !== undefined ? Boolean(sc.includeDescendants) : true,
          accessLevel,
          roleId: resolvedRoleId,
          validFrom,
          validUntil,
          reason,
        });
      }

      // Rule 6: Replace inside same transaction
      await this.orgRepo.setUserScopes(companyId, userId, normalizedScopes, actorId || null, tx);

      // Rule 7: Mandatory audit USER_SCOPE_SET inside same tx
      await defaultAuditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'USER_SCOPE_SET',
        entityType: 'user_org_scope',
        entityId: userId,
        metadata: {
          scopesCount: normalizedScopes.length,
          scopes: normalizedScopes.map((s) => ({
            orgUnitId: s.orgUnitId,
            includeDescendants: s.includeDescendants,
            accessLevel: s.accessLevel,
            roleId: s.roleId,
            validFrom: s.validFrom,
            validUntil: s.validUntil,
            delegatedBy: actorId || null,
            reason: s.reason,
          })),
        },
      }, { mode: 'required', executor: tx });

      return await this.orgRepo.listUserScopes(companyId, userId, tx);
    });
  }

  /**
   * Application-layer scope check helper (ADR-03).
   * If a user has defined scopes, asserts whether target orgUnitId is authorized
   * against currently effective scopes (valid_from <= today <= valid_until and active unit).
   * - platform_admin: BYPASS (returns true).
   * - empty userScopes: returns true (company-wide access).
   * - non-empty userScopes + empty effectiveScopes: returns false (all assigned scopes expired/future/inactive).
   * - non-empty effectiveScopes + targetOrgUnitId null/undefined:
   *   - requiredLevel === 'write' | 'approve': returns false.
   *   - requiredLevel === 'read': returns true.
   * - targetOrgUnitId set: returns true if matching direct unit or descendant with sufficient accessLevel.
   */
  async assertUserOrgAccess(
    companyId: string,
    userId: string,
    targetOrgUnitId?: string | null,
    requiredLevel: OrgScopeAccessLevel = 'read',
    isPlatformAdmin: boolean = false
  ): Promise<boolean> {
    if (isPlatformAdmin) return true; // platform_admin bypasses org scope
    if (!companyId || !userId) return false;

    const userScopes = await this.orgRepo.listUserScopes(companyId, userId);
    if (userScopes.length === 0) {
      // Backward-compatible: No explicit org unit restriction implies company-wide access
      return true;
    }

    const effectiveScopes = await this.orgRepo.listEffectiveScopes(companyId, userId);
    if (effectiveScopes.length === 0) {
      return false;
    }

    // Scoped user with active effective scopes
    if (!targetOrgUnitId) {
      // Write/approve without target org unit when user has restricted scopes -> reject
      if (requiredLevel === 'write' || requiredLevel === 'approve') {
        return false;
      }
      return true;
    }

    const targetUnit = await this.orgRepo.findById(companyId, targetOrgUnitId);
    if (!targetUnit) return false;

    // Check direct or ancestor matching effective scope
    return effectiveScopes.some((sc) => {
      if (requiredLevel === 'approve' && sc.accessLevel !== 'approve') {
        return false;
      }
      if (requiredLevel === 'write' && sc.accessLevel !== 'write' && sc.accessLevel !== 'approve') {
        return false;
      }
      if (sc.orgUnitId === targetOrgUnitId) {
        return true;
      }
      if (sc.includeDescendants) {
        if (sc.path && targetUnit.path.startsWith(sc.path)) {
          return true;
        }
        if (sc.orgUnitCode && targetUnit.path.includes(`/${sc.orgUnitCode}/`)) {
          return true;
        }
      }
      return false;
    });
  }
}

export const defaultOrgUnitService = new OrgUnitService();
