# AN-P1A-LEDGER-ORG-DESIGN-1 Results Report

**Package**: AN-P1A-LEDGER-ORG-DESIGN-1  
**Type**: LEAN / DESIGN + ADR ONLY — NO RUNTIME FEATURE CODE  
**Status**: DESIGN_COMPLETE / DOCUMENTED  
**Date**: 2026-11-08  

---

## 1. Executive Summary

This package established the complete architectural foundations, data model designs, and Architecture Decision Records (ADRs) for the upcoming P1 implementation phases without introducing conflicting schemas, premature migrations, or untested runtime features:
- **ADR-01 (Org Structure)**: Established standard adjacency list (`parent_id`) with path hierarchy for company-scoped branches, departments, divisions, and cost centers. Defined `user_org_scope` access grants and made `org_unit_id` nullable across initial accounting tables. Confirmed zero intercompany in P1.
- **ADR-02 (Ledger Guarantees)**: Established non-negotiable double-entry invariants ($\sum \text{debit} = \sum \text{credit}$), minimum two lines, positive amounts, composite tenant FK integrity (`company_id`), posted entry immutability triggers, reversal workflows, and atomic monotonic numbering per company.
- **ADR-03 (Tenant vs Org Scope)**: Confirmed that `company_id` via PostgreSQL RLS is the immutable primary security kernel (`withTenantTransaction`), while organizational units operate as an application-level visibility and authorization filter in Phase 1 with forward compatibility for RLS v2.
- **ADR-04 (Currency & Periods)**: Linked functional currency to `company_settings.default_currency_code`, defined future-proof currency and exchange rate columns, and established period locking to prevent back-dated mutations in closed accounting periods.
- **P1 Data Model Draft**: Specified table schemas for `org_units`, `user_org_scope`, `accounting_sequences`, and `accounting_periods`.
- **P1 Migration Sequence**: Designed phased rollout (P1b Ledger Guarantees -> P1c Org Units -> P1d UI Expansion) forbidding monolithic migrations.

---

## 2. Deliverables Summary

| Artifact | Purpose |
|----------|---------|
| `docs/foundation/adr/ADR-01-org-structure.md` | Org units, hierarchy, unit types, user scoping |
| `docs/foundation/adr/ADR-02-ledger-guarantees.md` | Balance invariants, draft/posted immutability, reversal, sequences |
| `docs/foundation/adr/ADR-03-tenant-vs-org-scope.md` | Company RLS kernel vs application org scope |
| `docs/foundation/adr/ADR-04-currency-and-periods.md` | Functional currency & fiscal year period locking |
| `docs/foundation/P1_DATA_MODEL_DRAFT.md` | Logical table definitions and constraint draft |
| `docs/foundation/P1_MIGRATION_SEQUENCE.md` | Phase ordering, precheck, postcheck, and rollback guidelines |
| `scripts/verifyP1aDesign1.ts` | Automated verification harness asserting design artifacts |
| `evidence/p1a-design-1/acceptance-rows.md` | Structured acceptance matrix |

---

## 3. Strict Boundary Compliance

- **No Migrations**: Zero new files added to `database/migrations/` (highest migration remains `012_company_settings.sql`).
- **No Runtime Code Churn**: Zero business logic changes in `src/server/` or `src/components/`.
- **No New Modules Started**: No inventory, sales, cash, or fleet modules initiated.
- **Non-claim**: Explicitly documented as `DESIGN_COMPLETE`; no claim of runtime ledger completion.
