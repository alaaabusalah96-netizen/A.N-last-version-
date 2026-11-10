# 04 - Package Roadmap

The road to the No-Code Configuration Platform is split into implementable packages.

## Wave A: Foundation & Registry
Establish the storage and lifecycle for configuration data.

### A0 - Documentation & Architecture (Current)
- **Goal**: Finalize design and map current state.
- **Outcome**: Architectural documents (01-07) and verification script.

### A1 - Foundation Integrity
- **Goal**: Close any residual data integrity gaps (e.g., final GRN+GL atomic link verified).
- **Primary Outcome**: Zero cross-tenant contamination in business modules.

### A2 - Configuration Registry
- **Goal**: Implement `config_definitions` and `config_registry` schema + RLS.
- **Outcome**: A database system ready to store tenant metadata.

### A3 - Versioning & Publishing
- **Goal**: Implement the Draft → Publish lifecycle in the backend services.
- **Outcome**: Ability to roll back configuration changes safely.

### A4 - Validation Engine
- **Goal**: Build a server-side service to validate config drafts against schemas and master data.
- **Outcome**: Prevents "bad" configs from being published.

---

## Wave B: First Real Customization
Moving logic out of code and into the Registry.

### B1 - Organization Designer
- **Goal**: Upgrade Org Units UI to support custom attributes and configuration overrides.
- **Outcome**: Visual tree management for company structure.

### B2 - Dynamic Roles
- **Goal**: Move role definitions from `roles.ts` to `config_registry`.
- **Outcome**: Administrators can create new roles in the UI.

### B3 - Permission Matrix UI
- **Goal**: Visual grid for mapping roles to permissions.
- **Outcome**: Self-service security management.

### B4 - Scope Assignment
- **Goal**: UI to map users to roles and org units visually.
- **Outcome**: Complete user access control.

### B5 - Accounting Mapping UI
- **Goal**: UI to map business events (GRN, Issue, Transfer) to target accounts.
- **Outcome**: Finance teams control the General Ledger posting rules.

### B6 - Configuration Management Center
- **Goal**: A unified dashboard to see active versions and publish changes.
- **Outcome**: Central "Cockpit" for the platform.

---

## Wave C: Full Platform
Complex behaviors and extensibility.

### C1 - Workflow Engine (Runtime)
- **Goal**: Implement the server-side engine that interprets workflow metadata.
- **Builds on**: All business modules (Inventory, Purchasing, Ledger).
- **User-visible outcome**: Business documents follow defined state transitions (e.g., Draft -> Pending Approval -> Posted).
- **Out of scope**: Visual designer UI.
- **Acceptance hints**: Document status changes strictly follow metadata rules.
- **Depends on**: A4 (Validation Engine), B6.

### C2 - Workflow Designer (UI)
- **Goal**: Visual drag-and-drop or node-based editor for workflows.
- **Builds on**: C1.
- **User-visible outcome**: Admins can visually map document lifecycles.
- **Out of scope**: Custom code execution inside nodes.
- **Acceptance hints**: Published UI workflow immediately affects document behavior.
- **Depends on**: C1.

### C3 - Business Rules
- **Goal**: Implement "If This Then That" logic for data validation (e.g., "Max discount 10%").
- **Builds on**: A4, C1.
- **User-visible outcome**: Real-time validation of business rules without code changes.
- **Out of scope**: Accounting posting rules (reserved for C4).
- **Acceptance hints**: Rule violation blocks document saving with a clear Arabic error.
- **Depends on**: A4.

### C4 - Posting Rules
- **Goal**: Advanced accounting mapping based on conditions (e.g., "If warehouse X, use account Y").
- **Builds on**: B5.
- **User-visible outcome**: Dynamic General Ledger posting based on granular business attributes.
- **Out of scope**: Tax/VAT engine complexity (if handled elsewhere).
- **Acceptance hints**: Journal entries created for varied scenarios match expected mappings.
- **Depends on**: B5.

### C5 - Dimensions
- **Goal**: Enable tracking Project, Cost Center, or Department on every transaction.
- **Builds on**: Ledger (011, 013).
- **User-visible outcome**: Multi-dimensional financial reporting.
- **Out of scope**: Custom dynamic dimensions (reserved for C6).
- **Acceptance hints**: Transaction lines store and validate dimension IDs.
- **Depends on**: B5.

### C6 - Custom Fields
- **Goal**: Allow admins to add metadata fields to any core entity (Item, Warehouse, GRN).
- **Builds on**: Config Registry (A2).
- **User-visible outcome**: Forms display custom fields dynamically.
- **Out of scope**: Schema-altering DDL.
- **Acceptance hints**: Custom field data survives versioning and publishing.
- **Depends on**: A2.

### C7 - Form & Screen Designer
- **Goal**: Customize layout and visibility of fields on screens.
- **Builds on**: C6.
- **User-visible outcome**: Clean, role-specific UIs.
- **Out of scope**: Full "Page Builder" (limited to existing form modification).
- **Acceptance hints**: Field hidden in config is not rendered in the DOM.
- **Depends on**: B2, C6.

### C8 - Report Builder
- **Goal**: Visual interface to define columns, filters, and aggregations.
- **Builds on**: C5.
- **User-visible outcome**: Custom PDF/Excel exports.
- **Out of scope**: Real-time streaming analytics.
- **Acceptance hints**: Report output matches Registry definition.
- **Depends on**: C5.

### C9 - Dashboard Builder
- **Goal**: Visual layout for KPI widgets and charts.
- **Builds on**: C8.
- **User-visible outcome**: Personalized home screens.
- **Out of scope**: Publicly shared dashboards.
- **Acceptance hints**: Widgets refresh correctly and honor tenant isolation.
- **Depends on**: C8.

### C10 - Industry Templates
- **Goal**: Pre-configured sets of workflows/accounts for specific sectors (Retail, Services).
- **Builds on**: B6.
- **User-visible outcome**: One-click company setup.
- **Out of scope**: Multi-industry hybrid configs in one company.
- **Acceptance hints**: Applying template backfills Registry accurately.
- **Depends on**: B6, C1–C9.

### C11 - Simulation & Impact
- **Goal**: "What-if" analysis for configuration changes.
- **Builds on**: A3.
- **User-visible outcome**: Preview how a new posting rule would have affected past transactions.
- **Out of scope**: Automatic back-posting.
- **Acceptance hints**: Simulation results are read-only and clearly marked.
- **Depends on**: C4.

### C12 - Governance
- **Goal**: Advanced audit trails, peer review for configs, and scheduled publishing.
- **Builds on**: A3.
- **User-visible outcome**: Enterprise-grade control over platform behavior.
- **Out of scope**: Integration with external IAM (unless requested).
- **Acceptance hints**: Two-man rule enforced for critical config changes.
- **Depends on**: A3.
