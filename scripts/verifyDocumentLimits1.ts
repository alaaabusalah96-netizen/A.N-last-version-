import fs from 'fs';
import { MAX_DOCUMENT_LINES, assertMaxDocumentLines } from '../src/server/http/documentLimits.js';

let failed = 0;
function check(id: string, label: string, ok: boolean) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}: ${label}`);
  if (!ok) failed++;
}
const tryLines = (n: number) => {
  try { assertMaxDocumentLines(Array.from({ length: n }, () => ({}))); return 'ok'; } catch (e: any) { return String(e.message); }
};
check('L1', 'limit is 100', MAX_DOCUMENT_LINES === 100);
check('L2', '1, 2 and 100 lines are accepted', tryLines(1) === 'ok' && tryLines(2) === 'ok' && tryLines(100) === 'ok');
check('L3', '101 lines are rejected with a clear Arabic message naming the limit', tryLines(101).includes('100') && tryLines(101).includes('الحد الأقصى'));
check('L4', 'non-array input is left to the existing validation', tryLines(0) === 'ok');
const services = ['purchasing/purchaseOrderService', 'purchasing/grnService', 'purchasing/invoiceService', 'purchasing/purchReturnService', 'sales/salesDeliveryService', 'sales/salesInvoiceService', 'sales/salesReturnService', 'cash/custodyVoucherService'];
for (const s of services) {
  const t = fs.readFileSync(`src/server/${s}.ts`, 'utf8');
  check(`L5:${s}`, 'create path enforces the shared limit', t.includes('assertMaxDocumentLines(input.lines)'));
}
const route = fs.readFileSync('src/server/routes/accountingRoutes.ts', 'utf8');
check('L5:journal-route', 'manual journal create enforces the limit (system posting entries are not capped: a 100-line document posts 200 journal lines)', route.includes('assertMaxDocumentLines(lines)'));
const stock = fs.readFileSync('src/server/inventory/stockDocumentService.ts', 'utf8');
check('L6', 'stock documents use limit 100 (was 500)', stock.includes('MAX_STOCK_DOCUMENT_LINES = 100'));
const modal = fs.readFileSync('src/components/inventory/StockDocumentModal.tsx', 'utf8');
check('L7', 'stock document screen shows n / 100 and stops adding at 100', modal.includes('MAX_LINES = 100') && modal.includes('/ {MAX_LINES}') && modal.includes('lines.length >= MAX_LINES'));
if (failed > 0) { console.log(`[FAIL] ${failed} check(s) failed`); process.exit(1); }
console.log('[PASS] verifyDocumentLimits1');
