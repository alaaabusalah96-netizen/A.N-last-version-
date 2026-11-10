export interface AccountingPeriod {
  id: string;
  companyId: string;
  code: string;
  startDate: string;
  endDate: string;
  isClosed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  createdAt: string;
}

export interface CreatePeriodInput {
  code: string;
  startDate: string;
  endDate: string;
}
