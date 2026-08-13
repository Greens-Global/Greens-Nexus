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
const { BrowserWindow, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');

let consentWin = null;
let bannerWin = null;
let sink = null;
let active = false;
let consentTimer = null;
let onConsentDecision = null;   // (accepted: boolean) => void
let onBannerEnd = null;         // employee clicked End Session
let logFn = () => {};

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
  if (!active || !sink || !sink.stdin || !sink.stdin.writable || !m) return;
  let line = null;
  switch (m.t) {
    case 'mv':
      if (ok01(m.x) && ok01(m.y)) line = `mv ${m.x.toFixed(4)} ${m.y.toFixed(4)}`;
      break;
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
  startSink();
  showBanner(requesterName);
}

function stop() {
  active = false;
  onBannerEnd = null;
  stopSink();
  hideBanner();
}

function isActive() { return active; }

function init(opts) { logFn = (opts && opts.log) || (() => {}); }

module.exports = { init, showConsent, closeConsent, start, stop, inject, isActive };
