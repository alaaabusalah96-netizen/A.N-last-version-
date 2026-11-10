# 03 - Data Model Draft (Finalized Design)

This document defines the schema rules and lifecycle logic for the Configuration Platform. These rules are mandatory for the implementation of Wave A.

## 1. Core Schema Entities

### A. Config Definitions (`config_definitions`)
- **Nature**: Global catalog of customization points.
- **Constraints**: `UNIQUE(key)`.
- **Fields**:
  - `id`: UUID (PK)
  - `key`: VARCHAR (e.g., 'system.roles', 'accounting.grn_mapping')
  - `schema`: JSONB (Mandatory JSON Schema for engine validation)
  - `default_value`: JSONB (Fallback if no company value exists)

### B. Config Registry (`config_registry`)
- **Nature**: Immutable historical snapshots of published configurations.
- **Constraints**: `UNIQUE(company_id, config_definition_id, version_no)`.
- **Lifecycle**: Once a row is `published`, it MUST NOT be updated. Changes require a new `version_no`.
- **Fields**:
  - `id`: UUID (PK)
  - `company_id`: UUID (FK to `companies`, RLS enforced)
  - `config_definition_id`: UUID (FK)
  - `version_no`: INT (Monotonic per company+definition)
  - `is_active`: BOOLEAN (True for the currently live version; only one active per company+definition)
  - `content`: JSONB
  - `published_at`: TIMESTAMPTZ
  - `published_by`: UUID (FK)

### C. Config Drafts (`config_drafts`)
- **Nature**: Mutable work-in-progress state.
- **Constraints**: `UNIQUE(company_id, config_definition_id)`. Only one draft allowed per definition per company.
- **States**: `draft`, `in_review`.
- **Fields**:
  - `id`: UUID (PK)
  - `company_id`: UUID (FK, RLS enforced)
  - `config_definition_id`: UUID (FK)
  - `status`: VARCHAR
  - `content`: JSONB
  - `updated_at`: TIMESTAMPTZ

## 2. Configuration Lifecycle Logic

1. **Initialization**: When a new company is created, it inherits values from `config_definitions.default_value`.
2. **Editing**: Admins modify `config_drafts`.
3. **Validation**: Draft is checked against `config_definitions.schema` and master data (accounts/units).
4. **Publishing**: 
   - A new row is inserted into `config_registry` with `version_no = latest + 1`.
   - `is_active` is set to `true` for the new row.
   - `is_active` is set to `false` for the previous version.
   - The `config_draft` is deleted or cleared.
5. **Rollback**: 
   - A previous row in `config_registry` is identified.
   - A NEW row is inserted (copying the old content) with a NEW `version_no`. 
   - *Rationale*: We never "un-publish"; we only "publish a known good state" to maintain audit history.

## 3. Inheritance & Resolution Order

Engines resolve configuration using the following priority:
1. **Org Unit Override**: (Wave B/C) If config exists for a specific `org_unit_id`.
2. **Company Published**: The row in `config_registry` where `company_id = X` and `is_active = true`.
3. **Platform Default**: `config_definitions.default_value`.

## 4. Relationship to Existing Data
- **Company Settings**: The `company_settings` table remains the source for "System Primitive Settings" (Timezone, Currency). "Behavioral Logic" (Mappings, Rules) moves to the Registry.
- **Permissions**: Permissions remain hardcoded constants in `src/server/rbac/permissions.ts`. The Registry stores mappings of these constants to Dynamic Roles.
- **Accounts**: The Registry stores `account_id` or `account_code` strings. The engines use `AccountRepository` to resolve them at runtime.

## 5. Audit Requirements
Every Registry row must capture:
- `who`: The user ID.
- `when`: Server-generated timestamp.
- `why`: Mandatory `change_summary` text field.
- `diff`: (Optional) JSON diff of the change from the previous version.
