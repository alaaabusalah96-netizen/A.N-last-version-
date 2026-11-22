import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import {
  PriceVarianceExceptionPanel,
  PriceVarianceExceptionItem,
  ExceptionMatchReport,
} from '../PriceVarianceExceptionPanel.js';

function makeReport(overrides: Partial<ExceptionMatchReport> = {}): ExceptionMatchReport {
  return {
    invoiceId: 'inv-1',
    supplierInvoiceNo: 'SINV-2026-01',
    overallStatus: 'variance_exceeded',
    hasQtyExceeded: false,
    hasPriceExceeded: true,
    lines: [
      {
        grnLineId: 'grn-1',
        itemNameAr: 'صنف اختباري',
        invoiceQty: 10,
        grnQty: 10,
        poQty: 10,
        priceVariancePct: 12.5,
        qtyExceeded: false,
        priceExceeded: true,
      },
    ],
    ...overrides,
  };
}

function makeException(overrides: Partial<PriceVarianceExceptionItem> = {}): PriceVarianceExceptionItem {
  return {
    id: 'exc-1',
    companyId: 'comp-1',
    invoiceId: 'inv-1',
    supplierId: 'sup-1',
    status: 'pending',
    requestedBy: 'user-req',
    requestedByUsername: 'ahmed.req',
    approvedBy: null,
    rejectedBy: null,
    reason: 'زيادة سعر الصرف من المورد',
    decisionReason: null,
    fingerprint: 'fp-1',
    maxVariancePc: 12.5,
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    isFingerprintValid: true,
    isExpired: false,
    ...overrides,
  };
}

const noopAsync = async () => {};
const noop = () => {};

describe('PriceVarianceExceptionPanel UI & RBAC / SoD Rendering', () => {
  it('shows Request button ONLY to users with purchasing:variance:request and hides it otherwise', () => {
    const withRequest = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport()}
        exceptions={[]}
        loading={false}
        currentUserId="user-req"
        canRequestVariance={true}
        canApproveVariance={false}
        canPostInvoice={false}
        actionLoading={false}
        onRefresh={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(withRequest).toContain('<span>طلب استثناء تباين سعر</span>');
    expect(withRequest).not.toContain('<span>اعتماد</span>');
    expect(withRequest).not.toContain('<span>رفض</span>');

    const withoutRequest = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport()}
        exceptions={[]}
        loading={false}
        currentUserId="user-viewer"
        canRequestVariance={false}
        canApproveVariance={false}
        canPostInvoice={false}
        actionLoading={false}
        onRefresh={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(withoutRequest).not.toContain('<span>طلب استثناء تباين سعر</span>');
    expect(withoutRequest).toContain('purchasing:variance:request');
  });

  it('hides Approve and Reject buttons from the requester (SoD UI) even if they have purchasing:variance:approve, and shows them to a distinct approver', () => {
    const pendingExc = makeException({ status: 'pending', requestedBy: 'user-same' });

    const selfView = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport()}
        exceptions={[pendingExc]}
        loading={false}
        currentUserId="user-same"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(selfView).toContain('فصل المهام (SoD)');
    expect(selfView).not.toContain('>اعتماد<');
    expect(selfView).not.toContain('>رفض<');

    const otherApproverView = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport()}
        exceptions={[pendingExc]}
        loading={false}
        currentUserId="user-approver"
        canRequestVariance={false}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(otherApproverView).toContain('<span>اعتماد</span>');
    expect(otherApproverView).toContain('<span>رفض</span>');
  });

  it('strictly blocks and hides exception actions when qtyExceeded is present', () => {
    const html = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport({
          hasQtyExceeded: true,
          lines: [
            {
              grnLineId: 'grn-1',
              invoiceQty: 15,
              grnQty: 10,
              poQty: 10,
              priceVariancePct: 12.5,
              qtyExceeded: true,
              priceExceeded: true,
            },
          ],
        })}
        exceptions={[makeException()]}
        loading={false}
        currentUserId="user-approver"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(html).toContain('تجاوز في الكمية');
    expect(html).not.toContain('طلب استثناء تباين سعر');
    expect(html).not.toContain('تقديم طلب استثناء جديد');
    expect(html).not.toContain('<span>اعتماد</span>');
    expect(html).not.toContain('<span>رفض</span>');
  });

  it('clearly flags expired fingerprint on approved exception, blocks reuse, and hides post button', () => {
    const expiredApproved = makeException({
      status: 'approved',
      approvedBy: 'user-approver',
      approvedByUsername: 'cfo.ali',
      isFingerprintValid: false,
      isExpired: true,
    });
    const html = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport()}
        exceptions={[expiredApproved]}
        loading={false}
        currentUserId="user-req"
        canRequestVariance={true}
        canApproveVariance={false}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onPostInvoice={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(html).toContain('انتهت صلاحية بصمة الاستثناء');
    expect(html).toContain('معتمد (منتهي الصلاحية - تغيرت البنود)');
    expect(html).toContain('تقديم طلب استثناء جديد');
    expect(html).not.toContain('ترحيل الفاتورة الآن');
  });

  it('displays posted/cancelled closed banners and rejected/superseded reasons without action buttons', () => {
    const postedHtml = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', supplierInvoiceNo: 'SINV-2026-01', status: 'posted' }}
        matchReport={makeReport()}
        exceptions={[
          makeException({
            status: 'rejected',
            rejectedBy: 'user-app',
            rejectedByUsername: 'manager.sara',
            decisionReason: 'السعر أعلى من السوق',
          }),
        ]}
        loading={false}
        currentUserId="user-req"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(postedHtml).toContain('الفاتورة مرحّلة بالفعل ومغلقة محاسبياً');
    expect(postedHtml).toContain('manager.sara');
    expect(postedHtml).toContain('السعر أعلى من السوق');
    expect(postedHtml).not.toContain('طلب استثناء تباين سعر');
    expect(postedHtml).not.toContain('<span>اعتماد</span>');

    const cancelledHtml = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', supplierInvoiceNo: 'SINV-2026-01', status: 'cancelled' }}
        matchReport={makeReport()}
        exceptions={[
          makeException({
            status: 'superseded',
            supersededBy: 'user-app',
            supersededByUsername: 'auditor.omar',
            decisionReason: 'تغيرت بنود الفاتورة',
          }),
        ]}
        loading={false}
        currentUserId="user-req"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(cancelledHtml).toContain('الفاتورة ملغاة');
    expect(cancelledHtml).toContain('auditor.omar');
    expect(cancelledHtml).toContain('تغيرت بنود الفاتورة');
  });

  it('hides/disables request, approve, reject, and post actions during loading or status update failure', () => {
    const pendingExc = makeException({ status: 'pending', requestedBy: 'user-req' });
    const approvedExc = makeException({
      id: 'exc-app',
      status: 'approved',
      approvedBy: 'user-approver',
      approvedByUsername: 'cfo.ali',
    });

    const loadingHtml = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', companyId: 'comp-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport()}
        exceptions={[pendingExc, approvedExc]}
        loading={true}
        loadError={null}
        currentUserId="user-approver"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onPostInvoice={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(loadingHtml).toContain('جاري تحديث حالة المطابقة والاستثناءات');
    expect(loadingHtml).not.toContain('<span>طلب استثناء تباين سعر</span>');
    expect(loadingHtml).not.toContain('<span>تقديم طلب استثناء جديد</span>');
    expect(loadingHtml).not.toContain('<span>اعتماد</span>');
    expect(loadingHtml).not.toContain('<span>رفض</span>');
    expect(loadingHtml).not.toContain('<span>ترحيل الفاتورة الآن</span>');

    const errorHtml = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', companyId: 'comp-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport()}
        exceptions={[pendingExc, approvedExc]}
        loading={false}
        loadError="فشل تحميل سجل استثناءات تباين السعر"
        currentUserId="user-approver"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onPostInvoice={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(errorHtml).toContain('تعذر تحديث حالة الاستثناءات');
    expect(errorHtml).not.toContain('<span>طلب استثناء تباين سعر</span>');
    expect(errorHtml).not.toContain('<span>تقديم طلب استثناء جديد</span>');
    expect(errorHtml).not.toContain('<span>اعتماد</span>');
    expect(errorHtml).not.toContain('<span>رفض</span>');
    expect(errorHtml).not.toContain('<span>ترحيل الفاتورة الآن</span>');
  });

  it('never treats missing isFingerprintValid as valid approval or decidable pending request', () => {
    const unverifiedApproved = makeException({
      status: 'approved',
      approvedBy: 'user-approver',
      approvedByUsername: 'cfo.ali',
      isFingerprintValid: undefined,
      isExpired: undefined,
    });
    const htmlApproved = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', companyId: 'comp-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport()}
        exceptions={[unverifiedApproved]}
        loading={false}
        currentUserId="user-req"
        canRequestVariance={true}
        canApproveVariance={false}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onPostInvoice={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(htmlApproved).toContain('صلاحية بصمة الاستثناء غير مؤكدة');
    expect(htmlApproved).toContain('معتمد (صلاحية البصمة غير مؤكدة)');
    expect(htmlApproved).not.toContain('يوجد اعتماد ساري لاستثناء تباين السعر');
    expect(htmlApproved).not.toContain('معتمد (ساري)');
    expect(htmlApproved).not.toContain('<span>ترحيل الفاتورة الآن</span>');
    expect(htmlApproved).not.toContain('<span>تقديم طلب استثناء جديد</span>');

    const unverifiedPending = makeException({
      status: 'pending',
      requestedBy: 'user-req',
      isFingerprintValid: undefined,
      isExpired: undefined,
    });
    const htmlPending = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={{ id: 'inv-1', companyId: 'comp-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport()}
        exceptions={[unverifiedPending]}
        loading={false}
        currentUserId="user-approver"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onPostInvoice={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(htmlPending).toContain('معلق (صلاحية البصمة غير مؤكدة)');
    expect(htmlPending).not.toContain('<span>اعتماد</span>');
    expect(htmlPending).not.toContain('<span>رفض</span>');
    expect(htmlPending).not.toContain('<span>تقديم طلب استثناء جديد</span>');
  });

  it('hides all request, decision, and post actions when invoice status is unknown or mismatched', () => {
    const unknownInvoiceHtml = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-1"
        invoice={null}
        matchReport={makeReport()}
        exceptions={[makeException({ status: 'pending' })]}
        loading={false}
        currentUserId="user-approver"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onPostInvoice={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(unknownInvoiceHtml).toContain('غير معروفة');
    expect(unknownInvoiceHtml).toContain('حالة الفاتورة غير معروفة أو غير متطابقة مع السياق الحالي');
    expect(unknownInvoiceHtml).not.toContain('<span>طلب استثناء تباين سعر</span>');
    expect(unknownInvoiceHtml).not.toContain('<span>تقديم طلب استثناء جديد</span>');
    expect(unknownInvoiceHtml).not.toContain('<span>اعتماد</span>');
    expect(unknownInvoiceHtml).not.toContain('<span>رفض</span>');
    expect(unknownInvoiceHtml).not.toContain('<span>ترحيل الفاتورة الآن</span>');

    const crossCompanyInvoiceHtml = renderToStaticMarkup(
      <PriceVarianceExceptionPanel
        companyId="comp-2"
        invoice={{ id: 'inv-1', companyId: 'comp-1', supplierInvoiceNo: 'SINV-2026-01', status: 'draft' }}
        matchReport={makeReport()}
        exceptions={[makeException({ status: 'approved' })]}
        loading={false}
        currentUserId="user-approver"
        canRequestVariance={true}
        canApproveVariance={true}
        canPostInvoice={true}
        actionLoading={false}
        onRefresh={noopAsync}
        onPostInvoice={noopAsync}
        onError={noop}
        onSuccess={noop}
      />
    );
    expect(crossCompanyInvoiceHtml).toContain('حالة الفاتورة غير معروفة أو غير متطابقة مع السياق الحالي');
    expect(crossCompanyInvoiceHtml).not.toContain('<span>ترحيل الفاتورة الآن</span>');
    expect(crossCompanyInvoiceHtml).not.toContain('<span>طلب استثناء تباين سعر</span>');
  });
});
