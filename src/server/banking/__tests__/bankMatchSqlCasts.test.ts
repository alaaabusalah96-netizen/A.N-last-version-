import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression: untyped $n params inside CASE ... THEN $n made Postgres infer text for a uuid column
// ("column matched_by is of type uuid but expression is of type text") -> HTTP 500 on statement-line match.
describe('bank statement match SQL', () => {
  it('casts uuid params explicitly in setStatementLineMatch', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/server/banking/bankReconcileRepository.ts'), 'utf8');
    expect(src).toContain('THEN $5::uuid ELSE NULL END');
    expect(src).toContain('matched_journal_line_id = $4::uuid');
    expect(src).not.toMatch(/THEN \$5 ELSE NULL/);
  });
});
