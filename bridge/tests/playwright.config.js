const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://localhost:${process.env.TEST_HTTP_PORT || 9222}`,
    screenshot: 'on',
    video: 'on',
    trace: 'retain-on-failure',
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './test-results/html' }],
  ],
  outputDir: './test-results/artifacts',
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', viewport: { width: 900, height: 800 } },
    },
  ],
  webServer: {
    command: 'node serve.js',
    port: parseInt(process.env.TEST_HTTP_PORT) || 9222,
    reuseExistingServer: true,
    timeout: 10000,
  },
});
