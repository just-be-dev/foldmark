import { defineConfig } from "@playwright/test";

const port = Number(process.env.FOLDMARK_TEST_PORT ?? 5176);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("FOLDMARK_TEST_PORT must be an integer from 1024 to 65535");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  outputDir: `./test-results/${port}`,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: `playwright-report/${port}` }]]
    : "list",
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-{platform}{ext}",
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide" },
  },
  use: {
    baseURL,
    viewport: { width: 1440, height: 1100 },
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: `bun run dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
