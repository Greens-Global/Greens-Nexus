// Committed baseline spec — proves the CI stack itself works even before any
// AI-generated specs exist. No [caseId] prefix, so its verdict is not uploaded.
import { test } from '@playwright/test';
import { openApp, go, clickByText, fillByLabel, expectVisible } from '../helpers.mjs';

test('app boots and the dashboard renders', async ({ page }) => {
  await openApp(page);
  await expectVisible(page, 'Quick actions');
});

test('testing module: create a run and see the seeded library', async ({ page }) => {
  await openApp(page);
  await go(page, 'testing');
  await expectVisible(page, 'Run the QA test cases');
  await clickByText(page, 'New run');
  await fillByLabel(page, 'e.g. Jul 15 regression', 'CI smoke run');
  await clickByText(page, 'Create');
  await expectVisible(page, 'Item Management');
});
