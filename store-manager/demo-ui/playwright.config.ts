import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 150_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: process.env.DEMO_UI_BASE_URL || "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } },
  ],
});
