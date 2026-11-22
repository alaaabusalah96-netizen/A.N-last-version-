import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import {
  MatchReportController,
  resolveTrustedMatchInvoice,
  TrustedInvoiceCandidate,
} from '../matchReportController.js';
import {
  PriceVarianceExceptionPanel,
  ExceptionMatchReport,
  PriceVarianceExceptionItem,
} from '../PriceVarianceExceptionPanel.js';

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeReport(invoiceId: string, supplierInvoiceNo: string): ExceptionMatchReport {
  return {
    invoiceId,
    supplierInvoiceNo,
    overallStatus: 'variance_exceeded',
    hasQtyExceeded: false,
    hasPriceExceeded: true,
    lines: [
      {
        grnLineId: 'grn-1',
        itemNameAr: 'صنف',
        invoiceQty: 10,
        grnQty: 10,
        poQty: 10,
        priceVariancePct: 15,
        qtyExceeded: false,
        priceExceeded: true,
      },
    ],
  };
}

function makeException(invoiceId: string, companyId: string, status: 'pending' | 'approved' = 'pending'): PriceVarianceExceptionItem {
  return {
    id: `exc-${invoiceId}`,
    companyId,
    invoiceId,
    supplierId: 'sup-1',
    status,
    requestedBy: 'user-req',
    requestedByUsername: 'ahmed',
    approvedBy: status === 'approved' ? 'user-app' : null,
    approvedByUsername: status === 'approved' ? 'cfo' : null,
    rejectedBy: null,
    reason: 'Price variance',
    decisionReason: null,
    fingerprint: 'fp-1',
    maxVariancePc: 15,
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    isFingerprintValid: true,
    isExpired: false,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MatchReportController Concurrency, Context Switching & Fail-Closed Resolution', () => {
  it('discards delayed Company A HTTP response after switching to Company B (even if transport ignores AbortSignal)', async () => {
    const pendingRequests: Array<{
      url: string;
      signal?: AbortSignal | null;
      deferred: ReturnType<typeof createDeferred<Response>>;
    }> = [];

    const fetcher = (url: string, init?: RequestInit) => {
      const deferred = createDeferred<Response>();
      pendingRequests.push({ url, signal: init?.signal, deferred });
      return deferred.promise;
    };

    const errors: Array<string | null> = [];
    const controller = new MatchReportController(fetcher, (m) => errors.push(m), 'comp-A');

    // Start match fetch for Company A invoice
    const compAFetchPromise = controller.fetchMatchReport('inv-A1', 'comp-A');
    expect(controller.getState().loading).toBe(true);
    expect(pendingRequests).toHaveLength(2);

    // User switches to Company B (which has NO invoices) before Company A HTTP returns
    controller.setCompanyContext('comp-B');
    const compBInvoices: TrustedInvoiceCandidate[] = [];

    // Signals from Company A should be aborted, and context immediately cleared
    expect(pendingRequests[0].signal?.aborted).toBe(true);
    expect(pendingRequests[1].signal?.aborted).toBe(true);
    expect(controller.getState().companyId).toBe('comp-B');
    expect(controller.getState().selectedInvoiceId).toBe('');
    expect(controller.getState().matchReport).toBeNull();
    expect(controller.getState().priceExceptions).toEqual([]);
    expect(controller.getState().loading).toBe(false);

    // Simulate delayed transport delivering Company A's valid HTTP 200 responses AFTER switching to Company B
    pendingRequests[0].deferred.resolve(jsonResponse({ status: 'ok', report: makeReport('inv-A1', 'SINV-A1') }));
    pendingRequests[1].deferred.resolve(jsonResponse({ status: 'ok', exceptions: [makeException('inv-A1', 'comp-A')] }));
    await compAFetchPromise;

    const finalState = controller.getState();
    expect(finalState.companyId).toBe('comp-B');
    expect(finalState.selectedInvoiceId).toBe('');
    expect(finalState.reportCompanyId).toBe('');
    expect(finalState.matchReport).toBeNull();
    expect(finalState.priceExceptions).toEqual([]);
    expect(finalState.loading).toBe(false);
    expect(finalState.loadError).toBeNull();
    expect(errors).toEqual([]);

    const trustedInv = resolveTrustedMatchInvoice({
      selectedCompanyId: 'comp-B',
      selectedInvoiceId: finalState.selectedInvoiceId,
      matchReport: finalState.matchReport,
      reportCompanyId: finalState.reportCompanyId,
      invoicesCompanyId: 'comp-B',
      invoices: compBInvoices,
    });
    expect(trustedInv).toBeNull();

    const panelHtml = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-B"
        invoice={trustedInv}
        matchReport={finalState.matchReport}
        exceptions={finalState.priceExceptions}
        loading={finalState.loading}
        loadError={finalState.loadError}
        currentUserId="user-req"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={async () => {}}
        onError={() => {}}
        onSuccess={() => {}}
      />
    );
    expect(panelHtml).toBe('');
  });

  it('clears previous invoice data immediately on invoice switch and prevents stale finally/error from clobbering newer request', async () => {
    const queue: Array<{
      url: string;
      signal?: AbortSignal | null;
      deferred: ReturnType<typeof createDeferred<Response>>;
    }> = [];

    const fetcher = (url: string, init?: RequestInit) => {
      const deferred = createDeferred<Response>();
      queue.push({ url, signal: init?.signal, deferred });
      return deferred.promise;
    };

    const errors: Array<string | null> = [];
    const controller = new MatchReportController(fetcher, (m) => errors.push(m), 'comp-1');

    // 1. Load Invoice 1 cleanly first
    const p1 = controller.fetchMatchReport('inv-1', 'comp-1');
    queue[0].deferred.resolve(jsonResponse({ status: 'ok', report: makeReport('inv-1', 'SINV-1') }));
    queue[1].deferred.resolve(jsonResponse({ status: 'ok', exceptions: [makeException('inv-1', 'comp-1', 'approved')] }));
    await p1;
    expect(controller.getState().matchReport?.invoiceId).toBe('inv-1');
    expect(controller.getState().priceExceptions).toHaveLength(1);

    // 2. Refresh Invoice 1 (req 2) and before it resolves, switch to Invoice 2 (req 3)
    const pRefresh1 = controller.fetchMatchReport('inv-1', 'comp-1');
    const p2 = controller.fetchMatchReport('inv-2', 'comp-1');

    // Immediately upon switching to inv-2, inv-1's old report & exceptions MUST be cleared
    expect(controller.getState().selectedInvoiceId).toBe('inv-2');
    expect(controller.getState().matchReport).toBeNull();
    expect(controller.getState().priceExceptions).toEqual([]);
    expect(controller.getState().loading).toBe(true);

    // Older request (inv-1 refresh) fails AND runs its finally BEFORE inv-2 finishes
    queue[2].deferred.reject(new Error('Network glitch on stale inv-1'));
    queue[3].deferred.resolve(jsonResponse({ error: 'stale' }, 500));
    await pRefresh1;

    // Crucial: stale failure and stale finally MUST NOT turn off loading or set loadError for inv-2
    expect(controller.getState().loading).toBe(true);
    expect(controller.getState().loadError).toBeNull();
    expect(controller.getState().matchReport).toBeNull();
    expect(errors).toEqual([]);

    // Now inv-2 finishes cleanly
    queue[4].deferred.resolve(jsonResponse({ status: 'ok', report: makeReport('inv-2', 'SINV-2') }));
    queue[5].deferred.resolve(jsonResponse({ status: 'ok', exceptions: [makeException('inv-2', 'comp-1', 'pending')] }));
    await p2;

    expect(controller.getState().loading).toBe(false);
    expect(controller.getState().matchReport?.invoiceId).toBe('inv-2');
    expect(controller.getState().priceExceptions[0].id).toBe('exc-inv-2');
  });

  it('never mixes matchReport from a new request with exceptions from a previous request when price-exceptions fails', async () => {
    let callIndex = 0;
    const fetcher = async (url: string) => {
      callIndex += 1;
      if (callIndex === 1) {
        return jsonResponse({ status: 'ok', report: makeReport('inv-1', 'SINV-1') });
      }
      if (callIndex === 2) {
        return jsonResponse({ status: 'ok', exceptions: [makeException('inv-1', 'comp-1', 'approved')] });
      }
      if (callIndex === 3 && url.includes('three-way-match')) {
        return jsonResponse({ status: 'ok', report: makeReport('inv-1', 'SINV-1') });
      }
      return jsonResponse({ error: 'Failed to refresh exception log' }, 500);
    };

    const controller = new MatchReportController(fetcher, undefined, 'comp-1');
    await controller.fetchMatchReport('inv-1', 'comp-1');
    expect(controller.getState().priceExceptions).toHaveLength(1);
    expect(controller.getState().loadError).toBeNull();

    // Refresh fails on price-exceptions endpoint while three-way-match returns 200
    await controller.fetchMatchReport('inv-1', 'comp-1');
    const stateAfterFail = controller.getState();

    // Must NOT keep stale approved exception from request 1, and must expose loadError
    expect(stateAfterFail.priceExceptions).toEqual([]);
    expect(stateAfterFail.loadError).toBe('Failed to refresh exception log');

    const panelHtml = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', companyId: 'comp-1', supplierInvoiceNo: 'SINV-1', status: 'draft' }}
        matchReport={stateAfterFail.matchReport}
        exceptions={stateAfterFail.priceExceptions}
        loading={stateAfterFail.loading}
        loadError={stateAfterFail.loadError}
        currentUserId="user-approver"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={async () => {}}
        onPostInvoice={async () => {}}
        onError={() => {}}
        onSuccess={() => {}}
      />
    );
    expect(panelHtml).toContain('تعذر تحديث حالة الاستثناءات');
    expect(panelHtml).not.toContain('<span>طلب استثناء تباين سعر</span>');
    expect(panelHtml).not.toContain('<span>اعتماد</span>');
    expect(panelHtml).not.toContain('<span>رفض</span>');
    expect(panelHtml).not.toContain('<span>ترحيل الفاتورة الآن</span>');
  });

  it('resolveTrustedMatchInvoice never fabricates draft status when invoice is missing or belongs to another company', () => {
    const report = makeReport('inv-1', 'SINV-1');
    const invoicesFromCompA: TrustedInvoiceCandidate[] = [
      { id: 'inv-1', companyId: 'comp-A', supplierInvoiceNo: 'SINV-1', status: 'posted' },
    ];

    expect(
      resolveTrustedMatchInvoice({
        selectedCompanyId: 'comp-B',
        selectedInvoiceId: 'inv-1',
        matchReport: report,
        reportCompanyId: 'comp-B',
        invoicesCompanyId: 'comp-B',
        invoices: [],
      })
    ).toBeNull();

    expect(
      resolveTrustedMatchInvoice({
        selectedCompanyId: 'comp-B',
        selectedInvoiceId: 'inv-1',
        matchReport: report,
        reportCompanyId: 'comp-B',
        invoicesCompanyId: 'comp-A',
        invoices: invoicesFromCompA,
      })
    ).toBeNull();

    expect(
      resolveTrustedMatchInvoice({
        selectedCompanyId: 'comp-A',
        selectedInvoiceId: 'inv-1',
        matchReport: report,
        reportCompanyId: 'comp-A',
        invoicesCompanyId: 'comp-A',
        invoices: invoicesFromCompA,
      })?.status
    ).toBe('posted');
  });
});
