export type OrgUnitType = 'branch' | 'department' | 'cost_center' | 'division';

export type OrgScopeAccessLevel = 'read' | 'write' | 'approve';

export interface OrgUnit {
  id: string;
  companyId: string;
  parentId?: string | null;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  unitType: OrgUnitType;
  isActive: boolean;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrgUnitInput {
  parentId?: string | null;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  unitType: OrgUnitType;
  isActive?: boolean;
}

export interface UpdateOrgUnitInput {
  nameAr?: string;
  nameEn?: string | null;
  isActive?: boolean;
}

export interface UserOrgScope {
  companyId: string;
  userId: string;
  orgUnitId: string;
  includeDescendants: boolean;
  accessLevel: OrgScopeAccessLevel;
  roleId?: string | null;
  roleCode?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  delegatedBy?: string | null;
  reason?: string | null;
  createdAt?: string;
  orgUnitCode?: string;
  orgUnitNameAr?: string;
  code?: string;
  nameAr?: string;
  unitType?: OrgUnitType;
  path?: string;
}

export interface UserOrgScopeInput {
  userId?: string;
  orgUnitId: string;
  includeDescendants?: boolean;
  accessLevel?: OrgScopeAccessLevel;
  roleId?: string | null;
  roleCode?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  reason?: string | null;
}

export interface SetUserOrgScopesInput {
  scopes: UserOrgScopeInput[];
}

export interface OrgUnitMember {
  userId: string;
  username: string;
  role: string;
  orgUnitId: string;
  includeDescendants: boolean;
  accessLevel: OrgScopeAccessLevel;
  roleId?: string | null;
  roleCode?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  reason?: string | null;
}
