// Tiny, stable helper API for AI-generated Nexus specs. Generated tests may use
// ONLY these helpers — constraining the surface is what keeps ~generated code
// reliable across UI drift. Mirrors the in-app flow recorder's find strategy.
import { expect } from '@playwright/test';

export async function openApp(page) {
  await page.goto('/');
  // Sidebar renders once the app shell is up (VITE_E2E skips the MSAL gate).
  await page.locator('.app-container, aside, nav').first().waitFor({ timeout: 20_000 });
}

export async function go(page, view) {
  await page.goto(`/${view}`);
  await page.waitForTimeout(800);
}

export async function clickByText(page, text) {
  const byRole = page.getByRole('button', { name: text, exact: false }).first();
  if (await byRole.count()) { await byRole.click(); return; }
  const byLabel = page.locator(`[aria-label="${text}"]`).first();
  if (await byLabel.count()) { await byLabel.click(); return; }
  await page.getByText(text, { exact: false }).first().click();
}

export async function fillByLabel(page, label, value) {
  const byPlaceholder = page.getByPlaceholder(label, { exact: false }).first();
  if (await byPlaceholder.count()) { await byPlaceholder.fill(value); return; }
  const byAria = page.locator(`input[aria-label="${label}"], textarea[aria-label="${label}"]`).first();
  if (await byAria.count()) { await byAria.fill(value); return; }
  await page.getByLabel(label, { exact: false }).first().fill(value);
}

export async function selectByLabel(page, label, optionText) {
  const sel = page.locator('select').filter({ hasText: optionText }).first();
  await sel.selectOption({ label: optionText });
}

export async function expectVisible(page, text) {
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
}
