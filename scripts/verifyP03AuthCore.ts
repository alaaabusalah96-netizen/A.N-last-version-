import fs from 'fs';
import path from 'path';

interface Check {
  name: string;
  run: () => boolean;
}

const rootDir = process.cwd();

const checks: Check[] = [
  {
    name: 'Required small modular auth files exist',
    run: () => {
      const required = [
        'src/server/auth/passwordHash.ts',
        'src/server/auth/userStore.ts',
        'src/server/auth/sessionStore.ts',
        'src/server/auth/authService.ts',
        'src/server/auth/authMiddleware.ts',
        'src/server/routes/authRoutes.ts',
        'src/server/routes/index.ts',
        'src/components/LoginForm.tsx',
      ];
      return required.every((f) => fs.existsSync(path.join(rootDir, f)));
    },
  },
  {
    name: 'passwordHash.ts implements Argon2id hashing and verify',
    run: () => {
      const p = path.join(rootDir, 'src/server/auth/passwordHash.ts');
      if (!fs.existsSync(p)) return false;
      const content = fs.readFileSync(p, 'utf8');
      return content.includes('hashPassword') && content.includes('verifyPassword') && content.includes('argon2');
    },
  },
  {
    name: 'sessionStore.ts manages sessions with create, get, revoke, and TTL',
    run: () => {
      const p = path.join(rootDir, 'src/server/auth/sessionStore.ts');
      if (!fs.existsSync(p)) return false;
      const content = fs.readFileSync(p, 'utf8');
      return (
        content.includes('createSession') &&
        content.includes('getSession') &&
        content.includes('revokeSession') &&
        content.includes('SESSION_TTL_HOURS')
      );
    },
  },
  {
    name: 'authRoutes.ts defines /login, /logout, and /me routes',
    run: () => {
      const p = path.join(rootDir, 'src/server/routes/authRoutes.ts');
      if (!fs.existsSync(p)) return false;
      const content = fs.readFileSync(p, 'utf8');
      return content.includes("'/login'") && content.includes("'/logout'") && content.includes("'/me'");
    },
  },
  {
    name: 'server.ts is NOT bloated (mounts authRoutes, does not embed long login logic)',
    run: () => {
      const p = path.join(rootDir, 'server.ts');
      if (!fs.existsSync(p)) return false;
      const content = fs.readFileSync(p, 'utf8');
      const lines = content.split('\n').length;
      const hasAuthMount = content.includes("app.use('/api/auth', authRoutes)");
      const noInlineLogin = !content.includes('function login') && !content.includes('argon2.hash');
      return hasAuthMount && noInlineLogin && lines < 120;
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
  {
    name: 'package.json includes cookie-parser and argon2',
    run: () => {
      const p = path.join(rootDir, 'package.json');
      if (!fs.existsSync(p)) return false;
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Boolean(pkg.dependencies?.['cookie-parser'] && pkg.dependencies?.['argon2']);
    },
  },
];

console.log('--- Running P03 Auth Core Verification ---');

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
