import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('company admin UI wiring (static)', () => {
  it('users screen sends companyId and waits for the company list', () => {
    const s = read('src/components/users/UsersAdminWorkspace.tsx');
    expect(s).toMatch(/\/api\/users\?companyId=\$\{encodeURIComponent\(companyId\)\}/);
    expect(s).toMatch(/if \(!companiesLoaded\) return;/);
  });
  it('platform admin option is offered only to platform admins', () => {
    const s = read('src/components/users/UsersAdminWorkspace.tsx');
    expect(s).toMatch(/userRole === 'platform_admin' && <option value="legacy:platform_admin"/);
    expect(read('src/App.tsx')).toMatch(/<UsersAdminWorkspace userRole=\{currentUser\.role\}/);
  });
  it('company admins see their company role and the roles menu', () => {
    const app = read('src/App.tsx');
    expect(app).toMatch(/m\.role === 'company_admin'/);
    expect(app).toMatch(/role: isCompanyAdmin \? 'company_admin' : baseRole/);
    expect(read('src/components/shell/AppSidebar.tsx')).toMatch(/permissions\.includes\('roles\.read'\)/);
  });
});

describe('company settings account lists are filtered by role', () => {
  it('inventory and purchases clearing selects use usableAccounts', () => {
    const src = read('src/components/companies/CompanySettingsPanel.tsx');
    expect(src).toContain("usableAccounts(accounts, 'inventory_account_id')");
    expect(src).toContain("usableAccounts(accounts, 'purchases_clearing_account_id')");
  });
});
