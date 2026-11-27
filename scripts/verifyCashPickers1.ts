import fs from 'fs';

let failed = 0;
function check(id: string, label: string, ok: boolean) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}: ${label}`);
  if (!ok) failed++;
}
const routes = fs.readFileSync('src/server/routes/cashRoutes.ts', 'utf8');
const ws = fs.readFileSync('src/components/cash/CashCustodyWorkspace.tsx', 'utf8');

function block(path: string): string {
  const i = routes.indexOf(`cashRoutes.get(\n  '${path}'`);
  return i < 0 ? '' : routes.slice(i, i + 900);
}
const acc = block('/accounts');
const org = block('/org-units');
check('P1', 'GET /api/cash/accounts exists and needs only cash:read', acc.includes('PERMISSIONS.CASH_READ') && !acc.includes('ACCOUNTING_'));
check('P2', 'GET /api/cash/org-units exists and needs only cash:read', org.includes('PERMISSIONS.CASH_READ') && !org.includes('ACCOUNTING_'));
check('P3', 'accounts picker returns minimal fields only (no spread of the full row)', acc.includes('nameAr: a.nameAr') && !acc.includes('...a'));
check('P4', 'cash screens read pickers from /api/cash and never from /api/accounting', ws.includes('/api/cash/accounts?companyId') && ws.includes('/api/cash/org-units?companyId') && !/api\/accounting/.test(ws));
if (failed > 0) { console.log(`[FAIL] ${failed} check(s) failed`); process.exit(1); }
console.log('[PASS] verifyCashPickers1: 4/4');
