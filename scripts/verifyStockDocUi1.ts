import fs from 'fs';

let failed = 0;
function check(id: string, label: string, ok: boolean) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}: ${label}`);
  if (!ok) failed++;
}
const ws = fs.readFileSync('src/components/inventory/InventoryWorkspace.tsx', 'utf8');
const modal = fs.readFileSync('src/components/inventory/StockDocumentModal.tsx', 'utf8');
const routes = fs.readFileSync('src/server/routes/inventoryRoutes.ts', 'utf8');

function btn(label: string): string {
  const i = ws.indexOf(`<span>${label}</span>`);
  return i < 0 ? '' : ws.slice(Math.max(0, i - 400), i);
}
check('S1', 'issue slip button opens the multi-line document modal preset to issue', btn('إذن صرف').includes("setDocumentInitialType('issue')") && btn('إذن صرف').includes('setShowDocumentModal(true)') && !btn('إذن صرف').includes('setShowIssueModal(true)'));
check('S2', 'transfer slip button opens the multi-line document modal preset to transfer', btn('إذن تحويل').includes("setDocumentInitialType('transfer')") && btn('إذن تحويل').includes('setShowDocumentModal(true)') && !btn('إذن تحويل').includes('setShowTransferModal(true)'));
check('S3', 'the modal receives the preset type and supports many lines with an add-line control', ws.includes('initialType={documentInitialType}') && modal.includes('setLines(') && modal.includes('الأسطر ('));
check('S4', 'the server accepts lines[] for stock documents of every type', routes.includes('/documents') && routes.includes('Array.isArray(b.lines)'));
if (failed > 0) { console.log(`[FAIL] ${failed} check(s) failed`); process.exit(1); }
console.log('[PASS] verifyStockDocUi1: 4/4');
