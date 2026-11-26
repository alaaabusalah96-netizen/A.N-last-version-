import { describe, it, expect } from 'vitest';
import { usableAccounts } from '../accountRules';

const acc = (code: string, nameAr: string, reservedRole: string | null = null) => ({ id: code, code, nameAr, isActive: true, isPostable: true, accountType: 'asset', reservedRole });

describe('cash and bank pickers hide system-role accounts', () => {
  it('hides inventory (1400), receivables and custody; keeps cash and bank', () => {
    const list = [acc('1100', 'النقدية وما في حكمها'), acc('1110', 'البنك'), acc('1200', 'العملاء'), acc('1300', 'ذمم عهد الموظفين'), acc('1400', 'المخزون')];
    expect(usableAccounts(list, 'cash_register_gl_account').map((a) => a.code)).toEqual(['1100', '1110']);
  });
  it('hides any account the server marks with a reserved role, whatever its code or name', () => {
    const list = [acc('1100', 'النقدية'), acc('1999', 'حساب عام', 'المخزون')];
    expect(usableAccounts(list, 'cash_register_gl_account').map((a) => a.code)).toEqual(['1100']);
  });
});
