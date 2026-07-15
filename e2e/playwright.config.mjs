import { defineConfig } from '@playwright/test';

// Runs against a self-contained local stack (CI starts backend :8000 with
// NEXUS_SKIP_AUTH + NEXUS_QA_MODULE and a fresh sqlite DB, plus the frontend
// built with VITE_E2E=true on :5173). Override with NEXUS_E2E_URL.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 1,
  workers: 2,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: process.env.NEXUS_E2E_URL || 'http://localhost:5173',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
});
