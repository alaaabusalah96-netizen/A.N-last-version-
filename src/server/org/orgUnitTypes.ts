export type OrgUnitType = 'branch' | 'department' | 'cost_center' | 'division';

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
  accessLevel: 'read' | 'write';
  createdAt?: string;
  orgUnitCode?: string;
  orgUnitNameAr?: string;
}

export interface SetUserOrgScopesInput {
  scopes: {
    orgUnitId: string;
    includeDescendants?: boolean;
    accessLevel?: 'read' | 'write';
  }[];
}
