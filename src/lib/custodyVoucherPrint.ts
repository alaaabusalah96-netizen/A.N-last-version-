import { amountInWordsAr } from './amountInWordsAr.js';

export interface PrintableVoucher {
  voucherNo: string;
  status: string;
  totalAmount: number;
  memo: string | null;
  lines: { expenseAccountName: string; amount: number; memo: string | null }[];
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const money = (n: number): string => Number(n || 0).toFixed(2);

/** HTML of a printable custody voucher. Only approved vouchers are printable. All text is escaped. */
export function buildCustodyVoucherHtml(v: PrintableVoucher, companyName: string, printedAt: Date = new Date()): string {
  if (v.status !== 'approved') throw new Error('لا تُطبع إلا حافظة معتمدة');
  const rows = v.lines
    .map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.expenseAccountName)}</td><td>${esc(l.memo || '')}</td><td class="n">${money(l.amount)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>حافظة ${esc(v.voucherNo)}</title>
<style>body{font-family:Tahoma,Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}
td,th{border:1px solid #444;padding:6px;font-size:13px}.n{text-align:left}.words{margin-top:12px;font-weight:bold}.sig{display:flex;justify-content:space-between;margin-top:48px;font-size:13px}</style></head>
<body><h1>${esc(companyName)}</h1><div>سند صرف عهدة، حافظة رقم: <b>${esc(v.voucherNo)}</b></div>
<table><thead><tr><th>#</th><th>الحساب</th><th>البيان</th><th>المبلغ</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="3">الإجمالي</td><td class="n"><b>${money(v.totalAmount)}</b></td></tr></tfoot></table>
<div class="words">${esc(amountInWordsAr(v.totalAmount))}</div>
${v.memo ? `<div>ملاحظات: ${esc(v.memo)}</div>` : ''}
<div class="sig"><span>أمين العهدة: ........</span><span>المراجع: ........</span><span>المعتمد: ........</span></div>
<div style="margin-top:24px;font-size:11px;color:#666">طُبع في ${esc(printedAt.toISOString().slice(0, 10))}</div></body></html>`;
}

export function printCustodyVoucher(v: PrintableVoucher, companyName: string): void {
  const html = buildCustodyVoucherHtml(v, companyName);
  const w = window.open('', '_blank', 'noopener=no,width=900,height=700');
  if (!w) throw new Error('تعذر فتح نافذة الطباعة، اسمح بالنوافذ المنبثقة');
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}
