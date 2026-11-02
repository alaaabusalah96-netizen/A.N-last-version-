import fs from 'fs';
import path from 'path';

interface Check {
  name: string;
  run: () => boolean;
}

const rootDir = process.cwd();

const checks: Check[] = [
  {
    name: 'All core files exist under src/server/db/',
    run: () => {
      const required = [
        'src/server/db/types.ts',
        'src/server/db/DatabaseEngine.ts',
        'src/server/db/ConnectionRegistry.ts',
        'src/server/db/TenantDatabaseResolver.ts',
        'src/server/db/adapters/PostgresqlAdapter.ts',
        'src/server/db/index.ts',
      ];
      return required.every((f) => fs.existsSync(path.join(rootDir, f)));
    },
  },
  {
    name: 'PostgresqlAdapter contains postgresql identifier, query and health methods',
    run: () => {
      const filePath = path.join(rootDir, 'src/server/db/adapters/PostgresqlAdapter.ts');
      if (!fs.existsSync(filePath)) return false;
      const content = fs.readFileSync(filePath, 'utf8');
      return (
        content.includes("'postgresql'") &&
        content.includes('query') &&
        content.includes('health') &&
        content.includes('withTransaction')
      );
    },
  },
  {
    name: 'ConnectionRegistry and TenantDatabaseResolver classes exist and are defined',
    run: () => {
      const crPath = path.join(rootDir, 'src/server/db/ConnectionRegistry.ts');
      const trPath = path.join(rootDir, 'src/server/db/TenantDatabaseResolver.ts');
      if (!fs.existsSync(crPath) || !fs.existsSync(trPath)) return false;
      const crContent = fs.readFileSync(crPath, 'utf8');
      const trContent = fs.readFileSync(trPath, 'utf8');
      return (
        crContent.includes('class ConnectionRegistry') &&
        trContent.includes('class TenantDatabaseResolver')
      );
    },
  },
  {
    name: 'server.ts imports db layer and references getDefaultExecutor or ready logic',
    run: () => {
      const serverPath = path.join(rootDir, 'server.ts');
      if (!fs.existsSync(serverPath)) return false;
      const content = fs.readFileSync(serverPath, 'utf8');
      return content.includes('getDefaultExecutor') && content.includes('/api/ready');
    },
  },
  {
    name: 'package.json contains "pg" dependency',
    run: () => {
      const pkgPath = path.join(rootDir, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return Boolean(pkg.dependencies && pkg.dependencies.pg);
    },
  },
  {
    name: 'package.json does NOT contain any firebase reference',
    run: () => {
      const pkgPath = path.join(rootDir, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;
      const content = fs.readFileSync(pkgPath, 'utf8').toLowerCase();
      return !content.includes('firebase');
    },
  },
  {
    name: 'docs/foundation/DATABASE_STRATEGY.md exists intact',
    run: () => fs.existsSync(path.join(rootDir, 'docs/foundation/DATABASE_STRATEGY.md')),
  },
];

console.log('--- Running P02a Database Foundation Verification ---');

let passed = 0;
let failed = 0;

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
