import fs from 'fs';
import path from 'path';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type AuthClassification =
  | 'PERMISSION'
  | 'PLATFORM_ADMIN'
  | 'AUTH_SELF_SERVICE'
  | 'PUBLIC'
  | 'UNCLASSIFIED';

interface EndpointRecord {
  prefix: string;
  method: HttpMethod;
  path: string;
  requireAuth: boolean;
  permissions: string[];
  requirePlatformAdmin: boolean;
  classification: AuthClassification;
  authorizationLabel: string;
  sourceFile: string;
  conditional: boolean;
}

interface RouterMount {
  routerVar: string;
  filePath: string;
  prefix: string;
  conditional: boolean;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const ALLOWED_PUBLIC_ENDPOINTS = new Set([
  'GET /api/auth/csrf',
  'POST /api/auth/login',
  'POST /api/auth/logout',
]);
const ALLOWED_SELF_SERVICE_ENDPOINTS = new Set([
  'GET /api/auth/me',
  'POST /api/auth/logout-all',
  // Company groups: group membership is enforced in CompanyGroupService (not a company permission)
  'GET /api/groups',
  'GET /api/groups/:groupId',
  'PUT /api/groups/:groupId',
  'POST /api/groups/:groupId/users',
  'PUT /api/groups/:groupId/users/:userId',
  'DELETE /api/groups/:groupId/users/:userId',
]);

const MATRIX_DOC_REL = 'docs/security/endpoint-permission-matrix.md';
const APP_TS_REL = 'src/server/app.ts';
const ROUTES_DIR_REL = 'src/server/routes';

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function normalizeUrlPath(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '/') continue;
    for (const seg of trimmed.split('/')) {
      if (seg) segments.push(seg);
    }
  }
  return '/' + segments.join('/');
}

/**
 * Strips comments (// and /* *\/) while preserving string/template-literal delimiters
 * so lexical scanning does not match tokens inside comments.
 */
function stripCommentsPreservingStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // Single-line comment
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Multi-line comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }

    // String or template literal
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = src[i];
        out += c;
        if (c === '\\') {
          i++;
          if (i < n) {
            out += src[i];
            i++;
          }
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Finds the matching closing parenthesis index for '(' at openIdx,
 * skipping over string and template literals.
 */
function findMatchingParen(code: string, openIdx: number): number {
  let depth = 0;
  const n = code.length;
  let i = openIdx;

  while (i < n) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        const c = code[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Splits a top-level comma-separated argument list (respecting nested (), [], {}, and strings).
 */
function splitTopLevelArgs(argStr: string): string[] {
  const args: string[] = [];
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let start = 0;
  let i = 0;
  const n = argStr.length;

  while (i < n) {
    const ch = argStr[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        const c = argStr[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;
    else if (ch === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      args.push(argStr.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }

  const tail = argStr.slice(start).trim();
  if (tail.length > 0) args.push(tail);
  return args;
}

function unquoteStringLiteral(expr: string): string | null {
  const trimmed = expr.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return null;
}

function resolveImportPath(fromFileAbs: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = path.dirname(fromFileAbs);
  const rawTarget = path.resolve(dir, specifier);
  const candidates = [
    rawTarget.replace(/\.js$/i, '.ts'),
    rawTarget.replace(/\.mjs$/i, '.mts'),
    rawTarget + '.ts',
    rawTarget,
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return cand;
    }
  }
  return null;
}

function parseImports(code: string, fromFileAbs: string): Map<string, string> {
  const imports = new Map<string, string>();
  const importRegex = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(code)) !== null) {
    const clause = match[1].trim();
    const spec = match[2].trim();
    const resolved = resolveImportPath(fromFileAbs, spec);
    if (!resolved) continue;

    // Named imports: { a, b as c }
    const braceMatch = clause.match(/\{([\s\S]*?)\}/);
    if (braceMatch) {
      const items = braceMatch[1].split(',');
      for (const item of items) {
        const cleaned = item.trim();
        if (!cleaned) continue;
        const asParts = cleaned.split(/\s+as\s+/);
        const localName = (asParts[1] || asParts[0]).trim();
        if (localName) imports.set(localName, resolved);
      }
    }

    // Default import before comma or standalone
    const defaultPart = clause.replace(/\{[\s\S]*?\}/, '').replace(',', '').trim();
    if (defaultPart && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(defaultPart)) {
      imports.set(defaultPart, resolved);
    }
  }

  return imports;
}

function isRouterIdentifierInFile(fileAbs: string, ident: string): boolean {
  if (!fs.existsSync(fileAbs)) return false;
  const raw = fs.readFileSync(fileAbs, 'utf8');
  const code = stripCommentsPreservingStrings(raw);
  const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const routerDeclRegex = new RegExp(
    `\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b[^=]*=\\s*(?:express\\.)?Router\\s*\\(`
  );
  return routerDeclRegex.test(code);
}

/**
 * Checks whether a call expression like `app.use(...)` at `callIndex` is enclosed inside an `if (...)` block.
 */
function isInsideConditionalBlock(code: string, targetIndex: number): boolean {
  const before = code.slice(0, targetIndex);
  // Look for an unclosed `if (...) {` block before targetIndex
  const ifRegex = /\bif\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = ifRegex.exec(before)) !== null) {
    const parenOpen = match.index + match[0].length - 1;
    const parenClose = findMatchingParen(before, parenOpen);
    if (parenClose === -1) continue;
    let cursor = parenClose + 1;
    while (cursor < before.length && /\s/.test(before[cursor])) cursor++;
    if (before[cursor] !== '{') continue;
    // Check if brace is still open at targetIndex
    let depth = 0;
    let i = cursor;
    while (i < before.length) {
      const c = before[i];
      if (c === "'" || c === '"' || c === '`') {
        const q = c;
        i++;
        while (i < before.length) {
          if (before[i] === '\\') {
            i += 2;
            continue;
          }
          if (before[i] === q) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    if (depth > 0) return true;
  }
  return false;
}

function parseAppMounts(rootDir: string): RouterMount[] {
  const appAbs = path.resolve(rootDir, APP_TS_REL);
  const raw = fs.readFileSync(appAbs, 'utf8');
  const code = stripCommentsPreservingStrings(raw);
  const imports = parseImports(code, appAbs);

  const mounts: RouterMount[] = [];
  const callRegex = /\bapp\.use\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = callRegex.exec(code)) !== null) {
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = findMatchingParen(code, openIdx);
    if (closeIdx === -1) continue;

    const inner = code.slice(openIdx + 1, closeIdx);
    const args = splitTopLevelArgs(inner);
    if (args.length >= 2) {
      const mountPath = unquoteStringLiteral(args[0]);
      const routerIdent = args[1].trim();
      if (mountPath && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(routerIdent)) {
        const targetFile = imports.get(routerIdent);
        if (targetFile && isRouterIdentifierInFile(targetFile, routerIdent)) {
          mounts.push({
            routerVar: routerIdent,
            filePath: targetFile,
            prefix: normalizeUrlPath(mountPath),
            conditional: isInsideConditionalBlock(code, match.index),
          });
        }
      }
    }
  }

  return mounts;
}

function parseRouterFile(
  rootDir: string,
  mount: RouterMount,
  visitedFiles: Set<string>,
  endpoints: EndpointRecord[]
): void {
  const raw = fs.readFileSync(mount.filePath, 'utf8');
  const code = stripCommentsPreservingStrings(raw);
  const imports = parseImports(code, mount.filePath);
  const relSource = toPosix(path.relative(rootDir, mount.filePath));
  visitedFiles.add(relSource);

  const escapedVar = mount.routerVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const callRegex = new RegExp(`\\b${escapedVar}\\.(use|get|post|put|patch|delete)\\s*\\(`, 'g');
  let match: RegExpExecArray | null;

  while ((match = callRegex.exec(code)) !== null) {
    const op = match[1].toLowerCase();
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = findMatchingParen(code, openIdx);
    if (closeIdx === -1) continue;

    const inner = code.slice(openIdx + 1, closeIdx);
    const args = splitTopLevelArgs(inner);
    if (args.length < 2) continue;

    const subPath = unquoteStringLiteral(args[0]);
    if (subPath === null) continue;

    if (op === 'use') {
      const childIdent = args[args.length - 1].trim();
      const childFile = imports.get(childIdent);
      if (childFile && isRouterIdentifierInFile(childFile, childIdent)) {
        const childPrefix = normalizeUrlPath(mount.prefix, subPath);
        const childConditional = mount.conditional || isInsideConditionalBlock(code, match.index);
        parseRouterFile(
          rootDir,
          {
            routerVar: childIdent,
            filePath: childFile,
            prefix: childPrefix,
            conditional: childConditional,
          },
          visitedFiles,
          endpoints
        );
      }
      continue;
    }

    if (!HTTP_METHODS.has(op)) continue;

    const method = op.toUpperCase() as HttpMethod;
    const fullPath = normalizeUrlPath(mount.prefix, subPath);
    const middlewareAndHandlerArgs = args.slice(1);
    const middlewareArgs = middlewareAndHandlerArgs.slice(0, -1);
    const fullCallText = middlewareAndHandlerArgs.join(', ');

    const hasRequireAuth = middlewareArgs.some((a) => /\brequireAuth\b/.test(a));
    const hasPlatformAdmin = middlewareArgs.some((a) => /\brequirePlatformAdmin\b/.test(a));

    const permissionMatches = Array.from(fullCallText.matchAll(/\bPERMISSIONS\.([A-Z0-9_]+)\b/g)).map(
      (m) => `PERMISSIONS.${m[1]}`
    );
    const permissions = Array.from(new Set(permissionMatches));

    let classification: AuthClassification;
    let authorizationLabel: string;

    const endpointKey = `${method} ${fullPath}`;
    if (!hasRequireAuth) {
      if (ALLOWED_PUBLIC_ENDPOINTS.has(endpointKey)) {
        classification = 'PUBLIC';
        authorizationLabel = 'PUBLIC (allowlisted)';
      } else {
        classification = 'UNCLASSIFIED';
        authorizationLabel = 'UNCLASSIFIED (missing requireAuth)';
      }
    } else if (hasPlatformAdmin) {
      classification = 'PLATFORM_ADMIN';
      authorizationLabel =
        permissions.length > 0
          ? `requirePlatformAdmin, ${permissions.join(', ')}`
          : 'requirePlatformAdmin';
    } else if (permissions.length > 0) {
      classification = 'PERMISSION';
      authorizationLabel = permissions.join(', ');
    } else if (ALLOWED_SELF_SERVICE_ENDPOINTS.has(endpointKey)) {
      classification = 'AUTH_SELF_SERVICE';
      authorizationLabel = 'AUTH_SELF_SERVICE (requireAuth only)';
    } else {
      classification = 'UNCLASSIFIED';
      authorizationLabel = 'UNCLASSIFIED (no PERMISSIONS.* or requirePlatformAdmin)';
    }

    endpoints.push({
      prefix: mount.prefix,
      method,
      path: fullPath,
      requireAuth: hasRequireAuth,
      permissions,
      requirePlatformAdmin: hasPlatformAdmin,
      classification,
      authorizationLabel,
      sourceFile: relSource,
      conditional: mount.conditional,
    });
  }
}

function renderMatrixMarkdown(endpoints: EndpointRecord[], mountedFilesCount: number): string {
  const sorted = [...endpoints].sort((a, b) => {
    const pCmp = a.path.localeCompare(b.path);
    if (pCmp !== 0) return pCmp;
    return a.method.localeCompare(b.method);
  });

  const total = sorted.length;
  const publicCount = sorted.filter((e) => e.classification === 'PUBLIC').length;
  const selfServiceCount = sorted.filter((e) => e.classification === 'AUTH_SELF_SERVICE').length;
  const platformAdminCount = sorted.filter((e) => e.classification === 'PLATFORM_ADMIN').length;
  const permissionProtectedCount = sorted.filter((e) => e.classification === 'PERMISSION').length;
  const conditionalCount = sorted.filter((e) => e.conditional).length;

  const lines: string[] = [
    '# Endpoint Permission Matrix',
    '',
    '<!-- Auto-generated by scripts/verifyEndpointPermissionMatrix.ts (--write). Do not edit manually. -->',
    '',
    '## Summary',
    '',
    '- **Total Mounted Endpoints**: ' + total,
    '- **Mounted Route Modules Parsed**: ' + mountedFilesCount,
    '- **RBAC Permission-Guarded (`PERMISSIONS.*`)**: ' + permissionProtectedCount,
    '- **Platform Admin-Only (`requirePlatformAdmin`)**: ' + platformAdminCount,
    '- **Authenticated Self-Service (`requireAuth` only)**: ' + selfServiceCount,
    '- **Public Endpoints (`requireAuth: false`)**: ' +
      publicCount +
      ' (`GET /api/auth/csrf`, `POST /api/auth/login`, `POST /api/auth/logout`)',
    '- **Conditional Env-Gated Endpoints**: ' +
      conditionalCount +
      ' (`ENABLE_TENANT_DEMO=1`, non-production only)',
    '',
    '## Matrix',
    '',
    '| Prefix | Method | Path | requireAuth | Authorization (`PERMISSIONS.*` / `requirePlatformAdmin`) | Source |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const ep of sorted) {
    const authBadge = ep.requireAuth ? 'true' : 'false';
    const condSuffix = ep.conditional ? ' *(conditional)*' : '';
    const authz = `\`${ep.authorizationLabel}\`${condSuffix}`;
    lines.push(
      `| \`${ep.prefix}\` | \`${ep.method}\` | \`${ep.path}\` | \`${authBadge}\` | ${authz} | \`${ep.sourceFile}\` |`
    );
  }

  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const writeMode = args.has('--write');
  const rootDir = process.cwd();

  let passed = 0;
  let failed = 0;

  function record(ok: boolean, label: string, detail?: string): void {
    if (ok) {
      passed++;
      console.log(`[PASS] ${label}${detail ? ` - ${detail}` : ''}`);
    } else {
      failed++;
      console.error(`[FAIL] ${label}${detail ? ` - ${detail}` : ''}`);
    }
  }

  // 1. Parse mounts from src/server/app.ts and traverse mounted routers
  const mounts = parseAppMounts(rootDir);
  const visitedFiles = new Set<string>();
  const endpoints: EndpointRecord[] = [];

  for (const mount of mounts) {
    parseRouterFile(rootDir, mount, visitedFiles, endpoints);
  }

  record(
    mounts.length > 0 && endpoints.length > 0,
    'Parse router mounts from src/server/app.ts and *Routes.ts',
    `${mounts.length} app mounts, ${endpoints.length} endpoints across ${visitedFiles.size} route files`
  );

  // 2. Ensure every src/server/routes/*Routes.ts file is mounted & parsed
  const routesDirAbs = path.resolve(rootDir, ROUTES_DIR_REL);
  const routeFiles = fs
    .readdirSync(routesDirAbs)
    .filter((f) => f.endsWith('Routes.ts'))
    .map((f) => `${ROUTES_DIR_REL}/${f}`)
    .sort();

  const unmountedRouteFiles = routeFiles.filter((f) => !visitedFiles.has(f));
  record(
    unmountedRouteFiles.length === 0,
    'All src/server/routes/*Routes.ts files are mounted from src/server/app.ts',
    unmountedRouteFiles.length > 0
      ? `Unmounted: ${unmountedRouteFiles.join(', ')}`
      : `${routeFiles.length}/${routeFiles.length} mounted`
  );

  // 3. Enforce strict public allowlist
  const actualPublic = endpoints
    .filter((e) => !e.requireAuth)
    .map((e) => `${e.method} ${e.path}`)
    .sort();
  const expectedPublic = Array.from(ALLOWED_PUBLIC_ENDPOINTS).sort();
  const publicMatches =
    actualPublic.length === expectedPublic.length &&
    actualPublic.every((val, idx) => val === expectedPublic[idx]);

  record(
    publicMatches,
    'Public endpoints strictly restricted to GET /api/auth/csrf, POST /api/auth/login, POST /api/auth/logout',
    `Found: ${actualPublic.join(', ') || '(none)'}`
  );

  // 4. Ensure zero unclassified endpoints
  const unclassified = endpoints.filter((e) => e.classification === 'UNCLASSIFIED');
  record(
    unclassified.length === 0,
    'Every endpoint is explicitly classified (PERMISSIONS.*, requirePlatformAdmin, AUTH_SELF_SERVICE, or allowlisted PUBLIC)',
    unclassified.length > 0
      ? `Unclassified: ${unclassified.map((u) => `${u.method} ${u.path} (${u.sourceFile})`).join('; ')}`
      : `${endpoints.length}/${endpoints.length} classified`
  );

  // 5. Generate markdown and either --write or verify exact match
  const generated = renderMatrixMarkdown(endpoints, visitedFiles.size);
  const docAbs = path.resolve(rootDir, MATRIX_DOC_REL);

  if (writeMode) {
    fs.mkdirSync(path.dirname(docAbs), { recursive: true });
    fs.writeFileSync(docAbs, generated, 'utf8');
    record(
      true,
      `Regenerated ${MATRIX_DOC_REL} via --write`,
      `${endpoints.length} endpoints written`
    );
  } else {
    if (!fs.existsSync(docAbs)) {
      record(
        false,
        `${MATRIX_DOC_REL} matches live parse exactly`,
        `Missing file ${MATRIX_DOC_REL}; run with --write to generate`
      );
    } else {
      const committed = fs.readFileSync(docAbs, 'utf8').replace(/\r\n/g, '\n');
      const normalizedGenerated = generated.replace(/\r\n/g, '\n');
      if (committed === normalizedGenerated) {
        record(
          true,
          `${MATRIX_DOC_REL} matches live parse exactly`,
          `${endpoints.length} endpoints verified with zero drift`
        );
      } else {
        const committedLines = committed.split('\n');
        const generatedLines = normalizedGenerated.split('\n');
        const firstDiffIdx = Math.max(
          0,
          committedLines.findIndex((line, i) => line !== generatedLines[i])
        );
        const diffDetail = `Drift at line ${firstDiffIdx + 1}: committed=${JSON.stringify(
          committedLines[firstDiffIdx] ?? '<EOF>'
        )} vs live=${JSON.stringify(generatedLines[firstDiffIdx] ?? '<EOF>')}`;
        record(false, `${MATRIX_DOC_REL} matches live parse exactly`, diffDetail);
      }
    }
  }

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed} | Blocked: 0`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
