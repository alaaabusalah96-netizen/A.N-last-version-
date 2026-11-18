export type CostingMethod = 'FIFO' | 'PERPETUAL_MOVING_AVERAGE';

export type ValuationMovementType =
  | 'RECEIVE'
  | 'ISSUE'
  | 'ADJUSTMENT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'OPENING'
  | 'RETURN';

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
  costingMethod?: CostingMethod | null;
  quantity: number;
  totalCost: number;
  unitCost: number;
  updatedAt: string;
}

export interface CostLayer {
  id: string;
  companyId: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  originalQty: number;
  remainingQty: number;
  unitCost: number;
  totalCost: number;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  originLayerId?: string | null;
  originSourceType?: string | null;
  originSourceId?: string | null;
  originSourceLineId?: string | null;
  effectiveDate: string;
  isExhausted: boolean;
  createdAt: string;
}

export interface ValuationMovement {
  id: string;
  companyId: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  movementType: ValuationMovementType;
  qty: number;
  unitCost: number;
  totalCost: number;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  journalEntryId?: string | null;
  reason?: string | null;
  costSource?: string | null;
  costingMethod?: CostingMethod | null;
  referenceMovementId?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  createdAt: string;
}

export interface CostAllocationRecord {
  id: string;
  companyId: string;
  valuationMovementId: string;
  costLayerId?: string | null;
  allocatedQty: number;
  unitCost: number;
  allocatedCost: number;
  createdAt: string;
}

export interface CostAdjustmentRecord {
  id: string;
  companyId: string;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  grnId?: string | null;
  grnLineId?: string | null;
  invoiceId?: string | null;
  invoiceLineId?: string | null;
  costLayerId?: string | null;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  costingMethod?: CostingMethod | null;
  qtyBasis: number;
  originalUnitCost: number;
  finalUnitCost: number;
  unitVariance: number;
  adjustmentAmount: number;
  remainingAllocation: number;
  consumedAllocation: number;
  status: string;
  reason?: string | null;
  journalEntryId?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  createdBy?: string | null;
  createdAt: string;
}

export interface OpeningValuationInput {
  warehouseId: string;
  itemId: string;
  quantity: number;
  totalCost?: number;
  unitCost?: number;
  reason?: string;
  evidenceRef?: string;
}

export interface OpeningValuationRecord {
  id: string;
  companyId: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  costingMethod?: CostingMethod | null;
  quantity: number;
  totalCost: number;
  unitCost: number;
  status: 'pending_setup' | 'approved' | 'rejected';
  reason?: string | null;
  evidenceRef?: string | null;
  approvedAt?: string | null;
  approvedBy?: string | null;
  rejectedAt?: string | null;
  rejectedBy?: string | null;
  rejectionReason?: string | null;
  journalEntryId?: string | null;
  valuationMovementId?: string | null;
  createdBy?: string | null;
  createdAt: string;
}

export interface ValuationSetupStatusItem {
  warehouseId: string;
  warehouseCode: string;
  warehouseNameAr: string;
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  costingMethod: CostingMethod | null;
  profileName: string | null;
  stockQty: number;
  valuationQty: number;
  valuationTotalCost: number;
  openingStatus: 'not_created' | 'pending_setup' | 'approved' | 'rejected';
  isReady: boolean;
  issueReason: string | null;
}

export interface ValuationSetupStatusSummary {
  companyId: string;
  unassignedItems: Array<{ itemId: string; itemCode: string; itemNameAr: string; hasStock: boolean }>;
  warehouseItemStatuses: ValuationSetupStatusItem[];
  readyCount: number;
  blockedCount: number;
}

export interface ValuationReconciliationInput {
  warehouseId?: string;
  itemId?: string;
  costingMethod?: CostingMethod;
  periodId?: string;
  notes?: string;
}

export interface ValuationReconciliationRecord {
  id: string;
  companyId: string;
  warehouseId?: string | null;
  warehouseNameAr?: string | null;
  itemId?: string | null;
  itemNameAr?: string | null;
  costingMethod?: CostingMethod | null;
  periodId?: string | null;
  periodCode?: string | null;
  accountId?: string | null;
  subledgerTotal: number;
  glControlTotal: number;
  variance: number;
  status: 'reconciled' | 'discrepancy_detected';
  unmatchedMovementsCount: number;
  unbalancedAdjustmentsCount: number;
  duplicateJournalLinksCount: number;
  qtyValuationMismatchesCount: number;
  openingDiff: number;
  details?: Record<string, unknown> | null;
  notes?: string | null;
  reconciledAt: string;
  reconciledBy?: string | null;
}

export type StockSyncMode = 'internal' | 'external_verified';
