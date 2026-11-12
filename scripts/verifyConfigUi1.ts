import fs from 'fs';
import path from 'path';

async function run() {
  console.log('=== Verifying Config Platform UI Wiring (WP-6) ===');
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

  // S1: AppSidebar.tsx contains 'config_platform'
  const sidebarSrc = read('src/components/shell/AppSidebar.tsx');
  check('S1', sidebarSrc.includes('config_platform'), 'AppSidebar.tsx contains config_platform nav key');

  // S2: AppSidebar.tsx contains SlidersHorizontal
  check('S2', sidebarSrc.includes('SlidersHorizontal'), 'AppSidebar.tsx uses SlidersHorizontal icon');

  // S3: App.tsx contains 'config_platform'
  const appSrc = read('src/App.tsx');
  check('S3', appSrc.includes('config_platform'), 'App.tsx contains config_platform nav key');

  // S4: App.tsx contains ConfigPlatformPanel
  check('S4', appSrc.includes('ConfigPlatformPanel'), 'App.tsx renders ConfigPlatformPanel');

  // S5: src/components/config/ConfigPlatformPanel.tsx exists
  const panelPath = path.resolve('src/components/config/ConfigPlatformPanel.tsx');
  check('S5', fs.existsSync(panelPath), 'src/components/config/ConfigPlatformPanel.tsx exists');

  // S6-S9: ConfigPlatformPanel.tsx content checks
  if (fs.existsSync(panelPath)) {
    const panelSrc = read('src/components/config/ConfigPlatformPanel.tsx');
    check('S6',
      panelSrc.includes('/config/draft') &&
      panelSrc.includes('/config/publish') &&
      panelSrc.includes('/config/rollback') &&
      panelSrc.includes('/config/versions'),
      'ConfigPlatformPanel.tsx contains API routes for draft, publish, rollback, and versions'
    );

    check('S7', panelSrc.includes('apiFetch'), 'ConfigPlatformPanel.tsx imports and uses apiFetch');

    check('S8', !panelSrc.includes('fetch(') || panelSrc.includes('apiFetch('),
      'ConfigPlatformPanel.tsx does not use raw fetch()');

    check('S9', panelSrc.includes('changeSummary'),
      'ConfigPlatformPanel.tsx enforces changeSummary requirement for publish');
  } else {
    check('S6', false, 'panel file missing');
    check('S7', false, 'panel file missing');
    check('S8', false, 'panel file missing');
    check('S9', false, 'panel file missing');
  }

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
