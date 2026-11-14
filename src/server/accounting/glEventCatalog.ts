import { AccountType } from '../accounting/accountTypes.js';

export type GlEventStatus = 'wired' | 'not_implemented';

export interface GlEventField {
  field: string;
  labelAr: string;
  allowedTypes: readonly AccountType[];
  requirePostable: boolean;
}

export interface GlEventDefinition {
  eventKey: string;          // مفتاح الإعداد، مثال: accounting.grn_mapping
  eventCode: string;         // goods_receipt
  labelAr: string;
  /** wired = فيه مسار ترحيل فعلي بينتج قيدًا. not_implemented = مفيش مسار بعد. */
  status: GlEventStatus;
  /** الملف/الدالة اللي بتنفّذ الترحيل — إلزامي لو status='wired'. */
  wiringPoint?: string;
  fields: readonly GlEventField[];
}

export const GL_EVENT_CATALOG: readonly GlEventDefinition[] = [
  {
    eventKey: 'accounting.grn_mapping',
    eventCode: 'goods_receipt',
    labelAr: 'استلام البضائع (GRN)',
    status: 'wired',
    wiringPoint: 'src/server/purchasing/grnService.ts#postGrn',
    fields: [
      { field: 'inventory_account_id', labelAr: 'حساب المخزون', allowedTypes: ['asset'], requirePostable: true },
      { field: 'purchases_clearing_account_id', labelAr: 'حساب المشتريات المعلّقة', allowedTypes: ['liability'], requirePostable: true },
    ],
  },
  {
    eventKey: 'accounting.custody_mapping',
    eventCode: 'custody_disbursement',
    labelAr: 'عهد الموظفين (صرف وتسوية)',
    status: 'wired',
    wiringPoint: 'src/server/cash/custodyService.ts#disburseCustody',
    fields: [
      { field: 'custody_receivable_account_id', labelAr: 'حساب ذمة عهد الموظفين', allowedTypes: ['asset'], requirePostable: true },
    ],
  },
  {
    // ملاحظة معمارية: fields فارغة عمدًا لأن سندات القبض والصرف تأخذ حساب الصندوق
    // من cash_registers.gl_account_id والحساب الطرف من voucher.contra_account_id مباشرةً،
    // ولا تستدعي GlMappingService.resolve لهذا الحدث؛ وجوده بحالة wired لتوثيق مسار الترحيل وتتبّعه فقط.
    eventKey: 'accounting.cash_voucher_mapping',
    eventCode: 'cash_voucher',
    labelAr: 'سندات القبض والصرف',
    status: 'wired',
    wiringPoint: 'src/server/cash/voucherService.ts#postReceiptVoucher',
    fields: [],
  },
  {
    eventKey: 'accounting.purchase_invoice_mapping',
    eventCode: 'purchase_invoice',
    labelAr: 'فواتير الموردين (AP)',
    status: 'wired',
    wiringPoint: 'src/server/purchasing/invoiceService.ts#postInvoice',
    fields: [
      { field: 'purchases_clearing_account_id', labelAr: 'حساب المشتريات المعلّقة', allowedTypes: ['liability'], requirePostable: true },
      { field: 'accounts_payable_account_id', labelAr: 'حساب الدائنين (الموردون)', allowedTypes: ['liability'], requirePostable: true },
    ],
  },
  // العمليات التالية **معلنة بلا مسار ترحيل** في 616ebf9. لا تُفعّل إلا بحزمة
  // أعمال تنفّذ cycle الترحيل فعليًا. status='not_implemented' معناها:
  // لا شاشة، لا إعداد، لا تعريف إعداد مزروع.
  { eventKey: 'accounting.purchase_return_mapping', eventCode: 'purchase_return', labelAr: 'مرتجعات المشتريات', status: 'not_implemented', fields: [] },
  { eventKey: 'accounting.stock_issue_mapping', eventCode: 'stock_issue', labelAr: 'صرف المخزون', status: 'not_implemented', fields: [] },
  { eventKey: 'accounting.stock_transfer_mapping', eventCode: 'stock_transfer', labelAr: 'التحويل بين المستودعات', status: 'not_implemented', fields: [] },
  { eventKey: 'accounting.stock_adjustment_mapping', eventCode: 'stock_adjustment', labelAr: 'التسويات والجرد', status: 'not_implemented', fields: [] },
  { eventKey: 'accounting.sales_mapping', eventCode: 'sales', labelAr: 'المبيعات', status: 'not_implemented', fields: [] },
  { eventKey: 'accounting.cogs_mapping', eventCode: 'cogs', labelAr: 'تكلفة البضاعة المباعة', status: 'not_implemented', fields: [] },
  { eventKey: 'accounting.sales_return_mapping', eventCode: 'sales_return', labelAr: 'مرتجعات المبيعات', status: 'not_implemented', fields: [] },
];

export function findGlEvent(eventKey: string): GlEventDefinition | null {
  return GL_EVENT_CATALOG.find((e) => e.eventKey === eventKey) || null;
}

export function wiredGlEvents(): readonly GlEventDefinition[] {
  return GL_EVENT_CATALOG.filter((e) => e.status === 'wired');
}
