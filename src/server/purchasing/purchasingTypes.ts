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
