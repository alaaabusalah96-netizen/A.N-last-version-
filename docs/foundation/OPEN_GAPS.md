# Open Gaps & Residual Technical Risks Registry

## Overview
This document tracks residual technical gaps, open risk items, and recommended future packages following the closure of the P1 Foundation track (P0 Security, P1 Ledger, P1 Org Units, and P1 UI Expansion).

---

## Residual Open Gaps Registry

| ID | Gap / Description | Severity | Impact / Risk Area | Suggested Package / Mitigation |
| :--- | :--- | :--- | :--- | :--- |
| **PG-SMOKE-LIVE** | Integration smoke tests (`T1–T7` in `verifyPgIntegrationSmoke1.ts`) are `BLOCKED` in local preview due to unauthenticated / restricted application role DDL credentials in AI Studio preview sandbox. | **High** for Prod Certification | Database Trigger & FK Runtime Execution | Operator executes `npm run test:pg-smoke-1` on an isolated test database with `MIGRATION_DATABASE_URL` configured. |
| **PERIODS** | `accounting_periods` table and structure exist in migration 013, but fiscal period closure enforcement (blocking entry posting in closed periods) is not yet wired into `postEntry`. | **Medium** | Accounting Controls | `AN-ACCOUNTING-PERIODS-ENFORCE-1` |
| **CI** | No green GitHub Actions run SHA recorded yet for the latest baseline commits. | **Medium** | Automated CI Verification | `AN-CI-GATE-1` (Trigger and verify GitHub Actions pipeline run). |
| **C2-LIVE** | Platform admin user-administration privilege escalation rules locked via static analysis, but require live end-to-end HTTP/PG integration test suite execution. | **Medium** | RBAC Privilege Boundaries | `AN-C2-HTTP-PROOF-1` |
| **RLS-ORG-V2** | Organizational unit path hierarchy checks enforced in application layer services (`assertUserOrgAccess`), not yet translated to SQL RLS policies. | **Low / Later** | Row Level Security Granularity | Evaluate `RLS v2` policies after business modules stabilize. |
| **MODULES** | Sub-ledger business modules (Sales/AR, Purchasing/AP, Inventory, Cash & Bank, Fleet, POS) are intentionally not started. | **Product Scope** | ERP Functional Expansion | Select and implement first module deliberately by product priority. |

---

## Next Steps & Strategy
No new business modules should be deployed to production until high-severity open items (specifically `PG-SMOKE-LIVE`) are validated by the database operator on an active PostgreSQL test instance.
