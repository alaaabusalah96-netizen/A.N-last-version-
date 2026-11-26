import { describe, it, expect } from 'vitest';
import { amountInWordsAr, integerInWordsAr } from '../amountInWordsAr.js';

describe('amountInWordsAr', () => {
  it('basic numbers', () => {
    expect(integerInWordsAr(0)).toBe('صفر');
    expect(integerInWordsAr(1)).toBe('واحد');
    expect(integerInWordsAr(11)).toBe('أحد عشر');
    expect(integerInWordsAr(21)).toBe('واحد وعشرون');
    expect(integerInWordsAr(100)).toBe('مائة');
    expect(integerInWordsAr(250)).toBe('مائتان وخمسون');
  });
  it('thousands use the right form', () => {
    expect(integerInWordsAr(1000)).toBe('ألف');
    expect(integerInWordsAr(2000)).toBe('ألفان');
    expect(integerInWordsAr(3000)).toBe('ثلاثة آلاف');
    expect(integerInWordsAr(11000)).toBe('أحد عشر ألف');
    expect(integerInWordsAr(21500)).toBe('واحد وعشرون ألف وخمسمائة');
  });
  it('millions', () => {
    expect(integerInWordsAr(1_000_000)).toBe('مليون');
    expect(integerInWordsAr(2_500_000)).toBe('مليونان وخمسمائة ألف');
  });
  it('money with piasters and wrapper', () => {
    expect(amountInWordsAr(8000)).toBe('فقط ثمانية آلاف جنيهاً مصرياً لا غير');
    expect(amountInWordsAr(1500.5)).toBe('فقط ألف وخمسمائة جنيهاً مصرياً وخمسون قرشاً لا غير');
    expect(amountInWordsAr(0.25)).toBe('فقط خمسة وعشرون قرشاً لا غير');
    expect(amountInWordsAr(5)).toBe('فقط خمسة جنيهات مصرية لا غير');
  });
  it('rejects negatives and out of range', () => {
    expect(() => amountInWordsAr(-1)).toThrow();
    expect(() => integerInWordsAr(1e13)).toThrow();
  });
});
