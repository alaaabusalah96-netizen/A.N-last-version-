# Master Preflight Inventory (AN-PERSISTENCE-CORE-1)

## 1. Current Map Stores & Importers
- `UserStore` (`src/server/auth/userStore.ts`): Uses `Map<string, User>`. Imported by `authService.ts`.
- `SessionStore` (`src/server/auth/sessionStore.ts`): Uses `Map<string, Session>`. Imported by `authService.ts`.
- `CompanyStore` (`src/server/org/companyStore.ts`): Uses `Map<string, Company>`. Imported by `companyRoutes.ts`.
- `MembershipStore` (`src/server/org/membershipStore.ts`): Uses `Map<string, CompanyMembership>`. Imported by `rbacService.ts` and `companyRoutes.ts`.

## 2. Exact User / Session / Company / Membership Interfaces
- **User**: `id`, `username`, `passwordHash`, `role` (`'platform_admin' | 'user'`), `companyId?`, `createdAt`
- **Session**: `id`, `userId`, `expiresAt`, `createdAt`
- **Company**: `id`, `code`, `nameAr`, `nameEn?`, `isActive`, `createdAt`, `createdBy`
- **CompanyMembership**: `id`, `userId`, `companyId`, `role`, `isActive`, `createdAt`

## 3. Vite Mock Status
- `vite.config.ts`: **YES**, dev mock API (`devApiPlugin`, `AdminPass123!`, `dev_token_`) was completely removed in AN-FOUNDATION-REPAIR-2 and replaced with proxying `/api` to Express.

## 4. Existing Migrations Folder
- **None**: Folder `database/migrations/` does not exist yet. It will be created in Phase 1.

## 5. Package.json Test Scripts
- Existing: `test:foundation`, `test:repair2`
- To add: `migrate`, `test:persistence`
