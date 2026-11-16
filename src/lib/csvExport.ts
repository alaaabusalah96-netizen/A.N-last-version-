/**
 * بناء CSV للتقرير المالي — مصدر واحد للحقيقة.
 * قاعدتان إلزاميتان:
 *  1) أي خلية نصية بادئتها = + - @ TAB CR تتسبق بفاصلة عليا (حماية من حقن صيغ Excel).
 *  2) الأرقام تطلع كأرقام غير مُقتبسة، عشان Excel يقرأها كقيم مش كنص.
 */

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NEEDS_QUOTE = /[",\n\r;]/;

export function csvText(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_PREFIX.test(s)) s = `'${s}`;
  if (NEEDS_QUOTE.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvNumber(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '';
}

export function withBom(csv: string): string {
  return `\uFEFF${csv}`;
}

function line(cells: string[]): string {
  return cells.join(',');
}

export function buildGeneralLedgerCsv(data: any): string {
  const rows: string[] = [];
  rows.push(line(['تاريخ القيد', 'البيان', 'مدين', 'دائن', 'الرصيد التراكمي'].map(csvText)));

  for (const r of (data?.rows || [])) {
    rows.push(line([
      csvText(r.entryDate),
      csvText(r.lineMemo || '-'),
      csvNumber(r.debit),
      csvNumber(r.credit),
      csvNumber(r.runningBalance),
    ]));
  }

  // ملخص التقرير — نفس أرقام الشاشة بالحرف
  rows.push(line(['', csvText('الرصيد الافتتاحي'), '', '', csvNumber(data?.openingBalance)]));
  rows.push(line(['', csvText('إجمالي المدين'), csvNumber(data?.totalDebit), '', '']));
  rows.push(line(['', csvText('إجمالي الدائن'), '', csvNumber(data?.totalCredit), '']));
  rows.push(line(['', csvText('الرصيد الختامي'), '', '', csvNumber(data?.closingBalance)]));

  return `${rows.join('\n')}\n`;
}

export function buildIncomeStatementCsv(data: any): string {
  const rows: string[] = [];
  rows.push(line(['القسم', 'رمز الحساب', 'اسم الحساب', 'المبلغ'].map(csvText)));

  for (const r of (data?.revenue || [])) {
    rows.push(line([csvText('إيرادات'), csvText(r.accountCode), csvText(r.accountNameAr || ''), csvNumber(r.amount)]));
  }
  for (const r of (data?.expenses || [])) {
    rows.push(line([csvText('مصروفات'), csvText(r.accountCode), csvText(r.accountNameAr || ''), csvNumber(r.amount)]));
  }

  rows.push(line(['', '', csvText('إجمالي الإيرادات'), csvNumber(data?.totalRevenue)]));
  rows.push(line(['', '', csvText('إجمالي المصروفات'), csvNumber(data?.totalExpenses)]));
  rows.push(line(['', '', csvText('صافي الدخل'), csvNumber(data?.netIncome)]));

  return `${rows.join('\n')}\n`;
}

export function buildBalanceSheetCsv(data: any): string {
  const rows: string[] = [];
  rows.push(line(['القسم', 'رمز الحساب', 'اسم الحساب', 'المبلغ'].map(csvText)));

  for (const r of (data?.assets || [])) {
    rows.push(line([csvText('أصول'), csvText(r.accountCode), csvText(r.accountNameAr || ''), csvNumber(r.amount)]));
  }
  for (const r of (data?.liabilities || [])) {
    rows.push(line([csvText('التزامات'), csvText(r.accountCode), csvText(r.accountNameAr || ''), csvNumber(r.amount)]));
  }
  for (const r of (data?.equity || [])) {
    rows.push(line([csvText('حقوق ملكية'), csvText(r.accountCode), csvText(r.accountNameAr || ''), csvNumber(r.amount)]));
  }

  rows.push(line(['', '', csvText('إجمالي الأصول'), csvNumber(data?.totalAssets)]));
  rows.push(line(['', '', csvText('إجمالي الالتزامات'), csvNumber(data?.totalLiabilities)]));
  rows.push(line(['', '', csvText('إجمالي حقوق الملكية'), csvNumber(data?.totalEquity)]));
  rows.push(line(['', '', csvText('إجمالي الالتزامات وحقوق الملكية'), csvNumber(data?.totalLiabilitiesAndEquity)]));
  rows.push(line(['', '', csvText('حالة التوازن'), csvText(data?.isBalanced ? 'متوازنة' : 'غير متوازنة')]));

  return `${rows.join('\n')}\n`;
}

export function buildOpsCashSummaryCsv(data: any): string {
  const rows: string[] = [];
  rows.push(line(['النوع', 'الرمز', 'الاسم', 'الرصيد الافتتاحي', 'إجمالي الوارد', 'إجمالي الصادر', 'الرصيد الحالي'].map(csvText)));

  for (const r of (data?.registers || [])) {
    rows.push(line([
      csvText('خزينة نقدية'),
      csvText(r.code),
      csvText(r.nameAr),
      csvNumber(r.openingBalance),
      csvNumber(r.totalIn),
      csvNumber(r.totalOut),
      csvNumber(r.currentBalance),
    ]));
  }
  for (const b of (data?.banks || [])) {
    rows.push(line([
      csvText(`حساب بنكي (${b.bankName || ''})`),
      csvText(b.code),
      csvText(b.nameAr),
      csvNumber(b.openingBalance),
      '',
      '',
      csvNumber(b.bookBalance),
    ]));
  }

  rows.push(line(['', '', csvText('إجمالي الصناديق النقدية'), '', '', '', csvNumber(data?.totalCashBalance)]));
  rows.push(line(['', '', csvText('إجمالي البنوك (حسب الدفتر)'), '', '', '', csvNumber(data?.totalBankBalance)]));
  rows.push(line(['', '', csvText('إجمالي السيولة المتاحة'), '', '', '', csvNumber(data?.totalLiquidityPosition)]));
  rows.push(line(['', '', csvText(`العهد المفتوحة (${data?.openCustodiesCount || 0})`), '', '', '', csvNumber(data?.totalOpenCustodyAmount)]));

  return `${rows.join('\n')}\n`;
}

export function buildOpsArApSummaryCsv(data: any): string {
  const rows: string[] = [];
  rows.push(line(['التصنيف', 'الرمز', 'الطرف (عميل/مورد)', 'عدد الفواتير', '0-30 يوم', '31-60 يوم', '61+ يوم', 'الإجمالي المفتوح'].map(csvText)));

  for (const c of (data?.ar?.customers || [])) {
    rows.push(line([
      csvText('ذمم مدينة (عملاء)'),
      csvText(c.customerCode),
      csvText(c.customerNameAr),
      csvNumber(c.invoiceCount),
      csvNumber(c.bucket0To30),
      csvNumber(c.bucket31To60),
      csvNumber(c.bucket61Plus),
      csvNumber(c.totalOpenAmount),
    ]));
  }

  for (const s of (data?.ap?.suppliers || [])) {
    rows.push(line([
      csvText('ذمم دائنة (موردون)'),
      csvText(s.supplierCode),
      csvText(s.supplierNameAr),
      csvNumber(s.invoiceCount),
      csvNumber(s.bucket0To30),
      csvNumber(s.bucket31To60),
      csvNumber(s.bucket61Plus),
      csvNumber(s.totalOpenAmount),
    ]));
  }

  rows.push(line(['', '', csvText('إجمالي الذمم المدينة (AR)'), csvNumber(data?.ar?.openInvoiceCount), csvNumber(data?.ar?.bucket0To30), csvNumber(data?.ar?.bucket31To60), csvNumber(data?.ar?.bucket61Plus), csvNumber(data?.ar?.totalOpen)]));
  rows.push(line(['', '', csvText('إجمالي الذمم الدائنة (AP)'), csvNumber(data?.ap?.openInvoiceCount), csvNumber(data?.ap?.bucket0To30), csvNumber(data?.ap?.bucket31To60), csvNumber(data?.ap?.bucket61Plus), csvNumber(data?.ap?.totalOpen)]));
  rows.push(line(['', '', csvText('صافي الذمم (AR - AP)'), '', '', '', '', csvNumber(data?.netReceivablesMinusPayables)]));

  return `${rows.join('\n')}\n`;
}

