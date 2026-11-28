import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultStandardsService as svc } from '../src/server/standards/standardsService.js';

async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e: any) { return String(e?.message || e); }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !['localhost', '127.0.0.1', '::1'].includes(new URL(dbUrl).hostname)) { blocked('DATABASE_URL missing or not loopback'); process.exit(summary().exitCode); }
  const ex = await getDefaultExecutor();
  if (!ex) { blocked('no executor'); process.exit(summary().exitCode); }
  const sfx = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const users = new UserRepository();
  const mkU = async (n: string, role: any = 'user') => (await users.createUser({ username: `t_${n}_${sfx}`, passwordHash: 'dummy_hash', role })).id;
  const adminId = await mkU('pa', 'platform_admin'); const plainId = await mkU('u');
  const PA = { id: adminId, role: 'platform_admin' }; const USER = { id: plainId, role: 'user' };
  const mk = async (t: string) => (await new CompanyRepository().create({ code: `${t}_${sfx}`, nameAr: `شركة ${t}`, createdBy: adminId })).id;
  const c1 = await mk('S1'); const c2 = await mk('S2');
  const key = `inventory.costing_${sfx.replace(/\D/g, '')}`.slice(0, 60);

  const fws = await svc.listFrameworks();
  check('frameworks seeded IFRS, IFRS_SME, EAS', ['IFRS', 'IFRS_SME', 'EAS'].every((c) => fws.some((f) => f.code === c)));

  check('no profile before any is set', (await svc.getProfileOn(c1, '2026-06-01')) === null);
  check('resolve without profile => NO_PROFILE', (await svc.resolvePolicy(c1, key, '2026-06-01')).status === 'NO_PROFILE');
  check('profile rejects bad country', !!(await rejects(() => svc.setProfile(c1, { frameworkCode: 'EAS', countryCode: 'E', validFrom: '2026-01-01' }, adminId))));
  check('profile rejects EAS with non-EG country', !!(await rejects(() => svc.setProfile(c1, { frameworkCode: 'EAS', countryCode: 'SA', validFrom: '2026-01-01' }, adminId))));
  check('profile rejects unknown framework', !!(await rejects(() => svc.setProfile(c1, { frameworkCode: 'NOPE', countryCode: 'EG', validFrom: '2026-01-01' }, adminId))));
  check('profile rejects bad date', !!(await rejects(() => svc.setProfile(c1, { frameworkCode: 'EAS', countryCode: 'EG', validFrom: '2026-02-30' }, adminId))));
  await svc.setProfile(c1, { frameworkCode: 'EAS', countryCode: 'EG', validFrom: '2026-01-01' }, adminId);
  await svc.setProfile(c1, { frameworkCode: 'IFRS', countryCode: 'EG', validFrom: '2027-01-01', note: 'تحول للمعايير الدولية' }, adminId);
  check('profile on 2026-06-01 is EAS', (await svc.getProfileOn(c1, '2026-06-01'))?.frameworkCode === 'EAS');
  check('profile on 2027-03-01 is IFRS', (await svc.getProfileOn(c1, '2027-03-01'))?.frameworkCode === 'IFRS');
  check('profile before first valid_from is null', (await svc.getProfileOn(c1, '2025-12-31')) === null);
  check('duplicate valid_from rejected', !!(await rejects(() => svc.setProfile(c1, { frameworkCode: 'IFRS', countryCode: 'EG', validFrom: '2027-01-01' }, adminId))));
  check('history has 2 rows newest first', (await svc.listProfileHistory(c1)).map((p) => p.validFrom).join() === '2027-01-01,2026-01-01');
  check('other company sees none (RLS)', (await svc.listProfileHistory(c2)).length === 0);

  // policies
  check('non platform admin cannot create policy', !!(await rejects(() => svc.createPolicyVersion(USER, { policyKey: key, frameworkCode: 'EAS', standardRef: 'IAS 2', validFrom: '2026-01-01' }))));
  check('bad key rejected', !!(await rejects(() => svc.createPolicyVersion(PA, { policyKey: 'Bad Key', frameworkCode: 'EAS', standardRef: 'IAS 2', validFrom: '2026-01-01' }))));
  check('ACTIVE without verified source rejected', !!(await rejects(() => svc.createPolicyVersion(PA, { policyKey: key, frameworkCode: 'EAS', standardRef: 'IAS 2', validFrom: '2026-01-01', status: 'ACTIVE' }))));
  const d1 = await svc.createPolicyVersion(PA, { policyKey: key, frameworkCode: 'EAS', countryCode: 'EG', standardRef: 'IAS 2', validFrom: '2026-01-01', value: { methods: ['FIFO', 'AVG'] } });
  check('draft created as v1 DRAFT', d1.version === 1 && d1.status === 'DRAFT');
  const r0 = await svc.resolvePolicy(c1, key, '2026-06-01');
  check('draft never resolves (NONE, draftExists)', r0.status === 'NONE' && (r0 as any).draftExists === true);
  const a2 = await svc.createPolicyVersion(PA, { policyKey: key, frameworkCode: 'EAS', countryCode: 'EG', standardRef: 'IAS 2', validFrom: '2026-03-01', value: { methods: ['FIFO'] }, status: 'ACTIVE', sourceReference: 'test-source-ref', sourceVerified: true });
  check('v2 ACTIVE', a2.version === 2 && a2.status === 'ACTIVE');
  check('date before v2 does not resolve (draft v1 ignored)', (await svc.resolvePolicy(c1, key, '2026-02-01')).status === 'NONE');
  const r1: any = await svc.resolvePolicy(c1, key, '2026-06-01');
  check('resolves v2 on 2026-06-01 with EAS/EG', r1.status === 'RESOLVED' && r1.policy.version === 2 && r1.frameworkCode === 'EAS' && r1.countryCode === 'EG');
  check('same-date reject: v3 must start after v2', !!(await rejects(() => svc.createPolicyVersion(PA, { policyKey: key, frameworkCode: 'EAS', countryCode: 'EG', standardRef: 'IAS 2', validFrom: '2026-03-01' }))));
  const a3 = await svc.createPolicyVersion(PA, { policyKey: key, frameworkCode: 'EAS', countryCode: 'EG', standardRef: 'IAS 2', validFrom: '2026-09-01', value: { methods: ['AVG'] }, status: 'ACTIVE', sourceReference: 'test-source-ref-2', sourceVerified: true });
  const all = await svc.listPolicies({ policyKey: key, frameworkCode: 'EAS' });
  const v2 = all.find((p) => p.version === 2)!;
  check('v2 closed the day before v3', v2.validTo === '2026-08-31' && v2.status === 'SUPERSEDED' && a3.version === 3);
  check('on 2026-08-31 resolves v2', ((await svc.resolvePolicy(c1, key, '2026-08-31')) as any).policy?.version === 2);
  check('on 2026-09-01 resolves v3', ((await svc.resolvePolicy(c1, key, '2026-09-01')) as any).policy?.version === 3);
  check('2027 company is IFRS: no IFRS policy => NONE', (await svc.resolvePolicy(c1, key, '2027-03-01')).status === 'NONE');
  // framework-wide IFRS policy applies to country EG company
  await svc.createPolicyVersion(PA, { policyKey: key, frameworkCode: 'IFRS', standardRef: 'IAS 2', validFrom: '2026-01-01', value: { methods: ['FIFO'] }, status: 'ACTIVE', sourceReference: 'ifrs-ref', sourceVerified: true });
  check('2027 resolves framework-wide IFRS policy', ((await svc.resolvePolicy(c1, key, '2027-03-01')) as any).policy?.frameworkCode === 'IFRS');
  check('other company without profile => NO_PROFILE', (await svc.resolvePolicy(c2, key, '2027-03-01')).status === 'NO_PROFILE');

  // DB-level append-only guard
  const delErr = await rejects(() => ex.query(`DELETE FROM accounting_policies WHERE id = $1`, [d1.id]));
  check('DB blocks delete of a policy (no grant or trigger)', !!delErr);
  const updErr = await rejects(() => ex.query(`UPDATE accounting_policies SET value = '{}'::jsonb WHERE id = $1`, [a2.id]));
  check('DB blocks editing a policy value', !!updErr && /append-only/.test(updErr));
  const actErr = await rejects(() => ex.query(`UPDATE accounting_policies SET status = 'ACTIVE' WHERE id = $1`, [d1.id]));
  check('DB blocks ACTIVE without verified source', !!actErr);
  const dk = `T ${sfx.replace(/\D/g, '')}`;
  const rowsD: any[] = [
    { id: dk + ' A', framework: 'IFRS', jurisdiction: 'INTL', title: 'verified', effective_from: '2026-01-01', source_url: 'https://example.org/official', verification_status: 'OPENED' },
    { id: dk + ' B', framework: 'IFRS', jurisdiction: 'INTL', title: 'excerpt only', effective_from: '2026-01-01', source_url: 'https://example.org/x', verification_status: 'OFFICIAL_URL_EXCERPT_ONLY' },
    { id: dk + ' C', framework: 'EAS', jurisdiction: 'EG', title: 'opened but conditional date', effective_from: '2023-01-01 for fair value option (periods beginning on/after)', source_url: 'https://example.org/y', verification_status: 'OPENED' },
    { id: dk + ' D', framework: 'TAX', jurisdiction: 'EG', title: 'no date no url', effective_from: '', source_url: '', verification_status: 'NOT_VERIFIED' },
    { id: '', framework: 'IFRS', jurisdiction: 'INTL' },
  ];
  const ld = await svc.loadDataset(PA, rowsD);
  check('dataset: 1 active (OPENED + exact date + URL), 3 draft, 1 rejected', ld.active === 1 && ld.draft === 3 && ld.rejected.length === 1 && ld.rejected[0].index === 4, JSON.stringify(ld));
  const ld2 = await svc.loadDataset(PA, rowsD);
  check('dataset: reload is additive, identical rows unchanged', ld2.unchanged === 4 && ld2.active === 0 && ld2.draft === 0, JSON.stringify(ld2));
  const slugA = `standard.${(dk + ' A').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
  const pa = await svc.listPolicies({ policyKey: slugA });
  check('dataset: ACTIVE row keeps URL, verified flag and status in value', pa.length === 1 && pa[0].status === 'ACTIVE' && pa[0].sourceVerified && (pa[0].value as any).verificationStatus === 'OPENED');
  const lg = await svc.loadDataset(PA, [{ id: dk + ' L', framework: 'EAS', jurisdiction: 'EG', title: 'legal date only', effective_from: '', source_url: 'https://example.org/z', verification_status: 'OPENED', legal_in_force_date: '2023-03-07', legal_in_force_source: 'Decree 883/2023' } as any]);
  const slugL = `standard.${(dk + ' L').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
  const pl = (await svc.listPolicies({ policyKey: slugL }))[0];
  check('dataset: legal in-force date kept separate; standard stays DRAFT with no valid_from', lg.draft === 1 && pl.status === 'DRAFT' && pl.validFrom === null && (pl.value as any).legalInForceDate === '2023-03-07' && (pl.value as any).legalInForceSource === 'Decree 883/2023');
  const slugC = `standard.${(dk + ' C').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
  const pc = (await svc.listPolicies({ policyKey: slugC }))[0];
  check('dataset: OPENED with a conditional date stays DRAFT with no valid_from', pc.status === 'DRAFT' && pc.validFrom === null && pc.sourceVerified === false);
  const slugD = `standard.${(dk + ' D').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
  check('dataset: TAX framework row stored as DRAFT', (await svc.listPolicies({ policyKey: slugD }))[0]?.frameworkCode === 'TAX');
  const rowsD2 = [{ ...rowsD[1], effective_from: '2026-06-01', verification_status: 'OPENED' }];
  const ld3 = await svc.loadDataset(PA, rowsD2);
  check('dataset: updated row loads as new version and goes ACTIVE', ld3.active === 1);
  const pb = await svc.listPolicies({ policyKey: `standard.${(dk + ' B').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}` });
  check('dataset: old draft kept (v1) and new v2 active', pb.length === 2 && pb[0].version === 2 && pb[0].status === 'ACTIVE' && pb[1].status === 'DRAFT');
  const corr = await svc.loadDataset(PA, [{ ...rowsD[0], title: 'verified corrected title' }]);
  check('dataset: same-date verified correction becomes new version, old superseded', corr.active === 1 && corr.rejected.length === 0, JSON.stringify(corr));
  const pa2 = await svc.listPolicies({ policyKey: slugA });
  check('dataset: correction chain v2 ACTIVE, v1 SUPERSEDED, resolves to v2 data', pa2.length === 2 && pa2[0].version === 2 && pa2[0].status === 'ACTIVE' && pa2[1].status === 'SUPERSEDED' && (pa2[0].value as any).title === 'verified corrected title');
  const down = await svc.loadDataset(PA, [{ ...rowsD[0], title: 'x', verification_status: 'OFFICIAL_URL_EXCERPT_ONLY' }]);
  check('dataset: an unverified reload never downgrades or replaces an ACTIVE row', down.rejected.length === 1 && (await svc.listPolicies({ policyKey: slugA }))[0].status === 'ACTIVE');
  check('dataset: non platform admin refused', !!(await rejects(() => svc.loadDataset(USER, []))));
  process.exit(summary().exitCode);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => closeAllExecutors());
