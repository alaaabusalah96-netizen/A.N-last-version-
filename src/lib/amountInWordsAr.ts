/**
 * Amount in words (تفقيط) in Arabic for Egyptian pounds and piasters.
 * Pure function. Supports 0 to 999,999,999,999.99. Money is rounded to 2 decimals.
 */
const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

/** 1..999 */
function below1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (r) {
    if (r < 20) parts.push(ONES[r]);
    else {
      const t = Math.floor(r / 10);
      const o = r % 10;
      parts.push(o ? `${ONES[o]} و${TENS[t]}` : TENS[t]);
    }
  }
  return parts.join(' و');
}

interface Scale { one: string; two: string; few: string; many: string }
const SCALES: Scale[] = [
  { one: 'ألف', two: 'ألفان', few: 'آلاف', many: 'ألف' },
  { one: 'مليون', two: 'مليونان', few: 'ملايين', many: 'مليون' },
  { one: 'مليار', two: 'ملياران', few: 'مليارات', many: 'مليار' },
];

function scaled(n: number, s: Scale): string {
  if (n === 1) return s.one;
  if (n === 2) return s.two;
  if (n >= 3 && n <= 10) return `${below1000(n)} ${s.few}`;
  return `${below1000(n)} ${s.many}`;
}

export function integerInWordsAr(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999_999) throw new Error('المبلغ خارج النطاق المدعوم');
  if (n === 0) return 'صفر';
  const groups = [n % 1000, Math.floor(n / 1000) % 1000, Math.floor(n / 1_000_000) % 1000, Math.floor(n / 1_000_000_000)];
  const out: string[] = [];
  for (let i = 3; i >= 1; i--) if (groups[i]) out.push(scaled(groups[i], SCALES[i - 1]));
  if (groups[0]) out.push(below1000(groups[0]));
  return out.join(' و');
}

export function amountInWordsAr(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('المبلغ غير صالح');
  const total = Math.round((amount + Number.EPSILON) * 100);
  const pounds = Math.floor(total / 100);
  const piasters = total % 100;
  const p = pounds === 0 && piasters > 0 ? '' : `${integerInWordsAr(pounds)} ${pounds >= 3 && pounds <= 10 ? 'جنيهات مصرية' : 'جنيهاً مصرياً'}`;
  const q = piasters ? `${integerInWordsAr(piasters)} ${piasters >= 3 && piasters <= 10 ? 'قروش' : 'قرشاً'}` : '';
  const body = [p, q].filter(Boolean).join(' و');
  return `فقط ${body} لا غير`;
}
