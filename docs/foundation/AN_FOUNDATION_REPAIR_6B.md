# AN-FOUNDATION-REPAIR-6B Technical Documentation (Finalized)

## Overview
AN-FOUNDATION-REPAIR-6B implements rigorous production SSL hardening (R3) with CA certificate support and secure, least-privilege app role provisioning (R4) utilizing native SCRAM-SHA-256 password verifiers.

---

## 1. Production SSL Policy (R3)
- **Strict TLS Enforcement**: Production environments (`NODE_ENV === 'production'`) strictly require encrypted TLS connections.
- **No Insecure Bypasses**: Insecure bypass flags have been completely removed.
- **Certificate Verification & CA Support**: `rejectUnauthorized` is enforced true. Custom CA certificates are supported securely via `DATABASE_SSL_CA` or `DATABASE_SSL_CA_FILE`.
- **Verified by Tests**: Tested via `verifyDbConfig.ts` and `verifyRepair2.ts`.

---

## 2. Secure App Database Role Provisioning (R4)
- **Dedicated Provisioner**: Database provisioning runs through a separate migration/provisioner connection.
- **SCRAM-SHA-256 Verifier Generation**: Passwords are securely hashed into SCRAM verifiers in Node.js (`scram.ts`) and executed via server-side parameterized statements.
- **Least-Privilege Runtime (`an_app`)**: The runtime application user `an_app` is provisioned with `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, and `NOREPLICATION`.
- **Data API Lockdown**: Automatically revokes table, sequence, and function privileges from `anon`, `authenticated`, and `service_role`.
- **Verified by Tests**: Tested via `verifyProvisioning.ts` and `verifyDbPrivileges.ts`.
