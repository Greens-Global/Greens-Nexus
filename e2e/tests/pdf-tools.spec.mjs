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
    window.__open = (b64, password) => pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), ...(password ? { password } : {}) }).promise;
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
    await page.locator('.modal-overlay input').fill(password);
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
