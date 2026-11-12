import fs from 'fs';
import path from 'path';
import assert from 'assert';

/**
 * AN-WAVE-A-COMPLETION-1 — Wave A proof harness.
 *
 * S*  : static source checks (A1 stabilization surface, A2 registry, A3 lifecycle,
 *       A4 validation engine) — always runnable.
 * T1-T6: live PostgreSQL checks (migration 027 RLS isolation, immutability trigger,
 *       publish flow). Exit code 2 (BLOCKED) when DATABASE_URL is absent, so the
 *       battery policy treats missing DB as BLOCKED, not FAIL.
 */
async function verify() {
  console.log('=== Verifying Wave A Completion (AN-WAVE-A-COMPLETION-1) ===');
  let passed = 0;
  let failed = 0;

  function check(name: string, condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${name}: ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name}: ${message}`);
      failed++;
    }
  }

  const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf8');

  // ---- A1: GRN-GL ordering + /me permissions (already closed in 00c8489, re-asserted here)
  const grnService = read('src/server/purchasing/grnService.ts');
  check('S1', grnService.indexOf('requireGlAccounts') < grnService.indexOf('incrementBalance'),
    'A1: GL account validation precedes stock writes in postGrn');
  check('S2', grnService.includes('resolveEntryDate') && grnService.includes('grn.createdAt'),
    'A1: entry date resolves from GRN createdAt, not wall clock');
  const authRoutes = read('src/server/routes/authRoutes.ts');
  check('S3', authRoutes.includes('resolveEffectiveAccess') && authRoutes.includes('permissions'),
    'A1: GET /api/auth/me returns resolved permissions');

  // ---- A2: Configuration Registry
  const migration = read('database/migrations/027_config_platform_registry.sql');
  check('S4', migration.includes('CREATE TABLE IF NOT EXISTS config_definitions')
    && migration.includes('CREATE TABLE IF NOT EXISTS config_registry')
    && migration.includes('CREATE TABLE IF NOT EXISTS config_drafts'),
    'A2: migration 027 creates all three registry tables');
  check('S5', (migration.match(/FORCE ROW LEVEL SECURITY/g) || []).length === 3,
    'A2: RLS ENABLE+FORCE on config_definitions, config_registry, config_drafts');
  check('S6', migration.includes('config_registry_tenant_isolation')
    && migration.includes("current_setting('app.current_tenant_id', true)"),
    'A2: tenant isolation policy keyed on app.current_tenant_id');
  check('S7', migration.includes('UNIQUE (company_id, config_definition_id, version_no)'),
    'A2: registry uniqueness on (company, definition, version)');
  check('S8', migration.includes('REVOKE ALL ON config_registry FROM PUBLIC, anon, authenticated'),
    'A2: least-privilege revokes from anon/authenticated/PUBLIC');

  const appTs = read('src/server/app.ts');
  const companyRoutes = read('src/server/routes/companyRoutes.ts');
  check('S9', appTs.includes("app.use('/api/config', configPlatformRoutes)")
    && companyRoutes.includes('companyConfigRoutes'),
    'A2: config routes mounted globally and per-company');

  // ---- A3: Draft → Publish → Rollback lifecycle
  const configService = read('src/server/config-platform/configService.ts');
  check('S10', configService.includes('publishDraft') && configService.includes('rollback'),
    'A3: publish and rollback services implemented');
  check('S11', configService.includes('changeSummary') && configService.includes('إلزامي'),
    'A3: change summary mandatory (audit discipline)');
  check('S12', configService.includes('nextVersionNo') && configService.includes('rollback to v'),
    'A3: rollback publishes a NEW version (never un-publish)');

  const repoSrc = read('src/server/config-platform/configRepository.ts');
  check('S13', repoSrc.includes('UPDATE config_registry SET is_active = false')
    && repoSrc.includes('INSERT INTO config_registry'),
    'A3: publish = deactivate previous + insert new immutable version');

  // ---- A4: Validation engine
  const validation = read('src/server/config-platform/configValidationService.ts');
  check('S14', !validation.includes('eval(') && !validation.includes('new Function'),
    'A4: no dynamic code execution (metadata-driven validation only)');
  check('S15', validation.includes('validateAgainstSchema') && validation.includes('validateReferences'),
    'A4: structural + referential validation gates present');
  check('S16', configService.includes('accountCheckerFactory'),
    'A4: referential checker resolved per-transaction against accounts master data');

  // ---- Tests registered
  const hasTests = fs.existsSync('src/server/config-platform/__tests__/configService.test.ts')
    && fs.existsSync('src/server/config-platform/__tests__/configWiring.test.ts');
  check('S17', hasTests, 'A3/A4: unit test suites present for lifecycle and validation');

  // ---- Live PostgreSQL proofs (T1-T6)
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !databaseUrl.trim()) {
    console.log('[BLOCKED] DATABASE_URL not set — live RLS/immutability proofs skipped (exit 2)');
    console.log(`\n=== SUMMARY ===\nPassed: ${passed} | Failed: ${failed}`);
    process.exit(failed > 0 ? 1 : 2);
  }

  const { buildPgConfig } = await import('../src/server/db/connection.js');
  const pg = (await import('pg')).default;
  const client = new pg.Client(buildPgConfig(databaseUrl));
  await client.connect();

  try {
    // Ensure two isolated tenants for the live attack
    await client.query(`INSERT INTO companies (id, code, name_ar) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001','WA','شركة Wave A'),
      ('bbbbbbbb-0000-0000-0000-000000000002','WB','شركة Wave B')
      ON CONFLICT (id) DO NOTHING;`);

    const invalidDefKey = `wave.a.proof.${Date.now()}`;
    let invalidKeyRejected = false;
    try {
      await client.query(
        `INSERT INTO config_definitions (key, schema, default_value) VALUES ($1, '{"type":"object"}'::jsonb, '{}'::jsonb) RETURNING id;`,
        [invalidDefKey]
      );
    } catch (e: any) {
      invalidKeyRejected = /chk_config_def_key_format|check constraint/i.test(String(e?.message || ''));
    }
    check(
      'T8',
      invalidKeyRejected,
      'live: invalid config_definitions key (digit-leading segment) is rejected by chk_config_def_key_format'
    );

    const defKey = `wave.a.proof.ts${Date.now()}`;
    const def = await client.query(
      `INSERT INTO config_definitions (key, schema, default_value) VALUES ($1, '{"type":"object"}'::jsonb, '{}'::jsonb) RETURNING id;`,
      [defKey]
    );
    const definitionId = def.rows[0].id;

    const setTenant = (cid: string) =>
      client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [cid]);

    // T1: publish v1 as company A
    await setTenant('aaaaaaaa-0000-0000-0000-000000000001');
    await client.query(
      `INSERT INTO config_registry (company_id, config_definition_id, version_no, is_active, content, change_summary)
       VALUES ('aaaaaaaa-0000-0000-0000-000000000001', $1, 1, true, '{"x":1}'::jsonb, 'A v1');`,
      [definitionId]
    );
    check('T1', true, 'live: company A published version 1');

    // T2: company B reads A → 0 rows (RLS USING hides foreign rows)
    await setTenant('bbbbbbbb-0000-0000-0000-000000000002');
    const r2 = await client.query(`SELECT count(*)::int AS c FROM config_registry`);
    check('T2', r2.rows[0].c === 0, 'live: company B sees zero registry rows of company A (RLS)');

    // T3: company B writes into A → RLS WITH CHECK violation
    let t3 = false;
    try {
      await client.query(
        `INSERT INTO config_registry (company_id, config_definition_id, version_no, is_active, content, change_summary)
         VALUES ('aaaaaaaa-0000-0000-0000-000000000001', $1, 99, true, '{}'::jsonb, 'cross-tenant write');`,
        [definitionId]
      );
    } catch (e: any) {
      t3 = /row-level security|violates row-level/i.test(String(e?.message || ''));
    }
    check('T3', t3, 'live: cross-tenant registry write rejected (RLS WITH CHECK)');

    // T4: content UPDATE → immutability trigger
    await setTenant('aaaaaaaa-0000-0000-0000-000000000001');
    let t4 = false;
    try {
      await client.query(
        `UPDATE config_registry SET content = '{"hacked":true}'::jsonb WHERE config_definition_id = $1 AND version_no = 1;`,
        [definitionId]
      );
    } catch (e: any) {
      t4 = String(e?.message || '').includes('CONFIG_REGISTRY_IMMUTABLE');
    }
    check('T4', t4, 'live: published content is immutable (trigger CONFIG_REGISTRY_IMMUTABLE)');

    // T5: DELETE → immutability trigger
    let t5 = false;
    try {
      await client.query(
        `DELETE FROM config_registry WHERE config_definition_id = $1 AND version_no = 1;`,
        [definitionId]
      );
    } catch (e: any) {
      t5 = String(e?.message || '').includes('CONFIG_REGISTRY_IMMUTABLE');
    }
    check('T5', t5, 'live: published versions cannot be deleted (audit preserved)');

    // T6: legal control — deactivate v1 then publish v2 (single-active pointer flips)
    await client.query(
      `UPDATE config_registry SET is_active = false WHERE config_definition_id = $1 AND version_no = 1;`,
      [definitionId]
    );
    await client.query(
      `INSERT INTO config_registry (company_id, config_definition_id, version_no, is_active, content, change_summary)
       VALUES ('aaaaaaaa-0000-0000-0000-000000000001', $1, 2, true, '{"x":2}'::jsonb, 'A v2');`,
      [definitionId]
    );
    const r6 = await client.query(
      `SELECT version_no FROM config_registry WHERE config_definition_id = $1 AND is_active = true;`,
      [definitionId]
    );
    check('T6', r6.rows.length === 1 && Number(r6.rows[0].version_no) === 2,
      'live: publish v2 flipped the single-active pointer correctly');

    // Cleanup proof data. published registry rows are immutable by design
    // (CONFIG_REGISTRY_IMMUTABLE blocks DELETE), so teardown deactivates the
    // proof rows. Cleanup failure is a FAIL, not a warning: leaving proof
    // data behind pollutes later runs and hides real defects.
    try {
      await client.query(
        `UPDATE config_registry SET is_active = false WHERE config_definition_id = $1;`,
        [definitionId]
      );
      check('T7', true, 'live: proof rows deactivated (cleanup)');
    } catch (e: any) {
      check('T7', false, `cleanup FAILED: could not deactivate proof rows (${String(e?.message || e)})`);
    }
  } finally {
    await client.end();
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
  console.log('=== All Wave A Completion Verifications Passed ===');
}

verify().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
