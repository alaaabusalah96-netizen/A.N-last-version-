export type CostingMethod = 'FIFO' | 'PERPETUAL_MOVING_AVERAGE';

export interface CostingProfile {
  id: string;
  companyId: string;
  name: string;
  costingMethod: CostingMethod;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface CreateCostingProfileInput {
  name: string;
  costingMethod: CostingMethod;
  isDefault?: boolean;
}

export interface ItemCostingAssignment {
  companyId: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  profileId: string;
  profileName?: string;
  costingMethod?: CostingMethod;
  assignedAt: string;
  assignedBy?: string | null;
}

export interface ValuationBalance {
  companyId: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  quantity: number;
  totalCost: number;
  unitCost: number;
  updatedAt: string;
}

export interface CostLayer {
  id: string;
  companyId: string;
  warehouseId: string;
  itemId: string;
  originalQty: number;
  remainingQty: number;
  unitCost: number;
  totalCost: number;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  effectiveDate: string;
  isExhausted: boolean;
  createdAt: string;
}

export interface ValuationMovement {
  id: string;
  companyId: string;
  warehouseId: string;
  itemId: string;
  movementType: 'RECEIVE' | 'ISSUE' | 'ADJUSTMENT' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'OPENING' | 'RETURN';
  qty: number;
  unitCost: number;
  totalCost: number;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  journalEntryId?: string | null;
  createdBy?: string | null;
  createdAt: string;
}

export interface OpeningValuationInput {
  warehouseId: string;
  itemId: string;
  quantity: number;
  totalCost: number;
}
