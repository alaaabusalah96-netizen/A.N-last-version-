# AN-FOUNDATION-REPAIR-6B Technical Documentation

## Overview
AN-FOUNDATION-REPAIR-6B implements rigorous production SSL hardening (R3) and secure, least-privilege app role provisioning (R4) for the A.N ERP platform.

---

## 1. Production SSL Policy (R3)
- **Strict TLS Enforcement**: Production environments (`NODE_ENV === 'production'`) strictly require encrypted TLS connections.
- **No Insecure Bypasses**: The former `ALLOW_INSECURE_DB_SSL=1` bypass and `DATABASE_SSL_REJECT_UNAUTHORIZED=false` configurations have been removed and throw fatal errors when attempted in production.
- **Certificate Verification**: `rejectUnauthorized` defaults to `true` in production, ensuring invalid, expired, untrusted certificates or hostname mismatches fail closed immediately.
- **Test-Only Isolation**: Insecure settings are structurally restricted to non-production environments (`NODE_ENV !== 'production'`).

---

## 2. Secure App Database Role Provisioning (R4)
- **Dedicated Provisioner**: Database provisioning runs through a separate migration/provisioner connection.
- **Least-Privilege Runtime (`an_app`)**: The runtime application user `an_app` is provisioned with `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, and `NOCREATEROLE`, with no membership in privileged roles.
- **SQL Identifier Safety**: Strict allowlist validation (`USER_REGEX`) and PostgreSQL trusted identifier formatting prevent SQL injection on dynamic database user identifiers.
- **Parameterization**: Passwords and secure credentials are bound via PostgreSQL query parameters and are never concatenated into dynamic SQL string literals.
- **Idempotency**: Provisioning safely creates or updates roles, sets least-privilege table grants across public schema, enforces append-only restrictions on `audit_logs` (revoking update/delete/truncate), and restricts `schema_migrations` to SELECT-only.
- **Credential Redaction**: Passwords and connection credentials are strictly redacted from console output, logs, and exception details.

---

## 3. Verification Evidence
- **Typecheck**: Passed (`tsc --noEmit`).
- **Build**: Passed (`vite build && esbuild server.ts`).
- **SSL Resolution Tests**: Verified strict production rejection and non-production flexibility.
- **Database Privilege Verification**: Verified `an_app` attributes, DDL prohibitions, table permissions, and idempotency.
