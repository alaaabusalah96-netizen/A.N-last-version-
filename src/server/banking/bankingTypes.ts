export interface BankAccount {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  bankName: string;
  accountNumber: string | null;
  iban: string | null;
  currencyCode: string;
  glAccountId: string;
  glAccountCode?: string;
  glAccountNameAr?: string;
  openingBalance: string;
  bookBalance?: string;
  unmatchedStatementCount?: number;
  lastReconciledAt?: string | null;
  isActive: boolean;
  memo: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBankAccountInput {
  code: string;
  nameAr: string;
  nameEn?: string | null;
  bankName: string;
  accountNumber?: string | null;
  iban?: string | null;
  currencyCode?: string;
  glAccountId: string;
  openingBalance?: string | number;
  memo?: string | null;
}

export interface UpdateBankAccountInput {
  code?: string;
  nameAr?: string;
  nameEn?: string | null;
  bankName?: string;
  accountNumber?: string | null;
  iban?: string | null;
  currencyCode?: string;
  isActive?: boolean;
  memo?: string | null;
}

export type BankStatementLineStatus = 'unmatched' | 'matched';

export interface BankStatementLine {
  id: string;
  companyId: string;
  bankAccountId: string;
  statementDate: string;
  valueDate: string | null;
  reference: string | null;
  description: string;
  debitAmount: string;
  creditAmount: string;
  status: BankStatementLineStatus;
  matchedJournalLineId: string | null;
  matchedEntryNo?: string | null;
  matchedEntryDate?: string | null;
  reconciliationId: string | null;
  matchedAt: string | null;
  matchedBy: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface CreateBankStatementLineInput {
  statementDate: string;
  valueDate?: string | null;
  reference?: string | null;
  description: string;
  debitAmount?: string | number;
  creditAmount?: string | number;
}

export interface GlBookMovementRow {
  journalLineId: string;
  entryId: string;
  entryNo: string | null;
  entryDate: string;
  entryMemo: string | null;
  lineMemo: string | null;
  debit: string;
  credit: string;
  isMatched: boolean;
  matchedStatementLineId: string | null;
}

export interface BankReconciliation {
  id: string;
  companyId: string;
  bankAccountId: string;
  statementEndDate: string;
  statementEndingBalance: string;
  bookBalance: string;
  unmatchedStatementNet: string;
  unmatchedBookNet: string;
  differenceAmount: string;
  status: 'draft' | 'completed';
  memo: string | null;
  completedAt: string | null;
  completedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BankReconciliationWorkspace {
  bankAccount: BankAccount;
  asOfDate: string;
  bookBalance: string;
  statementLines: BankStatementLine[];
  bookMovements: GlBookMovementRow[];
  unmatchedStatementNet: string;
  unmatchedBookNet: string;
  matchedCount: number;
  unmatchedStatementCount: number;
  unmatchedBookCount: number;
  reconciliations: BankReconciliation[];
}
