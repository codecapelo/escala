import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  globalSetup: "./tests/e2e/global-setup.ts",
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  retries: 0,
  outputDir: "private/playwright-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "private/playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:5273",
    locale: "pt-BR",
    timezoneId: "America/Fortaleza",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      command: "node tests/e2e/local-server.mjs api",
      url: "http://127.0.0.1:3101/api/health",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "node tests/e2e/local-server.mjs vite",
      url: "http://127.0.0.1:5273",
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
