import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(process.cwd(), 'src/components/accounting/JournalWorkspace.tsx'), 'utf8');

describe('journal screen for org-scoped users', () => {
  it('reads the org units from the `units` key the API returns', () => {
    expect(src).toContain('dataOrg.units || dataOrg.orgUnits');
  });
  it('loads accounts and org units before the entries list', () => {
    const iAcc = src.indexOf('/api/accounting/accounts?companyId=');
    const iOrg = src.indexOf('/api/accounting/journals/org-units?companyId=');
    const iJrn = src.indexOf('/api/accounting/journals?companyId=');
    expect(iAcc).toBeGreaterThan(-1);
    expect(iAcc).toBeLessThan(iJrn);
    expect(iOrg).toBeLessThan(iJrn);
  });
  it('gets the unit list from the journals endpoint (no org:units:read needed)', () => {
    expect(src).not.toContain('/api/companies/${companyId}/org-units');
  });
  it('picks a unit automatically for scoped users and hides the all-units option', () => {
    expect(src).toContain('setScopedUser(true)');
    expect(src).toContain('{!scopedUser && <option value=""');
  });
});
