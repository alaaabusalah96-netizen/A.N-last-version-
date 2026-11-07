# Acceptance Rows — AN-UI-SHELL-1

| Requirement | Result | Evidence |
|---|---|---|
| AppSidebar component exists with vertical scroll | PASS | `src/components/shell/AppSidebar.tsx` |
| roleLabels translates technical roles to Arabic | PASS | `src/components/shell/roleLabels.ts` |
| App.tsx uses AppSidebar and clean layout | PASS | `src/App.tsx` |
| CompaniesPanel free of P04/Org RBAC jargon | PASS | `src/components/CompaniesPanel.tsx` |
| LoginForm free of Firebase/sovereignty jargon | PASS | `src/components/LoginForm.tsx` |
| Verification script passes all checks | PASS | `scripts/verifyUiShell1.ts` |
| P05_STARTED recorded as YES | PASS | `docs/foundation/AI_PROJECT_STATE.md` |
