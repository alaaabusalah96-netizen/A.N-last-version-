/**
 * Cash Receipt & Payment Vouchers & Cash Reporting Types
 * سندات القبض والصرف وتقارير حركة الصندوق وعهد الموظفين
 */

export type VoucherKind = 'receipt' | 'payment';
export type VoucherStatus = 'draft' | 'posted' | 'cancelled';

export interface CashVoucher {
  id: string;
  companyId: string;
  kind: VoucherKind;
  voucherNo: string | null;
  registerId: string;
  registerCode?: string | null;
  registerNameAr?: string | null;
  voucherDate: string;
  amount: number;
  contraAccountId: string;
  contraAccountCode?: string | null;
  contraAccountNameAr?: string | null;
  status: VoucherStatus;
  memo: string | null;
  reference: string | null;
  journalEntryId: string | null;
  journalEntryNo?: string | null;
  postedAt: string | null;
  postedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVoucherInput {
  registerId: string;
  voucherDate?: string;
  amount: number;
  contraAccountId: string;
  memo?: string | null;
  reference?: string | null;
}

export interface VoucherListFilters {
  status?: VoucherStatus;
  registerId?: string;
  from?: string;
  to?: string;
}

export interface RegisterMovementReportRow {
  id: string;
  sourceType: 'custody_disburse' | 'custody_return' | 'custody_reverse' | 'receipt_voucher' | 'payment_voucher';
  movementLabelAr: string;
  movementDate: string;
  inAmount: number;
  outAmount: number;
  reference: string;
  actorUsername: string;
  journalEntryId: string | null;
  journalEntryNo: string;
  memo: string | null;
  registerId: string;
  registerCode: string;
  registerNameAr: string;
  createdAt: string;
}

export interface RegisterMovementReport {
  registerId: string;
  registerCode: string;
  registerNameAr: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  closingBalance: number;
  rows: RegisterMovementReportRow[];
}

export interface EmployeeCustodyMovementRow {
  id: string;
  custodyId: string;
  custodyNo: string;
  custodyStatus: string;
  registerId: string;
  registerCode: string;
  registerNameAr: string;
  movementType: 'disburse' | 'settle_expense' | 'settle_return' | 'reverse';
  movementLabelAr: string;
  direction: 'out' | 'in' | 'none';
  amount: number;
  expenseAccountId: string | null;
  expenseAccountCode: string | null;
  expenseAccountNameAr: string | null;
  journalEntryId: string | null;
  journalEntryNo: string;
  memo: string | null;
  createdAt: string;
}
