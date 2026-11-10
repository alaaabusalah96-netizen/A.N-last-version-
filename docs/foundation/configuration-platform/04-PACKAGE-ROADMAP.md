# 04 - Package Roadmap

The road to the No-Code Configuration Platform is split into implementable packages.

## Wave A: Foundation & Registry
Establish the storage and lifecycle for configuration data.

### A0 - Documentation & Architecture (Current)
- **Goal**: Finalize design and map current state.
- **Outcome**: Six architectural documents and verification script.

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
- **Outcome**: Administrators can create new roles (e.g., "Warehouse Supervisor") in the UI.

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

- **C1–C3**: Workflow Designer & Approval Rules.
- **C4–C6**: Custom Dimensions (Cost Centers, Projects).
- **C7–C9**: Form & Report Template Registry.
- **C10–C12**: Governance, Templates, and Multi-Tenant Deployment Automation.
