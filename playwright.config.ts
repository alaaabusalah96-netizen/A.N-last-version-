import fs from 'fs';
import { defineConfig } from 'playwright/test';

function resolveChromiumExecutable(): string | undefined {
  if (
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH &&
    fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
  ) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }

  const knownPaths = [
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
  ];

  for (const candidate of knownPaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

const baseURL = (
  process.env.E2E_BASE_URL ||
  process.env.VERIFY_APP_URL ||
  'http://127.0.0.1:3000'
).replace(/\/+$/, '');

const executablePath = resolveChromiumExecutable();

export default defineConfig({
  testDir: './e2e',
  outputDir: '.test-reports/playwright-results',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    locale: 'ar',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  },
  webServer:
    process.env.E2E_SKIP_WEBSERVER === '1'
      ? undefined
      : {
          command: 'npm run dev',
          url: baseURL,
          reuseExistingServer: true,
          timeout: 60_000,
        },
});
