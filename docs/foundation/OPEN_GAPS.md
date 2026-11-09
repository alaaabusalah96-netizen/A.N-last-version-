# Open Gaps & Residual Technical Risks Registry

## Overview
This document tracks residual technical gaps, open risk items, and recommended future packages following the closure of the P1 Foundation track and `AN-PG-INTEGRATION-PROOF-2`.

---

## Residual Open Gaps Registry

| ID | Gap / Description | Severity | Impact / Risk Area | Status / Mitigation |
| :--- | :--- | :--- | :--- | :--- |
| **DB-SSL-DUAL-POLICY** | Remote non-prod connections (Supabase) failed when `sslmode` was stripped because non-prod defaulted to no SSL. | **CLOSED** | Connection SSL Policy | Implemented host-based auto-detection in `resolveSslConfig` (`connection.ts`) enabling SSL for remote hosts and disabling for localhost in non-production (`AN-DB-SSL-POLICY-2`). |
| **CI-PG-SSL** | Local Postgres service in CI encountered SSL error (`The server does not support SSL connections`). | **CLOSED** | CI Connection | Refactored `migrationRunner.ts` to use `buildPgConfig` and set `DATABASE_SSL: disable` in `foundation-ci.yml` (`AN-CI-POSTGRES-SSL-1`). |
| **CI-PROOF-WIRING** | PostgreSQL integration proof T1–T7 not wired into GitHub Actions CI. | **CLOSED** | CI Automation & Proof | Wired `test:pg-proof-2` with `AN_PG_PROOF_STRICT="1"` in `foundation-ci.yml` (`AN-CI-PROOF-WIRE-1`). |
| **PG-PROOF-HARNESS** | Smoke tests needed independent T1–T7 case isolation and strict error checking. | **CLOSED** | Test Quality & Proof | Fixed in `AN-PG-INTEGRATION-PROOF-2` (`scripts/verifyPgIntegrationProof2.ts`, migration 018 for search_path). |
| **MIGRATE-ENV** | Scraped `/proc` for `DATABASE_URL` and fell back to `DATABASE_URL` on migration auth failure. | **CLOSED** | Security & Privileges | Fixed in `AN-FIX-VERIFY-MIGRATE-SCOPE-1`. `/proc` removed. `MIGRATION_DATABASE_URL` is strictly required. No fallback. |
| **PG-SMOKE-QUALITY** | Smoke test T2 passed on any error; contained `/proc` scraping. | **CLOSED** | Test Quality & Assurance | Fixed in `AN-FIX-VERIFY-MIGRATE-SCOPE-1`. `/proc` removed. T2 requires matching `/CANNOT_MODIFY_POSTED|posted journal entry/i`. |
| **LIST-SCOPE-ENFORCE** | `listEntries` / `getTrialBalance` permitted scoped users without `orgUnitId` to read company-wide entries. | **CLOSED** | Scope Security | Fixed in `AN-FIX-VERIFY-MIGRATE-SCOPE-1`. Requires `orgUnitId` parameter for scoped users (`ValidationError`). |
| **PG-SMOKE-LIVE** | Integration smoke tests (`T1–T7` in `verifyPgIntegrationSmoke1.ts`) are `BLOCKED` in local preview due to unauthenticated / restricted application role DDL credentials in AI Studio preview sandbox. | **High** for Prod Certification | Database Trigger & FK Runtime Execution | Operator executes `npm run test:pg-smoke-1` on an isolated test database with `MIGRATION_DATABASE_URL` configured. |
| **PERIODS** | `accounting_periods` table and structure exist in migration 013, but fiscal period closure enforcement (blocking entry posting in closed periods) is not yet wired into `postEntry`. | **Medium** | Accounting Controls | `AN-ACCOUNTING-PERIODS-ENFORCE-1` |
| **CI** | No green GitHub Actions run SHA recorded yet for the latest baseline commits. | **Medium** | Automated CI Verification | `AN-CI-GATE-1` (Trigger and verify GitHub Actions pipeline run). |
| **C2-LIVE** | Platform admin user-administration privilege escalation rules locked via static analysis, but require live end-to-end HTTP/PG integration test suite execution. | **Medium** | RBAC Privilege Boundaries | `AN-C2-HTTP-PROOF-1` |
| **RLS-ORG-V2** | Organizational unit path hierarchy checks enforced in application layer services (`assertUserOrgAccess`), not yet translated to SQL RLS policies. | **Low / Later** | Row Level Security Granularity | Evaluate `RLS v2` policies after business modules stabilize. |
| **MODULES** | Sub-ledger business modules (Sales/AR, Purchasing/AP, Inventory, Cash & Bank, Fleet, POS) are intentionally not started. | **Product Scope** | ERP Functional Expansion | Select and implement first module deliberately by product priority. |

---

## Next Steps & Strategy
No new business modules should be deployed to production until high-severity open items (specifically `PG-SMOKE-LIVE`) are validated by the database operator on an active PostgreSQL test instance.

