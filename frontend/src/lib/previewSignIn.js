// Hosted Build Mode previews (11/13/2026, backend build_preview.py).
//
// Cloudflare builds every branch of the dev site at its own address,
// https://<build>.greens-nexus-dev.pages.dev, with the same /api proxy as dev
// (functions/api sends a preview host to the DEV backend). Microsoft cannot
// return to an address it does not know, so a preview signs in by borrowing
// the dev site's sign-in:
//   1. startPreviewSignIn keeps a random verifier in this tab and sends the
//      browser to the dev site's /api/auth/preview-handoff with its hash;
//   2. the dev site (signing the person in first when needed) checks they have
//      Build Mode and comes back with a single-use code in the address's
//      fragment (#nx_preview=...);
//   3. finishPreviewSignIn POSTs the code and the verifier to this preview's
//      own /api/auth/preview-claim, which sets this preview's session cookie.
// A code read off the address bar is useless without the verifier.

export const DEV_SITE = 'https://dev.nexus.greensglobal.com';
const SUFFIX = '.greens-nexus-dev.pages.dev';
const VERIFIER_KEY = 'nexus:preview-verifier';
const CODE_PARAM = 'nx_preview';
const TRIED_KEY = 'nexus:preview-tried';

export function isPreviewHost(hostname = (typeof location !== 'undefined' ? location.hostname : '')) {
  const host = String(hostname || '').toLowerCase();
  if (!host.endsWith(SUFFIX)) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host.slice(0, -SUFFIX.length));
}

export const PREVIEW_HOST = isPreviewHost();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** The dev site's handoff address for this preview (exported for the test). */
export function handoffUrl({ origin, next, challenge }) {
  const q = new URLSearchParams({ to: origin, next: next || '/', challenge });
  return `${DEV_SITE}/api/auth/preview-handoff?${q.toString()}`;
}

/** Send the browser to the dev site to sign this preview in. */
export async function startPreviewSignIn(next) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  try { sessionStorage.setItem(VERIFIER_KEY, verifier); } catch { /* storage blocked - the claim will fail and say so */ }
  const challenge = await challengeFor(verifier);
  const path = next || (location.pathname + location.search);
  window.location.href = handoffUrl({ origin: location.origin, next: path, challenge });
}

/** Start the sign-in by itself once a minute at most; returns true when it
 *  did (the page is leaving). A round that came back without a session
 *  lands on the sign-in screen instead of looping. */
export function autoPreviewSignIn() {
  if (!PREVIEW_HOST) return false;
  try {
    const last = Number(sessionStorage.getItem(TRIED_KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(TRIED_KEY, String(Date.now()));
  } catch { return false; }
  startPreviewSignIn();
  return true;
}

/** Read the code the dev site sent back (if any), take it off the address,
 *  and trade it for this preview's session. Never throws; returns true when a
 *  session was set. */
export async function finishPreviewSignIn() {
  if (!PREVIEW_HOST) return false;
  let code = '';
  try {
    const hash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    code = hash.get(CODE_PARAM) || '';
    if (!code) return false;
    hash.delete(CODE_PARAM);
    const rest = hash.toString();
    window.history.replaceState(window.history.state, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
  } catch { return false; }
  let verifier = '';
  try { verifier = sessionStorage.getItem(VERIFIER_KEY) || ''; sessionStorage.removeItem(VERIFIER_KEY); } catch { /* blocked */ }
  if (!verifier) return false;
  try {
    const res = await fetch('/api/auth/preview-claim', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier }),
    });
    return res.ok;
  } catch { return false; }
}

/** A quiet line on every preview so nobody mistakes it for the dev site:
 *  what it is, and that what is saved here lands on the dev site's data. */
export function showPreviewMark() {
  if (!PREVIEW_HOST || typeof document === 'undefined' || document.getElementById('nx-preview-mark')) return;
  try {
    const el = document.createElement('div');
    el.id = 'nx-preview-mark';
    el.setAttribute('role', 'note');
    el.textContent = 'Preview - what you save here saves to the dev site';
    el.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483000',
      'padding:6px 10px', 'border-radius:8px', 'font:600 12px Inter,system-ui,sans-serif',
      'background:var(--wk-card,#fff)', 'color:var(--wk-ink,#111827)',
      'border:1px solid var(--wk-live-line,#f5c48a)', 'box-shadow:0 2px 8px rgba(0,0,0,.08)',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
  } catch { /* never in the way */ }
}
