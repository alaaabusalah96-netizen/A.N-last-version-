# A.N ERP No-Code Configuration Platform

## Purpose
The purpose of this platform is to enable non-technical administrators (Implementation Consultants / Power Users) to customize the ERP behavior without writing code or modifying database schemas directly. This includes defining organizational structures, dynamic roles, permission matrices, accounting mappings, and business workflows.

## Strategy: Wave-Based Implementation
The platform follows a three-wave strategy to ensure stability and incremental value:

- **Wave A: Foundation + Central Config Engine**: Establishing the core registry and versioning system.
- **Wave B: First Real Customization**: Moving static configurations (roles, account mappings) into the dynamic registry.
- **Wave C: Full Platform**: Expanding into complex workflows, forms, reports, and governance.

## Key Principles
- **No Demolition**: Never destroy working hardcoded modules; instead, extend them to read from the configuration registry.
- **Tenant Isolation**: Configuration data is strictly company-scoped and isolated at the database level using RLS.
- **Immutability & Audit**: Published configurations are versioned and immutable. Every change is audited.
- **Legal and Financial Soundness (Alaa, 25 Nov 2026)**: The ERP must be legally sound and financially reliable and follow accounting convention and standards. It must never alter a financial operation without a basis or standard. Any design choice not backed by a cited standard must be configurable.
- **Many Treatments, Configured Not Coded**: Any operation that has several valid settlements or treatments supports all of them through configuration and customization without code, with approval paths. It is never hardcoded to a single view. Defaults follow standard practice and are documented with their source.
- **Counts Never Post**: Only journal entries and expenses post to accounting. A physical count (جرد) is a control record and never posts by itself.
- **Safety First**: No user-supplied executable code (SQL/JS) in the configuration registry. All logic is driven by metadata and safe engines.

## Documentation Index
1. [Current State Map](./01-CURRENT-STATE-MAP.md) - Analysis of existing modules and their readiness.
2. [Target Architecture](./02-TARGET-ARCHITECTURE.md) - The vision for the Registry and Engines.
3. [Data Model Draft](./03-DATA-MODEL-DRAFT.md) - Proposed database schema for the configuration platform.
4. [Package Roadmap](./04-PACKAGE-ROADMAP.md) - Detailed implementation plan (A0–C12).
5. [Acceptance and Risks](./05-ACCEPTANCE-AND-RISKS.md) - Quality gates and mitigation strategies.
