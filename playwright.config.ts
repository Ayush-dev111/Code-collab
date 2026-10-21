import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const baseURL = process.env.COLLAB_E2E_BASE_URL;
if (
  !baseURL ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
)
  throw new Error(
    "Run Playwright through test:phase8 against its isolated local servers.",
  );
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120000,
  expect: { timeout: 15000 },
  outputDir: resolve("../../.tools/playwright-results"),
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: resolve("../../.tools/playwright-report"),
        open: "never",
      },
    ],
  ],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROME_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL }
      : {},
  },
});
