// Playwright config for the real-browser scenarios in e2e/ (Oct 8). These
// are NOT part of `npm test` / CI: vitest only picks up src/**/*.test.*, and
// nothing here is wired into package.json scripts. Run them by hand against
// a local backend (localhost:8000, NEXUS_SKIP_AUTH) and a Vite dev server:
//
//   cd frontend && npx vite --port 5175      # in one terminal
//   npx playwright test                       # in another (add --headed to watch)
//
// E2E_BASE_URL overrides the Vite address.
import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/test-results', // gitignored (root .gitignore: e2e/test-results/)
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5175',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
  },
});
