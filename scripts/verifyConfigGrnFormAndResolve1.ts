import fs from 'fs';
import path from 'path';

async function run() {
  console.log('=== Verifying Config GRN Form and Resolve Preview (AN-FIX-CONFIG-GRN-FORM-AND-RESOLVE-1) ===');
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

  const panelPath = path.resolve('src/components/config/ConfigPlatformPanel.tsx');
  const reportsPath = path.resolve('src/components/accounting/ReportsPanel.tsx');
  const settingsPath = path.resolve('src/components/companies/CompanySettingsPanel.tsx');

  check('PanelExists', fs.existsSync(panelPath), 'ConfigPlatformPanel.tsx exists');
  check('ReportsExists', fs.existsSync(reportsPath), 'ReportsPanel.tsx exists');
  check('SettingsExists', fs.existsSync(settingsPath), 'CompanySettingsPanel.tsx exists');

  if (fs.existsSync(panelPath)) {
    const panelSrc = read('src/components/config/ConfigPlatformPanel.tsx');

    // S1: accounting.grn_mapping form branch
    check('S1', panelSrc.includes('accounting.grn_mapping'), 'ConfigPlatformPanel contains accounting.grn_mapping branch');

    // S2: /api/accounting/accounts referenced
    check('S2', panelSrc.includes('/api/accounting/accounts'), 'ConfigPlatformPanel references /api/accounting/accounts');

    // S3: inventory_account_id AND purchases_clearing_account_id
    check('S3', panelSrc.includes('inventory_account_id') && panelSrc.includes('purchases_clearing_account_id'),
      'ConfigPlatformPanel handles inventory_account_id and purchases_clearing_account_id');

    // S4: <select used in GRN mapping UI path
    check('S4', panelSrc.includes('<select'), 'ConfigPlatformPanel uses <select> for COA dropdowns');

    // S5: config/resolve endpoint called
    check('S5', panelSrc.includes('config/resolve'), 'ConfigPlatformPanel calls /config/resolve endpoint');

    // S6: company_published or platform_default handled/shown
    check('S6', panelSrc.includes('company_published') || panelSrc.includes('platform_default'),
      'ConfigPlatformPanel shows config resolve source (company_published / platform_default)');

    // S7: versionNo handled/shown in preview path
    check('S7', panelSrc.includes('versionNo'), 'ConfigPlatformPanel shows versionNo in resolve preview');

    // S8: JSON textarea/advanced path still present
    check('S8', panelSrc.includes('<textarea') || panelSrc.includes('details'),
      'ConfigPlatformPanel contains JSON editor/textarea in advanced section');

    // S9: form change path stringifies JSON
    check('S9', panelSrc.includes('JSON.stringify'), 'ConfigPlatformPanel synchronizes form to JSON string');

    // S12: publish/save handlers still present
    check('S12', panelSrc.includes('handlePublish') && panelSrc.includes('handleSaveDraft'),
      'ConfigPlatformPanel preserves handlePublish and handleSaveDraft handlers');
  } else {
    for (const key of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S12']) {
      check(key, false, 'ConfigPlatformPanel missing');
    }
  }

  // S10: ReportsPanel CSV path includes text/csv or application/csv or explicit BOM \uFEFF
  if (fs.existsSync(reportsPath)) {
    const reportsSrc = read('src/components/accounting/ReportsPanel.tsx');
    check('S10', reportsSrc.includes('text/csv') || reportsSrc.includes('application/csv') || reportsSrc.includes('\\uFEFF') || reportsSrc.includes('\uFEFF'),
      'ReportsPanel includes CSV export with charset/BOM support');
  } else {
    check('S10', false, 'ReportsPanel missing');
  }

  // S11: CompanySettingsPanel still contains حساب المخزون
  if (fs.existsSync(settingsPath)) {
    const settingsSrc = read(settingsPath);
    check('S11', settingsSrc.includes('حساب المخزون'), 'CompanySettingsPanel preserves inventory account dropdowns');
  } else {
    check('S11', false, 'CompanySettingsPanel missing');
  }

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
