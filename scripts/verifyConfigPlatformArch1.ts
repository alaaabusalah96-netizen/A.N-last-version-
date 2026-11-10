import fs from 'fs';
import path from 'path';

async function runVerification() {
  console.log('=== RUNNING CONFIGURATION PLATFORM ARCHITECTURE VERIFICATION (A0) ===');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const root = process.cwd();
  const docDir = path.join(root, 'docs/foundation/configuration-platform');

  const requiredFiles = [
    'README.md',
    '01-CURRENT-STATE-MAP.md',
    '02-TARGET-ARCHITECTURE.md',
    '03-DATA-MODEL-DRAFT.md',
    '04-PACKAGE-ROADMAP.md',
    '05-ACCEPTANCE-AND-RISKS.md'
  ];

  assert(fs.existsSync(docDir), 'Documentation directory exists');

  for (const file of requiredFiles) {
    const filePath = path.join(docDir, file);
    const exists = fs.existsSync(filePath);
    assert(exists, `${file} exists`);

    if (exists) {
      const content = fs.readFileSync(filePath, 'utf8');
      assert(content.length > 100, `${file} is not empty`);
      
      // Basic check for some keywords to ensure real content
      if (file === '01-CURRENT-STATE-MAP.md') {
        assert(content.includes('REUSE') || content.includes('EXTEND'), '01-CURRENT-STATE-MAP.md contains mapping strategy');
      }
      if (file === '04-PACKAGE-ROADMAP.md') {
        assert(content.includes('Wave A') && content.includes('Wave B') && content.includes('Wave C'), '04-PACKAGE-ROADMAP.md contains wave structure');
      }
    }
  }

  // Check project state entry
  const statePath = path.join(root, 'docs/foundation/AI_PROJECT_STATE.md');
  if (fs.existsSync(statePath)) {
    const stateContent = fs.readFileSync(statePath, 'utf8');
    assert(stateContent.includes('AN-CONFIGURATION-PLATFORM-ARCHITECTURE-1'), 'AI_PROJECT_STATE.md records the architecture package');
  }

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
