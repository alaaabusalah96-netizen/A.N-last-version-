import fs from 'fs';

function assert(condition: boolean, label: string, details?: string) {
  if (!condition) throw new Error(`[FAIL] ${label}${details ? `: ${details}` : ''}`);
  console.log(`[PASS] ${label}`);
}

const panel = fs.readFileSync('src/components/cash/CustodyStatementPanel.tsx', 'utf8');
const workspace = fs.readFileSync('src/components/cash/CashCustodyWorkspace.tsx', 'utf8');
const routes = fs.readFileSync('src/server/routes/cashRoutes.ts', 'utf8');

// U1: every API path the panel calls is a real route, with the same verb.
const calls: Array<{ verb: 'get' | 'post'; route: string; frag: RegExp }> = [
  { verb: 'get', route: '/custodies/:id/statement', frag: /\/api\/cash\/custodies\/\$\{custodyId\}\/statement\?companyId=/ },
  { verb: 'post', route: '/custodies/:id/vouchers', frag: /\/api\/cash\/custodies\/\$\{custodyId\}\/vouchers`/ },
  { verb: 'post', route: '/custodies/:id/topup', frag: /\/api\/cash\/custodies\/\$\{custodyId\}\/topup`/ },
  { verb: 'post', route: '/custodies/:id/cash-counts', frag: /\/api\/cash\/custodies\/\$\{custodyId\}\/cash-counts`/ },
  { verb: 'post', route: '/custodies/:id/cash-counts/:countId/shortage-claim', frag: /cash-counts\/\$\{c\.id\}\/shortage-claim`/ },
  { verb: 'post', route: '/custody-shortage-claims/:id/repay', frag: /custody-shortage-claims\/\$\{c\.id\}\/repay`/ },
  { verb: 'post', route: '/custody-vouchers/:id/approve', frag: /custody-vouchers\/\$\{v\.id\}\/approve`/ },
  { verb: 'post', route: '/custody-vouchers/:id/reject', frag: /custody-vouchers\/\$\{v\.id\}\/reject`/ },
  { verb: 'post', route: '/custody-vouchers/:id/reverse', frag: /custody-vouchers\/\$\{v\.id\}\/reverse`/ },
];
for (const c of calls) {
  assert(routes.includes(`cashRoutes.${c.verb}(\n  '${c.route}'`), `U1 route exists: ${c.verb.toUpperCase()} ${c.route}`);
  assert(c.frag.test(panel), `U1 panel calls ${c.route}`);
}

// U2: buttons are gated by the same permission the route enforces.
const perm = (route: string): string => {
  const i = routes.indexOf(`cashRoutes.post(\n  '${route}'`);
  const m = /PERMISSIONS\.(CUSTODY_[A-Z]+)/.exec(routes.slice(i, i + 700));
  return m ? m[1].toLowerCase().replace('_', ':') : '';
};
const gates: Array<[string, string]> = [
  ['/custodies/:id/vouchers', "can('custody:request')"],
  ['/custodies/:id/topup', "can('custody:disburse')"],
  ['/custodies/:id/cash-counts', "can('custody:settle')"],
  ['/custody-vouchers/:id/approve', "can('custody:approve')"],
  ['/custody-shortage-claims/:id/repay', "can('custody:settle')"],
];
for (const [route, gate] of gates) {
  const p = perm(route);
  assert(`can('${p}')` === gate, `U2 gate matches server permission for ${route}`, p);
  assert(panel.includes(gate), `U2 panel uses ${gate}`);
}

// U3: request bodies use the field names the services read.
assert(/countedAmount: countAmount/.test(panel), 'U3 cash count sends countedAmount');
assert(/\{ amount: topUpAmount/.test(panel), 'U3 top-up sends amount');
assert(/\{ amount: repayById\[c\.id\] \}/.test(panel), 'U3 repayment sends amount');
assert(/lines: toPayloadLines\(/.test(panel) && /expenseAccountId: l\.account, amount: l\.amount/.test(fs.readFileSync('src/lib/voucherLines.ts', 'utf8')), 'U3 voucher sends lines[].expenseAccountId/amount');
assert(/\{ reason: reasonById\[v\.id\] \}/.test(panel), 'U3 reject/reverse send reason');

// U4: the count never posts and the UI never adjusts automatically. Since C13 (owner decision) a write-off or payroll deduction is offered only as an approval request.
assert(/لا يرحّل/.test(panel), 'U4 count labelled as non-posting');
assert(!/auto.?adjust|تسوية تلقائية/i.test(panel), 'U4 no auto-adjust action in the panel');
assert(/custody-shortage-claims\/\$\{c\.id\}\/settlements/.test(panel) && /لا قيد قبل الاعتماد/.test(panel), 'U4 settlement is only an approval request (no entry before approval)');
assert(/custody-shortage-settlements\/\$\{st\.id\}\/approve/.test(panel) && /can\('custody:approve'\)/.test(panel), 'U4 settlement approval needs custody:approve');
assert(/policies\.some\(\(pl\) => pl\.enabled\)/.test(panel), 'U4 settlement offered only when a treatment is enabled');
assert(/!claimedCountIds\.has\(c\.id\)/.test(panel) && /c\.variance < 0/.test(panel), 'U4 claim offered only for negative variance without a claim');
assert(/c\.outstanding - \(c\.pendingSettlement \|\| 0\) > 0/.test(panel), 'U4 repay offered only while outstanding and not reserved');
assert(/!\(reasonById\[v\.id\] \|\| ''\)\.trim\(\)/.test(panel), 'U4 reject/reverse require a reason');

// U5: mounted in the custody drawer with account options and permission checker.
assert(/<CustodyStatementPanel[\s\S]{0,400}expenseAccounts=\{expenseAccountOptions\}[\s\S]{0,200}can=\{can\}/.test(workspace), 'U5 mounted in drawer with accounts and can()');
assert(/import \{ CustodyStatementPanel \}/.test(workspace), 'U5 imported');
console.log('verifyCashCustodyUi2: ALL PASS');
