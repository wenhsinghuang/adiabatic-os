import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1280, height: 900 },
    // Save screenshots on failure
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // Don't start server — assume Docker is already running
  webServer: undefined,
});
