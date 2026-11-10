# 03 - Data Model Draft (Wave A)

This draft outlines the logical schema for the Configuration Registry. It is designed to be additive and non-disruptive to existing modules.

## 1. Config Definitions (`config_definitions`)
Defines the schema and default values for a specific customization point (e.g., `accounting_mapping`, `custom_roles`).
- `id`: UUID (PK)
- `key`: VARCHAR (e.g., 'accounting.inventory')
- `schema`: JSONB (JSON Schema for validation)
- `default_value`: JSONB

## 2. Config Registry (`config_registry`)
Stores the actual configuration values per company.
- `id`: UUID (PK)
- `company_id`: UUID (FK to `companies`, RLS enforced)
- `config_definition_id`: UUID (FK)
- `version_no`: INT
- `is_active`: BOOLEAN (The "Live" version)
- `content`: JSONB (The metadata)
- `published_at`: TIMESTAMPTZ
- `published_by`: UUID (FK to `platform_users`)

## 3. Config Drafts (`config_drafts`)
Work-in-progress configurations.
- `id`: UUID (PK)
- `company_id`: UUID (FK, RLS enforced)
- `config_definition_id`: UUID (FK)
- `content`: JSONB
- `updated_at`: TIMESTAMPTZ

## Relationships
- **tenancy**: All tables must have `company_id` and strict RLS policies matching the `an_app` role patterns established in Migration 010.
- **accounting**: Config registry entries for account mappings will store `account_id` or `account_code` strings which are resolved at runtime via the `accounts` table.
- **rbac**: Dynamic roles in `config_registry` will map to existing `permissions` keys.

## Wave B Expansion
Later waves will add:
- `config_change_logs`: Audit trail for version comparisons.
- `config_approval_workflow`: Multi-user sign-off before publishing.
