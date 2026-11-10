# 02 - Target Architecture

The «A.N Configuration Platform» centralizes logic and behavior metadata into a unified registry, decoupling application features from hardcoded constants.

## 1. The Configuration Registry
A central database repository for all company-scoped metadata.
- **Scope**: Strictly tenant-isolated (`company_id`).
- **Storage**: JSONB columns for flexible schemas, allowing different versions of the platform to evolve without schema changes.

## 2. Versioning & Publishing
Configuration follows a **Draft → Publish** lifecycle.
- **Drafts**: Mutable state for administrators to experiment.
- **Published Versions**: Immutable snapshots referenced by the application at runtime.
- **Rollback**: Instant switching between published versions by updating a "current_version" pointer.

## 3. The Validation Engine
Before any configuration is published, it must pass a battery of checks:
- **Structural Integrity**: JSON schema validation.
- **Referential Integrity**: Ensuring account codes or role IDs referenced in the config actually exist in the tenant's master data.
- **Business Logic Invariants**: e.g., "Account mappings must result in balanced entries."

## 4. Plug-in Engines
The platform consists of specialized engines that interpret the registry data:
- **Role Engine**: Merges dynamic database roles with static system roles.
- **Posting Engine**: Resolves dynamic account mappings for financial transactions.
- **Workflow Engine (Wave C)**: Executes state transitions and approval gates based on metadata.

## 5. Security & Invariants
The architecture maintains several "Protected Invariants" that cannot be bypassed by configuration:
- **Tenancy**: No configuration can enable cross-company data access (enforced by RLS).
- **Double-Entry**: The accounting engine always validates `SUM(debit) == SUM(credit)` regardless of mapping configuration.
- **No Remote Execution**: Users cannot upload arbitrary JavaScript or SQL. Only pre-defined, safe configuration schemas are supported.

## 6. Integration Model
Existing services (e.g., `JournalService`) will be wrapped or modified to:
1. Identify the transaction context.
2. Query the Registry for the active configuration version.
3. Apply the mapping/rule.
4. Execute the hardcoded core logic.
