// Sales Revenue Cycle Types (AN-SALES-CYCLE-1)

export interface Customer {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  phone?: string | null;
  email?: string | null;
  taxNumber?: string | null;
  address?: string | null;
  creditLimit: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomerInput {
  code: string;
  nameAr: string;
  nameEn?: string;
  phone?: string;
  email?: string;
  taxNumber?: string;
  address?: string;
  creditLimit?: number;
  isActive?: boolean;
}

export interface UpdateCustomerInput {
  nameAr?: string;
  nameEn?: string;
  phone?: string;
  email?: string;
  taxNumber?: string;
  address?: string;
  creditLimit?: number;
  isActive?: boolean;
}

export type SalesDeliveryStatus = 'draft' | 'posted' | 'cancelled';

export interface SalesDeliveryLine {
  id: string;
  deliveryId: string;
  companyId: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  qty: number;
  unitPrice: number;
  unitCost: number;
  lineNo: number;
}

export interface SalesDeliveryNote {
  id: string;
  companyId: string;
  customerId: string;
  customerCode?: string;
  customerNameAr?: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  deliveryNo?: string | null;
  deliveryDate: string;
  status: SalesDeliveryStatus;
  memo?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: SalesDeliveryLine[];
}

export interface CreateDeliveryLineInput {
  itemId: string;
  qty: number;
  unitPrice?: number;
  unitCost?: number;
}

export interface CreateDeliveryInput {
  customerId: string;
  warehouseId: string;
  deliveryDate?: string;
  memo?: string;
  lines: CreateDeliveryLineInput[];
}

export type SalesInvoiceStatus = 'draft' | 'posted' | 'cancelled';

export interface SalesInvoiceLine {
  id: string;
  invoiceId: string;
  companyId: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  deliveryLineId?: string | null;
  qty: number;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
  lineNo: number;
}

export interface SalesInvoice {
  id: string;
  companyId: string;
  customerId: string;
  customerCode?: string;
  customerNameAr?: string;
  deliveryId?: string | null;
  deliveryNo?: string | null;
  invoiceNo?: string | null;
  invoiceDate: string;
  dueDate?: string | null;
  status: SalesInvoiceStatus;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  memo?: string | null;
  journalEntryId?: string | null;
  journalEntryNo?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: SalesInvoiceLine[];
}

export interface CreateSalesInvoiceLineInput {
  itemId: string;
  deliveryLineId?: string;
  qty: number;
  unitPrice: number;
  taxRate?: number;
}

export interface CreateSalesInvoiceInput {
  customerId: string;
  deliveryId?: string;
  invoiceDate?: string;
  dueDate?: string;
  memo?: string;
  lines: CreateSalesInvoiceLineInput[];
}

export type SalesCollectionStatus = 'draft' | 'posted' | 'cancelled';

export interface SalesCollection {
  id: string;
  companyId: string;
  customerId: string;
  customerCode?: string;
  customerNameAr?: string;
  invoiceId: string;
  invoiceNo?: string | null;
  registerId: string;
  registerCode?: string;
  registerNameAr?: string;
  collectionNo?: string | null;
  collectionDate: string;
  amount: number;
  status: SalesCollectionStatus;
  reference?: string | null;
  memo?: string | null;
  journalEntryId?: string | null;
  journalEntryNo?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSalesCollectionInput {
  customerId: string;
  invoiceId: string;
  registerId: string;
  collectionDate?: string;
  amount: number;
  reference?: string;
  memo?: string;
}

export interface ArAgingItem {
  invoiceId: string;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string | null;
  customerId: string;
  customerCode: string;
  customerNameAr: string;
  invoiceTotal: number;
  collectedAmount: number;
  remainingOpenAmount: number;
  agingDays: number;
  bucket: '0-30' | '31-60' | '61+';
}

export interface ArCustomerAgingSummary {
  customerId: string;
  customerCode: string;
  customerNameAr: string;
  totalOpenAmount: number;
  bucket0To30: number;
  bucket31To60: number;
  bucket61Plus: number;
  invoiceCount: number;
}

export interface ArAgingReport {
  items: ArAgingItem[];
  customerSummaries: ArCustomerAgingSummary[];
  grandTotalOpen: number;
  grandTotal0To30: number;
  grandTotal31To60: number;
  grandTotal61Plus: number;
}
