import fs from 'fs';
import path from 'path';
const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf8');
let failed = 0;
function check(name: string, ok: boolean) { console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`); if (!ok) failed++; }
const panel = read('src/components/companies/StandardsPanel.tsx');
const settings = read('src/components/companies/CompanySettingsPanel.tsx');
const routes = read('src/server/routes/standardsRoutes.ts');
const app = read('src/server/app.ts');
check('SU1 settings screen renders StandardsPanel for the selected company', settings.includes('<StandardsPanel') && settings.includes("import { StandardsPanel }"));
check('SU2 panel uses apiFetch and no raw fetch', panel.includes('apiFetch(') && !/[^i]fetch\(/.test(panel.replace(/apiFetch\(/g, '')));
check('SU3 panel calls profile, policies and frameworks APIs', ['/api/standards/profile', '/api/standards/policies', '/api/standards/frameworks'].every((x) => panel.includes(x)));
check('SU4 panel has test ids for the persona flow', ['std-fw', 'std-country', 'std-from', 'std-save-profile', 'std-history-row', 'std-policy-row', 'std-pol-save'].every((x) => panel.includes(x)));
check('SU5 profile write gated by canWrite, policy form by platform admin', panel.includes('canWrite &&') && panel.includes('isPlatformAdmin &&'));
check('SU6 routes mounted at /api/standards', app.includes("'/api/standards'") && routes.includes('standardsRoutes'));
check('SU7 profile routes check company permissions (read/write)', routes.includes('COMPANY_SETTINGS_READ') && routes.includes('COMPANY_SETTINGS_WRITE'));
check('SU8 policy creation restricted by service to platform admin', read('src/server/standards/standardsService.ts').includes("actor.role !== 'platform_admin'"));
check('SU9 legal in-force date shown separately with its label', panel.includes('std-legal-date') && panel.includes('ليس تاريخ تطبيق المعيار'));
process.exit(failed ? 1 : 0);
