// PDF editor engine smoke - drives the static app directly (same-origin static
// assets, no MSAL needed). No [caseId] prefix, so its verdict is not uploaded.
// The sample document is generated in-page with the engine's own pdf-lib and
// handed to the drop zone, so the spec needs no binary fixture.
import { test, expect } from '@playwright/test';

const EDITOR = '/pdf-editor-app/index.html';

async function openSamplePdf(page, pages = 3) {
  await page.goto(EDITOR);
  await page.waitForFunction(() => window.PDFLib && window.pdfjsLib && window.fabric, null, { timeout: 20000 });
  await page.evaluate(async (n) => {
    const { PDFDocument, StandardFonts } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= n; i++) {
      const p = doc.addPage([612, 792]);
      p.drawText('Sample page ' + i + ' - Nexus e2e fixture', { x: 60, y: 720, size: 24, font });
      p.drawText('The quick brown fox jumps over the lazy dog.', { x: 60, y: 680, size: 12, font });
    }
    const bytes = await doc.save();
    const file = new File([bytes], 'sample.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.getElementById('dropZone').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, pages);
  await expect(page.locator('#fileInfo')).toContainText(`${pages} page(s)`, { timeout: 20000 });
}

test('opens a PDF and enters continuous scroll', async ({ page }) => {
  await openSamplePdf(page);
  await expect(page.locator('#continuousView')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.cv-page')).toHaveCount(3);
});

test('user scrolling is not yanked back by the scroll-mode settle', async ({ page }) => {
  await openSamplePdf(page);
  await page.waitForSelector('#continuousView');
  // Scroll immediately - the old settle loop re-asserted the target position
  // for ~330ms and pulled the view back out from under the user.
  await page.locator('#canvasScrollWrapper').hover();
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => document.getElementById('canvasScrollWrapper').scrollTop);
  await page.waitForTimeout(600); // outlives the old reassert window
  const after = await page.evaluate(() => document.getElementById('canvasScrollWrapper').scrollTop);
  expect(before).toBeGreaterThan(0);
  expect(Math.abs(after - before)).toBeLessThan(50);
});

test('clicking a page enters edit mode; invalid page input is rejected', async ({ page }) => {
  await openSamplePdf(page);
  await page.locator('.cv-page[data-page="2"]').click();
  await expect(page.locator('#canvasWrapper')).toBeVisible();
  const input = page.locator('#pageInput');
  await expect(input).toHaveValue('2');
  // Clearing the box and pressing Enter used to set currentPage = NaN and
  // break navigation; the guard now restores the current page number.
  await input.fill('');
  await input.press('Enter');
  await expect(input).toHaveValue('2');
});

test('page delete offers Undo and Undo restores the page', async ({ page }) => {
  await openSamplePdf(page);
  await page.locator('.cv-page[data-page="1"]').click(); // into edit mode
  const thumb = page.locator('.thumbnail-item[data-page="2"]');
  await thumb.hover();
  await thumb.locator('.delete-btn').click();
  await expect(page.locator('#fileInfo')).toContainText('2 page(s)', { timeout: 10000 });
  const undo = page.locator('.toast .toast-action', { hasText: 'Undo' });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(page.locator('#fileInfo')).toContainText('3 page(s)', { timeout: 10000 });
});

test('Save menu opens and PDF - All Pages downloads a file', async ({ page }) => {
  await openSamplePdf(page);
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
  await page.locator('#downloadBtn').click();
  await page.locator('#saveMenu .dropdown-item', { hasText: 'PDF - All Pages' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
});
