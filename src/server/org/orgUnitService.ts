import { defaultOrgUnitRepository, OrgUnitRepository } from './orgUnitRepository.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { defaultAuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError, ConflictError } from '../http/errors.js';
import {
  OrgUnit,
  CreateOrgUnitInput,
  UpdateOrgUnitInput,
  UserOrgScope,
  SetUserOrgScopesInput,
} from './orgUnitTypes.js';

export class OrgUnitService {
  constructor(private orgRepo: OrgUnitRepository = defaultOrgUnitRepository) {}

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
      });

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
      });

      return updated;
    });
  }

  /**
   * List user org scopes.
   */
  async listUserScopes(companyId: string, userId: string): Promise<UserOrgScope[]> {
    if (!companyId || !userId) throw new ValidationError('companyId and userId are required');
    return await this.orgRepo.listUserScopes(companyId, userId);
  }

  /**
   * Set user org scopes within a company.
   */
  async setUserScopes(companyId: string, userId: string, input: SetUserOrgScopesInput, actorId?: string): Promise<UserOrgScope[]> {
    if (!companyId || !userId) throw new ValidationError('companyId and userId are required');

    return await withTenantTransaction(companyId, async (tx) => {
      // Validate target user is an active member of this company
      const isMember = await this.orgRepo.checkUserCompanyMembership(companyId, userId, tx);
      if (!isMember) {
        throw new ValidationError(`Target user ${userId} is not an active member of company ${companyId}`);
      }

      // Validate all orgUnitIds belong to company
      for (const sc of input.scopes) {
        const u = await this.orgRepo.findById(companyId, sc.orgUnitId, tx);
        if (!u) {
          throw new ValidationError(`Organizational unit ${sc.orgUnitId} not found in this company`);
        }
      }

      await this.orgRepo.setUserScopes(companyId, userId, input.scopes, tx);

      await defaultAuditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'USER_ORG_SCOPES_SET',
        entityType: 'user_org_scope',
        entityId: userId,
        metadata: { scopesCount: input.scopes.length },
      });

      return await this.orgRepo.listUserScopes(companyId, userId, tx);
    });
  }

  /**
   * Application-layer scope check helper (ADR-03).
   * If a user has defined scopes, asserts whether target orgUnitId is authorized.
   * If user has no specific org unit scopes configured, access defaults to company-wide (backward compatible).
   */
  async assertUserOrgAccess(
    companyId: string,
    userId: string,
    targetOrgUnitId?: string | null,
    requiredLevel: 'read' | 'write' = 'read'
  ): Promise<boolean> {
    if (!targetOrgUnitId) return true; // Company-wide entity

    const userScopes = await this.orgRepo.listUserScopes(companyId, userId);
    if (userScopes.length === 0) {
      // Backward-compatible: No explicit org unit restriction implies company-wide access
      return true;
    }

    const targetUnit = await this.orgRepo.findById(companyId, targetOrgUnitId);
    if (!targetUnit) return false;

    // Check direct or ancestor matching scope
    return userScopes.some((sc) => {
      if (requiredLevel === 'write' && sc.accessLevel !== 'write') {
        return false;
      }
      if (sc.orgUnitId === targetOrgUnitId) {
        return true;
      }
      if (sc.includeDescendants && sc.orgUnitCode && targetUnit.path.includes(`/${sc.orgUnitCode}/`)) {
        return true;
      }
      return false;
    });
  }
}

export const defaultOrgUnitService = new OrgUnitService();
