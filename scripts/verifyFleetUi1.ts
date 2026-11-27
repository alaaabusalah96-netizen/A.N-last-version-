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
check('F8', 'status change asks for confirmation before calling the API', ws.includes('fleet-status-confirm') && ws.includes('setPending('));
check('F9', 'vehicle type is an Arabic select and brand/model/year are separate columns', ws.includes('VEHICLE_TYPE') && ws.includes('<th className="py-3.5 px-4">الماركة</th>'));
check('F10', 'add dialog has a close button and license warnings (expired, within 30 days)', ws.includes('aria-label="إغلاق"') && ws.includes('تنتهي خلال') && ws.includes('رخصة منتهية'));

const tp = read('src/components/fleet/FleetTripsPanel.tsx');
check('F11', 'trips tab uses only /api/fleet/trips endpoints and offers no delete', tp.includes('/api/fleet/trips') && !/method:\s*'DELETE'/.test(tp) && ws.includes('<FleetTripsPanel'));
check('F12', 'create/approve/dispatch actions are gated by fleet:trip:* permissions', tp.includes("can('fleet:trip:create')") && tp.includes("can('fleet:trip:approve')") && tp.includes("can('fleet:trip:dispatch')") && tp.includes('if (!canCreate) return'));
check('F13', 'a trip needs two stops in the form and reject/cancel need a reason', tp.includes('محطتين على الأقل') && tp.includes('السبب مطلوب'));
check('F14', 'every action asks for confirmation, start/complete need the odometer, dialog has close X', tp.includes('fleet-trip-confirm') && tp.includes('قراءة العداد') && tp.includes('aria-label="إغلاق"'));
check('F15', 'trip statuses are shown in Arabic', ['مسودة', 'معتمدة', 'مرفوضة', 'جارية', 'مكتملة', 'ملغاة'].every((w) => tp.includes(w)));

const ep = read('src/components/fleet/FleetExpensesPanel.tsx');
check('F16', 'expenses tab uses only /api/fleet/expenses and categories endpoints, offers no delete, and is wired into the workspace', ep.includes('/api/fleet/expenses') && ep.includes('/api/fleet/expense-categories') && !/method:\s*'DELETE'/.test(ep) && ws.includes('<FleetExpensesPanel'));
check('F17', 'create/approve/post actions are gated by fleet:expense:* permissions', ep.includes("can('fleet:expense:create')") && ep.includes("can('fleet:expense:approve')") && ep.includes("can('fleet:expense:post')") && ep.includes('if (!canCreate) return'));
check('F18', 'posting asks the user to choose the counter account (no hard-coded account), reject/reverse need a reason, confirmation dialog on every action', ep.includes('counterAccountId') && ep.includes('اختر الحساب المقابل') && ep.includes('السبب مطلوب') && ep.includes('fleet-expense-confirm'));
check('F19', 'expense statuses are shown in Arabic and dialogs have a close button', ['مسودة', 'معتمد', 'مرفوض', 'مرحّل', 'معكوس'].every((w) => ep.includes(w)) && ep.includes('aria-label="إغلاق"'));
if (failed > 0) { console.log(`[FAIL] ${failed} check(s) failed`); process.exit(1); }
console.log('[PASS] verifyFleetUi1: 19/19');
