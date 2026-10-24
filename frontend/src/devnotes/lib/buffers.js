// What was happening when the pin was made: the console since the mode went
// on (console.error / warn, window errors, unhandled rejections; ring of 50)
// and every API request through api.js (ring of 30, with the request and
// response bodies masked and trimmed to 2 KB each - api.js clones the
// response only while this buffer is on). Started by BuildModeApp on mount,
// stopped and restored on unmount.
import { onApiRequest, setApiBodyCapture } from '../../api';
import { maskBody } from './privacy';

const CONSOLE_MAX = 50;
const NET_MAX = 30;
const consoleBuf = [];
const netBuf = [];
let stopFns = [];
let paused = false;

const now = () => new Date().toISOString();
const ring = (buf, max, entry) => { buf.push(entry); if (buf.length > max) buf.splice(0, buf.length - max); };

function stringify(a) {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}
const textOf = (args) => args.map(stringify).join(' ').slice(0, 600);

export function pauseBuffers(p) { paused = !!p; }

export function startBuffers() {
  if (stopFns.length) return;
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args) => { if (!paused) ring(consoleBuf, CONSOLE_MAX, { level: 'error', text: textOf(args), at: now() }); return origError.apply(console, args); };
  console.warn = (...args) => { if (!paused) ring(consoleBuf, CONSOLE_MAX, { level: 'warn', text: textOf(args), at: now() }); return origWarn.apply(console, args); };
  const onError = (e) => { if (!paused) ring(consoleBuf, CONSOLE_MAX, { level: 'error', text: `${e.message || 'Error'}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`, at: now() }); };
  const onReject = (e) => { if (!paused) ring(consoleBuf, CONSOLE_MAX, { level: 'error', text: `Unhandled rejection: ${stringify(e.reason)}`.slice(0, 600), at: now() }); };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onReject);
  setApiBodyCapture(true);
  const offApi = onApiRequest((entry) => {
    if (paused) return;
    const row = { method: entry.method, path: entry.path, status: entry.status, ms: entry.ms, at: entry.at, requestBody: maskBody(entry.requestBody), responseBody: '' };
    ring(netBuf, NET_MAX, row);
    const res = entry.response;
    if (res && typeof res.text === 'function') {
      res.text().then((t) => { row.responseBody = maskBody(t); }).catch(() => {});
    }
  });
  stopFns = [
    () => { console.error = origError; console.warn = origWarn; },
    () => window.removeEventListener('error', onError),
    () => window.removeEventListener('unhandledrejection', onReject),
    () => setApiBodyCapture(false),
    offApi,
  ];
}

export function stopBuffers() {
  stopFns.forEach((f) => { try { f(); } catch { /* already restored */ } });
  stopFns = [];
}

export function snapshotBuffers() {
  return {
    consoleLog: consoleBuf.map((e) => ({ ...e })),
    networkLog: netBuf.map((e) => ({ ...e })),
  };
}
