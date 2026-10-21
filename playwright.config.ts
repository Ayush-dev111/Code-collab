import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Tests talk to the database directly for setup and cleanup.
if (existsSync(".env")) process.loadEnvFile(".env");

const baseURL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests",
  testIgnore: "unit/**",
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Set PLAYWRIGHT_CHANNEL=chrome to use an installed Chrome instead.
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
  },
  // Reuses a running `npm run dev`; otherwise starts the production build.
  webServer: {
    command: "npm start",
    url: `${baseURL}/login`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
