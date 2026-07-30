// Post-deploy verification gate.
//
// Everything that broke this week was invisible to the existing pipeline: lint
// does not load a page, the nightly e2e run serves a LOCAL build (so it never
// sees _headers or the real CSP), and the uptime probe only asserts HTTP 200 -
// which the SPA fallback returns happily while the app is a white screen. So the
// only detector was a person noticing. This is that detector, automated.
//
//   node verify-deployed.mjs --base https://dev.nexus.greensglobal.com \
//                            [--build-id <sha>] [--timeout 300]
//
// With --build-id it first waits for /version.json to report that exact id, so a
// pass means "the build I just shipped is healthy" and not "the previous build is
// still being served". Without it, it is a plain health check (use it for uptime).
import { chromium } from '@playwright/test';

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const BASE = (arg('base') || '').replace(/\/+$/, '');
const WANT_ID = arg('build-id');
const DEADLINE_S = Number(arg('timeout', '300'));
if (!BASE) { console.error('--base is required'); process.exit(2); }

const results = [];
const ok   = (name, detail = '') => results.push({ pass: true,  name, detail });
const fail = (name, detail = '') => results.push({ pass: false, name, detail });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. wait for the expected build to actually be live ───────────────────────
async function waitForBuild() {
  if (!WANT_ID) return true;
  const until = Date.now() + DEADLINE_S * 1000;
  let seen = '(never fetched)';
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/version.json`, { cache: 'no-store' });
      if (r.ok) {
        seen = (await r.json()).buildId;
        // Prefix match so a short sha typed by hand still works; CI passes the
        // full github.sha.
        if (seen && (seen === WANT_ID || seen.startsWith(WANT_ID))) {
          ok('build is live', seen.slice(0, 12));
          return true;
        }
      }
    } catch { /* mid-deploy */ }
    await sleep(10_000);
  }
  fail('build is live', `waited ${DEADLINE_S}s; /version.json still reports ${seen}`);
  return false;
}

// ── 2. config invariants, checked over HTTP ──────────────────────────────────
async function checkHtmlAndAssets() {
  const res = await fetch(`${BASE}/`, { cache: 'no-store' });
  const html = await res.text();

  // Unhashed public/ files (guard.js, the PDF engine) are served with a
  // year-long max-age, so they MUST carry a ?v= stamp or an update can never
  // reach a browser that already has them. guard.js failed this for weeks.
  const unstamped = [...html.matchAll(/(?:src|href)="((?!https?:|\/\/|data:|\/assets\/)[^"?#]+\.(?:js|css))"/g)]
    .map(m => m[1]);
  unstamped.length
    ? fail('unhashed assets are version-stamped', `missing ?v= on: ${unstamped.join(', ')}`)
    : ok('unhashed assets are version-stamped');

  // A hashed asset that answers with HTML is the deploy-race poison: the module
  // loader rejects it and the app is a white screen.
  const refs = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]))];
  if (!refs.length) fail('index.html references hashed assets', 'found none - is this really the app shell?');

  // Retry before condemning. A chunk can legitimately be mid-propagation for a
  // few seconds right after a deploy - that transient is the very thing the boot
  // guard exists to ride out, and failing the gate on it would make this job
  // flaky, which gets gates ignored. A genuinely missing or poisoned asset stays
  // broken, so only a persistent failure counts.
  async function probeAsset(ref) {
    let last = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await sleep(6000);
      try {
        const r = await fetch(BASE + ref, { cache: 'no-store' });
        const ct = r.headers.get('content-type') || '';
        if (r.ok && !/text\/html/i.test(ct)) return null;         // healthy
        last = `${r.status} ${ct}`;
      } catch (e) { last = String(e.message || e); }
    }
    return `${ref} -> ${last} (5 attempts over ~24s)`;
  }
  const bad = (await Promise.all(refs.map(probeAsset))).filter(Boolean);
  bad.length ? fail('every hashed asset serves real JS/CSS', bad.join('; '))
             : ok('every hashed asset serves real JS/CSS', `${refs.length} checked`);

  // version.json drives the update prompt and this gate; if it is cacheable both
  // silently compare against a stale value.
  const vc = (await fetch(`${BASE}/version.json`, { cache: 'no-store' })).headers.get('cache-control') || '';
  /no-store|no-cache/i.test(vc) ? ok('version.json is uncacheable', vc)
                                : fail('version.json is uncacheable', `cache-control: ${vc || '(none)'}`);
}

// ── 3. the PDF editor's framing contract ────────────────────────────────────
async function checkPdfEditor() {
  // Same-origin framing must be permitted, or the module is an empty box - it
  // shipped that way and localhost could never catch it, since Vite does not
  // serve _headers.
  const r = await fetch(`${BASE}/pdf-editor-app/index.html`, { cache: 'no-store', redirect: 'follow' });
  const xfo = (r.headers.get('x-frame-options') || '').toUpperCase();
  const csp = r.headers.get('content-security-policy') || '';
  const ancestors = (csp.match(/frame-ancestors[^;]*/) || [''])[0];
  const frameSrc = (csp.match(/frame-src[^;]*/) || [''])[0];

  xfo === 'DENY' ? fail('PDF engine is framable (X-Frame-Options)', 'DENY blocks even same-origin')
                 : ok('PDF engine is framable (X-Frame-Options)', xfo || '(unset)');
  /'self'/.test(ancestors) ? ok('PDF engine is framable (frame-ancestors)', ancestors)
                           : fail('PDF engine is framable (frame-ancestors)', ancestors || '(unset)');
  /'self'/.test(frameSrc) ? ok("parent CSP allows 'self' frames", frameSrc)
                          : fail("parent CSP allows 'self' frames", frameSrc || '(unset)');

  // The SPA route must not be shadowed by the static directory - that is what
  // made a refresh drop the Nexus shell.
  const spa = await fetch(`${BASE}/pdf-editor`, { redirect: 'manual' });
  [301, 302, 307, 308].includes(spa.status)
    ? fail('/pdf-editor reaches the SPA', `redirects to ${spa.headers.get('location')}`)
    : ok('/pdf-editor reaches the SPA', String(spa.status));
}

// ── 4. does it actually render? ──────────────────────────────────────────────
async function checkRenders() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const violations = [];
    page.on('console', m => {
      const t = m.text();
      if (/Content Security Policy|Refused to (frame|load|execute)|MIME type/i.test(t)) violations.push(t.slice(0, 180));
    });
    page.on('pageerror', e => violations.push('pageerror: ' + String(e).slice(0, 180)));

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Unauthenticated lands on the sign-in screen - that still proves the bundle
    // executed and rendered, which is exactly what a white screen does not.
    const rendered = await page
      .waitForFunction(() => (document.getElementById('root')?.innerText || '').trim().length > 40, { timeout: 45_000 })
      .then(() => true).catch(() => false);

    const rootLen = await page.evaluate(() => (document.getElementById('root')?.innerText || '').trim().length);
    rendered ? ok('app renders', `${rootLen} chars in #root`)
             : fail('app renders', `#root has ${rootLen} chars - white screen`);

    // guard.js paints this when boot fails; if it is up, the app did not load.
    const panel = await page.evaluate(() => !!document.getElementById('nx-boot-panel'));
    panel ? fail('boot guard did not trigger', 'recovery panel is visible')
          : ok('boot guard did not trigger');

    violations.length ? fail('no CSP/module errors', violations.slice(0, 4).join(' | '))
                      : ok('no CSP/module errors');
  } finally {
    await browser.close();
  }
}

const live = await waitForBuild();
if (live) {
  await checkHtmlAndAssets();
  await checkPdfEditor();
  await checkRenders();
}

console.log(`\nPost-deploy verification - ${BASE}\n`);
for (const r of results) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nThis deploy is NOT healthy. Roll back in the Cloudflare dashboard');
  console.log('(Pages > project > Deployments > the previous one > Rollback), then fix forward.');
  process.exit(1);
}
