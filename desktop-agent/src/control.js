// ── Attended remote control (agent side) ──────────────────────────────────────
// IT support: with the employee's explicit consent, the viewer's mouse/keyboard
// events arrive over the live-view WebRTC data channel and are injected here via
// SendInput (a persistent PowerShell-hosted helper, inputsink.ps1). This module
// owns the three employee-facing pieces:
//   1. The consent prompt - "IT (Name) wants to access your computer", Accept /
//      Decline, auto-declines after 60s. Nothing is ever injected without it.
//   2. The persistent banner while control is active - "IT (Name) is controlling
//      your computer" with an End Session button that kills control instantly.
//   3. The input sink lifecycle + the JS-event -> SendInput line protocol.
// Local input is never blocked: the employee's own mouse/keyboard always work,
// and ending control (banner button, clock-out, closed viewer) is immediate.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { BrowserWindow, ipcMain, screen, clipboard } = require('electron');
const { spawn } = require('child_process');

let consentWin = null;
let bannerWin = null;
let sink = null;
let active = false;
let consentTimer = null;
let onConsentDecision = null;   // (accepted: boolean) => void
let onBannerEnd = null;         // employee clicked End Session
let sendToViewer = () => {};    // agent -> viewer over the data channel (clipboard, file acks)
let logFn = () => {};

// The captured displays, source order (primary first) - set per session so
// input for screen N can be mapped onto that display's slice of the virtual
// desktop. Bounds are Electron DIP coords; SendInput's VIRTUALDESK space is
// physical pixels, so the normalized position matches exactly on uniform-DPI
// setups (the office norm) and is approximate only on mixed-DPI multi-monitor.
let displays = [];
let virtualRect = null;   // DIP union of all display bounds

function setDisplays(list) {
  // Keep the FULL list in source order - indexes must line up with the renderer's
  // track order (a display with no matched bounds just can't take mvv input).
  displays = list || [];
  const withBounds = displays.filter((d) => d && d.bounds);
  if (!withBounds.length) { virtualRect = null; return; }
  const xs = withBounds.map((d) => d.bounds.x), ys = withBounds.map((d) => d.bounds.y);
  const x2 = withBounds.map((d) => d.bounds.x + d.bounds.width), y2 = withBounds.map((d) => d.bounds.y + d.bounds.height);
  virtualRect = { x: Math.min(...xs), y: Math.min(...ys),
                  w: Math.max(...x2) - Math.min(...xs), h: Math.max(...y2) - Math.min(...ys) };
}

// ── Clipboard sync (only while control is active) ─────────────────────────────
// Remote -> viewer: poll the clipboard and push text changes so IT can copy on
// the employee's PC and paste locally. Viewer -> remote arrives as a 'clip'
// message (the viewer pushes its clipboard just before sending Ctrl+V).
const CLIP_MAX = 1024 * 1024;   // 1MB of text either way
let clipTimer = null;
let lastClip = null;

function startClipWatch() {
  lastClip = null;
  try { lastClip = clipboard.readText(); } catch (_) { /* ignore */ }
  clipTimer = setInterval(() => {
    let t;
    try { t = clipboard.readText(); } catch (_) { return; }
    if (typeof t === 'string' && t && t !== lastClip) {
      lastClip = t;
      sendToViewer({ t: 'clip', s: t.slice(0, CLIP_MAX) });
    }
  }, 1000);
}

function stopClipWatch() {
  if (clipTimer) { clearInterval(clipTimer); clipTimer = null; }
  lastClip = null;
}

// ── File receive (viewer -> this PC, only while control is active) ────────────
// Chunked base64 over the data channel; lands in Downloads\Nexus Support. The
// employee accepted the control session, and the banner is up the whole time.
// Effectively "any file" - a ceiling only so a mistaken send can't fill the
// employee's disk. Bytes stream straight to disk (createWriteStream), never held
// in memory, so large files are fine. Matches the viewer's FILE_MAX.
const FILE_MAX = 20 * 1024 * 1024 * 1024;
const files = new Map();   // id -> {stream, path, size, received, name}
let activeFileId = null;   // the file binary chunks currently append to (one at a time)

function fileDir() {
  const dir = path.join(os.homedir(), 'Downloads', 'Nexus Support');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150);
  return base || 'file';
}

function fileStart(m) {
  const size = Number(m.size) || 0;
  if (size <= 0 || size > FILE_MAX || files.size >= 4) {
    sendToViewer({ t: 'file-err', id: m.id, err: size > FILE_MAX ? 'File is larger than 200MB.' : 'Transfer refused.' });
    return;
  }
  const dir = fileDir();
  let name = safeName(m.name), p = path.join(dir, name), n = 1;
  while (fs.existsSync(p)) { p = path.join(dir, name.replace(/(\.[^.]*)?$/, ` (${n})$1`)); n += 1; }
  try {
    files.set(String(m.id), { stream: fs.createWriteStream(p), path: p, size, received: 0, name: path.basename(p) });
    activeFileId = String(m.id);
  } catch (e) {
    logFn(`control: file open failed: ${e.message || e}`);
    sendToViewer({ t: 'file-err', id: m.id, err: 'Could not write the file.' });
  }
}

// Binary chunk (viewer sends raw ArrayBuffer): appends to the one open file.
function fileChunkBin(buf) {
  const f = activeFileId && files.get(activeFileId);
  if (!f || !buf) return;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  f.received += b.length;
  if (f.received > f.size + 1024 * 1024) { fileAbort(activeFileId); return; }   // liar - drop it
  try { f.stream.write(b); } catch (_) { fileAbort(activeFileId); }
}

// Legacy base64 chunk (kept so a mid-upgrade viewer still works).
function fileChunk(m) {
  const f = files.get(String(m.id));
  if (!f) return;
  const buf = Buffer.from(String(m.d || ''), 'base64');
  f.received += buf.length;
  if (f.received > f.size + 1024 * 1024) { fileAbort(String(m.id)); return; }   // liar - drop it
  try { f.stream.write(buf); } catch (_) { fileAbort(String(m.id)); }
}

function fileEnd(m) {
  const id = String(m.id);
  const f = files.get(id);
  if (!f) return;
  files.delete(id);
  if (activeFileId === id) activeFileId = null;
  f.stream.end(() => {
    logFn(`control: received file ${f.name} (${f.received} bytes) into Downloads\\Nexus Support`);
    sendToViewer({ t: 'file-done', id, name: f.name });
  });
}

function fileAbort(id) {
  const f = files.get(id);
  if (!f) return;
  files.delete(id);
  if (activeFileId === id) activeFileId = null;
  try { f.stream.destroy(); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(f.path); } catch (_) { /* ignore */ }
}

function abortAllFiles() { for (const id of Array.from(files.keys())) fileAbort(id); activeFileId = null; }

// Packaged builds run from app.asar, which PowerShell can't read into - the
// script is unpacked next to it (electron-builder asarUnpack).
const SINK_PATH = path.join(__dirname, 'inputsink.ps1').replace('app.asar', 'app.asar.unpacked');

const CONSENT_TIMEOUT_MS = 60 * 1000;   // server expires the request at 75s

// ── JS KeyboardEvent.code -> Windows virtual-key [vk, extendedFlag] ───────────
const VK = {
  Enter: [0x0D, 0], NumpadEnter: [0x0D, 1], Escape: [0x1B, 0], Backspace: [0x08, 0],
  Tab: [0x09, 0], Space: [0x20, 0],
  ArrowLeft: [0x25, 1], ArrowUp: [0x26, 1], ArrowRight: [0x27, 1], ArrowDown: [0x28, 1],
  Home: [0x24, 1], End: [0x23, 1], PageUp: [0x21, 1], PageDown: [0x22, 1],
  Insert: [0x2D, 1], Delete: [0x2E, 1],
  ShiftLeft: [0xA0, 0], ShiftRight: [0xA1, 0], ControlLeft: [0xA2, 0], ControlRight: [0xA3, 1],
  AltLeft: [0xA4, 0], AltRight: [0xA5, 1], MetaLeft: [0x5B, 1], MetaRight: [0x5C, 1],
  CapsLock: [0x14, 0], NumLock: [0x90, 0], ScrollLock: [0x91, 0],
  PrintScreen: [0x2C, 1], Pause: [0x13, 0], ContextMenu: [0x5D, 1],
  Minus: [0xBD, 0], Equal: [0xBB, 0], BracketLeft: [0xDB, 0], BracketRight: [0xDD, 0],
  Backslash: [0xDC, 0], Semicolon: [0xBA, 0], Quote: [0xDE, 0], Comma: [0xBC, 0],
  Period: [0xBE, 0], Slash: [0xBF, 0], Backquote: [0xC0, 0], IntlBackslash: [0xE2, 0],
  NumpadDivide: [0x6F, 1], NumpadMultiply: [0x6A, 0], NumpadSubtract: [0x6D, 0],
  NumpadAdd: [0x6B, 0], NumpadDecimal: [0x6E, 0],
};
for (let i = 0; i < 26; i++) VK['Key' + String.fromCharCode(65 + i)] = [0x41 + i, 0];
for (let i = 0; i < 10; i++) { VK['Digit' + i] = [0x30 + i, 0]; VK['Numpad' + i] = [0x60 + i, 0]; }
for (let i = 1; i <= 24; i++) VK['F' + i] = [0x70 + i - 1, 0];

// Keydowns sent as a self-contained unicode down+up pair; the matching keyup
// from the browser must then be swallowed instead of mapped to a VK.
const skipKeyUp = new Set();

function ok01(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1; }

function keyLine(m) {
  // Plain typing goes as KEYEVENTF_UNICODE so it lands correctly on any keyboard
  // layout; anything held with Ctrl/Alt/Win (shortcuts) and every non-printable
  // key goes as a virtual-key press so the OS sees the real combo.
  const printable = typeof m.key === 'string' && m.key.length === 1;
  if (m.t === 'kd' && printable && !m.c && !m.a && !m.m) {
    const cp = m.key.codePointAt(0);
    if (cp > 0xFFFF) return null;   // outside the BMP (emoji) - not injectable as one ushort
    skipKeyUp.add(m.code);
    return `ch ${cp}`;
  }
  if (m.t === 'ku' && skipKeyUp.has(m.code)) { skipKeyUp.delete(m.code); return null; }
  const v = VK[m.code];
  if (!v) return null;
  return `${m.t} ${v[0]} ${v[1]}`;
}

// Validate + translate one data-channel message into sink line(s). Dropped
// unless control is actually active (belt to the server-side suspenders).
function inject(m) {
  if (!active || !m) return;
  // Clipboard + file transfer don't touch the sink - handle them first.
  if (m.t === 'clip') {
    const s = typeof m.s === 'string' ? m.s.slice(0, CLIP_MAX) : '';
    if (s) { lastClip = s; try { clipboard.writeText(s); } catch (_) { /* ignore */ } }
    return;
  }
  if (m.t === 'fs') { fileStart(m); return; }
  if (m.t === 'fc') { fileChunk(m); return; }
  if (m.t === 'fe') { fileEnd(m); return; }
  if (!sink || !sink.stdin || !sink.stdin.writable) return;
  let line = null;
  switch (m.t) {
    case 'mv': {
      if (!ok01(m.x) || !ok01(m.y)) break;
      const s = Number.isInteger(m.s) ? m.s : 0;
      const d = displays[s];
      if (s > 0 || (d && !d.primary)) {
        // A non-primary screen: map the in-screen position into the DIP virtual
        // desktop and inject with the VIRTUALDESK flag.
        if (!d || !d.bounds || !virtualRect || !virtualRect.w || !virtualRect.h) break;
        const vx = (d.bounds.x + m.x * d.bounds.width - virtualRect.x) / virtualRect.w;
        const vy = (d.bounds.y + m.y * d.bounds.height - virtualRect.y) / virtualRect.h;
        line = `mvv ${Math.max(0, Math.min(1, vx)).toFixed(5)} ${Math.max(0, Math.min(1, vy)).toFixed(5)}`;
      } else {
        // Primary screen: plain ABSOLUTE coords are exact (incl. DPI scaling).
        line = `mv ${m.x.toFixed(4)} ${m.y.toFixed(4)}`;
      }
      break;
    }
    case 'dn': case 'up': {
      const b = m.b === 1 || m.b === 2 ? m.b : 0;
      line = `${m.t} ${b}`;
      break;
    }
    case 'wh': {
      // Browser wheel deltas are in pixels (one notch ~ 100); Windows wheel data
      // is 120 per notch with the opposite sign for vertical.
      const parts = [];
      const dy = Math.max(-600, Math.min(600, Math.round(-(Number(m.dy) || 0) * 1.2)));
      const dx = Math.max(-600, Math.min(600, Math.round((Number(m.dx) || 0) * 1.2)));
      if (dy) parts.push(`wh ${dy}`);
      if (dx) parts.push(`wm ${dx}`);
      line = parts.length ? parts.join('\n') : null;
      break;
    }
    case 'kd': case 'ku':
      if (typeof m.code === 'string') line = keyLine(m);
      break;
    default:
      break;
  }
  if (line) { try { sink.stdin.write(line + '\n'); } catch (_) { /* sink died; next start respawns */ } }
}

// ── Consent prompt ────────────────────────────────────────────────────────────
function showConsent(requesterName, onDecision) {
  closeConsent();
  onConsentDecision = onDecision;
  consentWin = new BrowserWindow({
    width: 440, height: 232, frame: false, resizable: false, movable: true,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  consentWin.setAlwaysOnTop(true, 'screen-saver');
  consentWin.on('closed', () => { consentWin = null; });
  consentWin.loadFile(path.join(__dirname, 'consent-window.html'));
  consentWin.webContents.once('did-finish-load', () => {
    if (consentWin) {
      consentWin.webContents.send('consent:init', { name: requesterName || 'IT' });
      consentWin.show();
      consentWin.focus();
    }
  });
  // Walked away / ignored it: treat as a decline so the request can't sit armed.
  consentTimer = setTimeout(() => decideConsent(false), CONSENT_TIMEOUT_MS);
}

function decideConsent(accepted) {
  const cb = onConsentDecision;
  onConsentDecision = null;
  closeConsent();
  if (cb) cb(!!accepted);
}

function closeConsent() {
  if (consentTimer) { clearTimeout(consentTimer); consentTimer = null; }
  onConsentDecision = null;
  if (consentWin && !consentWin.isDestroyed()) { try { consentWin.destroy(); } catch (_) { /* ignore */ } }
  consentWin = null;
}

ipcMain.on('control:consent-decision', (_e, { accept }) => decideConsent(!!accept));
ipcMain.on('control:end-click', () => { if (onBannerEnd) onBannerEnd(); });

// ── Active-control banner ─────────────────────────────────────────────────────
function showBanner(requesterName) {
  hideBanner();
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 520, h = 46;
  bannerWin = new BrowserWindow({
    width: w, height: h, x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + 8,
    frame: false, transparent: true, resizable: false, movable: true,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  bannerWin.setAlwaysOnTop(true, 'screen-saver');
  bannerWin.on('closed', () => { bannerWin = null; });
  bannerWin.loadFile(path.join(__dirname, 'control-banner.html'));
  bannerWin.webContents.once('did-finish-load', () => {
    if (bannerWin) {
      bannerWin.webContents.send('banner:init', { name: requesterName || 'IT' });
      bannerWin.showInactive();   // never steal focus from what IT is fixing
    }
  });
}

function hideBanner() {
  if (bannerWin && !bannerWin.isDestroyed()) { try { bannerWin.destroy(); } catch (_) { /* ignore */ } }
  bannerWin = null;
}

// ── Input sink (SendInput helper) lifecycle ───────────────────────────────────
function startSink() {
  stopSink();
  if (process.platform !== 'win32') { logFn('control: input injection is Windows-only'); return; }
  try {
    sink = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SINK_PATH],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    sink.on('exit', () => { sink = null; });
    sink.on('error', (e) => { logFn(`control: sink error ${e.message || e}`); sink = null; });
  } catch (e) { logFn(`control: sink spawn failed: ${e.message || e}`); sink = null; }
}

function stopSink() {
  if (sink) { try { sink.stdin.end(); } catch (_) { /* ignore */ } try { sink.kill(); } catch (_) { /* ignore */ } }
  sink = null;
  skipKeyUp.clear();
}

// ── Session-facing surface ────────────────────────────────────────────────────
function start(requesterName, opts) {
  active = true;
  onBannerEnd = (opts && opts.onEnd) || null;
  sendToViewer = (opts && opts.send) || (() => {});
  startSink();
  showBanner(requesterName);
  startClipWatch();
}

function stop() {
  active = false;
  onBannerEnd = null;
  sendToViewer = () => {};
  stopClipWatch();
  abortAllFiles();
  stopSink();
  hideBanner();
}

function isActive() { return active; }

function init(opts) { logFn = (opts && opts.log) || (() => {}); }

module.exports = { init, showConsent, closeConsent, start, stop, inject, fileChunkBin, isActive, setDisplays };
