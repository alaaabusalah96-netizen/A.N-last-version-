import { ValidationError } from './errors.js';

/** One limit for every document with lines (journal, stock, PO, GRN, invoices, returns, vouchers). */
export const MAX_DOCUMENT_LINES = 100;

export function assertMaxDocumentLines(lines: unknown): void {
  if (Array.isArray(lines) && lines.length > MAX_DOCUMENT_LINES) {
    throw new ValidationError(`عدد الأسطر (${lines.length}) يتجاوز الحد الأقصى المسموح به لكل مستند (${MAX_DOCUMENT_LINES} سطر). قسّم المستند إلى أكثر من مستند.`);
  }
}
