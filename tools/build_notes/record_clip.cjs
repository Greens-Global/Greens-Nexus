#!/usr/bin/env node
// Record a short clip of a fix for a Build Mode pin (11/12/2026).
//
//   node tools/build_notes/record_clip.cjs <url> --out clip.webm
//        [--viewport 1280x800] [--click "<selector>"]... [--type "<selector>=<text>"]...
//        [--wait 800] [--seconds 4]
//
// Opens the page, runs the steps in the order given (each --click / --type
// is followed by a pause of --wait milliseconds), holds for --seconds, and
// writes ONE WebM. Attach it with `cli.py clip <id> --video clip.webm`; the
// author plays it on the pin and Accepts or Reopens from there.
//
// It records the page only - no microphone, no desktop. Keep it under 25 MB
// (the server's cap): a few steps at the pin's own viewport is enough.
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadPlaywright() {
  const tries = ['playwright', path.join(__dirname, '..', '..', 'e2e', 'node_modules', 'playwright'),
    path.join(__dirname, '..', '..', 'frontend', 'node_modules', 'playwright')];
  for (const name of tries) {
    try { return require(name); } catch (e) { /* the next place */ }
  }
  console.error('Playwright is not installed here - record no clip and say so on the pin.');
  process.exit(2);
  return null;
}

function parse(argv) {
  const out = { url: '', out: 'clip.webm', viewport: '1280x800', wait: 800, seconds: 4, steps: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) { console.error(a + ' needs a value'); process.exit(2); } return argv[i]; };
    if (a === '--out') out.out = next();
    else if (a === '--viewport') out.viewport = next();
    else if (a === '--wait') out.wait = Math.max(0, Number(next()) || 0);
    else if (a === '--seconds') out.seconds = Math.min(60, Math.max(0, Number(next()) || 0));
    else if (a === '--click') out.steps.push({ click: next() });
    else if (a === '--type') {
      const v = next(); const at = v.indexOf('=');
      if (at < 1) { console.error('--type takes "<selector>=<text>"'); process.exit(2); }
      out.steps.push({ type: v.slice(0, at), text: v.slice(at + 1) });
    } else if (a.startsWith('--')) { console.error('Unknown option ' + a); process.exit(2); }
    else if (!out.url) out.url = a;
  }
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(out.viewport);
  if (!out.url || !m) { console.error('Usage: record_clip.cjs <url> --out clip.webm [--viewport WxH] [--click SEL]... [--type SEL=TEXT]... [--wait MS] [--seconds N]'); process.exit(2); }
  out.size = { width: Number(m[1]), height: Number(m[2]) };
  return out;
}

(async () => {
  const args = parse(process.argv.slice(2));
  const { chromium } = loadPlaywright();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-clip-'));
  const browser = await chromium.launch();
  let failed = '';
  try {
    const context = await browser.newContext({ viewport: args.size, recordVideo: { dir, size: args.size } });
    const page = await context.newPage();
    try {
      await page.goto(args.url, { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(args.wait);
      for (const step of args.steps) {
        if (step.click) await page.click(step.click, { timeout: 15000 });
        else await page.fill(step.type, step.text, { timeout: 15000 });
        await page.waitForTimeout(args.wait);
      }
      await page.waitForTimeout(args.seconds * 1000);
    } catch (e) {
      failed = String((e && e.message) || e).split('\n')[0];
    }
    const video = page.video();
    await context.close();                       // the file is complete only once the context closes
    if (!failed && video) {
      const from = await video.path();
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.copyFileSync(from, args.out);
    }
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failed) { console.error('No clip: ' + failed); process.exit(1); }
  const size = fs.statSync(args.out).size;
  if (size > 25 * 1024 * 1024) { console.error('The clip is over 25 MB (' + Math.round(size / 1048576) + ' MB) - record fewer steps or a smaller viewport.'); process.exit(1); }
  console.log('Clip saved: ' + args.out + ' (' + Math.max(1, Math.round(size / 1024)) + ' KB)');
})();
