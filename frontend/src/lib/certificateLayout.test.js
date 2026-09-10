import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Certificate of Completion - acceptance criteria 5, 6 and 7 of the build note.
//
//   5  regeneration from a fixed snapshot is byte-identical
//   6  exactly one letter page for 1-4 signers; a different template at 5
//   7  the embedded QR decodes to the verification URL, read back out of the
//      generated HTML
//
// These drive the REAL Python renderer and measure in real Chromium, because
// the page count is a layout fact - "do not eyeball the page count". A fixture
// copy of the HTML would drift away from the renderer and quietly stop
// testing it.

const REPO = resolve(__dirname, '../../..');
const BACKEND = join(REPO, 'backend');
const PY = join(BACKEND, '.venv', 'Scripts', 'python.exe');
const PY_NIX = join(BACKEND, '.venv', 'bin', 'python');
const python = existsSync(PY) ? PY : existsSync(PY_NIX) ? PY_NIX : null;

const SHEET_H = 1056;   // 11in at 96dpi
const VERIFY_URL = 'https://nexus.greensglobal.com/verify/8f2a1c9d4e7b3f60';

function renderCertificate(signerCount) {
  return execFileSync(python, ['-m', 'services.certificate', String(signerCount), VERIFY_URL],
    { cwd: BACKEND, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

let browser;
let dir;
beforeAll(async () => {
  if (!python) return;
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  dir = mkdtempSync(join(tmpdir(), 'nexus-cert-'));
}, 60_000);
afterAll(async () => { if (browser) await browser.close(); });

/** Lay the HTML out in Chromium and return the certificate's real box. */
async function measure(html, name) {
  const file = join(dir, `${name}.html`);
  writeFileSync(file, html, 'utf8');
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  try {
    await page.goto(pathToFileURL(file).href);
    const box = await page.locator('#certificate').boundingBox();
    const qr = await page.locator('#certificate svg').first().screenshot();
    return { box, qr, page: null };
  } finally {
    await page.close();
  }
}

const maybe = python ? describe : describe.skip;
if (!python) {
  // Loud, not silent: a skipped layout suite must be obvious in the log.
  console.warn('[certificateLayout] backend venv not found - layout tests skipped');
}

maybe('Certificate determinism (criterion 5)', () => {
  it('regenerates byte-identically from the same snapshot', () => {
    const first = renderCertificate(3);
    for (let i = 0; i < 5; i++) {
      expect(renderCertificate(3)).toBe(first);
    }
  });

  it('renders different signer counts differently (the check is not vacuous)', () => {
    expect(renderCertificate(2)).not.toBe(renderCertificate(3));
  });

  it('states no cryptographic control the system does not have', () => {
    const html = renderCertificate(3).toLowerCase();
    // Never, under any configuration - these describe controls nobody bought.
    for (const claim of ['cades', 'b-lta', 'fips 140', 'hardware security module',
      'adobe approved trust list', 'aatl', 'trusted root', 'worm', 'seal intact',
      'ial2', 'aal2', '800-63']) {
      expect(html, `certificate claims ${claim}`).not.toContain(claim);
    }
    // PAdES may be named - it is a true statement about the signature actually
    // applied - but only alongside what it is NOT. The lie would be implying
    // the self-signed development seal is publicly trusted.
    if (html.includes('pades')) {
      expect(html, 'a PAdES seal is claimed without saying it is untrusted')
        .toContain('not publicly trusted');
      expect(html).toContain('self-signed development');
    }
  });

  it('prints every digest as lowercase hex (criterion 8)', () => {
    const html = renderCertificate(3);
    const hexes = [...html.matchAll(/class="hex">([^<]*(?:<wbr>[^<]*)*)</g)]
      .map(m => m[1].replaceAll('<wbr>', '').trim())
      .filter(v => v && v !== '-');
    expect(hexes.length).toBeGreaterThan(3);
    for (const h of hexes) {
      expect(h, `${h} is not lowercase hex`).toMatch(/^[0-9a-f]+$/);
      expect([32, 64]).toContain(h.length);
    }
  });
});

maybe('Certificate page count (criterion 6)', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`fits exactly one letter page with ${n} signer(s)`, async () => {
      const { box } = await measure(renderCertificate(n), `signers-${n}`);
      expect(Math.round(box.width)).toBe(816);
      expect(Math.round(box.height)).toBe(SHEET_H);
    }, 30_000);
  }

  it('switches to the taller template at 5 signers instead of overflowing', async () => {
    const { box } = await measure(renderCertificate(5), 'signers-5');
    // The one-page sheet clips its overflow; the two-page template must grow
    // instead, so a fifth signer is never silently cut off the bottom.
    expect(box.height).toBeGreaterThan(SHEET_H);
  }, 30_000);

  it('does not clip content off the single-page sheet at 4 signers', async () => {
    const html = renderCertificate(4);
    const file = join(dir, 'clip-4.html');
    writeFileSync(file, html, 'utf8');
    const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
    try {
      await page.goto(pathToFileURL(file).href);
      const overflow = await page.locator('#certificate').evaluate(
        el => el.scrollHeight - el.clientHeight);
      expect(overflow, 'content is being clipped off the sheet').toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  }, 30_000);
});

maybe('Certificate QR (criterion 7)', () => {
  it('decodes to the verification URL, read back out of the generated HTML', async () => {
    const { qr } = await measure(renderCertificate(3), 'qr');
    const { PNG } = await import('pngjs').catch(() => ({ PNG: null }));
    const jsQR = (await import('jsqr')).default;

    // Decode the rendered pixels, not the source - this is the QR a phone sees.
    const page = await browser.newPage();
    try {
      const b64 = qr.toString('base64');
      const decodedPixels = await page.evaluate(async (data) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + data;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        return { w: c.width, h: c.height, data: Array.from(d.data) };
      }, b64);
      const result = jsQR(Uint8ClampedArray.from(decodedPixels.data),
        decodedPixels.w, decodedPixels.h);
      expect(result, 'QR did not decode at all').not.toBeNull();
      expect(result.data).toBe(VERIFY_URL);
    } finally {
      await page.close();
    }
  }, 45_000);

  it('embeds the QR inline with no external fetch and no runtime library', () => {
    const html = renderCertificate(3);
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).toMatch(/<svg[^>]*><rect[^>]*\/><path d="M/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img[^>]+src=/i);
    expect(html).not.toMatch(/https?:\/\/[^"' ]+\.(js|css|png|svg)/i);
  });
});
