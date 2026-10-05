import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:5176',
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5176 --strictPort',
    url: 'http://localhost:5176',
    reuseExistingServer: !process.env.CI,
  },
})
