import fs from 'fs';
import path from 'path';

interface Check {
  name: string;
  run: () => boolean;
}

const rootDir = process.cwd();

const checks: Check[] = [
  {
    name: 'Required small modular P04 files exist',
    run: () => {
      const required = [
        'src/server/org/companyTypes.ts',
        'src/server/org/companyStore.ts',
        'src/server/org/membershipStore.ts',
        'src/server/rbac/permissions.ts',
        'src/server/rbac/roles.ts',
        'src/server/rbac/rbacService.ts',
        'src/server/rbac/requirePermission.ts',
        'src/server/routes/companyRoutes.ts',
        'src/server/routes/index.ts',
        'src/components/CompaniesPanel.tsx',
      ];
      return required.every((f) => fs.existsSync(path.join(rootDir, f)));
    },
  },
  {
    name: 'permissions.ts and roles.ts define standard permission codes and role mappings',
    run: () => {
      const pPath = path.join(rootDir, 'src/server/rbac/permissions.ts');
      const rPath = path.join(rootDir, 'src/server/rbac/roles.ts');
      if (!fs.existsSync(pPath) || !fs.existsSync(rPath)) return false;
      const pContent = fs.readFileSync(pPath, 'utf8');
      const rContent = fs.readFileSync(rPath, 'utf8');
      return (
        pContent.includes('company:read') &&
        pContent.includes('company:write') &&
        rContent.includes('platform_admin') &&
        rContent.includes('company_admin') &&
        rContent.includes('company_user')
      );
    },
  },
  {
    name: 'requirePermission.ts provides middleware returning 403 when permission missing',
    run: () => {
      const p = path.join(rootDir, 'src/server/rbac/requirePermission.ts');
      if (!fs.existsSync(p)) return false;
      const content = fs.readFileSync(p, 'utf8');
      return content.includes('requirePermission') && content.includes('403');
    },
  },
  {
    name: 'companyRoutes.ts defines GET / and POST / routes with requireAuth and requirePermission',
    run: () => {
      const p = path.join(rootDir, 'src/server/routes/companyRoutes.ts');
      if (!fs.existsSync(p)) return false;
      const content = fs.readFileSync(p, 'utf8');
      return (
        content.includes("companyRoutes.get") &&
        content.includes("companyRoutes.post") &&
        content.includes("requireAuth") &&
        content.includes("requirePermission")
      );
    },
  },
  {
    name: 'routes/index.ts mounts companyRoutes under /companies',
    run: () => {
      const p = path.join(rootDir, 'src/server/routes/index.ts');
      if (!fs.existsSync(p)) return false;
      const content = fs.readFileSync(p, 'utf8');
      return content.includes("'/companies', companyRoutes");
    },
  },
  {
    name: 'server.ts remains slim (no inline auth/company logic and mounts modular routers)',
    run: () => {
      const p = path.join(rootDir, 'server.ts');
      if (!fs.existsSync(p)) return false;
      const content = fs.readFileSync(p, 'utf8');
      const lines = content.split('\n').length;
      return (
        content.includes("app.use('/api/companies', companyRoutes)") &&
        !content.includes('function login') &&
        lines < 130
      );
    },
  },
  {
    name: 'package.json does NOT contain any firebase dependencies',
    run: () => {
      const p = path.join(rootDir, 'package.json');
      if (!fs.existsSync(p)) return false;
      const content = fs.readFileSync(p, 'utf8').toLowerCase();
      return !content.includes('firebase');
    },
  },
];

console.log('--- Running P04 Org & RBAC Verification ---');

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
