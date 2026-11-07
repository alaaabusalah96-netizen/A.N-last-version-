# Acceptance Rows — AN-FIX-ACCOUNTING-RBAC-1

| Requirement | Result | Evidence |
|---|---|---|
| Domain permissions defined in permissions.ts | PASS | `src/server/rbac/permissions.ts` |
| Role matrix updated (company_user = READ only) | PASS | `src/server/rbac/roles.ts` |
| Server routes enforce ACCOUNTING_ACCOUNTS_* | PASS | `src/server/routes/accountingRoutes.ts` |
| Verification script passes all checks (S1-S10) | PASS | `scripts/verifyFixAccountingRbac1.ts` |
| No COMPANY_WRITE substitution for accounting writes | PASS | Code audit |
| P05_STARTED recorded as YES | PASS | `docs/foundation/AI_PROJECT_STATE.md` |
