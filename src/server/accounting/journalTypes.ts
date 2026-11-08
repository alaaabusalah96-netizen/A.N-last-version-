export type JournalEntryStatus = 'draft' | 'posted';

export interface JournalLine {
  id?: string;
  companyId: string;
  entryId?: string;
  accountId: string;
  debit: number;
  credit: number;
  lineMemo?: string | null;
  accountCode?: string;
  accountNameAr?: string;
}

export interface JournalEntry {
  id: string;
  companyId: string;
  entryDate: string; // YYYY-MM-DD
  entryNo?: string | null;
  memo?: string | null;
  status: JournalEntryStatus;
  periodId?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  reversedByEntryId?: string | null;
  createdBy?: string | null;
  createdAt: string;
  lines?: JournalLine[];
}

export interface CreateJournalLineInput {
  accountId: string;
  debit: number;
  credit: number;
  lineMemo?: string | null;
}

export interface CreateDraftJournalEntryInput {
  entryDate: string;
  memo?: string | null;
  lines: CreateJournalLineInput[];
}
