// PDF Tools engine (frontend/public/pdf-editor-app): what people download must
// match what they see, and redaction must really remove content.
//
// Every test drives the real UI of the engine and then checks the DOWNLOADED
// FILE independently: a clean pdf.js tab that never loaded the engine renders it,
// and a scanner in Node reads the raw bytes. Runs with no backend:
//   npx playwright test -c pdf-tools.config.mjs
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const APP = path.join(REPO, 'frontend/public/pdf-editor-app');

// The bundled libraries are UMD files; frontend/ is an ES module package, so they
// are evaluated by hand rather than required.
const umd = (file) => {
  const m = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(path.join(APP, 'libs', file), 'utf8'))(m, m.exports);
  return m.exports;
};
const PDFLib = umd('pdf-lib.min.js');
const PDFEnc = umd('pdf-lib-encrypt.js');
const JSZip = umd('jszip.min.js');
const { PDFDocument, StandardFonts, PDFName, rgb, degrees } = PDFLib;

// ── Static server, one per worker ────────────────────────────────────────────
let server, BASE;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.gz': 'application/gzip' };
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__blank') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>verify</title>'); return; }
    const file = path.join(APP, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(APP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); });

test.setTimeout(120_000);

// The browser lives as long as the worker: a context left open keeps its renderer
// and sockets, and a long run then starves (net::ERR_NO_BUFFER_SPACE on Windows).
// A busy Windows machine now and then refuses a loopback socket to Chrome (that
// same error, or a script that fails to load, or a pdf.js worker that never comes
// up). Getting the app onto the screen may retry; nothing after that does.
async function settled(start) {
  for (let attempt = 1; ; attempt++) {
    try { return await start(); } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
const openContexts = new Set();
async function newContext(browser, options) {
  const ctx = await browser.newContext(options);
  // Nothing in these tests may reach beyond this machine. The engine falls back to
  // a public CDN when a bundled library fails to load; that must not rescue a test.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  openContexts.add(ctx);
  return ctx;
}
test.afterEach(async () => {
  for (const ctx of openContexts) await ctx.close().catch(() => {});
  openContexts.clear();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SECRETS = {
  text: 'SSN-111-11-1111',
  title: 'TITLE-SECRET-1111',
  author: 'AUTHOR-SECRET-2222',
  xmp: 'XMP-SECRET-3333',
  form: 'FORM-SECRET-4444',
  bookmark: 'BOOKMARK-SECRET-5555',
  annot: 'ANNOT-SECRET-6666',
  keptAnnot: 'KEPT-ANNOT-SECRET-6667',
  attachment: 'ATTACH-SECRET-7777',
  shared: 'SHARED-SECRET-8888',
  pageMeta: 'PAGE-META-SECRET-9999',
};
const hexOf = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

async function simplePdf(texts, { size = [612, 792], rotate = 0 } = {}) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (const t of texts) {
    const p = d.addPage(size);
    p.drawText(t, { x: 72, y: size[1] - 90, size: 14, font });
    if (rotate) p.setRotation(degrees(rotate));
  }
  return Buffer.from(await d.save());
}

// Page 1 carries the secret in its text, and in everything a saved PDF can leak
// through: metadata, a form value, a bookmark, annotations, an attachment, a form
// XObject in a /Resources dictionary shared with page 2, and a link on page 2 that
// points back at page 1.
async function secretPdf() {
  const d = await PDFDocument.create();
  const ctx = d.context;
  const font = await d.embedFont(StandardFonts.Helvetica);
  await d.flush();
  d.setTitle(SECRETS.title); d.setAuthor(SECRETS.author);
  d.setSubject(SECRETS.title); d.setKeywords([SECRETS.author]);
  const p1 = d.addPage([612, 792]), p2 = d.addPage([612, 792]), p3 = d.addPage([612, 792]);
  p1.drawText(SECRETS.text, { x: 72, y: 700, size: 14, font });
  p1.drawText('PUBLIC-P1-TEXT', { x: 72, y: 300, size: 14, font });
  p2.drawText('PUBLIC-P2-TEXT', { x: 72, y: 700, size: 14, font });
  p3.drawText('PUBLIC-P3-TEXT', { x: 72, y: 700, size: 14, font });

  // XMP on the catalog and on the page
  d.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream(`<x:xmpmeta>${SECRETS.xmp}</x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' })));
  p1.node.set(PDFName.of('Metadata'), ctx.register(ctx.stream(`<x:xmpmeta>${SECRETS.pageMeta}</x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' })));

  // A form field whose value is on the redacted page
  const form = d.getForm();
  const tf = form.createTextField('ssn');
  tf.setText(SECRETS.form);
  tf.addToPage(p1, { x: 72, y: 600, width: 300, height: 24, font });

  // A bookmark
  const outlineRef = ctx.nextRef(), itemRef = ctx.nextRef();
  ctx.assign(itemRef, ctx.obj({ Title: PDFLib.PDFHexString.fromText(SECRETS.bookmark), Parent: outlineRef, Dest: [p1.ref, 'Fit'] }));
  ctx.assign(outlineRef, ctx.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 }));
  d.catalog.set(PDFName.of('Outlines'), outlineRef);

  // Annotations on the redacted page and a kept page, and a link back to page 1
  const annot = (page, contents, rect) => {
    const ref = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: rect, Contents: PDFLib.PDFHexString.fromText(contents), P: page.ref }));
    const list = page.node.lookup(PDFName.of('Annots'));
    if (list) list.push(ref); else page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  };
  annot(p1, SECRETS.annot, [400, 700, 420, 720]);
  annot(p2, SECRETS.keptAnnot, [400, 700, 420, 720]);
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 600, 200, 620], Dest: [p1.ref, 'Fit'], P: p2.ref }));
  p2.node.lookup(PDFName.of('Annots')).push(link);

  // An attachment
  await d.attach(Buffer.from(SECRETS.attachment), 'secret.txt', { mimeType: 'text/plain' });

  // A /Resources dictionary shared by pages 1 and 2; only page 1 draws the form
  const content = `BT /F1 12 Tf 72 500 Td <${hexOf(SECRETS.shared)}> Tj ET`;
  const fm = ctx.register(ctx.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Resources: { Font: { F1: font.ref } } }));
  const res1 = p1.node.Resources(), res2 = p2.node.Resources();
  const xo = ctx.obj({}); xo.set(PDFName.of('FmSecret'), fm);
  res1.set(PDFName.of('XObject'), xo);
  for (const [k, v] of res2.lookup(PDFName.of('Font')).entries()) res1.lookup(PDFName.of('Font')).set(k, v);
  const shared = ctx.register(res1);
  p1.node.set(PDFName.of('Resources'), shared);
  p2.node.set(PDFName.of('Resources'), shared);
  p1.pushOperators(PDFLib.drawObject('FmSecret'));
  return Buffer.from(await d.save());
}

// ── Independent checks on the bytes ──────────────────────────────────────────
// Everything a file holds as text: raw bytes, every inflated stream, and inside
// those every hex string <...> and literal string (...), decoded. pdf-lib writes
// page text as hex strings, so a plain search of the file misses it.
function deepText(buf) {
  const raw = buf.toString('latin1');
  const parts = [raw];
  // "endstream" ends in "stream" too; without the lookbehind every other stream
  // in the file is skipped, which the positive control below caught.
  const re = /(?<!end)stream\r?\n/g;
  let m, streams = 0;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const chunk = buf.subarray(start, end);
    streams++;
    for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
      try { parts.push(fn(chunk).toString('latin1')); break; } catch { /* not this filter */ }
    }
    re.lastIndex = end + 9;
  }
  deepText.streams = streams;
  const decoded = [];
  const addUtf16 = (b) => { if (b.length > 1) { const s = []; for (let i = 0; i + 1 < b.length; i += 2) s.push(String.fromCharCode((b[i] << 8) | b[i + 1])); decoded.push(s.join('')); } };
  for (const part of parts) {
    for (const h of part.matchAll(/<([0-9A-Fa-f\s]{2,})>/g)) {
      const b = Buffer.from(h[1].replace(/\s/g, ''), 'hex');
      decoded.push(b.toString('latin1'));
      addUtf16(b);
    }
    for (const l of part.matchAll(/\(((?:\\.|[^\\()])*)\)/gs)) {
      const un = l[1].replace(/\\([0-7]{1,3}|.)/gs, (_, c) => (/^[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8)) : c));
      decoded.push(un);
      addUtf16(Buffer.from(un, 'latin1'));
    }
  }
  return parts.concat(decoded).join('\n');
}
function assertNoSecrets(buf, label, secrets = Object.values(SECRETS)) {
  const all = deepText(buf);
  for (const s of secrets) expect(all.includes(s), `${label} must not contain ${s}`).toBe(false);
}

// A clean tab: no engine, no markups, only pdf.js reading the bytes it is given.
async function verifier(browser) {
  const ctx = await newContext(browser, { viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  await settled(async () => {
    await page.goto(`${BASE}/__blank`);
    await page.addScriptTag({ url: `${BASE}/libs/pdf.min.js` });
  });
  await page.evaluate((b) => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${b}/libs/pdf.worker.min.js`;
    window.__worker = new pdfjsLib.PDFWorker(); // one worker: a new one per file ran the machine out of sockets
    window.__open = (b64, password) => pdfjsLib.getDocument({ worker: window.__worker, data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), ...(password ? { password } : {}) }).promise;
    window.__render = async (doc, n, scale) => {
      const p = await doc.getPage(n);
      const v = p.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = v.width; c.height = v.height;
      const g = c.getContext('2d');
      await p.render({ canvasContext: g, viewport: v }).promise;
      return { c, g, rotate: p.rotate, view: p.view };
    };
    // How much of a region (fractions of the page) matches a predicate, 0..1.
    window.__fill = (g, c, pred, [fx0, fy0, fx1, fy1]) => {
      const f = eval(pred);
      const x0 = Math.floor(fx0 * c.width), y0 = Math.floor(fy0 * c.height);
      const w = Math.max(1, Math.floor((fx1 - fx0) * c.width)), h = Math.max(1, Math.floor((fy1 - fy0) * c.height));
      const d = g.getImageData(x0, y0, w, h).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && f(d[i], d[i + 1], d[i + 2])) n++;
      return n / (w * h);
    };
    window.__box = (g, c, pred) => {
      const f = eval(pred);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] > 0 && f(d[i], d[i + 1], d[i + 2])) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      return n ? { n, x0: x0 / c.width, y0: y0 / c.height, x1: (x1 + 1) / c.width, y1: (y1 + 1) / c.height, W: c.width, H: c.height } : { n: 0, W: c.width, H: c.height };
    };
  }, BASE);
  return { page, close: () => ctx.close() };
}
const RED = '(r,g,b)=>r>200&&g<70&&b<70';
const BLACK = '(r,g,b)=>r<40&&g<40&&b<40';
const INK = '(r,g,b)=>r<225||g<225||b<225';

// Text per page, page count, rotation, annotations and fields of a file.
async function inspect(v, buf, { password } = {}) {
  return v.page.evaluate(async ({ b64, password }) => {
    const doc = await window.__open(b64, password);
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const t = await p.getTextContent();
      const a = await p.getAnnotations();
      pages.push({ text: t.items.map((x) => x.str).join(' '), rotate: p.rotate, view: p.view, annots: a.map((x) => x.subtype) });
    }
    const n = doc.numPages;
    const meta = await doc.getMetadata().catch(() => ({ info: {} }));
    const outline = await doc.getOutline();
    await doc.destroy();
    return { numPages: n, pages, info: meta.info, outline };
  }, { b64: buf.toString('base64'), password });
}
// The box of pixels matching a predicate on one page, as fractions of the page.
async function colorBox(v, buf, n, pred, { scale = 1, password } = {}) {
  return v.page.evaluate(async ({ b64, n, pred, scale, password }) => {
    const doc = await window.__open(b64, password);
    const { c, g } = await window.__render(doc, n, scale);
    const box = window.__box(g, c, pred);
    await doc.destroy();
    return box;
  }, { b64: buf.toString('base64'), n, pred, scale, password });
}
// How much of a region of one page matches a predicate, 0..1.
async function fillOf(v, buf, n, pred, region, { scale = 1, password } = {}) {
  return v.page.evaluate(async ({ b64, n, pred, region, scale, password }) => {
    const doc = await window.__open(b64, password);
    const { c, g } = await window.__render(doc, n, scale);
    const fill = window.__fill(g, c, pred, region);
    await doc.destroy();
    return fill;
  }, { b64: buf.toString('base64'), n, pred, region, scale, password });
}
// Same, for an image file (PNG / JPEG).
async function imageBox(v, buf, pred) {
  return v.page.evaluate(async ({ b64, pred }) => {
    const img = await createImageBitmap(await (await fetch('data:application/octet-stream;base64,' + b64)).blob());
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return window.__box(g, c, pred);
  }, { b64: buf.toString('base64'), pred });
}
// An uncompressed RGB TIFF as the engine writes it: is this fraction of it black?
function tiffPixel(buf, fx, fy) {
  const tag = (id) => {
    const count = buf.readUInt16LE(8);
    for (let i = 0; i < count; i++) {
      const p = 10 + i * 12;
      if (buf.readUInt16LE(p) === id) return buf.readUInt32LE(p + 8);
    }
    throw new Error('no tag ' + id);
  };
  const w = tag(256), h = tag(257), off = tag(273);
  const x = Math.floor(fx * w), y = Math.floor(fy * h), i = off + (y * w + x) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]];
}

// ── Driving the engine ───────────────────────────────────────────────────────
async function openEngine(browser, bytes, name = 'doc.pdf', { query = '', password } = {}) {
  return settled(async () => {
    const page = await startEngine(browser, query);
    if (bytes) await loadInto(page, bytes, name, { password });
    return page;
  });
}
async function startEngine(browser, query) {
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push(String(e)));
  page.on('dialog', (d) => d.accept());   // Delete Page asks with a native confirm
  if (process.env.PDF_DEBUG) page.on('console', (m) => console.log('[page]', m.text().slice(0, 300)));
  await page.addInitScript(() => {
    window.__events = [];
    for (const n of ['pdf-engine:state', 'pdf-engine:did']) window.addEventListener(n, (e) => window.__events.push({ type: n, detail: e.detail }));
    window.addEventListener('message', (e) => { if (e.data && e.data.type === 'pdf-editor:doc-state') window.__events.push({ type: 'post', detail: e.data }); });
  });
  await page.goto(`${BASE}/index.html${query}`, { waitUntil: 'load' });
  return page;
}
async function loadInto(page, bytes, name, { password } = {}) {
  await page.setInputFiles('#fileInput', { name, mimeType: 'application/pdf', buffer: bytes });
  if (password) {
    await page.locator('.modal-overlay input:visible').fill(password);
    await page.locator('.modal-overlay [data-act="ok"]').click();
  }
  await page.waitForFunction(() => +document.getElementById('totalPages').textContent > 0, null, { timeout: 25_000 });
  // The engine opens in continuous scroll on a short timer: the default view.
  await page.waitForSelector('#scrollModeBtn.active');
  await page.waitForSelector('#continuousView .cv-page');
  // The search bar opens by default and sits over the zoom buttons at this width.
  if (await page.locator('#searchClose').isVisible()) await page.click('#searchClose');
}
const group = async (page, name) => {
  const it = page.locator('.adobe-tool-item', { hasText: name }).first();
  if (!(await it.evaluate((e) => e.classList.contains('active')))) await it.click();
};
// Single-page view with the whole page visible, so ratios map onto the canvas.
async function editView(page) {
  if (await page.locator('#scrollModeBtn.active').count()) await page.click('#scrollModeBtn');
  await page.waitForFunction(() => !window.isScrollMode());
  await fitPage(page);
}
async function fitPage(page) {
  await page.click('#zoomFitPage');
  await settle(page);
}
const settle = (page, ms = 450) => page.waitForTimeout(ms);
async function canvasPoint(page, xr, yr) {
  const b = await page.locator('.upper-canvas').boundingBox();
  return [b.x + xr * b.width, b.y + yr * b.height];
}
async function drag(page, [xa, ya], [xb, yb]) {
  const [x1, y1] = await canvasPoint(page, xa, ya);
  const [x2, y2] = await canvasPoint(page, xb, yb);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 8 });
  await page.mouse.up();
  await settle(page, 200);
}
async function setColor(page, c) {
  await page.evaluate((c) => {
    for (const id of ['pbCustomColor', 'colorPicker']) {
      const e = document.getElementById(id);
      if (!e) continue;
      e.value = c;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, c);
}
// The Shape tool armed on a plain rectangle in solid red.
async function armRect(page) {
  await group(page, 'Assemble');
  await page.click('#shapeTool');
  await page.waitForFunction(() => !window.isScrollMode());
  await page.locator('#shapeMenu.open [data-shape="rect"], #shapeMenu [data-shape="rect"]').first().click({ timeout: 3000 }).catch(() => {});
  await page.evaluate(() => window.setShapeKind('rect'));
  await page.evaluate(() => document.getElementById('shapeMenu')?.classList.remove('open'));
  await setColor(page, '#ff0000');
  await settle(page, 200);
}
async function redactBox(page, a, b) {
  await group(page, 'Optimize');
  await page.click('#redactBtn');
  await page.locator('.modal-overlay [data-choice="go"]').click();
  await page.waitForFunction(() => !window.isScrollMode());
  await fitPage(page);
  await drag(page, a, b);
}
// Run an action, take the one download it triggers, return its bytes.
async function download(page, action, { timeout = 60_000, confirm = true } = {}) {
  const wait = page.waitForEvent('download', { timeout });
  await action();
  if (confirm) {
    // The first redacted save asks before flattening pages.
    const modal = page.locator('.modal-overlay [data-choice="go"]');
    await modal.click({ timeout: 1500 }).catch(() => {});
  }
  const d = await wait.catch(async (e) => {
    const said = await page.evaluate(() => [document.querySelector('.toast')?.textContent, document.getElementById('statusText')?.textContent]).catch(() => []);
    throw new Error(`${e.message.split('\n')[0]} - the engine said: ${JSON.stringify(said)}`);
  });
  const p = await d.path();
  return { buf: fs.readFileSync(p), name: d.suggestedFilename() };
}
const saveMenuItem = async (page, text, { other = false } = {}) => {
  await page.click('#downloadBtn');
  const item = page.locator('#saveMenu button', { hasText: text }).first();
  // "Other formats" stays expanded once opened; a second click would close it.
  if (other && !(await item.isVisible())) await page.locator('#saveMenu button', { hasText: 'Other formats' }).click();
  await item.click();
};
const saveAll = (page, opts) => download(page, () => saveMenuItem(page, 'all pages'), opts);
const toast = (page) => page.locator('.toast').textContent();
const engine = (page, expr) => page.evaluate(expr);

// ═════════════════════════════════════════════════════════════════════════════
// 1. Every engine asset is stamped by the build
// ═════════════════════════════════════════════════════════════════════════════
test.describe('1. asset stamping', () => {
  test('index.html carries no hand-set version, and the build stamps every script, style and lazy library', async ({ browser }) => {
    const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
    expect(html).not.toMatch(/\.(js|css)\?v=/);
    const { stampHtml } = await import(path.join(REPO, 'frontend/scripts/stamp-assets.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
    const stamped = stampHtml(html, 'TESTBUILD');
    const local = [...html.matchAll(/(?:src|href)="(?!https?:|\/\/|data:)([^"#?]+\.(?:js|css))"/g)].map((m) => m[1]);
    expect(local).toEqual(expect.arrayContaining(['app.js', 'adobe-ui.js', 'style.css']));
    for (const f of local) expect(stamped).toContain(`${f}?v=TESTBUILD`);

    // Serve the stamped page and watch what the engine asks for at run time.
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    await page.route('**/index.html', (r) => r.fulfill({ contentType: 'text/html', body: stamped }));
    const asked = [];
    page.on('request', (r) => asked.push(r.url()));
    await page.goto(`${BASE}/index.html`);
    await page.setInputFiles('#fileInput', { name: 'a.pdf', mimeType: 'application/pdf', buffer: await simplePdf(['stamp']) });
    await page.waitForFunction(() => +document.getElementById('totalPages').textContent > 0);
    await page.waitForTimeout(600);
    await page.evaluate(() => window.exportWordSmart());
    await page.waitForSelector('.word-preview-overlay');
    const lib = (needle) => asked.filter((u) => u.includes(needle));
    expect(lib('app.js').every((u) => u.includes('v=TESTBUILD'))).toBe(true);
    expect(lib('pdf.worker.min.js').length).toBeGreaterThan(0);
    expect(lib('pdf.worker.min.js').every((u) => u.includes('v=TESTBUILD'))).toBe(true);
    expect(lib('docx.umd.js').length).toBeGreaterThan(0);
    expect(lib('docx.umd.js').every((u) => u.includes('v=TESTBUILD'))).toBe(true);
    await expect(page.locator('#buildStamp')).toContainText('TESTBUILD');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2-3. Redaction really removes content, in every export
// ═════════════════════════════════════════════════════════════════════════════
const REDACT_A = [0.08, 0.08], REDACT_B = [0.62, 0.14]; // over the secret line on page 1

test.describe('2-3. redaction', () => {
  test('the scanner finds every secret in the unredacted fixture (positive control)', async () => {
    const raw = deepText(await secretPdf());
    for (const s of Object.values(SECRETS)) expect(raw.includes(s), `control: ${s}`).toBe(true);
  });

  test('the saved PDF holds no secret anywhere, and untouched pages keep real text', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await secretPdf(), 'secret.pdf');
    await redactBox(page, REDACT_A, REDACT_B);
    const { buf, name } = await saveAll(page);
    expect(name).toBe('secret_edited.pdf');
    assertNoSecrets(buf, 'saved PDF');
    const r = await inspect(v, buf);
    expect(r.numPages).toBe(3);
    expect(r.pages[0].text).toBe('');
    expect(r.pages[1].text).toContain('PUBLIC-P2-TEXT');
    expect(r.pages[2].text).toContain('PUBLIC-P3-TEXT');
    expect(r.outline).toBeNull();
    expect(r.pages.flatMap((p) => p.annots)).toEqual([]);
    expect(r.info.Title || '').toBe('');
    // The box is really on page 1, where it was drawn, and nowhere else.
    expect(await fillOf(v, buf, 1, BLACK, [0.09, 0.09, 0.61, 0.13])).toBeGreaterThan(0.98);
    expect(await fillOf(v, buf, 1, BLACK, [0.65, 0.05, 0.95, 0.2])).toBeLessThan(0.01);
    expect(await fillOf(v, buf, 1, BLACK, [0.09, 0.15, 0.61, 0.22])).toBeLessThan(0.01);
    expect(page.__errors).toEqual([]);
  });

  test('a redaction on a hidden layer still redacts', async ({ browser }) => {
    const page = await openEngine(browser, await secretPdf(), 'secret.pdf', { query: '?testhooks' });
    await redactBox(page, REDACT_A, REDACT_B);
    await page.evaluate(() => window.__hooks.setLayerVisible(1, false));
    const { buf } = await saveAll(page);
    assertNoSecrets(buf, 'hidden-layer redaction');
  });

  const SECRET_TEXT = [SECRETS.text, SECRETS.form, SECRETS.shared];
  async function redacted(browser) {
    const page = await openEngine(browser, await secretPdf(), 'secret.pdf');
    await redactBox(page, REDACT_A, REDACT_B);
    return page;
  }

  test('selected pages: the redacted page and the pages left out hold no secret', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await redacted(browser);
    const run = async (range) => {
      await group(page, 'Organize Pages');
      await page.click('#splitBtn');
      await page.fill('#splitRange', range);
      return download(page, () => page.click('#splitExtract'));
    };
    const a = await run('1-2');
    assertNoSecrets(a.buf, 'selected pages 1-2');
    const r = await inspect(v, a.buf);
    expect(r.numPages).toBe(2);
    expect(r.pages[0].text).toBe('');
    expect(r.pages[1].text).toContain('PUBLIC-P2-TEXT');
    expect((await colorBox(v, a.buf, 1, BLACK)).n).toBeGreaterThan(1000);
    const b = await run('2-3');
    assertNoSecrets(b.buf, 'selected pages 2-3');
  });

  test('Protect: redacted, encrypted, and opens with its password', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await redacted(browser);
    await group(page, 'Fill & Sign');
    await page.click('#protectBtn');
    await page.locator('.modal-overlay [data-k="user"]').fill('open-sesame');
    const { buf, name } = await download(page, () => page.getByRole('button', { name: 'Encrypt & Save' }).click(), { confirm: false });
    expect(name).toBe('secret_protected.pdf');
    assertNoSecrets(buf, 'protected');
    const r = await inspect(v, buf, { password: 'open-sesame' });
    expect(r.numPages).toBe(3);
    expect(r.pages[0].text).toBe('');
    expect(r.pages[1].text).toContain('PUBLIC-P2-TEXT');
    const decrypted = await PDFEnc.PDFDocument.load(buf, { password: 'open-sesame' });
    assertNoSecrets(Buffer.from(await decrypted.save()), 'protected, decrypted with its password');
    await expect(v.page.evaluate(async (b64) => {
      try { await window.__open(b64); return 'opened'; } catch (e) { return e.name; }
    }, buf.toString('base64'))).resolves.toBe('PasswordException');
  });

  test('Flatten holds no secret and shows the box', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await redacted(browser);
    const { buf } = await download(page, () => saveMenuItem(page, 'Flattened', { other: true }), { confirm: false });
    assertNoSecrets(buf, 'flattened');
    expect((await colorBox(v, buf, 1, BLACK)).n).toBeGreaterThan(1000);
    expect((await inspect(v, buf)).numPages).toBe(3);
  });

  test('PNG, JPEG and TIFF of the page show the box, not what was under it', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await redacted(browser);
    for (const [text, other] of [['PNG image', false], ['JPEG image', false]]) {
      const { buf } = await download(page, () => saveMenuItem(page, text, { other }), { confirm: false });
      const box = await imageBox(v, buf, BLACK);
      expect(box.x0, text).toBeCloseTo(0.08, 1);
      expect(box.x1, text).toBeCloseTo(0.62, 1);
      assertNoSecrets(buf, text, SECRET_TEXT);
    }
    const { buf } = await download(page, () => saveMenuItem(page, 'TIFF', { other: true }), { confirm: false });
    expect(tiffPixel(buf, 0.3, 0.11)).toEqual([0, 0, 0]);
  });

  test('ZIP of all pages: every image is redacted', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await redacted(browser);
    for (const [text, ext] of [['PNG images', 'png'], ['JPEG images', 'jpg']]) {
      const { buf } = await download(page, () => saveMenuItem(page, text, { other: true }), { confirm: false });
      const zip = await JSZip.loadAsync(buf);
      const names = Object.keys(zip.files).sort();
      expect(names).toEqual([`secret_page1.${ext}`, `secret_page2.${ext}`, `secret_page3.${ext}`]);
      const first = await zip.file(`secret_page1.${ext}`).async('nodebuffer');
      const box = await imageBox(v, first, BLACK);
      expect(box.x0).toBeCloseTo(0.08, 1);
      expect(box.x1).toBeCloseTo(0.62, 1);
    }
  });

  test('TXT and Markdown hold no redacted text and keep the rest', async ({ browser }) => {
    const page = await redacted(browser);
    const txt = await download(page, () => saveMenuItem(page, 'All text', { other: true }), { confirm: false });
    const t = txt.buf.toString('utf8');
    for (const s of Object.values(SECRETS)) expect(t.includes(s), s).toBe(false);
    expect(t).toContain('PUBLIC-P2-TEXT');
    await expect(page.locator('.toast')).toContainText('redacted pages are images');
    const md = await download(page, () => page.evaluate(() => window.exportMarkdownTool()), { confirm: false });
    const m = md.buf.toString('utf8');
    for (const s of Object.values(SECRETS)) expect(m.includes(s), s).toBe(false);
    expect(m).toContain('PUBLIC-P3-TEXT');
  });

  test('Word holds no redacted text, and the redacted page arrives as an image', async ({ browser }) => {
    const page = await redacted(browser);
    await saveMenuItem(page, 'Word', { other: true });
    await page.waitForSelector('.word-preview-overlay');
    const { buf } = await download(page, () => page.click('.wp-download'), { confirm: false });
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file('word/document.xml').async('string');
    for (const s of Object.values(SECRETS)) expect(xml.includes(s), s).toBe(false);
    expect(xml).toContain('PUBLIC-P2-TEXT');
    expect(Object.keys(zip.files).some((n) => n.startsWith('word/media/'))).toBe(true);
    for (const n of Object.keys(zip.files)) {
      if (zip.files[n].dir || /\.(png|jpe?g)$/.test(n)) continue;
      assertNoSecrets(await zip.file(n).async('nodebuffer'), `docx ${n}`);
    }
  });

  test('Excel holds no redacted text and keeps the rest', async ({ browser }) => {
    const page = await redacted(browser);
    const { buf } = await download(page, () => saveMenuItem(page, 'Excel', { other: true }), { confirm: false });
    const zip = await JSZip.loadAsync(buf);
    let all = '';
    for (const n of Object.keys(zip.files)) if (!zip.files[n].dir) all += await zip.file(n).async('string');
    for (const s of Object.values(SECRETS)) expect(all.includes(s), s).toBe(false);
    expect(all).toContain('PUBLIC-P2-TEXT');
  });

  test('Unlock: the unlocked copy is redacted too', async ({ browser }) => {
    const page = await redacted(browser);
    const { buf } = await download(page, () => page.evaluate(() => window.unlockPdfTool()), { confirm: false });
    assertNoSecrets(buf, 'unlocked');
  });

  test('Print renders the redacted document', async ({ browser }) => {
    const page = await openEngine(browser, await secretPdf(), 'secret.pdf', { query: '?testhooks' });
    await redactBox(page, REDACT_A, REDACT_B);
    await page.evaluate(() => window.printPdf());
    await page.waitForFunction(() => window.__printImgs === 3);
  });

  test('deleted page content is not written to a normal save', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await simplePdf(['KEEP-ONE', 'GONE-PAGE-SECRET', 'KEEP-THREE']), 'del.pdf');
    await page.locator('.thumb-btn.delete-btn').nth(1).click();
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '2');
    await settle(page, 600);
    const { buf } = await saveAll(page);
    assertNoSecrets(buf, 'after deleting a page', ['GONE-PAGE-SECRET']);
    const r = await inspect(v, buf);
    expect(r.pages.map((p) => p.text)).toEqual(['KEEP-ONE', 'KEEP-THREE']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Markups reach every export
// ═════════════════════════════════════════════════════════════════════════════
test.describe('3. one pipeline: markups', () => {
  async function marked(browser) {
    const page = await openEngine(browser, await simplePdf(['ONE', 'TWO', 'THREE']), 'marks.pdf');
    await armRect(page);
    await fitPage(page);
    await drag(page, [0.2, 0.5], [0.6, 0.7]);
    return page;
  }
  const expectMark = (b, label) => {
    expect(b.n, label).toBeGreaterThan(100);
    expect(b.x0, label).toBeCloseTo(0.2, 1);
    expect(b.x1, label).toBeCloseTo(0.6, 1);
    expect(b.y0, label).toBeCloseTo(0.5, 1);
    expect(b.y1, label).toBeCloseTo(0.7, 1);
  };

  test('selected pages, Protect, Flatten, images and ZIP all carry the markup', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await marked(browser);

    await group(page, 'Organize Pages');
    await page.click('#splitBtn');
    await page.fill('#splitRange', '1');
    let d = await download(page, () => page.click('#splitExtract'), { confirm: false });
    expectMark(await colorBox(v, d.buf, 1, RED), 'selected pages');
    expect((await inspect(v, d.buf)).numPages).toBe(1);

    await group(page, 'Fill & Sign');
    await page.click('#protectBtn');
    await page.locator('.modal-overlay [data-k="user"]').fill('pw1');
    d = await download(page, () => page.getByRole('button', { name: 'Encrypt & Save' }).click(), { confirm: false });
    expectMark(await colorBox(v, d.buf, 1, RED, { password: 'pw1' }), 'protect');

    d = await download(page, () => saveMenuItem(page, 'Flattened', { other: true }), { confirm: false });
    expectMark(await colorBox(v, d.buf, 1, RED), 'flatten');

    d = await download(page, () => saveMenuItem(page, 'PNG image'), { confirm: false });
    expectMark(await imageBox(v, d.buf, RED), 'png');
    d = await download(page, () => saveMenuItem(page, 'JPEG image'), { confirm: false });
    expectMark(await imageBox(v, d.buf, RED), 'jpeg');

    d = await download(page, () => saveMenuItem(page, 'PNG images', { other: true }), { confirm: false });
    const zip = await JSZip.loadAsync(d.buf);
    expectMark(await imageBox(v, await zip.file('marks_page1.png').async('nodebuffer'), RED), 'zip');
    expect((await imageBox(v, await zip.file('marks_page2.png').async('nodebuffer'), RED)).n).toBe(0);
  });

  test('text formats say what they cannot carry, and typed text reaches them', async ({ browser }) => {
    const page = await openEngine(browser, await simplePdf(['ONE']), 'marks.pdf', { query: '?testhooks' });
    await armRect(page);
    await fitPage(page);
    await drag(page, [0.2, 0.5], [0.6, 0.7]);
    await page.evaluate(() => {
      const h = window.__hooks;
      h.addObj(h.itext('TYPED-NOTE', { left: 60, top: 300, fontSize: 18, fill: '#000000' }));
    });
    const { buf } = await download(page, () => saveMenuItem(page, 'All text', { other: true }), { confirm: false });
    expect(buf.toString('utf8')).toContain('TYPED-NOTE');
    await expect(page.locator('.toast')).toContainText('cannot be carried into a text format');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The safety net
// ═════════════════════════════════════════════════════════════════════════════
test.describe('4. safety net', () => {
  test('bytes that do not open are never offered, and the error is clear', async ({ browser }) => {
    const page = await openEngine(browser, await simplePdf(['ONE', 'TWO']), 'net.pdf');
    await page.evaluate(() => {
      PDFLib.PDFDocument.prototype.save = async function () { return new TextEncoder().encode('%PDF-1.7 this is not a pdf'); };
    });
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await saveMenuItem(page, 'all pages');
    await expect(page.locator('.toast')).toContainText('Save failed');
    await expect(page.locator('.toast')).toContainText('final check');
    expect(await page.locator('.toast').textContent()).not.toContain('PDF saved');
    await settle(page, 500);
    expect(downloads).toBe(0);
    expect(await engine(page, () => window.__events.filter((e) => e.type === 'pdf-engine:did').length)).toBe(0);
  });

  test('a page count that disagrees is refused too', async ({ browser }) => {
    const page = await openEngine(browser, await simplePdf(['ONE', 'TWO']), 'net.pdf');
    await page.evaluate(() => {
      const orig = PDFLib.PDFDocument.prototype.save;
      PDFLib.PDFDocument.prototype.save = async function (o) { this.removePage(0); return orig.call(this, o); };
    });
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await saveMenuItem(page, 'all pages');
    await expect(page.locator('.toast')).toContainText('final check');
    await settle(page, 500);
    expect(downloads).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Helpers for the markup tests
// ═════════════════════════════════════════════════════════════════════════════
const HOOKS = '?testhooks';
const near = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `(r,g,b)=>Math.abs(r-${r})<45&&Math.abs(g-${g})<45&&Math.abs(b-${b})<45`;
};
const GREEN = '#00cc00', BLUE = '#0000ff', ORANGE = '#ff8800', MAGENTA = '#ff00ff', TEAL = '#00cccc';
const REDHEX = '#ff0000';
const BOX = [0.3, 0.4, 0.6, 0.6];

// A solid PNG, built here so no image file is needed.
function solidPng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A rectangle at fractions of the live canvas, added the way a tool adds one.
async function addRect(page, [x0, y0, x1, y1], fill) {
  await page.evaluate(({ x0, y0, x1, y1, fill }) => {
    const h = window.__hooks, f = h.fabric();
    h.addObj(h.rect({ left: x0 * f.width, top: y0 * f.height, width: (x1 - x0) * f.width, height: (y1 - y0) * f.height, fill, strokeWidth: 0 }));
  }, { x0, y0, x1, y1, fill });
}
const toPage = (page, n) => page.evaluate((n) => window.__hooks.goto(n), n);
// A document open in the editor with one colored box on each page in `marks`.
async function markedPages(browser, marks, texts = ['P1', 'P2', 'P3', 'P4']) {
  const page = await openEngine(browser, await simplePdf(texts), 'pages.pdf', { query: HOOKS });
  await editView(page);
  for (const [n, color] of Object.entries(marks)) { await toPage(page, +n); await addRect(page, BOX, color); }
  return page;
}
// Every page of the file shows exactly the boxes listed, where they were drawn,
// and still shows its own text: `want` is a list of [text, color or null].
async function expectPages(v, buf, want, { box = BOX, password } = {}) {
  const r = await inspect(v, buf, { password });
  expect(r.numPages, 'page count').toBe(want.length);
  const colors = [...new Set(want.map((w) => w[1]).filter(Boolean))];
  for (let i = 0; i < want.length; i++) {
    const [text, color] = want[i];
    if (text !== null) expect(r.pages[i].text, `page ${i + 1} text`).toBe(text);
    for (const c of colors) {
      const b = await colorBox(v, buf, i + 1, near(c), { password });
      if (c !== color) { expect(b.n, `page ${i + 1} must not hold ${c}`).toBe(0); continue; }
      expect(b.n, `page ${i + 1} must hold ${c}`).toBeGreaterThan(200);
      if (box) {
        expect(b.x0, `page ${i + 1} left`).toBeCloseTo(box[0], 1);
        expect(b.y0, `page ${i + 1} top`).toBeCloseTo(box[1], 1);
        expect(b.x1, `page ${i + 1} right`).toBeCloseTo(box[2], 1);
        expect(b.y1, `page ${i + 1} bottom`).toBeCloseTo(box[3], 1);
      }
    }
  }
  return r;
}
const expectClose = (actual, want, label, tol = 0.012) => {
  for (const k of ['x0', 'y0', 'x1', 'y1']) {
    expect(Math.abs(actual[k] - want[k]), `${label} ${k}: ${actual[k]} vs ${want[k]}`).toBeLessThan(tol);
  }
};
const saved = (page) => saveAll(page, { confirm: false });
const clickOk = (page) => page.locator('.modal-overlay [data-act="ok"]').click();
const isDirty = (page) => page.evaluate(() => window.__pdfEngine.isDirty());
const waitIdle = (page, ms = 700) => settle(page, ms);

// ═════════════════════════════════════════════════════════════════════════════
// 5. The default continuous-scroll view
// ═════════════════════════════════════════════════════════════════════════════
test.describe('5. scroll mode', () => {
  async function onPageTwo(browser) {
    const page = await openEngine(browser, await simplePdf(['ONE', 'TWO', 'THREE']), 'scroll.pdf', { query: HOOKS });
    expect(await page.evaluate(() => window.isScrollMode())).toBe(true);
    await settle(page, 1500); // the view pins itself to the first page while it settles
    await page.locator('.thumbnail-item').nth(1).click();
    await waitIdle(page);
    await expect(page.locator('#pageInput')).toHaveValue('2');
    return page;
  }

  test('Sign > Insert lands on the page being read, in the saved file', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await onPageTwo(browser);
    await group(page, 'Fill & Sign');
    await page.click('#signatureBtn');
    await page.fill('#signatureName', 'Jane Signer');
    await page.evaluate((c) => { document.getElementById('signatureColor').value = c; }, BLUE);
    await page.click('#signatureInsert');
    await expect(page.locator('.toast')).toContainText('Signature added');
    const { buf } = await saved(page);
    expect((await colorBox(v, buf, 2, near(BLUE))).n).toBeGreaterThan(100);
    expect((await colorBox(v, buf, 1, near(BLUE))).n).toBe(0);
    expect((await colorBox(v, buf, 3, near(BLUE))).n).toBe(0);
  });

  test('Stamp > APPROVED lands on the page being read, in the saved file', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await onPageTwo(browser);
    await group(page, 'Assemble');
    await page.click('#stampBtn');
    await page.locator('[data-stamp="APPROVED"]').click();
    await waitIdle(page);
    const { buf } = await saved(page);
    expect((await colorBox(v, buf, 2, near('#1a7a3f'))).n).toBeGreaterThan(200);
    expect((await colorBox(v, buf, 1, near('#1a7a3f'))).n).toBe(0);
    expect((await colorBox(v, buf, 3, near('#1a7a3f'))).n).toBe(0);
  });

  test('Add Image had the same bug: it lands too', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await onPageTwo(browser);
    await page.setInputFiles('#imageInput', { name: 'mark.png', mimeType: 'image/png', buffer: solidPng(60, 40, [255, 0, 0]) });
    await waitIdle(page);
    const { buf } = await saved(page);
    expect((await colorBox(v, buf, 2, RED)).n).toBeGreaterThan(200);
    expect((await colorBox(v, buf, 1, RED)).n).toBe(0);
  });

  test('markups drawn in the editor show in the scroll view and survive going back to it', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX }, ['ONE', 'TWO']);
    await page.click('#scrollModeBtn');
    await page.waitForFunction(() => window.isScrollMode());
    await waitIdle(page);
    const seen = await page.evaluate(() => {
      const c = document.querySelector('#continuousView .cv-page canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 70 && d[i + 2] < 70) n++;
      return n;
    });
    expect(seen).toBeGreaterThan(200);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['ONE', REDHEX], ['TWO', null]]);
  });

  test('Undo from the scroll view really undoes', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX }, ['ONE', 'TWO']);
    await page.click('#scrollModeBtn');
    await page.waitForFunction(() => window.isScrollMode());
    await page.click('#undoBtn');
    await waitIdle(page);
    const { buf } = await saved(page);
    expect((await colorBox(v, buf, 1, RED)).n).toBe(0);
  });

  test('Compress from scroll keeps the view and the markups', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 2: REDHEX }, ['ONE', 'TWO', 'THREE']);
    await page.click('#scrollModeBtn');
    await page.waitForFunction(() => window.isScrollMode());
    await group(page, 'Optimize');
    await page.click('#compressBtn');
    await clickOk(page);
    await page.waitForFunction(() => /Compressed/.test(document.getElementById('statusText').textContent), null, { timeout: 30_000 });
    expect(await page.evaluate(() => window.isScrollMode())).toBe(true);
    await expect(page.locator('#continuousView .cv-page')).toHaveCount(3);
    await page.waitForFunction(() => document.querySelector('#continuousView .cv-page canvas').width > 0);
    expect(await isDirty(page)).toBe(true);
    const { buf } = await saved(page);
    await expectPages(v, buf, [[null, null], [null, REDHEX], [null, null]]);
  });

  test('a second file opened from the scroll view shows, it is not left blank', async ({ browser }) => {
    const page = await openEngine(browser, await simplePdf(['FIRST']), 'first.pdf');
    await page.setInputFiles('#fileInput', { name: 'second.pdf', mimeType: 'application/pdf', buffer: await simplePdf(['SECOND', 'SECOND-2']) });
    await page.locator('.modal-overlay [data-choice="new"]').click();
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '2');
    await page.waitForFunction(() => window.isScrollMode() && document.querySelectorAll('#continuousView .cv-page').length === 2);
    await page.waitForFunction(() => document.querySelector('#continuousView .cv-page canvas').width > 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Encrypted PDFs
// ═════════════════════════════════════════════════════════════════════════════
test.describe('6. encrypted PDFs', () => {
  const ALL = { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true };
  async function encrypted(texts, { user, owner = 'owner-pw', permissions = ALL } = {}) {
    const d = await PDFEnc.PDFDocument.load(await simplePdf(texts));
    d.encrypt({ ...(user ? { userPassword: user } : {}), ownerPassword: owner, permissions });
    return Buffer.from(await d.save());
  }
  const encryptFlags = async (buf) => {
    const d = await PDFDocument.load(buf, { ignoreEncryption: true });
    const e = d.context.lookup(d.context.trailerInfo.Encrypt);
    return e ? e.lookup(PDFName.of('P')).asNumber() : null;
  };
  const opensWithout = (v, buf) => v.page.evaluate(async (b64) => {
    try { const d = await window.__open(b64); await d.destroy(); return 'opened'; } catch (e) { return e.name; }
  }, buf.toString('base64'));

  test('open with the password, edit, save: the file opens with the same password and holds the edit', async ({ browser }) => {
    const v = await verifier(browser);
    const noPrint = { ...ALL, printing: false };
    const page = await openEngine(browser, await encrypted(['LOCKED-ONE', 'LOCKED-TWO'], { user: 'open-me', permissions: noPrint }), 'locked.pdf', { password: 'open-me', query: HOOKS });
    await editView(page);
    await addRect(page, BOX, REDHEX);
    const { buf, name } = await saved(page);
    expect(name).toBe('locked_edited.pdf');
    expect(await opensWithout(v, buf)).toBe('PasswordException');
    await expectPages(v, buf, [['LOCKED-ONE', REDHEX], ['LOCKED-TWO', null]], { password: 'open-me' });
    // It is really encrypted, and the restriction it came with is still there.
    assertNoSecrets(buf, 'encrypted save', ['LOCKED-ONE', 'LOCKED-TWO']);
    expect((await encryptFlags(buf)) & 4).toBe(0);
    await expect(page.locator('.toast')).toContainText('PDF saved');
  });

  test('page tools work on an encrypted file too', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await encrypted(['LOCKED-ONE', 'LOCKED-TWO'], { user: 'open-me' }), 'locked.pdf', { password: 'open-me', query: HOOKS });
    await editView(page);
    await page.locator('.thumb-btn.delete-btn').nth(0).click();
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '1');
    await waitIdle(page);
    const { buf } = await saved(page);
    expect((await inspect(v, buf, { password: 'open-me' })).pages.map((p) => p.text)).toEqual(['LOCKED-TWO']);
    expect(await opensWithout(v, buf)).toBe('PasswordException');
  });

  test('a restrictions-only file opens with no password, and stays restricted after a save', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await encrypted(['RESTRICTED'], { permissions: { ...ALL, copying: false } }), 'restricted.pdf', { query: HOOKS });
    await editView(page);
    await addRect(page, BOX, REDHEX);
    const { buf } = await saved(page);
    expect(await opensWithout(v, buf)).toBe('opened');
    await expectPages(v, buf, [['RESTRICTED', REDHEX]]);
    expect((await encryptFlags(buf)) & 16).toBe(0);
  });

  test('if it cannot be decrypted, saving refuses clearly and nothing downloads', async ({ browser }) => {
    const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.route('**/pdf-lib-encrypt.js*', (r) => r.abort());
    await page.goto(`${BASE}/index.html`);
    await loadInto(page, await encrypted(['LOCKED'], { user: 'open-me' }), 'locked.pdf', { password: 'open-me' });
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await page.waitForFunction(() => document.getElementById('statusText').textContent.length > 0);
    await saveMenuItem(page, 'all pages');
    await expect(page.locator('.toast')).toContainText('could not be decrypted');
    expect(await page.locator('.toast').textContent()).not.toContain('PDF saved');
    await settle(page, 400);
    expect(downloads).toBe(0);
    await expect(page.locator('#rotateBtn')).toBeDisabled();
  });

  test('cancelling a password prompt leaves the open document exactly as it was', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX }, ['KEEP-ME']);
    await page.setInputFiles('#fileInput', { name: 'other.pdf', mimeType: 'application/pdf', buffer: await encrypted(['OTHER'], { user: 'x' }) });
    await page.locator('.modal-overlay [data-choice="new"]').click();
    await page.locator('.modal-overlay [data-act="cancel"]').click();
    await settle(page, 400);
    const info = await page.evaluate(() => window.__pdfEngine.info());
    expect(info).toMatchObject({ hasDoc: true, name: 'pages.pdf', pages: 1 });
    expect(await isDirty(page)).toBe(true);
    const { buf, name } = await saved(page);
    expect(name).toBe('pages_edited.pdf');
    await expectPages(v, buf, [['KEEP-ME', REDHEX]]);
  });

  test('a wrong password, three times over, opens nothing and "repairs" nothing', async ({ browser }) => {
    const locked = await encrypted(['LOCKED'], { user: 'right' });
    const page = await settled(async () => {
      const p = await startEngine(browser, HOOKS);
      await p.setInputFiles('#fileInput', { name: 'locked.pdf', mimeType: 'application/pdf', buffer: locked });
      await p.locator('.modal-overlay input:visible').waitFor({ timeout: 5000 });
      return p;
    });
    for (let i = 0; i < 3; i++) {
      await page.locator('.modal-overlay input:visible').fill('wrong');
      await clickOk(page);
      await settle(page, 300);
    }
    await expect(page.locator('.toast')).toContainText('Incorrect password');
    expect(await page.evaluate(() => window.__pdfEngine.info().hasDoc)).toBe(false);
  });

  test('Protect with only an owner password: the file opens with no password', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX }, ['OWNER-ONLY']);
    await group(page, 'Fill & Sign');
    await page.click('#protectBtn');
    await page.locator('.modal-overlay [data-k="owner"]').fill('boss');
    await page.locator('.modal-overlay [data-k="noCopy"]').check();
    const { buf } = await download(page, () => page.getByRole('button', { name: 'Encrypt & Save' }).click(), { confirm: false });
    expect(await opensWithout(v, buf)).toBe('opened');
    await expectPages(v, buf, [['OWNER-ONLY', REDHEX]]);
    expect((await encryptFlags(buf)) & 16).toBe(0);
    await expect(PDFEnc.PDFDocument.load(buf, { password: 'boss' })).resolves.toBeTruthy();
  });

  test('merging an encrypted file asks for its password and brings real pages', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX }, ['MAIN']);
    await page.setInputFiles('#mergeInput', { name: 'sub.pdf', mimeType: 'application/pdf', buffer: await encrypted(['MERGED-IN'], { user: 'sub-pw' }) });
    await clickOk(page);   // where to insert: at the end
    await page.locator('.modal-overlay input:visible').fill('sub-pw');
    await clickOk(page);
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '2');
    await waitIdle(page);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['MAIN', REDHEX], ['MERGED-IN', null]]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Markup position, checked by rendering the saved page
// ═════════════════════════════════════════════════════════════════════════════
test.describe('7. markup position', () => {
  // The pixel box of a color on the live editor canvases, as fractions.
  const onScreenBox = (page, hex) => page.evaluate((pred) => {
    const f = window.__hooks.fabric();
    const pdfCanvas = document.getElementById('pdfCanvas');
    f.discardActiveObject(); f.renderAll();
    const c = f.lowerCanvasEl, r = window.devicePixelRatio || 1;
    const g = c.getContext('2d');
    const test = eval(pred);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (d[i + 3] > 60 && test(d[i], d[i + 1], d[i + 2])) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return { n, x0: x0 / c.width, y0: y0 / c.height, x1: (x1 + 1) / c.width, y1: (y1 + 1) / c.height, r, pdf: !!pdfCanvas };
  }, near(hex));

  async function paintEverything(page) {
    await page.evaluate(([red, blue, green, orange]) => {
      const h = window.__hooks, f = h.fabric(), W = f.width, H = f.height;
      h.addObj(h.rect({ left: 0.1 * W, top: 0.1 * H, width: 0.2 * W, height: 0.1 * H, fill: red, strokeWidth: 0 }));
      h.addObj(h.itext('Position Check', { left: 0.5 * W, top: 0.3 * H, fontSize: 0.03 * H, fill: blue, fontFamily: 'Helvetica' }));
      h.addObj(h.rect({ left: 0.1 * W, top: 0.5 * H, width: 0.3 * W, height: 0.15 * H, fill: '', stroke: green, strokeWidth: 6, strokeUniform: true }));
      h.addObj(new fabric.Polyline([{ x: 0.6 * W, y: 0.6 * H }, { x: 0.8 * W, y: 0.8 * H }, { x: 0.9 * W, y: 0.6 * H }], { stroke: orange, strokeWidth: 5, fill: '', objectCaching: false }));
    }, [REDHEX, BLUE, GREEN, ORANGE]);
    await settle(page, 200);
  }
  const COLORS = [[REDHEX, 'filled rect'], [BLUE, 'text'], [GREEN, 'stroked rect'], [ORANGE, 'polyline']];

  async function expectSameAsScreen(page, v, buf, n = 1) {
    for (const [hex, label] of COLORS) {
      const screen = await onScreenBox(page, hex);
      expect(screen.n, `${label} on screen`).toBeGreaterThan(20);
      const out = await colorBox(v, buf, n, near(hex), { scale: 2 });
      expect(out.n, `${label} in the file`).toBeGreaterThan(20);
      // Text uses the PDF's Helvetica, so only its start and baseline are compared.
      if (hex === BLUE) {
        expect(Math.abs(out.x0 - screen.x0), `text left ${out.x0} vs ${screen.x0}`).toBeLessThan(0.012);
        expect(Math.abs(out.y1 - screen.y1), `text bottom ${out.y1} vs ${screen.y1}`).toBeLessThan(0.012);
      } else {
        expectClose(out, screen, label);
      }
    }
  }

  for (const rotate of [0, 90, 180, 270]) {
    test(`on a page rotated ${rotate}: the file shows what the screen shows`, async ({ browser }) => {
      const v = await verifier(browser);
      const page = await openEngine(browser, await simplePdf(['ROT'], { rotate }), 'rot.pdf', { query: HOOKS });
      await editView(page);
      await paintEverything(page);
      const { buf } = await saved(page);
      expect((await inspect(v, buf)).pages[0].rotate).toBe(rotate);
      await expectSameAsScreen(page, v, buf);
    });
  }

  for (const rotate of [0, 90]) {
    test(`on a page with a crop box away from 0,0, rotated ${rotate}: same`, async ({ browser }) => {
      const v = await verifier(browser);
      const d = await PDFDocument.create();
      const p = d.addPage([800, 1000]);
      p.setCropBox(100, 200, 500, 600);
      if (rotate) p.setRotation(degrees(rotate));
      const page = await openEngine(browser, Buffer.from(await d.save()), 'crop.pdf', { query: HOOKS });
      await editView(page);
      await paintEverything(page);
      const { buf } = await saved(page);
      await expectSameAsScreen(page, v, buf);
    });
  }

  test('zoom changes on another page do not move or fatten stored markups', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await simplePdf(['ONE', 'TWO']), 'zoom.pdf', { query: HOOKS });
    await editView(page);
    await paintEverything(page);
    const before = await saved(page);
    const inkBefore = await colorBox(v, before.buf, 1, near(ORANGE), { scale: 2 });
    await toPage(page, 2);
    for (let i = 0; i < 3; i++) { await page.click('#zoomIn'); await settle(page, 200); }
    await toPage(page, 1);
    await waitIdle(page, 400);
    // On screen, at the new zoom, they are where they were on the page...
    for (const [hex, label] of COLORS) {
      const was = await colorBox(v, before.buf, 1, near(hex), { scale: 2 });
      const now = await onScreenBox(page, hex);
      if (hex === BLUE) continue;
      expectClose(now, was, `${label} on screen after zoom`, 0.02);
    }
    // ...and in the file.
    for (let i = 0; i < 2; i++) { await page.click('#zoomOut'); await settle(page, 200); }
    const after = await saved(page);
    for (const [hex, label] of COLORS) {
      const was = await colorBox(v, before.buf, 1, near(hex), { scale: 2 });
      const now = await colorBox(v, after.buf, 1, near(hex), { scale: 2 });
      expectClose(now, was, `${label} in the file after zoom`, 0.012);
    }
    const inkAfter = await colorBox(v, after.buf, 1, near(ORANGE), { scale: 2 });
    expect(inkAfter.n / inkBefore.n, 'a stroke keeps its weight through zooming').toBeGreaterThan(0.8);
    expect(inkAfter.n / inkBefore.n, 'a stroke keeps its weight through zooming').toBeLessThan(1.25);
  });

  test('the Rotate button carries markups with the page', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await simplePdf(['ONE', 'TWO']), 'rotate.pdf', { query: HOOKS });
    await editView(page);
    await addRect(page, [0.2, 0.1, 0.4, 0.2], REDHEX);
    await group(page, 'Organize Pages');
    await page.click('#rotateBtn');
    await expect(page.locator('.toast')).toContainText('rotated');
    await waitIdle(page);
    const { buf } = await saved(page);
    const r = await inspect(v, buf);
    expect(r.pages.map((p) => p.rotate)).toEqual([90, 0]);
    // 90 clockwise: (x, y) -> (1 - y, x)
    const want = { x0: 0.8, y0: 0.2, x1: 0.9, y1: 0.4 };
    expectClose(await colorBox(v, buf, 1, RED, { scale: 2 }), want, 'in the file');
    expectClose(await onScreenBox(page, REDHEX), want, 'on screen', 0.02);
    // And Rotate again, from an already rotated page.
    await page.click('#rotateBtn');
    await waitIdle(page);
    const twice = await saved(page);
    expect((await inspect(v, twice.buf)).pages[0].rotate).toBe(180);
    expectClose(await colorBox(v, twice.buf, 1, RED, { scale: 2 }), { x0: 0.6, y0: 0.8, x1: 0.8, y1: 0.9 }, 'after two turns');
  });

  test('a markup drawn with the real tool lands where the mouse drew it', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await simplePdf(['ONE'], { rotate: 90 }), 'draw.pdf');
    await armRect(page);
    await fitPage(page);
    await drag(page, [0.2, 0.3], [0.6, 0.7]);
    const { buf } = await saved(page);
    expectClose(await colorBox(v, buf, 1, RED, { scale: 2 }), { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.7 }, 'rect', 0.02);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Every Fabric type reaches the file
// ═════════════════════════════════════════════════════════════════════════════
test.describe('8. every markup type', () => {
  test('circle, polyline, polygon, ellipse, triangle, line, freehand and group all export', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await simplePdf(['TYPES']), 'types.pdf', { query: HOOKS });
    await editView(page);
    const shapes = [
      ['#ff0000', 'circle', [0.1, 0.2, 0.2, 0.3]],
      ['#0000ff', 'polyline', [0.3, 0.2, 0.4, 0.3]],
      ['#00cc00', 'polygon', [0.5, 0.2, 0.6, 0.3]],
      ['#ff8800', 'ellipse', [0.7, 0.2, 0.8, 0.3]],
      ['#ff00ff', 'triangle', [0.1, 0.5, 0.2, 0.6]],
      ['#00cccc', 'line', [0.3, 0.5, 0.4, 0.6]],
      ['#884400', 'path', [0.5, 0.5, 0.6, 0.6]],
      ['#888800', 'group', [0.7, 0.5, 0.8, 0.6]],
    ];
    await page.evaluate((shapes) => {
      const h = window.__hooks, f = h.fabric(), W = f.width, H = f.height;
      for (const [c, type, [a, b, x, y]] of shapes) {
        const l = a * W, t = b * H, w = (x - a) * W, ht = (y - b) * H;
        const base = { left: l, top: t, fill: c, strokeWidth: 0 };
        if (type === 'circle') h.addObj(new fabric.Circle({ ...base, radius: Math.min(w, ht) / 2 }));
        if (type === 'polyline') h.addObj(new fabric.Polyline([{ x: l, y: t }, { x: l + w, y: t + ht / 2 }, { x: l, y: t + ht }], { stroke: c, strokeWidth: 4, fill: '' }));
        if (type === 'polygon') h.addObj(new fabric.Polygon([{ x: l, y: t }, { x: l + w, y: t }, { x: l + w / 2, y: t + ht }], { fill: c, strokeWidth: 0 }));
        if (type === 'ellipse') h.addObj(new fabric.Ellipse({ ...base, rx: w / 2, ry: ht / 2 }));
        if (type === 'triangle') h.addObj(new fabric.Triangle({ ...base, width: w, height: ht }));
        if (type === 'line') h.addObj(new fabric.Line([l, t, l + w, t + ht], { stroke: c, strokeWidth: 4 }));
        if (type === 'path') h.addObj(new fabric.Path(`M ${l} ${t} L ${l + w} ${t} L ${l + w} ${t + ht} L ${l} ${t + ht} z`, { fill: c, strokeWidth: 0 }));
        if (type === 'group') h.addObj(new fabric.Group([new fabric.Rect({ left: l, top: t, width: w / 2, height: ht, fill: c, strokeWidth: 0 }), new fabric.Circle({ left: l + w / 2, top: t, radius: w / 4, fill: c, strokeWidth: 0 })]));
      }
    }, shapes);
    const { buf } = await saved(page);
    await expect(page.locator('.toast')).not.toContainText('could not');
    for (const [c, type, [a, b, x, y]] of shapes) {
      const box = await colorBox(v, buf, 1, near(c), { scale: 2 });
      expect(box.n, type).toBeGreaterThan(20);
      expect(box.x0, `${type} left`).toBeGreaterThan(a - 0.03);
      expect(box.x1, `${type} right`).toBeLessThan(x + 0.03);
      expect(box.y0, `${type} top`).toBeGreaterThan(b - 0.03);
      expect(box.y1, `${type} bottom`).toBeLessThan(y + 0.03);
    }
  });

  test('the real Measure tools: count dots, polyline, angle and radius circles all reach the file', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await simplePdf(['MEASURE']), 'measure.pdf', { query: HOOKS });
    await editView(page);
    const arm = (kind, color) => page.evaluate(([kind, color]) => {
      window.setMeasureColor(color);
      window.activateShapeToolForMeasure();
      window.setShapeKind(kind);
    }, [kind, color]);
    const clickAt = async (x, y) => { const [px, py] = await canvasPoint(page, x, y); await page.mouse.click(px, py); await settle(page, 80); };
    await arm('mcount', '#ff8800');
    await clickAt(0.1, 0.2);
    await clickAt(0.2, 0.2);
    // Lengths need a scale; a count does not. Calibrate the real way: two clicks and a length.
    await arm('mcalibrate', '#0000ff');
    await clickAt(0.1, 0.9);
    await clickAt(0.5, 0.9);
    await page.locator('.modal-overlay input:visible').fill('10 ft');
    await clickOk(page);
    await settle(page, 200);
    await arm('mpolylen', '#0000ff');
    await clickAt(0.4, 0.2);
    await clickAt(0.5, 0.3);
    await clickAt(0.6, 0.2);
    await page.keyboard.press('Enter');
    await settle(page, 150);
    await arm('mangle', '#00cc00');
    await clickAt(0.1, 0.5);
    await clickAt(0.2, 0.7);
    await clickAt(0.35, 0.7);
    await settle(page, 150);
    await arm('mradius', '#ff00ff');
    await clickAt(0.7, 0.6);
    await clickAt(0.8, 0.6);
    await settle(page, 150);
    await page.keyboard.press('Escape');
    const made = await page.evaluate(() => window.__hooks.measures().map((m) => m.kind));
    expect(made).toEqual(expect.arrayContaining(['mcount', 'mpolylen', 'mangle', 'mradius']));
    const { buf } = await saved(page);
    await expect(page.locator('.toast')).not.toContainText('could not');
    const count = await colorBox(v, buf, 1, near('#ff8800'), { scale: 2 });
    expect(count.n, 'count dots').toBeGreaterThan(50);
    expect(count.x0, 'first dot').toBeLessThan(0.1);
    expect(count.x1, 'second dot').toBeGreaterThan(0.2);
    expect((await fillOf(v, buf, 1, near('#ff8800'), [0.097, 0.197, 0.103, 0.203], { scale: 2 })), 'dot sits at its click').toBeGreaterThan(0.8);
    const poly = await colorBox(v, buf, 1, near('#0000ff'), { scale: 2 });
    expect(poly.n, 'polyline').toBeGreaterThan(50);
    expect(poly.x0).toBeCloseTo(0.4, 1);
    expect(poly.x1).toBeGreaterThan(0.55);
    const angle = await colorBox(v, buf, 1, near('#00cc00'), { scale: 2 });
    expect(angle.n, 'angle').toBeGreaterThan(50);
    expect(angle.y1).toBeGreaterThan(0.65);
    const radius = await colorBox(v, buf, 1, near('#ff00ff'), { scale: 2 });
    expect(radius.n, 'radius circle').toBeGreaterThan(50);
    // The circle reaches past the center on every side.
    expect(radius.x0).toBeLessThan(0.65);
    expect(radius.x1).toBeGreaterThan(0.75);
  });

  test('an object that cannot be exported is counted and named in the toast; the rest still save', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX }, ['ONE', 'TWO']);
    await page.evaluate(() => {
      window.__hooks.annotations()[2] = { zoom: 1, fabricData: { version: '5.3.0', objects: [{ type: 'no-such-type', left: 10, top: 10 }, { type: 'rect', left: 100, top: 100, width: 100, height: 100, fill: '#00cc00', strokeWidth: 0 }] } };
    });
    const { buf } = await saved(page);
    await expect(page.locator('.toast')).toContainText('1 markup could not be included');
    expect((await colorBox(v, buf, 1, RED)).n).toBeGreaterThan(200);
    expect((await colorBox(v, buf, 2, near(GREEN))).n).toBeGreaterThan(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Markups follow their page through every page operation
// ═════════════════════════════════════════════════════════════════════════════
test.describe('9. page tools', () => {
  test('Add Page: nothing is copied onto the new page, later pages keep theirs', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX, 2: GREEN });
    await toPage(page, 1);
    await group(page, 'Organize Pages');
    await page.click('#addPageBtn');
    await clickOk(page);
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '5');
    await waitIdle(page);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['P1', REDHEX], ['', null], ['P2', GREEN], ['P3', null], ['P4', null]]);
  });

  test('Delete: page 1 goes, and the markup on page 2 stays on that content only', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX, 2: GREEN });
    await toPage(page, 1);
    await page.locator('.thumb-btn.delete-btn').nth(0).click();
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '3');
    await waitIdle(page);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['P2', GREEN], ['P3', null], ['P4', null]]);
  });

  test('Undo of a Delete brings the page and its markup back', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX, 2: GREEN });
    await toPage(page, 1);
    await page.locator('.thumb-btn.delete-btn').nth(0).click();
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '3');
    await waitIdle(page);
    await page.click('#undoBtn');
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '4');
    await waitIdle(page);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['P1', REDHEX], ['P2', GREEN], ['P3', null], ['P4', null]]);
  });

  test('Reorder: markups travel with the moved page', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX, 4: GREEN });
    await page.evaluate(() => window.__hooks.movePage(4, 2));
    await page.waitForFunction(() => window.__hooks.state().page === 2);
    await waitIdle(page);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['P1', REDHEX], ['P4', GREEN], ['P2', null], ['P3', null]]);
  });

  test('Merge at the start pushes markups along', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 2: GREEN }, ['P1', 'P2']);
    await page.setInputFiles('#mergeInput', { name: 'in.pdf', mimeType: 'application/pdf', buffer: await simplePdf(['NEW-1', 'NEW-2']) });
    await page.locator('.modal-overlay [data-k="pos"]').selectOption('start');
    await clickOk(page);
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '4');
    await waitIdle(page);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['NEW-1', null], ['NEW-2', null], ['P1', null], ['P2', GREEN]]);
  });

  test('Remove Blank keeps every markup on its page and stamps nothing on page 1', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 3: GREEN, 4: BLUE }, ['P1', ' ', 'P3', 'P4']);
    await group(page, 'Organize Pages');
    await page.click('#rmBlankBtn');
    await page.locator('.modal-overlay [data-choice="remove"]').click();
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '3');
    await waitIdle(page);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['P1', null], ['P3', GREEN], ['P4', BLUE]]);
  });

  test('a blank page someone drew on is not blank', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 2: GREEN }, ['P1', ' ', ' ']);
    await group(page, 'Organize Pages');
    await page.click('#rmBlankBtn');
    await expect(page.locator('.modal-overlay')).toContainText(['page 3']);
    await page.locator('.modal-overlay [data-choice="remove"]').click();
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '2');
    await waitIdle(page);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['P1', null], [null, GREEN]]);
  });

  test('Add Images keeps the markups and the unsaved work', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 2: GREEN }, ['P1', 'P2']);
    await page.setInputFiles('#addImagePageInput', { name: 'scan.png', mimeType: 'image/png', buffer: solidPng(100, 100, [0, 0, 255]) });
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '3');
    await waitIdle(page);
    expect(await isDirty(page)).toBe(true);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['P1', null], ['P2', GREEN], ['', null]]);
    expect((await colorBox(v, buf, 3, near(BLUE))).n).toBeGreaterThan(200);
  });

  test('N-up keeps a markup past the new page count: it is burned onto its sheet', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX, 3: GREEN, 4: BLUE });
    await group(page, 'Organize Pages');
    await page.click('#nupBtn');
    await page.locator('.modal-overlay [data-k="n"]').selectOption('2');
    await clickOk(page);
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '2');
    await waitIdle(page);
    const { buf } = await saved(page);
    const r = await inspect(v, buf);
    expect(r.numPages).toBe(2);
    expect(r.pages[0].text).toContain('P1');
    expect(r.pages[1].text).toContain('P3');
    const left = await colorBox(v, buf, 2, near(GREEN));
    const right = await colorBox(v, buf, 2, near(BLUE));
    expect(left.n).toBeGreaterThan(200);
    expect(right.n).toBeGreaterThan(200);
    expect(left.x1).toBeLessThan(0.5);
    expect(right.x0).toBeGreaterThan(0.5);
    expect((await colorBox(v, buf, 1, RED)).x1).toBeLessThan(0.5);
    expect((await colorBox(v, buf, 1, near(GREEN))).n).toBe(0);
    // Nothing is left over to be drawn a second time.
    expect(await page.evaluate(() => Object.keys(window.__hooks.annotations()).filter((k) => (window.__hooks.annotations()[k].fabricData.objects || []).length))).toEqual([]);
  });

  async function cropFromCanvas(page, a, b, mode) {
    await group(page, 'Assemble');
    await page.click('#cropTool');
    await drag(page, a, b);
    await page.click('#cropApply');
    await page.locator('.modal-overlay [data-k="mode"]').selectOption(mode);
    await clickOk(page);
    await expect(page.locator('.toast')).toContainText(/ropped/);
    await waitIdle(page);
  }
  // Fractions of the old page, seen through a crop from a to b.
  const through = (box, [ax, ay], [bx, by]) => [(box[0] - ax) / (bx - ax), (box[1] - ay) / (by - ay), (box[2] - ax) / (bx - ax), (box[3] - ay) / (by - ay)];

  test('Crop this page, then crop it again: the markup stays on what it was drawn on', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX, 2: GREEN }, ['P1', 'P2']);
    await toPage(page, 1);
    await fitPage(page);
    const A = [0.1, 0.1], B = [0.9, 0.9];
    await cropFromCanvas(page, A, B, 'replace');
    let { buf } = await saved(page);
    const once = through(BOX, A, B);
    expectClose(await colorBox(v, buf, 1, RED, { scale: 2 }), { x0: once[0], y0: once[1], x1: once[2], y1: once[3] }, 'one crop', 0.02);
    await fitPage(page);
    await cropFromCanvas(page, A, B, 'replace');
    ({ buf } = await saved(page));
    const twice = through(once, A, B);
    expectClose(await colorBox(v, buf, 1, RED, { scale: 2 }), { x0: twice[0], y0: twice[1], x1: twice[2], y1: twice[3] }, 'two crops', 0.03);
    expect((await colorBox(v, buf, 2, near(GREEN))).n).toBeGreaterThan(200);
    const r = await inspect(v, buf);
    expect(r.pages[1].text).toBe('P2');
  });

  test('Crop all pages: every page keeps its markup', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX, 2: GREEN }, ['P1', 'P2']);
    await toPage(page, 1);
    await fitPage(page);
    const A = [0.1, 0.1], B = [0.9, 0.9];
    await cropFromCanvas(page, A, B, 'all');
    const { buf } = await saved(page);
    const box = through(BOX, A, B);
    const want = { x0: box[0], y0: box[1], x1: box[2], y1: box[3] };
    expectClose(await colorBox(v, buf, 1, RED, { scale: 2 }), want, 'page 1', 0.02);
    expectClose(await colorBox(v, buf, 2, near(GREEN), { scale: 2 }), want, 'page 2', 0.02);
  });

  test('Crop to a copy: the original keeps its markup, the pages after keep theirs', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX, 2: GREEN }, ['P1', 'P2']);
    await toPage(page, 1);
    await fitPage(page);
    await cropFromCanvas(page, [0.1, 0.1], [0.9, 0.9], 'dup');
    const { buf } = await saved(page);
    const r = await inspect(v, buf);
    expect(r.numPages).toBe(3);
    expect((await colorBox(v, buf, 1, RED)).n).toBeGreaterThan(200);
    expect((await colorBox(v, buf, 2, RED)).n).toBe(0);
    expect((await colorBox(v, buf, 3, near(GREEN))).n).toBeGreaterThan(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Compare
// ═════════════════════════════════════════════════════════════════════════════
test.describe('10. compare', () => {
  async function compareWith(page, other) {
    await group(page, 'Fill & Sign');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#compareBtn')]);
    await chooser.setFiles({ name: 'other.pdf', mimeType: 'application/pdf', buffer: other });
    await page.waitForSelector('#compareResult');
  }

  test('the result opens beside the document: the file, its markups and its unsaved work stay', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 2: GREEN }, ['SAME', 'SAME-2']);
    await compareWith(page, await simplePdf(['SAME', 'DIFFERENT', 'EXTRA']));
    await expect(page.locator('#compareResult img')).toHaveCount(3);
    expect(await page.evaluate(() => window.__pdfEngine.info())).toMatchObject({ hasDoc: true, name: 'pages.pdf', pages: 2 });
    expect(await isDirty(page)).toBe(true);
    await expect(page.locator('#compareResult button', { hasText: 'Download Comparison' })).toBeVisible();

    const comparison = await download(page, () => page.locator('#compareResult .wp-download').click(), { confirm: false });
    expect(comparison.name).toBe('pages_comparison.pdf');
    expect((await inspect(v, comparison.buf)).numPages).toBe(3);
    expect((await colorBox(v, comparison.buf, 2, near('#e61e1e'))).n, 'differences are red').toBeGreaterThan(20);
    expect(await isDirty(page), 'a comparison is not a save of the document').toBe(true);
    expect(await page.evaluate(() => window.__events.filter((e) => e.type === 'pdf-engine:did').map((e) => e.detail.action))).toEqual(['export']);

    await page.keyboard.press('Escape');
    await expect(page.locator('#compareResult')).toHaveCount(0);
    const { buf } = await saved(page);
    await expectPages(v, buf, [['SAME', null], ['SAME-2', GREEN]]);
  });

  test('a redacted document shows its boxes in the comparison, never what is under them', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await secretPdf(), 'secret.pdf');
    await redactBox(page, [0.08, 0.08], [0.62, 0.14]);
    await compareWith(page, await simplePdf(['OTHER']));
    const { buf } = await download(page, () => page.locator('#compareResult .wp-download').click(), { confirm: false });
    assertNoSecrets(buf, 'comparison');
    // The box differs from the other file, so it paints as a solid red block: no
    // silhouette of the text under it, in the one picture that holds this page.
    expect(await fillOf(v, buf, 1, near('#e61e1e'), [0.09, 0.09, 0.61, 0.13])).toBeGreaterThan(0.8);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Fill Form
// ═════════════════════════════════════════════════════════════════════════════
test.describe('11. forms', () => {
  async function formPdf() {
    const d = await PDFDocument.create();
    const p = d.addPage([612, 792]);
    const form = d.getForm();
    form.createTextField('full.name').addToPage(p, { x: 72, y: 700, width: 300, height: 24 });
    form.createCheckBox('agree').addToPage(p, { x: 72, y: 660, width: 20, height: 20 });
    const radio = form.createRadioGroup('color');
    radio.addOptionToPage('Red', p, { x: 72, y: 620, width: 20, height: 20 });
    radio.addOptionToPage('Blue', p, { x: 112, y: 620, width: 20, height: 20 });
    const drop = form.createDropdown('state');
    drop.addOptions(['CA', 'NY', 'TX']);
    drop.addToPage(p, { x: 72, y: 580, width: 120, height: 24 });
    const list = form.createOptionList('fruit');
    list.addOptions(['Apple', 'Pear']);
    list.addToPage(p, { x: 72, y: 480, width: 120, height: 60 });
    return Buffer.from(await d.save());
  }
  const formFields = async (buf) => {
    const f = (await PDFDocument.load(buf)).getForm();
    return {
      name: f.getTextField('full.name').getText(),
      agree: f.getCheckBox('agree').isChecked(),
      color: f.getRadioGroup('color').getSelected(),
      state: f.getDropdown('state').getSelected(),
      fruit: f.getOptionList('fruit').getSelected(),
    };
  };
  const inField = (page, i) => page.locator(`.modal-overlay [data-k="f${i}"]`);

  test('every field type renders an input and its value lands in the saved file', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await formPdf(), 'form.pdf', { query: HOOKS });
    await group(page, 'Fill & Sign');
    await page.click('#formsBtn');
    await expect(page.getByText('5 field(s) found')).toBeVisible();
    await inField(page, 0).fill('Jane Tester');
    await inField(page, 1).check();
    await inField(page, 2).selectOption('Blue');
    await inField(page, 3).selectOption('NY');
    await inField(page, 4).selectOption('Pear');
    await clickOk(page);
    await expect(page.locator('.toast')).toContainText('Form filled');
    expect(await isDirty(page)).toBe(true);
    await waitIdle(page);
    const { buf } = await saved(page);
    expect(await formFields(buf)).toEqual({ name: 'Jane Tester', agree: true, color: 'Blue', state: ['NY'], fruit: ['Pear'] });
    // The value is drawn on the page as well, not only stored.
    const text = await inspect(v, buf);
    expect(text.numPages).toBe(1);
    expect((await colorBox(v, buf, 1, BLACK, { scale: 2 })).n).toBeGreaterThan(50);

    // The dialog shows the values back, and clearing works.
    await page.click('#formsBtn');
    await expect(inField(page, 0)).toHaveValue('Jane Tester');
    await expect(inField(page, 1)).toBeChecked();
    await expect(inField(page, 3)).toHaveValue('NY');
    await inField(page, 0).fill('');
    await inField(page, 1).uncheck();
    await inField(page, 3).selectOption('');
    await clickOk(page);
    await waitIdle(page);
    const cleared = await saved(page);
    expect(await formFields(cleared.buf)).toMatchObject({ name: undefined, agree: false, state: [] });
  });

  test('a character the form font cannot show is refused by name; the other fields still fill', async ({ browser }) => {
    const page = await openEngine(browser, await formPdf(), 'form.pdf', { query: HOOKS });
    await group(page, 'Fill & Sign');
    await page.click('#formsBtn');
    await inField(page, 0).fill('Rs ₹500');
    await inField(page, 1).check();
    await clickOk(page);
    await expect(page.locator('.toast')).toContainText('could not fill full.name');
    await waitIdle(page);
    const { buf } = await saved(page);
    expect(await formFields(buf)).toMatchObject({ name: undefined, agree: true });
  });

  test('markups stay when a form is filled, and nothing claims "filled" when nothing can be', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await formPdf(), 'form.pdf', { query: HOOKS });
    await editView(page);
    await addRect(page, [0.5, 0.5, 0.7, 0.7], REDHEX);
    await group(page, 'Fill & Sign');
    await page.click('#formsBtn');
    await inField(page, 0).fill('Keeps The Box');
    await clickOk(page);
    await expect(page.locator('.toast')).toContainText('Form filled');
    await waitIdle(page);
    const { buf } = await saved(page);
    expect((await colorBox(v, buf, 1, RED)).n).toBeGreaterThan(200);
    expect((await formFields(buf)).name).toBe('Keeps The Box');

    const plain = await openEngine(browser, await simplePdf(['NO FORM']), 'plain.pdf');
    await group(plain, 'Fill & Sign');
    await plain.click('#formsBtn');
    await expect(plain.locator('.toast')).toContainText('no fillable form fields');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. Text the standard fonts cannot encode
// ═════════════════════════════════════════════════════════════════════════════
test.describe('12. non-WinAnsi text', () => {
  test('a rupee sign, an arrow and Hindi save and render; the other objects are not lost', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await simplePdf(['BASE']), 'uni.pdf', { query: HOOKS });
    await editView(page);
    await page.evaluate(([blue, green]) => {
      const h = window.__hooks, f = h.fabric(), W = f.width, H = f.height;
      h.addObj(h.itext('₹1,000 → हिन्दी', { left: 0.1 * W, top: 0.3 * H, fontSize: 0.04 * H, fill: blue }));
      h.addObj(h.itext('PLAIN-NOTE', { left: 0.1 * W, top: 0.5 * H, fontSize: 0.03 * H, fill: green }));
      h.addObj(h.rect({ left: 0.6 * W, top: 0.6 * H, width: 0.2 * W, height: 0.1 * H, fill: '#ff0000', strokeWidth: 0 }));
    }, [BLUE, GREEN]);
    const { buf } = await saved(page);
    await expect(page.locator('.toast')).toContainText('PDF saved');
    await expect(page.locator('.toast')).not.toContainText('could not');
    const uni = await colorBox(v, buf, 1, near(BLUE), { scale: 2 });
    expect(uni.n).toBeGreaterThan(100);
    expect(uni.x0).toBeCloseTo(0.1, 1);
    expect(uni.y0).toBeGreaterThan(0.28);
    expect(uni.y1).toBeLessThan(0.38);
    expect((await colorBox(v, buf, 1, RED)).n).toBeGreaterThan(200);
    const r = await inspect(v, buf);
    expect(r.pages[0].text).toContain('BASE');
    expect(r.pages[0].text).toContain('PLAIN-NOTE');   // ordinary text stays real text
    expect((await colorBox(v, buf, 1, near(GREEN), { scale: 2 })).n).toBeGreaterThan(50);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. Dirty tracking, and 14. the interface the Nexus side builds on
// ═════════════════════════════════════════════════════════════════════════════
test.describe('13. dirty tracking', () => {
  test('every kind of change counts as unsaved work, and a save clears it', async ({ browser }) => {
    const page = await openEngine(browser, await simplePdf(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', ' ']), 'dirty.pdf', { query: HOOKS });
    const dirtyBtn = page.locator('#downloadBtn.dirty');
    expect(await isDirty(page), 'a fresh file').toBe(false);
    await expect(dirtyBtn).toHaveCount(0);
    await editView(page);
    expect(await isDirty(page), 'looking around changes nothing').toBe(false);
    await page.click('#zoomIn');
    await settle(page, 200);
    await toPage(page, 2);
    await toPage(page, 1);
    expect(await isDirty(page), 'zooming and paging change nothing').toBe(false);
    await fitPage(page);

    const organize = async (id) => { await group(page, 'Organize Pages'); await page.click(id); };
    const pagesAre = (n) => page.waitForFunction((n) => document.getElementById('totalPages').textContent === String(n), n);
    const ops = {
      'a markup': async () => { await addRect(page, BOX, REDHEX); },
      rotate: async () => { await organize('#rotateBtn'); await expect(page.locator('.toast')).toContainText('rotated'); },
      'add page': async () => { await organize('#addPageBtn'); await clickOk(page); await pagesAre(10); },
      delete: async () => { await page.locator('.thumb-btn.delete-btn').nth(1).click(); await pagesAre(9); },
      reorder: async () => { await page.evaluate(() => window.__hooks.movePage(3, 4)); await settle(page, 500); },
      merge: async () => {
        await page.setInputFiles('#mergeInput', { name: 'm.pdf', mimeType: 'application/pdf', buffer: await simplePdf(['M']) });
        await clickOk(page);
        await pagesAre(10);
      },
      crop: async () => {
        await fitPage(page);
        await group(page, 'Assemble');
        await page.click('#cropTool');
        await drag(page, [0.1, 0.1], [0.9, 0.9]);
        await page.click('#cropApply');
        await page.locator('.modal-overlay [data-k="mode"]').selectOption('replace');
        await clickOk(page);
        await expect(page.locator('.toast')).toContainText(/ropped/);
      },
      'remove blank': async () => { await organize('#rmBlankBtn'); await page.locator('.modal-overlay [data-choice="remove"]').click({ timeout: 5000 }); await settle(page, 600); },
      watermark: async () => { await organize('#watermarkBtn'); await clickOk(page); await settle(page, 600); },
      'page numbers': async () => { await organize('#pageNumBtn'); await clickOk(page); await settle(page, 600); },
      compress: async () => { await group(page, 'Optimize'); await page.click('#compressBtn'); await page.locator('.modal-overlay [data-k="level"]').selectOption('light'); await clickOk(page); await settle(page, 600); },
      'hiding a layer': async () => { await page.evaluate(() => window.pdfLayers.setVisible(1, false)); await page.evaluate(() => window.pdfLayers.setVisible(1, true)); },
      undo: async () => { await page.click('#undoBtn'); await settle(page, 600); },
    };
    for (const [name, run] of Object.entries(ops)) {
      await waitIdle(page, 300);
      await page.evaluate(() => window.__pdfEngine.markSaved());
      expect(await isDirty(page), `clean before ${name}`).toBe(false);
      await run();
      await settle(page, 150);
      expect(await isDirty(page), `after ${name}`).toBe(true);
      await expect(dirtyBtn, `the Save button shows it after ${name}`).toHaveCount(1);
    }
    await saved(page);
    expect(await isDirty(page), 'a successful save clears it').toBe(false);
    await expect(dirtyBtn).toHaveCount(0);
  });

  test('OCR counts as a change and keeps the markups', async ({ browser }) => {
    test.setTimeout(240_000);
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX }, ['OCR ME PLEASE']);
    await page.evaluate(() => window.__pdfEngine.markSaved());
    await group(page, 'Optimize');
    await page.click('#ocrBtn');
    await clickOk(page);
    await page.waitForFunction(() => /OCR completed/.test(document.getElementById('statusText').textContent), null, { timeout: 200_000 });
    expect(await isDirty(page)).toBe(true);
    await waitIdle(page);
    const { buf } = await saved(page);
    expect((await colorBox(v, buf, 1, RED)).n).toBeGreaterThan(200);
  });

  test('a failed save leaves the work marked unsaved', async ({ browser }) => {
    const page = await markedPages(browser, { 1: REDHEX }, ['ONE']);
    await page.evaluate(() => { PDFLib.PDFDocument.prototype.save = async function () { throw new Error('disk on fire'); }; });
    await saveMenuItem(page, 'all pages');
    await expect(page.locator('.toast')).toContainText('disk on fire');
    expect(await isDirty(page)).toBe(true);
  });

  test('every export that writes the whole document clears it; a page export does not', async ({ browser }) => {
    const page = await markedPages(browser, { 1: REDHEX }, ['ONE', 'TWO']);
    await download(page, () => saveMenuItem(page, 'PNG image'), { confirm: false });
    expect(await isDirty(page), 'a picture of one page saves nothing').toBe(true);
    await download(page, () => saveMenuItem(page, 'All text', { other: true }), { confirm: false });
    expect(await isDirty(page), 'nor does a text export').toBe(true);
    await download(page, () => saveMenuItem(page, 'Flattened', { other: true }), { confirm: false });
    expect(await isDirty(page), 'a flattened copy holds everything').toBe(false);
  });
});

test.describe('14. window.__pdfEngine', () => {
  const states = (page) => page.evaluate(() => window.__events.filter((e) => e.type === 'pdf-engine:state').map((e) => e.detail));
  const dids = (page) => page.evaluate(() => window.__events.filter((e) => e.type === 'pdf-engine:did').map((e) => e.detail));
  const posts = (page) => page.evaluate(() => window.__events.filter((e) => e.type === 'post').map((e) => e.detail));
  const openVia = (page, buf, name) => page.evaluate(async ({ b64, name }) => {
    await window.__pdfEngine.openBytes(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), name);
  }, { b64: buf.toString('base64'), name });

  test('openBytes, info, isDirty, markSaved and the state events', async ({ browser }) => {
    const page = await openEngine(browser, null, undefined, { query: HOOKS });
    expect(await page.evaluate(() => window.__pdfEngine.info())).toEqual({ hasDoc: false, name: '', pages: 0, redacted: false });
    await openVia(page, await simplePdf(['ONE', 'TWO']), 'bridge.pdf');
    expect(await page.evaluate(() => window.__pdfEngine.info())).toEqual({ hasDoc: true, name: 'bridge.pdf', pages: 2, redacted: false });
    expect(await isDirty(page)).toBe(false);
    expect((await states(page)).at(-1)).toEqual({ hasDoc: true, dirty: false, name: 'bridge.pdf', pages: 2 });
    expect((await posts(page)).at(-1)).toEqual({ type: 'pdf-editor:doc-state', hasDoc: true, dirty: false });

    await page.waitForSelector('#continuousView .cv-page');
    await editView(page);
    await addRect(page, BOX, REDHEX);
    expect(await isDirty(page)).toBe(true);
    expect((await states(page)).at(-1).dirty).toBe(true);
    expect((await posts(page)).at(-1)).toEqual({ type: 'pdf-editor:doc-state', hasDoc: true, dirty: true });

    await page.evaluate(() => window.__pdfEngine.markSaved());
    expect(await isDirty(page)).toBe(false);
    expect((await states(page)).at(-1).dirty).toBe(false);

    // Delete a page: the page count moves in the event too.
    await page.locator('.thumb-btn.delete-btn').nth(1).click();
    await page.waitForFunction(() => document.getElementById('totalPages').textContent === '1');
    await waitIdle(page);
    expect((await states(page)).at(-1)).toEqual({ hasDoc: true, dirty: true, name: 'bridge.pdf', pages: 1 });
  });

  test('openBytes rejects on a file that cannot open, and leaves the document alone', async ({ browser }) => {
    const page = await openEngine(browser, await simplePdf(['KEEP']), 'keep.pdf', { query: HOOKS });
    const bad = await page.evaluate(async () => {
      try { await window.__pdfEngine.openBytes(new TextEncoder().encode('not a pdf'), 'bad.pdf'); return 'resolved'; } catch (e) { return e.message; }
    });
    expect(bad).toContain('could not be opened');
    expect(await page.evaluate(() => window.__pdfEngine.info())).toMatchObject({ hasDoc: true, name: 'keep.pdf', pages: 1 });
  });

  test('buildOutput is the one pipeline: markups and redactions in, bytes verified, state untouched', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await openEngine(browser, await secretPdf(), 'secret.pdf', { query: HOOKS });
    await redactBox(page, REDACT_A, REDACT_B);
    expect(await page.evaluate(() => window.__pdfEngine.info().redacted)).toBe(true);
    const out = await page.evaluate(async () => {
      const { bytes, name } = await window.__pdfEngine.buildOutput();
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return { b64: btoa(bin), name, isU8: bytes instanceof Uint8Array, dirty: window.__pdfEngine.isDirty() };
    });
    expect(out.name).toBe('secret_edited.pdf');
    expect(out.isU8).toBe(true);
    expect(out.dirty, 'buildOutput does not count as saved until markSaved').toBe(true);
    const buf = Buffer.from(out.b64, 'base64');
    assertNoSecrets(buf, 'buildOutput');
    expect((await inspect(v, buf)).numPages).toBe(3);
    expect(await fillOf(v, buf, 1, BLACK, [0.09, 0.09, 0.61, 0.13])).toBeGreaterThan(0.98);
  });

  test('pdf-engine:did says download, redact, protect and export', async ({ browser }) => {
    const page = await markedPages(browser, { 1: REDHEX }, ['ONE', 'TWO']);
    const last = async () => (await dids(page)).at(-1);

    await saved(page);
    expect(await last()).toEqual({ action: 'download', name: 'pages_edited.pdf', pages: 2 });

    await group(page, 'Fill & Sign');
    await page.click('#protectBtn');
    await page.locator('.modal-overlay [data-k="user"]').fill('pw');
    await download(page, () => page.getByRole('button', { name: 'Encrypt & Save' }).click(), { confirm: false });
    expect(await last()).toEqual({ action: 'protect', name: 'pages_protected.pdf', pages: 2 });

    await download(page, () => saveMenuItem(page, 'All text', { other: true }), { confirm: false });
    expect((await last()).action).toBe('export');

    await redactBox(page, [0.1, 0.1], [0.2, 0.2]);
    await saveAll(page);
    expect(await last()).toMatchObject({ action: 'redact', pages: 2 });
    // A failed save announces nothing.
    const before = (await dids(page)).length;
    await page.evaluate(() => { PDFLib.PDFDocument.prototype.save = async function () { throw new Error('no'); }; });
    await saveMenuItem(page, 'all pages');
    await expect(page.locator('.toast')).toContainText('Save failed');
    expect((await dids(page)).length).toBe(before);
  });
});

test.describe('layers', () => {
  test('a hidden layer stays out of the file, and the save says so first', async ({ browser }) => {
    const v = await verifier(browser);
    const page = await markedPages(browser, { 1: REDHEX }, ['ONE']);
    await page.evaluate(() => window.pdfLayers.setVisible(1, false));
    const { buf } = await download(page, async () => {
      await saveMenuItem(page, 'all pages');
      await page.locator('.modal-overlay [data-choice="save"]').click();
    }, { confirm: false });
    expect((await colorBox(v, buf, 1, RED)).n).toBe(0);
  });
});
