import { test, expect, type Page } from 'playwright/test';

async function assertNonBlankScreen(page: Page, stage: string) {
  const rootBox = await page.locator('#root').boundingBox();
  expect(rootBox, `[${stage}] Blank screen detected: #root bounding box is missing`).not.toBeNull();
  expect(
    (rootBox?.width ?? 0) > 0 && (rootBox?.height ?? 0) > 0,
    `[${stage}] Blank screen detected: #root dimensions are ${rootBox?.width}x${rootBox?.height}`
  ).toBe(true);

  const visibleTextLen = await page.evaluate(() => (document.body.innerText || '').trim().length);
  expect(visibleTextLen, `[${stage}] Blank screen detected: document.body has no visible text`).toBeGreaterThan(0);
}

test('real browser login, shell render, and workspace navigation smoke flow', async ({ page }) => {
  const pageErrors: string[] = [];
  const postLogin401s: string[] = [];
  let isAuthenticated = false;

  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  page.on('response', (res) => {
    if (isAuthenticated && res.status() === 401 && res.url().includes('/api/')) {
      postLogin401s.push(`${res.status()} ${res.url()}`);
    }
  });

  // 1. Open login entry point and verify non-blank render + CSRF init
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول' })).toBeVisible({ timeout: 15_000 });
  await assertNonBlankScreen(page, 'login-screen');

  const submitBtn = page.locator('button[type="submit"]');
  await expect(submitBtn).toBeEnabled({ timeout: 15_000 });
  await expect(submitBtn).toContainText('دخول');

  // 2. Require test login credentials strictly from environment (no hardcoded secrets)
  const username = (
    process.env.E2E_USERNAME ||
    process.env.VERIFY_USERNAME ||
    process.env.PLATFORM_ADMIN_USERNAME ||
    ''
  ).trim();
  const password = (
    process.env.E2E_PASSWORD ||
    process.env.VERIFY_PASSWORD ||
    process.env.PLATFORM_ADMIN_PASSWORD ||
    ''
  ).trim();

  if (!username || !password) {
    throw new Error(
      'BLOCKED: E2E login credentials are not configured. Provide E2E_USERNAME/E2E_PASSWORD (or VERIFY_USERNAME/VERIFY_PASSWORD or PLATFORM_ADMIN_USERNAME/PLATFORM_ADMIN_PASSWORD).'
    );
  }

  // 3. Submit real login form and fail clearly on 401 / 503 / non-200
  await page.locator('input[type="text"]').fill(username);
  await page.locator('input[type="password"]').fill(password);

  const loginResponsePromise = page.waitForResponse(
    (res) => res.url().includes('/api/auth/login') && res.request().method() === 'POST',
    { timeout: 15_000 }
  );
  await submitBtn.click();
  const loginRes = await loginResponsePromise;

  if (loginRes.status() === 401) {
    throw new Error('FAIL: Login returned HTTP 401 Unauthorized for the configured test user.');
  }
  if (loginRes.status() === 503) {
    throw new Error('BLOCKED: Login returned HTTP 503 Service Unavailable (database unavailable on API server).');
  }
  expect(loginRes.status(), `Unexpected login HTTP status: ${loginRes.status()}`).toBe(200);

  isAuthenticated = true;

  // 4. Verify authenticated shell + expected sidebar menu items (no blank screen, no 401)
  const sidebar = page.locator('aside');
  await expect(sidebar).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('main h2')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('جلسة نشطة:')).toBeVisible({ timeout: 15_000 });
  await assertNonBlankScreen(page, 'authenticated-home');

  await expect(sidebar.getByText('القائمة الرئيسية')).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'الشركات' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'المحاسبة' })).toBeVisible();

  const purchasingNavBtn = sidebar.getByRole('button', { name: 'المشتريات' });
  await expect(purchasingNavBtn).toBeVisible();

  // 5. Navigate to Purchasing workspace and verify expected UI content renders
  await purchasingNavBtn.click();
  await expect(page.locator('main h2')).toHaveText('المشتريات', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: /الموردون/ })).toBeVisible({ timeout: 10_000 });
  await assertNonBlankScreen(page, 'purchasing-workspace');

  // 6. Navigate to Cash & Custody workspace if permitted for this user role
  const cashNavBtn = sidebar.getByRole('button', { name: 'الخزينة والعهد' });
  if (await cashNavBtn.isVisible()) {
    await cashNavBtn.click();
    await expect(page.locator('main h2')).toHaveText('الخزينة والعهد', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'الخزينة والعهد النقدية' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('tab', { name: /الصناديق/ })).toBeVisible({ timeout: 10_000 });
    await assertNonBlankScreen(page, 'cash-custody-workspace');
  }

  expect(postLogin401s, `Unexpected 401 responses after login: ${postLogin401s.join(', ')}`).toEqual([]);
  expect(pageErrors, `Uncaught browser page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
