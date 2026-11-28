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
  frozenTotalCost?: number;
  valuationMovementId?: string | null;
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
  netAmount?: number;
  cogsCost?: number;
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
  netAmount?: number;
  grossAmount?: number;
  cogsAmount?: number;
  cogsPostedAt?: string | null;
  memo?: string | null;
  journalEntryId?: string | null;
  journalEntryNo?: string | null;
  reversalJournalEntryId?: string | null;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
  cancellationReason?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: SalesInvoiceLine[];
}

export type SalesReturnStatus = 'draft' | 'posted' | 'cancelled';

export interface SalesReturnLine {
  id: string;
  returnId: string;
  companyId: string;
  invoiceLineId: string;
  deliveryLineId?: string | null;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  qty: number;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
  netAmount?: number;
  cogsCost: number;
  valuationMovementId?: string | null;
  lineNo: number;
}

export interface SalesReturn {
  id: string;
  companyId: string;
  customerId: string;
  customerCode?: string;
  customerNameAr?: string;
  invoiceId: string;
  invoiceNo?: string | null;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  returnNo?: string | null;
  returnDate: string;
  status: SalesReturnStatus;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  cogsAmount: number;
  reason?: string | null;
  memo?: string | null;
  journalEntryId?: string | null;
  journalEntryNo?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: SalesReturnLine[];
}

export interface CreateSalesReturnLineInput {
  invoiceLineId: string;
  qty: number;
}

export interface CreateSalesReturnInput {
  customerId: string;
  invoiceId: string;
  warehouseId: string;
  returnDate?: string;
  reason?: string;
  memo?: string;
  lines: CreateSalesReturnLineInput[];
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

export interface SalesCollectionLine {
  lineNo: number;
  invoiceId: string;
  invoiceNo?: string | null;
  amount: number;
}

export interface SalesCollection {
  lines?: SalesCollectionLine[];
  linesCount?: number;
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
  /** Legacy single-invoice form (invoiceId + amount). Ignored when lines is given. */
  invoiceId?: string;
  /** Multi-invoice form: one line per invoice, up to 100. */
  lines?: Array<{ invoiceId: string; amount: number }>;
  registerId: string;
  collectionDate?: string;
  amount?: number;
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
