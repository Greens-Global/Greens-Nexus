// Sheets and live editing in Documents (Neil, 11/05/2026). The CI stack has
// no Realtime, so two people editing at once meet only through their saves:
// the later save gets a 409, merges the newer saved state and sends again -
// both edits must survive. Also: a formula computes and a reload keeps it.
import { test, expect } from '@playwright/test';
import { openApp } from '../helpers.mjs';

// Every extra person is its own browser context, closed when the test ends:
// a context left open keeps polling the app and eats the per-IP rate budget.
let contexts = [];
async function person(browser) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  return ctx.newPage();
}
test.afterEach(async () => { await Promise.all(contexts.map((c) => c.close().catch(() => {}))); contexts = []; });

async function skipTour(page) {
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  if (await skip.count()) await skip.first().click().catch(() => {});
}

async function openRow(page, title) {
  await page.goto('/documents');
  await skipTour(page);
  // The library opens on whichever view has work waiting: look in All Documents, by title.
  await page.locator('.nx-dl-rail button', { hasText: 'All Documents' }).click();
  await page.getByLabel('Search documents').fill(title);
  await page.locator('td.nx-dl-name', { hasText: title }).first().click();
  await page.locator('.nx-dl-actions button', { hasText: /^Open$/ }).click();
}

async function openSheet(page, title) {
  await openRow(page, title);
  await expect(page.locator('[role=grid]')).toBeVisible({ timeout: 20_000 });
}

async function typeAt(page, moves, text) {
  await page.locator('[role=grid]').focus();
  await page.keyboard.press('Control+Home');
  for (const k of moves) await page.keyboard.press(k);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('a sheet computes, saves and reopens', async ({ page }) => {
  const title = `E2E Sheet ${Date.now()}`;
  await openApp(page);
  await page.goto('/documents');
  await skipTour(page);
  await page.getByRole('button', { name: 'New Sheet' }).click();
  await expect(page.locator('[role=grid]')).toBeVisible({ timeout: 20_000 });
  const name = page.getByLabel('Sheet name');
  await name.fill(title);
  await name.press('Enter');
  await typeAt(page, [], '100');
  await typeAt(page, ['ArrowDown'], '250');
  await typeAt(page, ['ArrowDown', 'ArrowDown'], '=SUM(A1:A2)*10%');
  await expect(page.locator('.dl-sheet-save')).toHaveText('Saved', { timeout: 10_000 });
  await openSheet(page, title);
  await expect(page.locator('[role=grid]')).toContainText('35');
});

test('two people editing at once both keep their edits', async ({ browser }) => {
  const title = `E2E Shared ${Date.now()}`;
  const a = await person(browser);
  await openApp(a);
  await a.goto('/documents');
  await skipTour(a);
  await a.getByRole('button', { name: 'New Sheet' }).click();
  await expect(a.locator('[role=grid]')).toBeVisible({ timeout: 20_000 });
  await a.getByLabel('Sheet name').fill(title);
  await a.getByLabel('Sheet name').press('Enter');
  await expect(a.locator('.dl-sheet-title')).toHaveValue(title);

  const b = await person(browser);
  await openApp(b);
  await openSheet(b, title);

  await Promise.all([typeAt(a, ['ArrowRight'], 'From A'), typeAt(b, ['ArrowRight', 'ArrowRight'], 'From B')]);
  await expect(a.locator('.dl-sheet-save')).toHaveText('Saved', { timeout: 15_000 });
  await expect(b.locator('.dl-sheet-save')).toHaveText('Saved', { timeout: 15_000 });

  await openSheet(a, title);
  await expect(a.locator('[role=grid]')).toContainText('From A');
  await expect(a.locator('[role=grid]')).toContainText('From B');
});

test('two people typing in one document both keep their words', async ({ browser }) => {
  const title = `E2E Doc ${Date.now()}`;
  const a = await person(browser);
  await openApp(a);
  await a.goto('/documents');
  await skipTour(a);
  await a.getByRole('button', { name: 'New Document' }).first().click();
  await a.locator('.modal-content input').first().fill(title);
  await a.locator('.modal-content input').first().press('Enter');
  const pageA = a.locator('.doc-page .ProseMirror').first();
  await expect(pageA).toBeVisible({ timeout: 20_000 });

  const b = await person(browser);
  await openApp(b);
  await openRow(b, title);
  const pageB = b.locator('.doc-page .ProseMirror').first();
  await expect(pageB).toBeVisible({ timeout: 20_000 });

  await pageA.click();
  await pageB.click();
  await Promise.all([a.keyboard.type('Words from A. '), b.keyboard.type('Words from B. ')]);
  await expect(a.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(b.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
  await a.waitForTimeout(2500);   // the later save merges and resends

  const c = await person(browser);
  await openApp(c);
  await openRow(c, title);
  const pageC = c.locator('.doc-page .ProseMirror').first();
  await expect(pageC).toContainText('Words from A.', { timeout: 20_000 });
  await expect(pageC).toContainText('Words from B.');
});
