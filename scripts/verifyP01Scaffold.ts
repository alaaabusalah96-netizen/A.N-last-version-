import fs from 'fs';
import path from 'path';

interface Check {
  name: string;
  run: () => boolean;
}

const rootDir = process.cwd();

const checks: Check[] = [
  {
    name: 'Existence of server.ts',
    run: () => fs.existsSync(path.join(rootDir, 'server.ts')),
  },
  {
    name: 'Package name is "an-erp-platform" in package.json',
    run: () => {
      const pkgPath = path.join(rootDir, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.name === 'an-erp-platform';
    },
  },
  {
    name: 'No firebase in package.json dependencies or devDependencies',
    run: () => {
      const pkgPath = path.join(rootDir, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;
      const content = fs.readFileSync(pkgPath, 'utf8').toLowerCase();
      return !content.includes('firebase');
    },
  },
  {
    name: 'GET /api/health endpoint present in server.ts',
    run: () => {
      const serverPath = path.join(rootDir, 'server.ts');
      if (!fs.existsSync(serverPath)) return false;
      const content = fs.readFileSync(serverPath, 'utf8');
      return content.includes('/api/health');
    },
  },
  {
    name: 'Existence of docs/foundation/P01_RESULTS.md',
    run: () => fs.existsSync(path.join(rootDir, 'docs/foundation/P01_RESULTS.md')),
  },
];

let passed = 0;
let failed = 0;

console.log('--- Running P01 Platform Scaffold Verification ---');

for (const check of checks) {
  const result = check.run();
  if (result) {
    console.log(`[PASS] ${check.name}`);
    passed++;
  } else {
    console.error(`[FAIL] ${check.name}`);
    failed++;
  }
}

console.log(`Passed: ${passed} | Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
