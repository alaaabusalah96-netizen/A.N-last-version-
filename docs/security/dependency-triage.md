# Dependency Security Triage

- **Audit Baseline Date**: 2026-11-25
- **Scope**: Security triage of `npm audit` and `npm outdated` without runtime code, dependency upgrades, or database migration changes (R06).

## Vulnerability Summary (`npm audit`)

| Scope | Critical | High | Moderate | Low | Info | Total |
| --- | --- | --- | --- | --- | --- | --- |
| Production (`dependencies`: 138) | 0 | 0 | 0 | 0 | 0 | **0** |
| Development (`devDependencies`: 123) | 0 | 0 | 0 | 1 | 0 | **1** |
| **Total** | **0** | **0** | **0** | **1** | **0** | **1** |

### Accepted Development-Only Vulnerability

| Package | Severity | Advisory | Affected Range | Installed | Disposition | Rationale |
| --- | --- | --- | --- | --- | --- | --- |
| `esbuild` | Low | `GHSA-g7r4-m6w7-qqqr` (CWE-22, CVSS 2.5) | `>=0.27.3 <0.28.1` | `0.27.7` (`^0.27.0`) | **Accepted** | Dev-only build tool; advisory applies only when running the `esbuild` development server on Windows (production server uses compiled bundle via `node dist/server.cjs`, and Linux dev/CI does not run `esbuild --serve` on Windows). Fix requires major jump to `0.28.x`. |

## Upgrade Backlog & Deferrals

### 1. Non-Breaking Patch / Minor Updates (Deferred to Maintenance Window)

Zero production vulnerabilities exist; non-breaking patch/minor updates are deferred to a separate maintenance pass after release verification:

- `@tailwindcss/vite` (`4.3.3` -> `4.3.5`)
- `@types/react` (`19.3.0` -> `19.3.1`)
- `@vitejs/plugin-react` (`6.2.1` -> `6.3.0`)
- `argon2` (`0.45.1` -> `0.45.2`)
- `autoprefixer` (`10.6.2` -> `10.7.0`)
- `concurrently` (`10.0.6` -> `10.0.7`)
- `playwright` (`1.65.0` -> `1.65.1`)
- `tailwindcss` (`4.3.3` -> `4.3.5`)
- `vite` (`8.3.5` -> `8.3.8`)
- `vitest` (`5.1.0` -> `5.1.1`)

### 2. Breaking Major Upgrades (Explicitly Deferred)

| Package | Current | Latest Major | Scope | Reason Deferred |
| --- | --- | --- | --- | --- |
| `express` | `4.22.3` (`^4.21.2`) | `5.3.0` (`5.x`) | Production | Express 5 introduces breaking router path-matching, error-handling, and middleware signature changes (`@types/express` `5.0.6` also paired). Requires dedicated regression pass across all route modules. |
| `@types/node` | `22.20.5` (`^22.14.0`) | `26.6.10` (`26.x`) | Dev | Locked to Node 22 LTS runtime baseline; upgrading type definitions ahead of runtime risks false-positive API availability. |
| `lucide-react` | `0.546.0` | `1.80.0` (`1.x`) | Production | Major icon-set overhaul (`1.x`) may rename or remove icon exports used across frontend components. |
| `motion` | `12.43.0` (`^12.23.24`) | `14.14.0` (`14.x`) | Production | Two-major-version jump (`12.x` -> `14.x`) risks breaking animation props and bundle behavior without UI regression testing. |
| `dotenv` | `17.4.2` (`^17.2.3`) | `18.0.10` (`18.x`) | Production | Breaking env-loading behavioral changes in `18.x` deferred to avoid altering runtime configuration parsing. |
| `esbuild` | `0.27.7` (`^0.27.0`) | `0.28.2` (`0.28.x`) | Dev | `0.28.x` is a breaking pre-1.0 minor bump; underlying advisory is low-severity, dev-only, and Windows-specific, so upgrade is deferred. |
