import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './desktop/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 45_000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/desktop', open: 'never' }]],
  outputDir: 'test-results/desktop',
});
