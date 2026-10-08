// Real-pointer scenarios for the Links launcher's drag-to-fold engine and
// the New Folder tile (Oct 8). Not part of `npm test` / CI - see
// playwright.config.js for how to run them. They drive a real Chromium with
// mouse and touch input against a local backend (localhost:8000 with
// NEXUS_SKIP_AUTH) and a Vite dev server, and they reset the signed-in
// user's link views between scenarios, so never point them at dev or prod.
import { test, expect } from 'playwright/test';

const API = process.env.E2E_API_BASE || 'http://localhost:8000';
// NEXUS_SKIP_AUTH ignores the bearer, but the request rate limiter keys on
// it: without one every call from this machine shares the anonymous per-IP
// budget (120/min), which a suite of page reloads blows through and the
// browser then sees 429s. With it, the calls get the signed-in budget.
const AUTH = { authorization: 'Bearer e2e-links-folding' };

// The backend only allows the 5173/5174 origins through CORS; this Vite runs
// on another port, so the browser's calls are proxied here with the headers
// added - nothing about the backend changes.
async function shimCors(context) {
  await context.route(`${API}/**`, async (route) => {
    const req = route.request();
    const cors = {
      'access-control-allow-origin': req.headers().origin || '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'Content-Disposition',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const resp = await route.fetch({ headers: { ...req.headers(), ...AUTH } });
    if (resp.status() >= 400) console.log(`[api] ${req.method()} ${req.url().replace(API, '')} -> ${resp.status()}`);
    return route.fulfill({ response: resp, headers: { ...resp.headers(), ...cors } });
  });
}

async function apiJson(request, method, path) {
  const res = await request.fetch(`${API}${path}`, { method, headers: AUTH });
  if (method === 'DELETE' && res.status() === 404) return null; // nothing to reset
  expect(res.ok(), `${method} ${path} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

async function resetLayout(request) {
  const { views = [] } = await apiJson(request, 'GET', '/link-layout/views');
  for (const v of views) await apiJson(request, 'DELETE', `/link-layout/views/${v.id}`);
  await apiJson(request, 'DELETE', '/link-layout');
}

async function openLinks(page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/links');
  await page.waitForSelector('.app-grid .app-tile[data-link-id]');
  await page.waitForTimeout(300); // let the first layout settle
}

async function enterCustomize(page) {
  await page.getByRole('button', { name: 'Customize' }).click();
  await expect(page.locator('body')).toHaveClass(/links-editing/);
  await page.waitForTimeout(200);
}

const grid = (page) => page.locator('.app-grid').first();
const appTile = (page, id) => grid(page).locator(`.app-tile[data-link-id="${id}"]`);
const folderTiles = (page) => grid(page).locator('.app-tile-folder');
const gridOrder = (page) => grid(page).locator('.app-tile[data-link-id]').evaluateAll(els => els.map(e => e.dataset.linkId));

async function iconCenter(loc) {
  const b = await loc.locator('.app-tile-icon-wrap').boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
// Where the lane beside a tile is: just past the right edge of its icon
// body (icon + 10px pad), inside the gap - the place a reorder is asked for.
async function laneRightOf(loc) {
  const t = await loc.boundingBox();
  const c = await iconCenter(loc);
  return { x: t.x + t.width - 2, y: c.y };
}

// A mouse drag that carries a tile by its icon: press on the icon center,
// lift with a 6px move, and from then on `to(x, y)` puts the CARRIED ICON's
// center at (x, y) (the engine decides from the icon, not the pointer).
async function pickUp(page, loc) {
  const c = await iconCenter(loc);
  const off = { x: 6, y: 0 };
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + off.x, c.y + off.y, { steps: 3 });
  await page.waitForTimeout(60);
  return {
    to: async (x, y, steps = 12) => { await page.mouse.move(x + off.x, y + off.y, { steps }); },
    release: async () => { await page.mouse.up(); },
  };
}

// A folder made by a fold opens for naming ~600ms after release (280ms fold
// animation + 320ms before the panel grows). Wait for the panel.
async function expectFolderPanelOpen(page) {
  const panel = page.locator('.folder-panel');
  await expect(panel).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(450); // the panel grows out of its tile for 360ms - measure it at rest
  return panel;
}

// The edit bar's Save: from Home it asks for a view name first.
async function saveLayout(page) {
  await page.locator('.links-edit-bar').getByRole('button', { name: 'Save' }).click();
  const nameCta = page.getByRole('button', { name: 'Save view' });
  if (await nameCta.isVisible({ timeout: 1500 }).catch(() => false)) await nameCta.click();
  // Saving as a new view keeps Customize open (the bar now reads Saved);
  // Done leaves it.
  const bar = page.locator('.links-edit-bar');
  if (await bar.isVisible().catch(() => false)) {
    await expect(bar.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 5000 });
    await bar.getByRole('button', { name: 'Done' }).click();
  }
  await expect(page.locator('body')).not.toHaveClass(/links-editing/, { timeout: 5000 });
}

test.describe('drag to fold (mouse)', () => {
  test.beforeEach(async ({ context, page, request }) => {
    await shimCors(context);
    await resetLayout(request);
    await openLinks(page);
    await enterCustomize(page);
  });
  test.afterEach(async ({ request }) => { await resetLayout(request); });

  test('1. drag B onto A, rest 300ms, release -> one folder with A then B, opened for rename', async ({ page }) => {
    const order = await gridOrder(page);
    const [A, B] = order;
    const a = await iconCenter(appTile(page, A));
    const d = await pickUp(page, appTile(page, B));
    await d.to(a.x, a.y);
    await page.waitForTimeout(300);
    // The target has visibly opened before the release.
    await expect(appTile(page, A)).toHaveClass(/app-tile-fold-target/);
    await page.screenshot({ path: 'e2e/test-results/s1-armed.png' });
    await d.release();
    const panel = await expectFolderPanelOpen(page);
    await expect(folderTiles(page)).toHaveCount(1);
    const members = await panel.locator('.app-tile[data-link-id]').evaluateAll(els => els.map(e => e.dataset.linkId));
    expect(members).toEqual([A, B]);
    // Opened straight into rename with the name selected.
    const input = panel.locator('input.form-input');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(/New Folder|\S+/);
    const sel = await input.evaluate(el => [el.selectionStart, el.selectionEnd, el.value.length]);
    expect(sel[0]).toBe(0);
    expect(sel[1]).toBe(sel[2]);
    await page.screenshot({ path: 'e2e/test-results/s1-folder.png' });
  });

  test('2. drag B onto A and release after 150ms -> folds before the ring', async ({ page }) => {
    const [A, B] = await gridOrder(page);
    const a = await iconCenter(appTile(page, A));
    const d = await pickUp(page, appTile(page, B));
    await d.to(a.x, a.y);
    await page.waitForTimeout(150);
    await d.release();
    await expectFolderPanelOpen(page);
    await expect(folderTiles(page)).toHaveCount(1);
    const members = await page.locator('.folder-panel .app-tile[data-link-id]').evaluateAll(els => els.map(e => e.dataset.linkId));
    expect(members).toEqual([A, B]);
  });

  test('3. drag B through the gaps and pause 250ms beside C -> reorder, no folder', async ({ page }) => {
    const order = await gridOrder(page);
    const [A, B, C] = order;
    const lane = await laneRightOf(appTile(page, C));
    const d = await pickUp(page, appTile(page, B));
    await d.to(lane.x, lane.y, 16);
    await page.waitForTimeout(250);
    await d.release();
    await page.waitForTimeout(500);
    await expect(folderTiles(page)).toHaveCount(0);
    const after = await gridOrder(page);
    expect(after.slice(0, 3)).toEqual([A, C, B]);
    expect(after.slice(3)).toEqual(order.slice(3));
  });

  test('4. quick sweep across three tiles, release in a gap -> back at the hole, nothing shuffled, no folder', async ({ page }) => {
    const order = await gridOrder(page);
    const [, B, C, D, E] = order;
    const c = await iconCenter(appTile(page, C));
    const dd = await iconCenter(appTile(page, D));
    const e = await iconCenter(appTile(page, E));
    const lane = await laneRightOf(appTile(page, E));
    const d = await pickUp(page, appTile(page, B));
    await d.to(c.x, c.y, 6);
    await d.to(dd.x, dd.y, 6);
    await d.to(e.x, e.y, 6);
    await d.to(lane.x, lane.y, 4);
    await d.release();
    await page.waitForTimeout(500);
    await expect(folderTiles(page)).toHaveCount(0);
    expect(await gridOrder(page)).toEqual(order);
  });

  test('6. drop an app onto an existing folder tile -> it joins the folder', async ({ page }) => {
    const [A, B, C] = await gridOrder(page);
    // Make a folder from A and B first.
    const a = await iconCenter(appTile(page, A));
    let d = await pickUp(page, appTile(page, B));
    await d.to(a.x, a.y);
    await page.waitForTimeout(300);
    await d.release();
    const panel = await expectFolderPanelOpen(page);
    await panel.getByRole('button', { name: 'Done' }).click();
    await expect(panel).toBeHidden();
    await page.waitForTimeout(300);
    // Now C onto the folder tile.
    const f = await iconCenter(folderTiles(page).first());
    d = await pickUp(page, appTile(page, C));
    await d.to(f.x, f.y);
    await page.waitForTimeout(300);
    await expect(folderTiles(page).first()).toHaveClass(/app-tile-fold-target/);
    await d.release();
    await page.waitForTimeout(600);
    await expect(folderTiles(page)).toHaveCount(1);
    await expect(folderTiles(page).first().locator('.app-folder-preview-cell')).toHaveCount(3);
    await expect(appTile(page, C)).toHaveCount(0);
  });
});

test.describe('drag to fold (touch)', () => {
  test.use({ hasTouch: true });
  test.beforeEach(async ({ context, page, request }) => {
    await shimCors(context);
    await resetLayout(request);
    await openLinks(page);
    await enterCustomize(page);
  });
  test.afterEach(async ({ request }) => { await resetLayout(request); });

  test('5. tap-hold lifts, drag onto A, release -> folds', async ({ page, context }) => {
    const [A, B] = await gridOrder(page);
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const a = await iconCenter(appTile(page, A));
    const b = await iconCenter(appTile(page, B));
    await touch('touchStart', b.x, b.y);
    await page.waitForTimeout(320); // the hold lifts the tile (260ms in Customize)
    await expect(page.locator('body')).toHaveClass(/links-dragging/);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', b.x + (a.x - b.x) * i / steps, b.y + (a.y - b.y) * i / steps);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(260);
    await expect(appTile(page, A)).toHaveClass(/app-tile-fold-target/);
    await touch('touchEnd');
    await expectFolderPanelOpen(page);
    await expect(folderTiles(page)).toHaveCount(1);
    const members = await page.locator('.folder-panel .app-tile[data-link-id]').evaluateAll(els => els.map(e => e.dataset.linkId));
    expect(members).toEqual([A, B]);
  });
});

test.describe('New Folder tile', () => {
  test.beforeEach(async ({ context, page, request }) => {
    await shimCors(context);
    await resetLayout(request);
    await openLinks(page);
  });
  test.afterEach(async ({ request }) => { await resetLayout(request); });

  test('7. creates and opens an empty folder, Save persists it, reload shows it', async ({ page, request }) => {
    const tile = page.getByTestId('new-folder-tile');
    await expect(tile).toBeVisible();
    // It is the very first tile of the grid.
    const first = await grid(page).locator('.app-tile').first().getAttribute('data-testid');
    expect(first).toBe('new-folder-tile');
    await tile.click();
    // Clicking from browse mode enters Customize...
    await expect(page.locator('body')).toHaveClass(/links-editing/);
    // ...and the folder opens for naming, empty, with its hint.
    const panel = await expectFolderPanelOpen(page);
    const input = panel.locator('input.form-input');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('New Folder');
    await expect(panel.getByTestId('folder-empty-hint')).toBeVisible();
    await input.fill('Banks');
    await input.press('Enter');
    await expect(panel.locator('h3')).toContainText('Banks');
    await panel.getByRole('button', { name: 'Done' }).click();
    await expect(panel).toBeHidden();
    // The folder sits first among the folders, right after the New Folder tile.
    await expect(folderTiles(page)).toHaveCount(1);
    await expect(folderTiles(page).first()).toContainText('Banks');
    const tiles = await grid(page).locator('.app-tile').evaluateAll(els => els.slice(0, 2).map(e => e.className));
    expect(tiles[0]).toContain('app-tile-add');
    expect(tiles[1]).toContain('app-tile-folder');
    // Save, reload: still there, still empty.
    await saveLayout(page);
    const { views } = await apiJson(request, 'GET', '/link-layout/views');
    expect(views).toHaveLength(1);
    expect(views[0].layout.folders.map(f => f.name)).toEqual(['Banks']);
    expect(views[0].layout.items.filter(i => i.folder_id)).toHaveLength(0);
    await page.reload();
    await page.waitForSelector('.app-grid .app-tile[data-link-id]');
    await expect(folderTiles(page)).toHaveCount(1);
    await expect(folderTiles(page).first()).toContainText('Banks');
    await expect(folderTiles(page).first().locator('.app-folder-preview-cell')).toHaveCount(0);
    await page.screenshot({ path: 'e2e/test-results/s7-reloaded.png' });
  });

  test('8. drag an app into the empty folder, then back out', async ({ page }) => {
    await page.getByTestId('new-folder-tile').click();
    const panel = await expectFolderPanelOpen(page);
    await panel.getByRole('button', { name: 'Done' }).click();
    await expect(panel).toBeHidden();
    await page.waitForTimeout(300);
    const [A] = await gridOrder(page);
    const f = await iconCenter(folderTiles(page).first());
    const d = await pickUp(page, appTile(page, A));
    await d.to(f.x, f.y);
    await page.waitForTimeout(300);
    await d.release();
    await page.waitForTimeout(600);
    await expect(folderTiles(page).first().locator('.app-folder-preview-cell')).toHaveCount(1);
    await expect(appTile(page, A)).toHaveCount(0);
    // Open it and drag the app out past the panel's edge onto the main grid.
    await folderTiles(page).first().click();
    const open = await expectFolderPanelOpen(page);
    const inside = open.locator(`.app-tile[data-link-id="${A}"]`);
    await expect(inside).toBeVisible();
    const pb = await open.boundingBox();
    const d2 = await pickUp(page, inside);
    await d2.to(pb.x + pb.width + 120, pb.y + pb.height + 160, 16);
    await page.waitForTimeout(350);
    await d2.release();
    await page.waitForTimeout(700);
    await expect(page.locator('.folder-panel')).toBeHidden();
    await expect(appTile(page, A)).toHaveCount(1);
    // The phone's rule: the folder its last app was dragged out of is gone.
    await expect(folderTiles(page)).toHaveCount(0);
  });
});
