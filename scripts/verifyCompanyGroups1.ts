import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultCompanyGroupService as svc } from '../src/server/org/companyGroupService.js';

async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e: any) { return String(e?.message || e); }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !['localhost', '127.0.0.1', '::1'].includes(new URL(dbUrl).hostname)) {
    blocked('DATABASE_URL missing or not loopback. Company group test is BLOCKED.');
    process.exit(summary().exitCode);
  }
  const ex = await getDefaultExecutor();
  if (!ex) { blocked('no executor'); process.exit(summary().exitCode); }
  const sfx = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const users = new UserRepository();
  const mkU = async (n: string, role: any = 'user') => (await users.createUser({ username: `g_${n}_${sfx}`, passwordHash: 'dummy_hash', role })).id;
  const [adminId, gaId, gvId, outId, newId] = [await mkU('pa', 'platform_admin'), await mkU('ga'), await mkU('gv'), await mkU('out'), await mkU('new')];
  const PA = { id: adminId, role: 'platform_admin' }, GA = { id: gaId, role: 'user' }, GV = { id: gvId, role: 'user' }, OUT = { id: outId, role: 'user' };
  const mkC = async (c: string) => (await new CompanyRepository().create({ code: `${c}_${sfx}`, nameAr: `شركة ${c}`, createdBy: adminId })).id;
  const [c1, c2, c3] = [await mkC('A'), await mkC('B'), await mkC('C')];

  const g = await svc.create(PA, { code: `GRP_${sfx}`, nameAr: 'مجموعة اختبار' });
  await check('GR-1 platform admin creates a group', !!g.id && g.isActive);
  await check('GR-2 non platform admin cannot create', !!(await rejects(() => svc.create(GA, { code: `X_${sfx}`, nameAr: 'x' }))));
  await check('GR-3 duplicate code rejected (case-insensitive)', !!(await rejects(() => svc.create(PA, { code: `grp_${sfx}`, nameAr: 'مكرر' }))));
  await check('GR-4 empty Arabic name rejected', !!(await rejects(() => svc.create(PA, { code: `Y_${sfx}`, nameAr: ' ' }))));

  await svc.addCompany(PA, g.id, c1); await svc.addCompany(PA, g.id, c2);
  const g2 = await svc.create(PA, { code: `GRP2_${sfx}`, nameAr: 'مجموعة ثانية' });
  const dupG = await rejects(() => svc.addCompany(PA, g2.id, c1));
  await check('GR-5 a company cannot join two groups', !!dupG && dupG.includes('مجموعة أخرى'), dupG || '');
  const dupSame = await rejects(() => svc.addCompany(PA, g.id, c1));
  await check('GR-6 adding the same company twice is rejected', !!dupSame);
  await check('GR-7 unknown company rejected', !!(await rejects(() => svc.addCompany(PA, g.id, '00000000-0000-4000-8000-000000000000'))));
  await check('GR-8 invalid company id rejected', !!(await rejects(() => svc.addCompany(PA, g.id, 'abc'))));
  await check('GR-9 group admin cannot add companies', !!(await rejects(() => svc.addCompany(GA, g.id, c3))));

  await svc.setUser(PA, g.id, gaId, 'group_admin'); await svc.setUser(PA, g.id, gvId, 'group_viewer');
  const d = await svc.get(PA, g.id);
  await check('GR-10 detail lists 2 companies and 2 users', d.companies.length === 2 && d.users.length === 2, `${d.companies.length}/${d.users.length}`);
  await check('GR-11 group viewer can read the detail', (await svc.get(GV, g.id)).companies.length === 2);
  await check('GR-12 non member sees nothing (not found)', !!(await rejects(() => svc.get(OUT, g.id))));
  const lv = await svc.listForActor(GV); const lo = await svc.listForActor(OUT); const la = await svc.listForActor(PA);
  await check('GR-13 list is scoped: viewer 1, outsider 0, platform admin sees both groups', lv.length === 1 && lo.length === 0 && la.filter((x) => x.id === g.id || x.id === g2.id).length === 2, `${lv.length}/${lo.length}/${la.length}`);
  await check('GR-14 viewer cannot rename', !!(await rejects(() => svc.update(GV, g.id, { nameAr: 'تعديل' }))));
  await check('GR-15 viewer cannot add users', !!(await rejects(() => svc.setUserByUsername(GV, g.id, `g_new_${sfx}`, 'group_viewer'))));
  await svc.update(GA, g.id, { nameAr: 'مجموعة معدلة' });
  await check('GR-16 group admin renames the group', (await svc.get(PA, g.id)).nameAr === 'مجموعة معدلة');
  await check('GR-17 group admin cannot deactivate the group', !!(await rejects(() => svc.update(GA, g.id, { isActive: false }))));
  await svc.setUserByUsername(GA, g.id, `g_new_${sfx}`, 'group_viewer');
  await check('GR-18 group admin adds a user by username', (await svc.get(PA, g.id)).users.some((u) => u.userId === newId && u.role === 'group_viewer'));
  await check('GR-19 unknown username rejected', !!(await rejects(() => svc.setUserByUsername(GA, g.id, `nobody_${sfx}`, 'group_viewer'))));
  await check('GR-20 invalid role rejected', !!(await rejects(() => svc.setUser(GA, g.id, newId, 'boss' as any))));
  await check('GR-21 group admin cannot demote or remove themself', !!(await rejects(() => svc.setUser(GA, g.id, gaId, 'group_viewer'))) && !!(await rejects(() => svc.removeUser(GA, g.id, gaId))));
  await svc.removeUser(GA, g.id, newId);
  await check('GR-22 group admin removes a user', !(await svc.get(PA, g.id)).users.some((u) => u.userId === newId));
  await check('GR-23 admin of group 1 has no access to group 2', !!(await rejects(() => svc.get(GA, g2.id))));

  await svc.setUser(PA, g.id, gvId, 'group_viewer', false);
  await check('GR-24 inactive group user loses access', !!(await rejects(() => svc.get(GV, g.id))));
  await svc.removeCompany(PA, g.id, c2);
  await check('GR-25 company removed from the group', (await svc.get(PA, g.id)).companies.length === 1);
  await svc.addCompany(PA, g2.id, c2);
  await check('GR-26 removed company can join another group', (await svc.get(PA, g2.id)).companies.length === 1);
  await check('GR-27 removing a company not in the group is rejected', !!(await rejects(() => svc.removeCompany(PA, g.id, c3))));

  await ex.query('UPDATE companies SET is_active = false WHERE id = $1', [c3]);
  await check('GR-28 inactive company cannot join', !!(await rejects(() => svc.addCompany(PA, g.id, c3))));
  await svc.update(PA, g2.id, { isActive: false });
  await check('GR-29 platform admin deactivates a group; a viewer of it loses access', !!(await rejects(() => svc.addCompany(PA, g2.id, c1))));
  const au = await ex.query<any>(`SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'company_group.%' AND entity_id = $1`, [g.id]);
  await check('GR-30 audit rows written for group changes', au.rows[0].n >= 8, String(au.rows[0].n));

  const { exitCode } = summary();
  await closeAllExecutors().catch(() => {});
  process.exit(exitCode);
}
main().catch(async (e) => { console.error('FATAL', e); await closeAllExecutors().catch(() => {}); process.exit(1); });
