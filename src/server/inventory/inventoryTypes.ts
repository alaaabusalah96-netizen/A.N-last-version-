export interface Warehouse {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface CreateWarehouseInput {
  code: string;
  nameAr: string;
  nameEn?: string;
}

export interface Item {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  uom: string;
  isActive: boolean;
  createdAt: string;
}

export interface CreateItemInput {
  code: string;
  nameAr: string;
  nameEn?: string;
  uom?: string;
}

export interface StockBalance {
  companyId: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  qty: number;
  updatedAt: string;
}

export type MovementType = 'receive' | 'issue';

export interface StockMovement {
  id: string;
  companyId: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  movementType: MovementType;
  qty: number;
  memo?: string | null;
  createdBy?: string | null;
  createdAt: string;
}

export interface RecordMovementInput {
  warehouseId: string;
  itemId: string;
  qty: number;
  memo?: string;
}
