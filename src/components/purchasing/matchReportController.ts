import type {
  ExceptionMatchReport,
  PriceVarianceExceptionItem,
} from './PriceVarianceExceptionPanel.js';

export interface TrustedInvoiceCandidate {
  id: string;
  companyId?: string;
  supplierInvoiceNo: string;
  status: 'draft' | 'posted' | 'cancelled';
}

export interface MatchReportState {
  companyId: string;
  selectedInvoiceId: string;
  reportCompanyId: string;
  reportInvoiceId: string;
  matchReport: ExceptionMatchReport | null;
  priceExceptions: PriceVarianceExceptionItem[];
  loading: boolean;
  loadError: string | null;
}

export type MatchFetcher = (path: string, init?: RequestInit) => Promise<Response>;

export function createInitialMatchReportState(companyId = ''): MatchReportState {
  return {
    companyId,
    selectedInvoiceId: '',
    reportCompanyId: '',
    reportInvoiceId: '',
    matchReport: null,
    priceExceptions: [],
    loading: false,
    loadError: null,
  };
}

export function resolveTrustedMatchInvoice(args: {
  selectedCompanyId: string;
  selectedInvoiceId: string;
  matchReport: ExceptionMatchReport | null;
  reportCompanyId: string;
  invoicesCompanyId: string;
  invoices: TrustedInvoiceCandidate[];
}): TrustedInvoiceCandidate | null {
  const {
    selectedCompanyId,
    selectedInvoiceId,
    matchReport,
    reportCompanyId,
    invoicesCompanyId,
    invoices,
  } = args;

  if (!selectedCompanyId || !selectedInvoiceId || !matchReport) return null;
  if (reportCompanyId !== selectedCompanyId) return null;
  if (invoicesCompanyId !== selectedCompanyId) return null;
  if (!matchReport.invoiceId || matchReport.invoiceId !== selectedInvoiceId) return null;

  const found = invoices.find(
    (inv) =>
      inv.id === selectedInvoiceId &&
      inv.id === matchReport.invoiceId &&
      inv.companyId === selectedCompanyId
  );
  if (!found) return null;
  if (found.status !== 'draft' && found.status !== 'posted' && found.status !== 'cancelled') {
    return null;
  }
  return found;
}

export interface MatchEndpoints {
  matchUrl: (invId: string, companyId: string) => string;
  exceptionsUrl: (invId: string, companyId: string) => string;
}

const DEFAULT_MATCH_ENDPOINTS: MatchEndpoints = {
  matchUrl: (invId, companyId) =>
    `/api/purchasing/supplier-invoices/${invId}/three-way-match?companyId=${companyId}`,
  exceptionsUrl: (invId, companyId) =>
    `/api/purchasing/supplier-invoices/${invId}/price-exceptions?companyId=${companyId}`,
};

export class MatchReportController {
  private state: MatchReportState;
  private requestSeq = 0;
  private abortController: AbortController | null = null;
  private listeners = new Set<(state: MatchReportState) => void>();

  constructor(
    private fetcher: MatchFetcher,
    private onError?: (msg: string | null) => void,
    initialCompanyId = '',
    private endpoints: MatchEndpoints = DEFAULT_MATCH_ENDPOINTS
  ) {
    this.state = createInitialMatchReportState(initialCompanyId);
  }

  getState(): MatchReportState {
    return this.state;
  }

  subscribe(listener: (state: MatchReportState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  setCompanyContext(nextCompanyId: string): void {
    this.abortController?.abort();
    this.abortController = null;
    this.requestSeq += 1;
    this.state = createInitialMatchReportState(nextCompanyId);
    this.notify();
  }

  clearSelection(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.requestSeq += 1;
    this.state = createInitialMatchReportState(this.state.companyId);
    this.notify();
  }

  async fetchMatchReport(invId: string, expectedCompanyId?: string): Promise<void> {
    const targetCompanyId = expectedCompanyId ?? this.state.companyId;
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const mySeq = ++this.requestSeq;

    if (!invId || !targetCompanyId) {
      this.state = {
        companyId: targetCompanyId,
        selectedInvoiceId: invId || '',
        reportCompanyId: '',
        reportInvoiceId: '',
        matchReport: null,
        priceExceptions: [],
        loading: false,
        loadError: null,
      };
      this.notify();
      return;
    }

    const isContextChanged =
      this.state.reportCompanyId !== targetCompanyId ||
      this.state.reportInvoiceId !== invId;

    this.state = {
      companyId: targetCompanyId,
      selectedInvoiceId: invId,
      reportCompanyId: isContextChanged ? '' : this.state.reportCompanyId,
      reportInvoiceId: isContextChanged ? '' : this.state.reportInvoiceId,
      matchReport: isContextChanged ? null : this.state.matchReport,
      priceExceptions: isContextChanged ? [] : this.state.priceExceptions,
      loading: true,
      loadError: null,
    };
    this.notify();

    const isStale = () =>
      mySeq !== this.requestSeq ||
      this.state.companyId !== targetCompanyId ||
      this.state.selectedInvoiceId !== invId;

    try {
      const [matchRes, excRes] = await Promise.all([
        this.fetcher(this.endpoints.matchUrl(invId, targetCompanyId), {
          signal: controller.signal,
        }),
        this.fetcher(this.endpoints.exceptionsUrl(invId, targetCompanyId), {
          signal: controller.signal,
        }),
      ]);

      if (isStale()) return;

      const [matchData, excData] = await Promise.all([
        matchRes.json().catch(() => ({})),
        excRes.json().catch(() => ({})),
      ]);

      if (isStale()) return;

      if (!matchRes.ok) {
        const msg = matchData?.message || matchData?.error || 'فشل جلب تقرير المطابقة الثلاثية';
        this.state = {
          ...this.state,
          reportCompanyId: '',
          reportInvoiceId: '',
          matchReport: null,
          priceExceptions: [],
          loadError: msg,
        };
        this.notify();
        this.onError?.(msg);
        return;
      }

      const report = matchData?.report || null;
      if (!report || (report.invoiceId && report.invoiceId !== invId)) {
        const msg = 'تعذر التحقق من تطابق تقرير المطابقة مع الفاتورة المحددة';
        this.state = {
          ...this.state,
          reportCompanyId: '',
          reportInvoiceId: '',
          matchReport: null,
          priceExceptions: [],
          loadError: msg,
        };
        this.notify();
        this.onError?.(msg);
        return;
      }

      if (!excRes.ok || !Array.isArray(excData?.exceptions)) {
        const msg = excData?.message || excData?.error || 'فشل تحميل سجل استثناءات تباين السعر';
        this.state = {
          ...this.state,
          reportCompanyId: targetCompanyId,
          reportInvoiceId: invId,
          matchReport: report,
          priceExceptions: [],
          loadError: msg,
        };
        this.notify();
        this.onError?.(msg);
        return;
      }

      this.state = {
        ...this.state,
        reportCompanyId: targetCompanyId,
        reportInvoiceId: invId,
        matchReport: report,
        priceExceptions: excData.exceptions,
        loadError: null,
      };
      this.notify();
    } catch (err: any) {
      if (err?.name === 'AbortError' || isStale()) return;
      const msg = err?.message || 'فشل جلب تقرير المطابقة الثلاثية';
      this.state = {
        ...this.state,
        reportCompanyId: '',
        reportInvoiceId: '',
        matchReport: null,
        priceExceptions: [],
        loadError: msg,
      };
      this.notify();
      this.onError?.(msg);
    } finally {
      if (mySeq === this.requestSeq && !isStale()) {
        this.state = {
          ...this.state,
          loading: false,
        };
        this.notify();
      }
    }
  }
}
