import { defineConfig } from '@playwright/test';

// Standalone run of the PDF Tools engine spec: no backend, no frontend server.
// The spec starts its own tiny static server for frontend/public/pdf-editor-app
// and generates every fixture PDF itself.
//   npx playwright test -c pdf-tools.config.mjs
// Locally only Chrome is installed; CI has the Playwright chromium.
export default defineConfig({
  testDir: './tests',
  testMatch: 'pdf-tools.spec.mjs',
  timeout: 120_000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  reporter: [['list']],
  use: {
    actionTimeout: 30_000,
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  },
});
