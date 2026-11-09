import fs from 'fs';
import path from 'path';

console.log('--- Running AN-FIX-NO-MEMORY-FALLBACK-1 Verification ---');

const rootDir = process.cwd();

const repoFiles = [
  'src/server/auth/userRepository.ts',
  'src/server/auth/sessionRepository.ts',
  'src/server/org/companyRepository.ts',
  'src/server/org/membershipRepository.ts',
];

async function runTests() {
  let passed = 0;
  let failed = 0;

  for (const relPath of repoFiles) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      console.error(`[FAIL] Repository file missing: ${relPath}`);
      failed++;
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');

    // Check 1: Must not instantiate new Map
    const hasMap = /new Map/.test(content);
    // Check 2: Must not contain in-memory fallback comments or logic
    const hasMemFallbackComment = /in-memory fallback|memory fallback/i.test(content);
    const hasMemStoreProp = /memStore/i.test(content);

    if (hasMap || hasMemFallbackComment || hasMemStoreProp) {
      console.error(`[FAIL] Repository ${relPath} contains in-memory Map fallback!`);
      failed++;
    } else {
      console.log(`[PASS] ${relPath} is free of in-memory Map fallback`);
      passed++;
    }
  }

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
