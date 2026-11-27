import fs from 'fs';

let failed = 0;
function check(id: string, label: string, ok: boolean) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}: ${label}`);
  if (!ok) failed++;
}
const read = (p: string) => fs.readFileSync(p, 'utf8');

const ws = read('src/components/fleet/FleetWorkspace.tsx');
const nav = read('src/lib/navAccess.ts');
const app = read('src/App.tsx');
const side = read('src/components/shell/AppSidebar.tsx');

check('F1', 'FleetWorkspace uses only /api/fleet endpoints for vehicles and drivers',
  ws.includes('/api/fleet/vehicles') && ws.includes('/api/fleet/drivers'));
check('F2', 'create and status actions are gated by fleet:manage', ws.includes("can('fleet:manage')") && ws.includes('if (!canManage) return'));
check('F3', 'nav key fleet requires fleet:read or fleet:manage', /fleet:\s*\['fleet:read',\s*'fleet:manage'\]/.test(nav));
check('F4', 'sidebar has fleet item gated by canAccessNav', side.includes("canAccessNav('fleet'") && side.includes("onNavigate('fleet')"));
check('F5', 'App renders FleetWorkspace lazily for fleet nav', app.includes("import('./components/fleet/FleetWorkspace.js')") && app.includes('<FleetWorkspace'));
check('F6', 'expired driver license is flagged in the UI', ws.includes('منتهية') && ws.includes('licenseExpiry < today'));
check('F7', 'no delete action is offered (retire via status only)', !/method:\s*'DELETE'/.test(ws));

if (failed > 0) { console.log(`[FAIL] ${failed} check(s) failed`); process.exit(1); }
console.log('[PASS] verifyFleetUi1: 7/7');
