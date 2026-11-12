import { describe, it, expect } from 'vitest';
import {
  csvText,
  csvNumber,
  buildGeneralLedgerCsv,
  buildIncomeStatementCsv,
  buildBalanceSheetCsv,
} from '../csvExport.js';

describe('csvExport — حماية من حقن الصيغ', () => {
  it('يسبق الخلايا النصية الخبيثة بفاصلة عليا', () => {
    expect(csvText('=1+1')).toBe("'=1+1");
    expect(csvText('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvText('-2+3')).toBe("'-2+3");
    expect(csvText('@cmd')).toBe("'@cmd");
    expect(csvText('\tX')).toBe("'\tX");
    expect(csvText('\rX')).toBe('"\'\rX"');
  });

  it('يضاعف علامات التنصيص ويلفّ الخلية عند وجود فاصلة أو سطر جديد', () => {
    expect(csvText('قال "لا"')).toBe('"قال ""لا"""');
    expect(csvText('أ,ب')).toBe('"أ,ب"');
    expect(csvText('سطر1\nسطر2')).toBe('"سطر1\nسطر2"');
  });

  it('يطلع الأرقام كنص غير مُقتبس، ويرفض غير الرقمي', () => {
    expect(csvNumber('1234.50')).toBe('1234.5');
    expect(csvNumber('abc')).toBe('');
    expect(csvNumber(null)).toBe('');
  });
});

describe('csvExport — اكتمال المحتوى', () => {
  const gl = {
    accountCode: '1100',
    openingBalance: '100.00',
    totalDebit: '50.00',
    totalCredit: '20.00',
    closingBalance: '130.00',
    rows: [{ entryDate: '2026-01-01', lineMemo: 'قيد', debit: '50.00', credit: '0', runningBalance: '150.00' }],
  };

  it('الأستاذ العام يحتوي الافتتاحي والإجماليات والختامي', () => {
    const csv = buildGeneralLedgerCsv(gl);
    expect(csv).toContain('الرصيد الافتتاحي');
    expect(csv).toContain('100');
    expect(csv).toContain('إجمالي المدين');
    expect(csv).toContain('إجمالي الدائن');
    expect(csv).toContain('الرصيد الختامي');
    expect(csv).toContain('130');
  });

  it('قائمة الدخل تحتوي الإجماليين وصافي الدخل', () => {
    const csv = buildIncomeStatementCsv({
      revenue: [{ accountCode: '4100', accountNameAr: 'مبيعات', amount: '1000.00' }],
      expenses: [{ accountCode: '5100', accountNameAr: 'إيجار', amount: '400.00' }],
      totalRevenue: '1000.00',
      totalExpenses: '400.00',
      netIncome: '600.00',
    });
    expect(csv).toContain('إجمالي الإيرادات');
    expect(csv).toContain('إجمالي المصروفات');
    expect(csv).toContain('صافي الدخل');
    expect(csv).toContain('600');
  });

  it('الميزانية تحتوي الإجماليات وحالة التوازن', () => {
    const csv = buildBalanceSheetCsv({
      assets: [],
      liabilities: [],
      equity: [],
      totalAssets: '500.00',
      totalLiabilities: '200.00',
      totalEquity: '300.00',
      totalLiabilitiesAndEquity: '500.00',
      isBalanced: true,
    });
    expect(csv).toContain('إجمالي الأصول');
    expect(csv).toContain('إجمالي الالتزامات وحقوق الملكية');
    expect(csv).toContain('حالة التوازن');
    expect(csv).toContain('متوازنة');
  });

  it('اسم حساب خبيث في التقرير ما بيطلعش صيغة قابلة للتنفيذ', () => {
    const csv = buildIncomeStatementCsv({
      revenue: [{ accountCode: '4100', accountNameAr: '=HYPERLINK("http://x")', amount: '1.00' }],
      expenses: [],
      totalRevenue: '1.00',
      totalExpenses: '0',
      netIncome: '1.00',
    });
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/);
    expect(csv).toContain("'=HYPERLINK");
  });
});
