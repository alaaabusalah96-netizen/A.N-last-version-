import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function check(id: string, condition: boolean, label: string) {
  if (condition) {
    console.log(`[PASS] ${id}: ${label}`);
    passed++;
  } else {
    console.error(`[FAIL] ${id}: ${label}`);
    failed++;
  }
}

function run() {
  console.log('=== VERIFY AN-UX-FOUNDATION-1 (Shared RTL, Tables & Empty/Error States) ===');
  const rootDir = process.cwd();

  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  check('U1', html.includes('lang="ar"') && html.includes('dir="rtl"'), 'index.html declares lang="ar" dir="rtl"');

  const css = fs.readFileSync(path.join(rootDir, 'src/index.css'), 'utf8');
  check(
    'U2',
    css.includes('direction: rtl') &&
      css.includes('tabular-nums') &&
      css.includes(':focus-visible') &&
      css.includes('prefers-reduced-motion'),
    'src/index.css enforces RTL, tabular-nums, focus-visible, and reduced-motion'
  );

  const uiFiles = [
    'src/components/ui/DataTableShell.tsx',
    'src/components/ui/EmptyState.tsx',
    'src/components/ui/ErrorBanner.tsx',
    'src/components/ui/LoadingState.tsx',
    'src/components/ui/index.ts',
  ];
  for (let i = 0; i < uiFiles.length; i++) {
    const rel = uiFiles[i];
    check(`U${3 + i}`, fs.existsSync(path.join(rootDir, rel)), `Shared UI component exists: ${rel}`);
  }

  const shellSrc = fs.readFileSync(path.join(rootDir, 'src/components/ui/DataTableShell.tsx'), 'utf8');
  check(
    'U8',
    shellSrc.includes('dir="rtl"') &&
      shellSrc.includes('overflow-x-auto') &&
      shellSrc.includes('tabular-nums') &&
      shellSrc.includes('EmptyState') &&
      shellSrc.includes('LoadingState'),
    'DataTableShell enforces RTL, horizontal scroll wrapper, tabular numerals, and loading/empty slots'
  );

  const companiesSrc = fs.readFileSync(path.join(rootDir, 'src/components/CompaniesPanel.tsx'), 'utf8');
  check(
    'U9',
    companiesSrc.includes('EmptyState') && companiesSrc.includes('ErrorBanner') && companiesSrc.includes('LoadingState'),
    'CompaniesPanel adopts shared EmptyState, ErrorBanner, and LoadingState'
  );

  const tbSrc = fs.readFileSync(path.join(rootDir, 'src/components/accounting/TrialBalancePanel.tsx'), 'utf8');
  check(
    'U10',
    tbSrc.includes('DataTableShell') && tbSrc.includes('ErrorBanner'),
    'TrialBalancePanel adopts shared DataTableShell and ErrorBanner'
  );

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run();
