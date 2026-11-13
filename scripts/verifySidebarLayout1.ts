import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

interface TabSpec {
  key: string;
  label: string;
  title: string;
}

const ALL_TABS: TabSpec[] = [
  { key: 'companies', label: 'الشركات', title: 'الشركات' },
  { key: 'accounting', label: 'المحاسبة', title: 'المحاسبة' },
  { key: 'inventory', label: 'المخزون', title: 'المخزون' },
  { key: 'purchasing', label: 'المشتريات', title: 'المشتريات' },
  { key: 'users', label: 'المستخدمون', title: 'المستخدمون' },
  { key: 'roles', label: 'الأدوار والصلاحيات', title: 'الأدوار والصلاحيات' },
  { key: 'org_units', label: 'الوحدات التنظيمية', title: 'الوحدات التنظيمية' },
  { key: 'company_settings', label: 'إعدادات الشركة', title: 'إعدادات الشركة' },
  { key: 'custom_fields', label: 'الحقول الإضافية', title: 'الحقول الإضافية' },
  { key: 'config_platform', label: 'منصة الإعدادات', title: 'منصة الإعدادات' },
  { key: 'config_definitions', label: 'تعريفات الإعدادات', title: 'تعريفات الإعدادات' },
];

const VIEWPORTS = [
  { name: '1280', width: 1280, height: 800 },
  { name: '768', width: 768, height: 1024 },
  { name: '390', width: 390, height: 844 },
];

function resolvePlaywright(): any | null {
  const candidates = [
    'playwright',
    'playwright-core',
    '/usr/local/share/bun-global/node_modules/playwright-core',
    '/usr/local/lib/node_modules/playwright-core',
  ];
  for (const mod of candidates) {
    try {
      return require(mod);
    } catch {
      // try next
    }
  }
  return null;
}

function resolveChromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const known = [
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
  ];
  for (const p of known) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function isServerReachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function installSessionShim(page: any) {
  const sampleCompany = {
    id: 'comp-verify-1',
    name: 'شركة النور للتجارة والتوزيع',
    code: 'NOUR-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    isActive: true,
  };

  await page.route('**/api/**', async (route: any) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;

    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    if (pathname === '/api/auth/csrf') {
      return json({ status: 'ok', csrfToken: 'verify-csrf-token' });
    }
    if (pathname === '/api/auth/me') {
      return json({
        status: 'ok',
        user: { id: 'usr-verify-admin', username: 'verify_admin', role: 'platform_admin' },
        permissions: [
          'companies.read',
          'companies.write',
          'accounting.read',
          'accounting.write',
          'inventory.read',
          'inventory.write',
          'purchasing.read',
          'purchasing.write',
          'users.read',
          'users.write',
          'roles.read',
          'roles.write',
          'config.read',
          'config.write',
        ],
        memberships: [],
      });
    }
    if (pathname === '/api/companies') {
      return json({ status: 'ok', companies: [sampleCompany] });
    }
    if (pathname.endsWith('/org-units')) {
      return json({
        status: 'ok',
        orgUnits: [
          { id: 'org-1', companyId: sampleCompany.id, code: 'HQ', name: 'المركز الرئيسي', type: 'branch', parentId: null, isActive: true },
        ],
      });
    }
    if (pathname.endsWith('/settings')) {
      return json({
        status: 'ok',
        settings: {
          companyId: sampleCompany.id,
          baseCurrency: 'SAR',
          fiscalYearStartMonth: 1,
          timezone: 'Asia/Riyadh',
        },
      });
    }
    if (pathname.endsWith('/custom-fields')) {
      return json({ status: 'ok', fields: [] });
    }
    if (pathname === '/api/accounting/accounts') {
      return json({
        status: 'ok',
        accounts: [
          { id: 'acc-1', companyId: sampleCompany.id, code: '1101', name: 'الصندوق الرئيسي', type: 'asset', isActive: true },
          { id: 'acc-2', companyId: sampleCompany.id, code: '2101', name: 'الموردون', type: 'liability', isActive: true },
        ],
      });
    }
    if (pathname === '/api/accounting/journals') {
      return json({ status: 'ok', journals: [] });
    }
    if (pathname === '/api/accounting/periods') {
      return json({ status: 'ok', periods: [] });
    }
    if (pathname === '/api/accounting/gl-events') {
      return json({ status: 'ok', events: [] });
    }
    if (pathname.startsWith('/api/inventory/')) {
      return json({ status: 'ok', warehouses: [], items: [], balances: [], movements: [] });
    }
    if (pathname.startsWith('/api/purchasing/')) {
      return json({ status: 'ok', suppliers: [], receipts: [], grns: [] });
    }
    if (pathname === '/api/users') {
      return json({
        status: 'ok',
        users: [{ id: 'usr-verify-admin', username: 'verify_admin', role: 'platform_admin', isActive: true, createdAt: '2026-01-01T00:00:00.000Z' }],
      });
    }
    if (pathname === '/api/roles') {
      return json({ status: 'ok', roles: [] });
    }
    if (pathname.startsWith('/api/config/')) {
      return json({ status: 'ok', definitions: [], versions: [] });
    }
    return json({ status: 'ok' });
  });
}

async function main() {
  const phase = process.env.VERIFY_PHASE === 'before' ? 'before' : 'after';
  const appUrl = process.env.VERIFY_APP_URL || 'http://127.0.0.1:3000';
  const username = process.env.VERIFY_USERNAME || process.env.PLATFORM_ADMIN_USERNAME || '';
  const password = process.env.VERIFY_PASSWORD || process.env.PLATFORM_ADMIN_PASSWORD || '';
  const useSessionShim = process.env.VERIFY_SESSION_SHIM === '1';

  const pw = resolvePlaywright();
  if (!pw) {
    console.log('[BLOCKED] Playwright/playwright-core is not installed in this environment.');
    process.exit(2);
  }

  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    console.log('[BLOCKED] Chromium headless binary not found in this environment.');
    process.exit(2);
  }

  if (!(await isServerReachable(appUrl))) {
    console.log(`[BLOCKED] App server is not reachable at ${appUrl}. Start npm run dev before running browser layout verification.`);
    process.exit(2);
  }

  if (!useSessionShim && (!username || !password)) {
    console.log('[BLOCKED] VERIFY_USERNAME/VERIFY_PASSWORD (or VERIFY_SESSION_SHIM=1) not provided.');
    process.exit(2);
  }

  const reportsDir = path.resolve(process.cwd(), '.test-reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  console.log(`=== verifySidebarLayout1 (phase=${phase}, authMode=${useSessionShim ? 'session-shim' : 'live-login'}) ===`);
  console.log(`Target: ${appUrl}`);

  const chromium = pw.chromium;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const results: Array<{
    viewport: number;
    tab: string;
    titleMatch: boolean;
    asidePosition: string;
    asideWidth: number;
    mainWidth: number;
    scrollWidth: number;
    innerWidth: number;
    overflowX: boolean;
    sidebarClosedAfterNav: boolean;
    hamburgerVisibleWhenClosed: boolean;
    pass: boolean;
    screenshot?: string;
  }> = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar' });
    const page = await context.newPage();

    page.on('console', (msg: any) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('WebSocket') && !text.includes('hmr')) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', (err: Error) => {
      pageErrors.push(err.message);
    });

    if (useSessionShim) {
      await installSessionShim(page);
    }

    await page.goto(appUrl, { waitUntil: 'networkidle' });

    if (!useSessionShim) {
      const userInput = page.locator('input[type="text"]');
      await userInput.waitFor({ state: 'visible', timeout: 10000 });
      await userInput.fill(username);
      await page.locator('input[type="password"]').fill(password);

      const submitBtn = page.locator('button[type="submit"]');
      await page.waitForFunction(
        () => {
          const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
          return Boolean(btn && !btn.disabled);
        },
        null,
        { timeout: 10000 }
      );
      await submitBtn.click();
    }

    await page.locator('aside').waitFor({ state: 'attached', timeout: 15000 });
    await page.locator('main h2').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(400);

    for (const vp of VIEWPORTS) {
      console.log(`\n--- Viewport ${vp.width}x${vp.height} ---`);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(300);

      if (phase === 'after') {
        const initialState = await page.evaluate(() => {
          const aside = document.querySelector('aside');
          const asideStyle = aside ? window.getComputedStyle(aside) : null;
          const asideRect = aside ? aside.getBoundingClientRect() : null;
          const hamburger = document.querySelector('button[aria-label="فتح القائمة"]');
          const hamburgerVisible = Boolean(
            hamburger && window.getComputedStyle(hamburger).display !== 'none' && hamburger.getBoundingClientRect().width > 0
          );
          const asideVisible = Boolean(
            aside &&
              asideStyle &&
              asideStyle.display !== 'none' &&
              asideStyle.visibility !== 'hidden' &&
              asideRect &&
              asideRect.width > 0 &&
              asideRect.right > 0 &&
              asideRect.left < window.innerWidth
          );
          return { asideVisible, hamburgerVisible };
        });

        if (vp.width >= 1024) {
          if (!initialState.asideVisible) {
            throw new Error(`[FAIL] At ${vp.width}px, sidebar should be visible by default.`);
          }
          if (initialState.hamburgerVisible) {
            throw new Error(`[FAIL] At ${vp.width}px while sidebar is open, hamburger button must NOT be visible.`);
          }
          const closeBtn = page.locator('aside button[aria-label="إغلاق القائمة"]');
          if ((await closeBtn.count()) > 0) {
            await closeBtn.click();
            await page.waitForTimeout(250);
            const afterClose = await page.evaluate(() => {
              const main = document.querySelector('main');
              const hamburger = document.querySelector('button[aria-label="فتح القائمة"]');
              return {
                mainWidth: main ? Math.round(main.getBoundingClientRect().width) : 0,
                hamburgerVisible: Boolean(hamburger && hamburger.getBoundingClientRect().width > 0),
              };
            });
            if (!afterClose.hamburgerVisible || afterClose.mainWidth < vp.width - 10) {
              throw new Error(
                `[FAIL] At ${vp.width}px after closing desktop sidebar, expected full-width main & visible hamburger (got mainWidth=${afterClose.mainWidth}, hamburgerVisible=${afterClose.hamburgerVisible})`
              );
            }
            await page.locator('button[aria-label="فتح القائمة"]').click();
            await page.waitForTimeout(250);
          }
        } else {
          if (initialState.asideVisible) {
            throw new Error(`[FAIL] At ${vp.width}px (<1024), sidebar should be closed by default.`);
          }
          if (!initialState.hamburgerVisible) {
            throw new Error(`[FAIL] At ${vp.width}px (<1024) when sidebar is closed, hamburger button must be visible.`);
          }

          await page.locator('button[aria-label="فتح القائمة"]').click();
          await page.waitForTimeout(300);
          const drawerStats = await page.evaluate(() => {
            const aside = document.querySelector('aside');
            const backdrop = document.querySelector('[data-sidebar-backdrop="true"]');
            const main = document.querySelector('main');
            return {
              asidePosition: aside ? window.getComputedStyle(aside).position : 'none',
              asideZIndex: aside ? window.getComputedStyle(aside).zIndex : '0',
              backdropVisible: Boolean(backdrop && window.getComputedStyle(backdrop).display !== 'none'),
              mainWidth: main ? Math.round(main.getBoundingClientRect().width) : 0,
            };
          });
          if (drawerStats.asidePosition !== 'fixed') {
            throw new Error(`[FAIL] At ${vp.width}px, mobile sidebar must have position:fixed (got ${drawerStats.asidePosition})`);
          }
          if (!drawerStats.backdropVisible) {
            throw new Error(`[FAIL] At ${vp.width}px, dimmed backdrop must be visible when drawer is open`);
          }
          if (drawerStats.mainWidth < vp.width - 4) {
            throw new Error(`[FAIL] At ${vp.width}px, overlay drawer must not squeeze <main> (mainWidth=${drawerStats.mainWidth})`);
          }
          await page.screenshot({ path: path.join(reportsDir, `sidebar-after-${vp.name}px-drawer-open.png`), fullPage: false });

          await page.locator('[data-sidebar-backdrop="true"]').click({ position: { x: 10, y: 10 } });
          await page.waitForTimeout(250);
        }
      }

      for (const tab of ALL_TABS) {
        if (phase === 'after' && vp.width < 1024) {
          const hamburger = page.locator('button[aria-label="فتح القائمة"]');
          if ((await hamburger.count()) > 0 && (await hamburger.isVisible())) {
            await hamburger.click();
            await page.waitForTimeout(220);
          }
        }

        const navButton = page.locator(`aside button:has-text("${tab.label}")`).first();
        await navButton.waitFor({ state: 'attached', timeout: 5000 });
        await navButton.click();
        await page.waitForTimeout(350);

        const metrics = await page.evaluate((expectedTitle: string) => {
          const aside = document.querySelector('aside');
          const main = document.querySelector('main');
          const h2 = document.querySelector('main h2');
          const hamburger = document.querySelector('button[aria-label="فتح القائمة"]');

          const asideStyle = aside ? window.getComputedStyle(aside) : null;
          const asideRect = aside ? aside.getBoundingClientRect() : null;
          const mainRect = main ? main.getBoundingClientRect() : null;

          const asideVisible = Boolean(
            aside &&
              asideStyle &&
              asideStyle.display !== 'none' &&
              asideStyle.visibility !== 'hidden' &&
              asideRect &&
              asideRect.width > 0 &&
              asideRect.right > 0 &&
              asideRect.left < window.innerWidth
          );

          const hamburgerVisible = Boolean(
            hamburger &&
              window.getComputedStyle(hamburger).display !== 'none' &&
              hamburger.getBoundingClientRect().width > 0
          );

          const docScrollWidth = document.documentElement.scrollWidth;
          const bodyScrollWidth = document.body.scrollWidth;
          const innerWidth = window.innerWidth;
          const headingText = h2 ? h2.textContent?.trim() || '' : '';

          return {
            titleMatch: headingText === expectedTitle,
            headingText,
            asidePosition: asideStyle ? asideStyle.position : 'none',
            asideVisible,
            asideWidth: asideRect ? Math.round(asideRect.width) : 0,
            mainWidth: mainRect ? Math.round(mainRect.width) : 0,
            scrollWidth: Math.max(docScrollWidth, bodyScrollWidth),
            innerWidth,
            overflowX: Math.max(docScrollWidth, bodyScrollWidth) > innerWidth,
            hamburgerVisible,
          };
        }, tab.title);

        const sidebarClosedAfterNav = vp.width < 1024 ? !metrics.asideVisible : true;
        const hamburgerVisibleWhenClosed = vp.width < 1024 ? metrics.hamburgerVisible : !metrics.hamburgerVisible;

        let tabPass = true;
        if (phase === 'after') {
          tabPass =
            metrics.titleMatch &&
            !metrics.overflowX &&
            sidebarClosedAfterNav &&
            hamburgerVisibleWhenClosed &&
            (vp.width < 1024 ? metrics.mainWidth >= vp.width - 4 : metrics.mainWidth >= 900);
        }

        const captureTab =
          tab.key === 'companies' ||
          tab.key === 'accounting' ||
          tab.key === 'inventory' ||
          tab.key === 'users' ||
          tab.key === 'roles' ||
          metrics.overflowX ||
          !tabPass;

        const screenshotFile = `sidebar-${phase}-${vp.name}px-${tab.key}.png`;
        if (captureTab) {
          await page.screenshot({ path: path.join(reportsDir, screenshotFile), fullPage: false });
        }

        results.push({
          viewport: vp.width,
          tab: tab.key,
          titleMatch: metrics.titleMatch,
          asidePosition: metrics.asidePosition,
          asideWidth: metrics.asideWidth,
          mainWidth: metrics.mainWidth,
          scrollWidth: metrics.scrollWidth,
          innerWidth: metrics.innerWidth,
          overflowX: metrics.overflowX,
          sidebarClosedAfterNav,
          hamburgerVisibleWhenClosed,
          pass: tabPass,
          screenshot: captureTab ? screenshotFile : undefined,
        });

        console.log(
          `[${vp.width}px][${tab.key}] title="${metrics.headingText}" aside=${metrics.asidePosition}(${metrics.asideWidth}px,vis=${metrics.asideVisible}) main=${metrics.mainWidth}px scrollW=${metrics.scrollWidth}/${metrics.innerWidth} overflowX=${metrics.overflowX} pass=${tabPass}`
        );
      }
    }

    fs.writeFileSync(
      path.join(reportsDir, `sidebar-${phase}-summary.json`),
      JSON.stringify({ phase, timestamp: new Date().toISOString(), consoleErrors, pageErrors, results }, null, 2),
      'utf8'
    );

    if (phase === 'after') {
      const failures = results.filter((r) => !r.pass);
      if (failures.length > 0 || consoleErrors.length > 0 || pageErrors.length > 0) {
        console.error('\n[FAIL] Sidebar layout verification failed:');
        for (const f of failures) {
          console.error(
            `  - viewport=${f.viewport} tab=${f.tab}: titleMatch=${f.titleMatch} overflowX=${f.overflowX} scroll=${f.scrollWidth}/${f.innerWidth} mainWidth=${f.mainWidth} closed=${f.sidebarClosedAfterNav} hamburger=${f.hamburgerVisibleWhenClosed}`
          );
        }
        if (consoleErrors.length > 0) console.error('Console errors:', consoleErrors);
        if (pageErrors.length > 0) console.error('Page errors:', pageErrors);
        process.exit(1);
      }
      console.log(`\n[PASS] All ${results.length} tab×viewport checks passed with 0 horizontal overflow and 0 console/page errors.`);
    } else {
      const overflowCount = results.filter((r) => r.overflowX).length;
      const squeezedCount = results.filter((r) => r.viewport < 1024 && r.asideWidth >= 200).length;
      console.log(
        `\n[BEFORE REPRODUCTION COMPLETE] Tested ${results.length} tab×viewport pairs. Squeezed mobile/tablet views (<1024px with fixed sidebar): ${squeezedCount}. Overflowing views: ${overflowCount}.`
      );
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[FAIL] Unhandled error in verifySidebarLayout1:', err);
  process.exit(1);
});
