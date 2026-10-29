import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      grep: /Chromium/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit",
      grep: /WebKit/,
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5000/vsl",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
