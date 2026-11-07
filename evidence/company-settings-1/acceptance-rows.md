# Acceptance Rows — AN-COMPANY-SETTINGS-1

| Requirement | Result | Evidence |
|---|---|---|
| Migration 012 defines company_settings table | PASS | `database/migrations/012_company_settings.sql` |
| table_ownership.json registers company_settings tenant | PASS | `database/table_ownership.json` |
| Backend service/repo handle upsert and defaults | PASS | `src/server/org/companySettingsService.ts` |
| Routes enforce explicit SETTINGS permissions | PASS | `src/server/routes/companySettingsRoutes.ts` |
| AppSidebar has "إعدادات الشركة" nav item | PASS | `src/components/shell/AppSidebar.tsx` |
| CompanySettingsPanel loads and saves via API | PASS | `src/components/companies/CompanySettingsPanel.tsx` |
| Verification script passes all S1-S10 checks | PASS | `scripts/verifyCompanySettings1.ts` |
| P05_STARTED recorded as YES | PASS | `docs/foundation/AI_PROJECT_STATE.md` |
