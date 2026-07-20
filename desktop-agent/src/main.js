// ── Greens Nexus Agent — tray-resident time-tracking companion ─────────────────
// Signs in as the employee (Entra), and WHILE THEY ARE CLOCKED IN captures every
// monitor every 5 minutes and posts to the same /timeclock/screenshot API the
// web app uses. No window, no Chrome sharing bar — it lives in the system tray.
// Capture is gated on clock state and pausable by the employee from the menu.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, Tray, Menu, nativeImage, powerMonitor, shell, dialog } = require('electron');
const config = require('./config');
const auth = require('./auth');
const api = require('./api');
const activity = require('./activity');
const { captureAllScreens } = require('./capture');

let tray = null;
let token = null;
let signedIn = false;
let paused = false;
let status = null;
let lastShotAt = 0;
let ticking = false;
let nextDueAt = 0;         // when the next screenshot pass is allowed (drives cadence)
let wasCapturing = false;  // capturing-state edge, so we can shoot promptly at shift start

// ── Effective monitoring policy ────────────────────────────────────────────────
// The SERVER decides cadence + what may be collected. config.js only supplies
// fallback defaults until the server has answered (silent: /agent/checkin's
// `policy`; interactive: GET /timeclock/monitoring/policy). This is a disclosed,
// clocked-in-only capture policy — never keystroke content.
const DEFAULT_POLICY = {
  enabled: true,
  intervalMinutes: config.captureIntervalMs / 60000,
  randomize: false,
  trackScreens: true,
  trackWindows: true,
  trackInput: true,
};
let policy = { ...DEFAULT_POLICY };

// Merge a server policy onto the defaults (tolerant of missing fields).
function applyPolicy(p) {
  if (!p || typeof p !== 'object') return;
  const mins = Number(p.intervalMinutes);
  policy = {
    enabled: p.enabled !== false,
    intervalMinutes: mins > 0 ? mins : DEFAULT_POLICY.intervalMinutes,
    randomize: !!p.randomize,
    trackScreens: p.trackScreens !== false,
    trackWindows: p.trackWindows !== false,
    trackInput: p.trackInput !== false,
  };
}

function baseIntervalMs() {
  const mins = policy.intervalMinutes > 0 ? policy.intervalMinutes : DEFAULT_POLICY.intervalMinutes;
  return mins * 60 * 1000;
}

// Next capture time. When randomize is on, jitter ±25% (0.75–1.25×) so a frame
// can't be timed/gamed. Computed per-capture, not a fixed setInterval.
function scheduleNext() {
  const base = baseIntervalMs();
  const ms = policy.randomize ? base * (0.75 + Math.random() * 0.5) : base;
  nextDueAt = Date.now() + Math.round(ms);
}

// Edge-detect the capturing state; on a not→yes transition (shift starts / turns
// active) make the first shot due NOW so a quick clock-in/out can't dodge capture.
function markCapturing(canCapture) {
  if (canCapture && !wasCapturing) nextDueAt = 0;
  wasCapturing = canCapture;
  return canCapture;
}

// ── Silent (token) mode ────────────────────────────────────────────────────────
// If a device token was provisioned (env var, or a file the install command
// dropped in userData), the agent runs headless: it authenticates with the token
// and never shows a Microsoft login. This is the "Silent App User" deployment.
// Candidate token locations, checked in order. ProgramData is machine-wide so
// the token is found no matter which user context the agent runs in (installing
// admin, SYSTEM via Intune/RMM, or the logged-in employee) — this is why silent
// deploys don't fall back to an interactive Microsoft login.
const TOKEN_FILE = path.join(app.getPath('userData'), 'device-token.txt');
const MACHINE_TOKEN_FILE = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData', 'Greens Nexus Agent', 'device-token.txt');
function readDeviceToken() {
  if (process.env.NEXUS_AGENT_TOKEN) return process.env.NEXUS_AGENT_TOKEN.trim();
  for (const f of [MACHINE_TOKEN_FILE, TOKEN_FILE]) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch { /* next */ }
  }
  return null;
}
let deviceToken = readDeviceToken();
let silentMode = !!deviceToken;
let silentEmail = '';           // learned from the first check-in
let silentCapture = false;      // server says capture right now

function firstMac() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
    }
  }
  return '';
}

// A 16×16 tray icon drawn as raw BGRA pixels (a filled brand-green disc) — no
// image asset to ship or risk corrupting.
function trayIcon() {
  const size = 16, buf = Buffer.alloc(size * size * 4);
  const cx = 7.5, cy = 7.5, r = 7.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      buf[i] = 60; buf[i + 1] = 122; buf[i + 2] = 30;        // B, G, R  (#1E7A3C)
      buf[i + 3] = inside ? 255 : 0;                          // A
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function clockedIn() {
  return !!(status && status.lastPunch && status.lastPunch.kind !== 'out');
}

function stateLabel() {
  if (silentMode) {
    const who = silentEmail ? ` · ${silentEmail}` : '';
    if (paused) return `Silent${who} — PAUSED`;
    return `Silent${who} — ${silentCapture ? 'active, capturing' : 'idle'}`;
  }
  if (!signedIn) return 'Not signed in';
  if (!status) return 'Connecting…';
  if (!clockedIn()) return 'Off the clock — not capturing';
  if (paused) return 'Clocked in — capture PAUSED';
  return 'Clocked in — capturing every 5 min';
}

function refreshTray() {
  if (!tray) return;
  const items = [
    { label: stateLabel(), enabled: false },
    { type: 'separator' },
    { label: paused ? 'Resume capture' : 'Pause capture',
      enabled: silentMode || signedIn,
      click: () => { paused = !paused; refreshTray(); } },
    { label: 'Open Time Clock', click: () => shell.openExternal(`${config.webBase}/timeclock`) },
    { type: 'separator' },
  ];
  if (!silentMode) {
    items.splice(3, 0, { label: 'Capture now', enabled: signedIn && clockedIn() && !paused, click: () => doCapture(true) });
    items.push(signedIn
      ? { label: 'Sign out', click: signOut }
      : { label: 'Sign in', click: () => signIn(true) });
  }
  items.push({ label: 'Quit', click: () => app.quit() });
  tray.setToolTip(`Greens Nexus Agent — ${stateLabel()}`);
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

async function ensureToken() {
  token = await auth.getTokenSilent();
  signedIn = !!token;
  return token;
}

async function signIn(interactive) {
  try {
    if (!(await ensureToken()) && interactive) {
      token = await auth.getTokenInteractive();
      signedIn = !!token;
    }
  } catch (e) {
    dialog.showErrorBox('Sign-in failed', String(e && e.message || e));
  }
  refreshTray();
  tick();
}

async function signOut() {
  await auth.signOut();
  token = null; signedIn = false; status = null;
  refreshTray();
}

async function doCapture(manual) {
  if (!token || (!clockedIn() && !manual) || (paused && !manual)) return;
  try {
    const screens = await captureAllScreens();
    const idleSec = powerMonitor.getSystemIdleTime();
    const tzOffsetMin = new Date().getTimezoneOffset();
    for (const s of screens) {
      const label = `desktop agent${s.total > 1 ? ` · screen ${s.index}/${s.total}` : ''}`;
      const res = await api.uploadShot(token, s.jpeg, { idleSec, activeView: label, tzOffsetMin });
      if (res && res.stopped) { status = await api.getStatus(token).catch(() => status); break; }
    }
    lastShotAt = Date.now();
  } catch { /* a failed pass never crashes the agent; next tick retries */ }
}

// Silent heartbeat: report activity (auto-punches happen server-side), learn
// whether to capture + the current policy, then capture on the server-set
// (optionally randomized) cadence while active.
async function silentTick() {
  if (ticking) return;
  ticking = true;
  try {
    const idleSec = powerMonitor.getSystemIdleTime();
    const r = await api.agentCheckin(deviceToken, {
      active: !paused && idleSec < config.idleActiveSec,
      idle_sec: idleSec,
      device_name: os.hostname(),
      device_user: (os.userInfo().username || ''),
      mac: firstMac(),
      platform: process.platform,
      tz_offset_min: new Date().getTimezoneOffset(),
    }).catch(() => null);
    if (r) {
      silentEmail = r.email || silentEmail;
      silentCapture = !!r.capture && !paused;   // server already clears capture when disabled
      applyPolicy(r.policy);                     // server-driven cadence + toggles
    }
    refreshTray();
    // Flush the last window of app activity (accumulated by sampleTick). Report
    // titles only when trackWindows, activity % only when trackInput.
    const act = activity.flush();
    if ((policy.trackWindows && act.segments.length) || policy.trackInput) {
      const body = { tz_offset_min: new Date().getTimezoneOffset() };
      if (policy.trackWindows) body.segments = act.segments;
      if (policy.trackInput) body.active_pct = act.activePct;
      api.agentPostActivity(deviceToken, body).catch(() => {});
    }
    const canCapture = markCapturing(silentCapture && policy.enabled && policy.trackScreens);
    if (canCapture && Date.now() >= nextDueAt) {
      try {
        const screens = await captureAllScreens();
        for (const s of screens) {
          const label = `desktop agent${s.total > 1 ? ` · screen ${s.index}/${s.total}` : ''}`;
          const res = await api.agentUploadShot(deviceToken, s.jpeg, { idleSec, activeView: label, tzOffsetMin: new Date().getTimezoneOffset() });
          if (res && res.stopped) break;   // benign 409 → stop this pass
        }
        lastShotAt = Date.now();
      } catch { /* next tick retries */ }
      scheduleNext();                       // (randomized) delay until the next pass
    }
  } finally { ticking = false; }
}

// Master heartbeat: refresh token + clock state, then capture if it's time.
async function tick() {
  // Self-heal into silent mode: if a device token appears after launch (e.g. the
  // installer auto-started us a moment before the install command wrote it), pick
  // it up here instead of ever showing an interactive login.
  if (!silentMode) {
    const t = readDeviceToken();
    if (t) { deviceToken = t; silentMode = true; refreshTray(); }
  }
  if (silentMode) return silentTick();
  if (ticking) return;
  ticking = true;
  try {
    if (!(await ensureToken())) { refreshTray(); return; }
    status = await api.getStatus(token).catch(() => status);
    const pol = await api.getPolicy(token).catch(() => null);   // server-driven cadence + toggles
    if (pol) applyPolicy(pol);
    refreshTray();
    const canCapture = markCapturing(clockedIn() && !paused && policy.enabled && policy.trackScreens);
    if (canCapture && Date.now() >= nextDueAt) {
      await doCapture(false);
      scheduleNext();                       // (randomized) delay until the next pass
    }
  } finally { ticking = false; }
}

// Single instance — a second launch just exits.
if (!app.requestSingleInstanceLock()) { app.quit(); }

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide(); // tray-only
  tray = new Tray(trayIcon());
  refreshTray();
  if (silentMode) {
    tick();                                  // headless: no login prompt
    // Sample the foreground app between heartbeats (silent mode only). Skip when
    // paused or when policy collects neither titles nor activity %.
    setInterval(() => {
      if (paused || !policy.enabled || (!policy.trackWindows && !policy.trackInput)) return;
      const idle = powerMonitor.getSystemIdleTime();
      activity.sample(idle, config.sampleMs / 1000, config.idleActiveSec, { trackWindows: policy.trackWindows }).catch(() => {});
    }, config.sampleMs);
  }
  // Non-silent: do NOT auto-open a Microsoft login (that popped AADSTS9002327 on
  // silent deploys that started before the token landed). Sit idle in the tray;
  // interactive users can choose "Sign in" from the tray menu. tick() will flip
  // us to silent the moment a device token appears.
  else { tick(); }                          // kick an immediate token re-check
  setInterval(tick, config.statusPollMs);   // heartbeat
  powerMonitor.on('resume', tick);          // wake from sleep → re-sync promptly
});

// Never quit just because there's no window (there isn't one).
app.on('window-all-closed', (e) => e.preventDefault());
