export interface Supplier {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface CreateSupplierInput {
  code: string;
  nameAr: string;
  nameEn?: string;
}

export type GrnStatus = 'draft' | 'posted';

export interface GrnLine {
  id: string;
  grnId: string;
  companyId: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  qty: number;
  unitCost?: number | null;
  lineNo: number;
}

export interface GrnHeader {
  id: string;
  companyId: string;
  supplierId: string;
  supplierCode?: string;
  supplierNameAr?: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  status: GrnStatus;
  grnNo?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  memo?: string | null;
  createdBy?: string | null;
  createdAt: string;
  journalEntryId?: string | null;
  lines?: GrnLine[];
}

export interface CreateGrnLineInput {
  itemId: string;
  qty: number;
  unitCost?: number;
}

export interface CreateGrnInput {
  supplierId: string;
  warehouseId: string;
  memo?: string;
  lines: CreateGrnLineInput[];
}

export type PoStatus = 'draft' | 'approved' | 'closed' | 'cancelled';

export interface PoLine {
  id: string;
  poId: string;
  companyId: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  qty: number;
  unitCost?: number | null;
  receivedQty: number;
  lineNo: number;
}

export interface PurchaseOrder {
  id: string;
  companyId: string;
  supplierId: string;
  supplierCode?: string;
  supplierNameAr?: string;
  status: PoStatus;
  poNo?: string | null;
  orderDate: string;
  expectedDate?: string | null;
  memo?: string | null;
  approvedAt?: string | null;
  approvedBy?: string | null;
  closedAt?: string | null;
  closedBy?: string | null;
  createdBy?: string | null;
  createdAt: string;
  lines?: PoLine[];
}

export interface CreatePoLineInput {
  itemId: string;
  qty: number;
  unitCost?: number;
}

export interface CreatePoInput {
  supplierId: string;
  expectedDate?: string;
  memo?: string;
  lines: CreatePoLineInput[];
}

