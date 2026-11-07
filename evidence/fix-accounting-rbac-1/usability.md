# Usability & RBAC Assessment — AN-FIX-ACCOUNTING-RBAC-1

- **Server-Side Enforcement**: All accounting write operations (`POST /api/accounting/accounts` and `POST /api/accounting/accounts/seed-default`) now strictly require domain permissions (`accounting.accounts.create` and `accounting.accounts.seed`) verified against active company membership via `RbacService`.
- **Role Isolation**: Ordinary company members (`company_user`) have read-only access to the chart of accounts and are blocked with 403 Forbidden on write attempts, while administrators (`company_admin` and `platform_admin`) retain full management access.
