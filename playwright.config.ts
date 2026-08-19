import { defineConfig } from '@playwright/test';
import { env } from './config';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: require.resolve('./global-setup'),
  use: {
    baseURL: env.apiBaseUrl,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
  },
});
