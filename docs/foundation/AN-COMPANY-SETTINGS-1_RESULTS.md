# AN-COMPANY-SETTINGS-1 Results

- **Package Name**: AN-COMPANY-SETTINGS-1
- **Date**: 2026-11-07 (UTC)
- **HEAD SHA**: Working Tree
- **Migration**: `012_company_settings.sql` (requires `npm run migrate`)
- **API**:
  - `GET /api/companies/:companyId/settings`
  - `PUT /api/companies/:companyId/settings`
- **UI Path**: Sidebar → إعدادات الشركة → `CompanySettingsPanel`
- **Permissions**:
  - `company:settings:read`
  - `company:settings:write`
- **Audit Logs**: Records `COMPANY_SETTINGS_UPDATE` on every change.
- **Tenant Isolation**: RLS enforced via `company_id` using `app.current_tenant_id` context.
- **P05_STARTED**: YES
- **CI_STATUS**: PENDING
