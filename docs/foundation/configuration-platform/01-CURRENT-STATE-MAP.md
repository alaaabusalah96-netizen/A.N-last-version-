# 01 - Current State Map

This document maps the existing application components and defines how they will be used or transformed in the configuration platform.

## 1. Tenancy & Core Entities
- **What exists**: 
  - `companies` table (Migration 002)
  - `company_memberships` (Migration 003)
  - `src/server/org/companyRepository.ts`
  - `src/server/http/tenantScope.ts` (Tenant isolation middleware)
- **Status**: **REUSE**
- **Strategy**: The core tenancy model is robust and RLS-enforced. The configuration platform will plug into the `company_id` scope.

## 2. Organization Structure
- **What exists**: 
  - `org_units` table (Migration 014: hierarchy via `parent_id` + `path`)
  - `user_org_scope` (Migration 014: mapping users to units)
  - `src/server/org/orgUnitService.ts`
  - `src/components/org/OrgUnitsPanel.tsx`
- **Status**: **EXTEND**
- **Gap**: The current UI is a flat list/tree. It needs to evolve into the **Organization Designer** (B1) where configuration templates can be applied to specific branches.

## 3. RBAC (Static)
- **What exists**: 
  - `src/server/rbac/permissions.ts` (Hardcoded constants)
  - `src/server/rbac/roles.ts` (Hardcoded static roles like `platform_admin`, `company_admin`)
  - `src/server/rbac/rbacService.ts`
  - `src/components/users/UsersAdminWorkspace.tsx`
- **Status**: **REPLACE (Gradual)**
- **Reason**: Roles are currently static TypeScript objects. For a no-code platform, they must move to the database configuration registry.
- **Strategy**: Keep static roles as a fallback; introduce **Dynamic Roles** (B2) that are merged with static ones at runtime.

## 4. Company Settings
- **What exists**: 
  - `company_settings` table (Migration 012)
  - `src/server/org/companySettingsRepository.ts`
  - Fields for `inventory_account_id` and `purchases_clearing_account_id` (Migration 024)
- **Status**: **REUSE / EXTEND**
- **Strategy**: Move specific "Account Mappings" from the flat `company_settings` table into the centralized Configuration Registry for better versioning and complex mapping rules.

## 5. Accounting Engine
- **What exists**: 
  - `accounts`, `journal_entries`, `journal_lines` (Migrations 011, 013, 015, 022)
  - `src/server/accounting/journalService.ts` (Immutability, balancing, sequence allocation)
- **Status**: **REUSE**
- **Strategy**: The posting engine is highly reliable. The configuration platform will focus on **Accounting Mappings** (B5) — metadata that tells the engine *which* accounts to use for a given transaction type (e.g., GRN Post).

## 6. Inventory & Purchasing
- **What exists**: 
  - `019_inventory_core.sql`, `021_purchasing_core.sql`
  - `src/server/inventory/stockService.ts`
  - `src/server/purchasing/grnService.ts` (With GRN-GL atomic posting link in 024)
- **Status**: **REUSE**
- **Strategy**: These represent the "Execution Layer". The platform will later add **Workflow Rules** (Wave C) to govern how these services are invoked.

## 7. CI / CD & Quality
- **What exists**: 
  - `foundation-ci.yml`
  - `scripts/runFoundationBattery.ts` (Static and live database assertions)
  - `scripts/verifyPgIntegrationProof2.ts` (Strict SQLSTATE and isolation checks)
- **Status**: **EXTEND**
- **Strategy**: Add "Configuration Integrity" checks to the battery to ensure published configs don't break database invariants.
