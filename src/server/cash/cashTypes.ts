/**
 * Cash Registers & Employee Custody Domain Types (موديول الخزينة والعهد)
 */

export interface CashRegister {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  glAccountId: string;
  isActive: boolean;
  openingBalance: number;
  memo: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCashRegisterInput {
  code: string;
  nameAr: string;
  nameEn?: string | null;
  glAccountId: string;
  openingBalance?: number;
  memo?: string | null;
}

export interface UpdateCashRegisterInput {
  code?: string;
  nameAr?: string;
  nameEn?: string | null;
  memo?: string | null;
}

export interface CashRegisterBalance {
  registerId: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  currentBalance: number;
}

export type CustodyStatus = 'pending' | 'approved' | 'rejected' | 'open' | 'settled' | 'cancelled';

export interface CustodyRecord {
  id: string;
  companyId: string;
  custodyNo: string | null;
  employeeUserId: string;
  employeeUsername?: string | null;
  registerId: string;
  registerCode?: string | null;
  registerNameAr?: string | null;
  amount: number;
  purpose: string;
  status: CustodyStatus;
  requestDate: string;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  disbursedBy: string | null;
  disbursedAt: string | null;
  settledBy: string | null;
  settledAt: string | null;
  disburseJournalEntryId: string | null;
  disburseJournalEntryNo?: string | null;
  settleJournalEntryId: string | null;
  settleJournalEntryNo?: string | null;
  settledExpenseTotal: number | null;
  settledCashReturn: number | null;
  memo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustodyListFilters {
  status?: CustodyStatus;
  employeeUserId?: string;
  registerId?: string;
  from?: string;
  to?: string;
}

export interface CreateCustodyInput {
  employeeUserId: string;
  registerId: string;
  amount: number;
  purpose: string;
  requestDate?: string;
  memo?: string | null;
}

export interface SettleCustodyLineInput {
  expenseAccountId: string;
  amount: number;
  memo?: string | null;
}

export interface SettleCustodyInput {
  lines: SettleCustodyLineInput[];
  cashReturn: number;
  memo?: string | null;
}

export interface CustodyMovement {
  id: string;
  companyId: string;
  custodyId: string;
  registerId: string;
  movementType: 'disburse' | 'settle_expense' | 'settle_return' | 'reverse';
  direction: 'out' | 'in' | 'none';
  amount: number;
  expenseAccountId: string | null;
  expenseAccountCode?: string | null;
  expenseAccountNameAr?: string | null;
  journalEntryId: string | null;
  journalEntryNo?: string | null;
  memo: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface OpenCustodyEmployeeSummary {
  employeeUserId: string;
  employeeUsername: string;
  openCount: number;
  totalAmount: number;
}

export interface CustodyEmployeeOption {
  userId: string;
  username: string;
  role: string;
  roleId: string | null;
}
