const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/responsive',
  testMatch: '**/*.spec.js',
  outputDir: 'test-results/responsive',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 45000,
  expect: { timeout: 8000 },
  reporter: 'list',
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure', actionTimeout: 10000 },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) } },
    { name: 'webkit', use: { browserName: 'webkit' } }
  ]
});
