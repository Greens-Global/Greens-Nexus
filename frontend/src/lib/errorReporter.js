// Uncaught-error reporter (Aug 1, 2026): every unhandled JS error and promise
// rejection is POSTed to /client-errors, where it lands in the audit trail and
// server logs. This is how a broken deploy or a crashing view becomes visible
// to whoever operates Nexus WITHOUT waiting for a user to report it.
//
// Guardrails: each distinct message is sent once per session, hard cap 10
// reports per session, and a failed report is swallowed - the reporter must
// never add errors of its own.
import { api } from '../api';

const _seen = new Set();
let _sent = 0;
const MAX_PER_SESSION = 10;

export function reportError(message, stack = '') {
  const key = String(message).slice(0, 200);
  if (_seen.has(key) || _sent >= MAX_PER_SESSION) return;
  _seen.add(key);
  _sent += 1;
  api.reportClientError({
    message: String(message).slice(0, 500),
    stack: String(stack || '').slice(0, 1500),
    url: window.location.href.slice(0, 200),
    build: window.__NEXUS_BUILD || '',
  }).catch(() => {});
}

export function installErrorReporter() {
  window.addEventListener('error', (e) => {
    // Stale-chunk 404s after a deploy are expected and handled by
    // ViewErrorBoundary's auto-reload - reporting them is noise.
    const msg = String(e?.message || '');
    if (/dynamically imported module|chunk|preload/i.test(msg)) return;
    reportError(msg, e?.error?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e?.reason;
    reportError(r?.message || String(r), r?.stack);
  });
}
