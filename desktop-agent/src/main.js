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

// ── Silent (token) mode ────────────────────────────────────────────────────────
// If a device token was provisioned (env var, or a file the install command
// dropped in userData), the agent runs headless: it authenticates with the token
// and never shows a Microsoft login. This is the "Silent App User" deployment.
const TOKEN_FILE = path.join(app.getPath('userData'), 'device-token.txt');
function readDeviceToken() {
  if (process.env.NEXUS_AGENT_TOKEN) return process.env.NEXUS_AGENT_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
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
// whether to capture, then capture every 5 min while active.
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
    if (r) { silentEmail = r.email || silentEmail; silentCapture = !!r.capture && !paused; }
    refreshTray();
    // Flush the last window of app activity (accumulated by sampleTick)
    const act = activity.flush();
    if (act.segments.length) {
      api.agentPostActivity(deviceToken, {
        segments: act.segments, active_pct: act.activePct, tz_offset_min: new Date().getTimezoneOffset(),
      }).catch(() => {});
    }
    if (silentCapture && Date.now() - lastShotAt >= config.captureIntervalMs) {
      try {
        const screens = await captureAllScreens();
        for (const s of screens) {
          const label = `desktop agent${s.total > 1 ? ` · screen ${s.index}/${s.total}` : ''}`;
          await api.agentUploadShot(deviceToken, s.jpeg, { idleSec, activeView: label, tzOffsetMin: new Date().getTimezoneOffset() });
        }
        lastShotAt = Date.now();
      } catch { /* next tick retries */ }
    }
  } finally { ticking = false; }
}

// Master heartbeat: refresh token + clock state, then capture if it's time.
async function tick() {
  if (silentMode) return silentTick();
  if (ticking) return;
  ticking = true;
  try {
    if (!(await ensureToken())) { refreshTray(); return; }
    status = await api.getStatus(token).catch(() => status);
    refreshTray();
    if (clockedIn() && !paused && Date.now() - lastShotAt >= config.captureIntervalMs) {
      await doCapture(false);
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
    // Sample the foreground app between heartbeats (silent mode only)
    setInterval(() => {
      if (paused) return;
      const idle = powerMonitor.getSystemIdleTime();
      activity.sample(idle, config.sampleMs / 1000, config.idleActiveSec).catch(() => {});
    }, config.sampleMs);
  } else {
    await signIn(true);                      // interactive: prompt on first launch
  }
  setInterval(tick, config.statusPollMs);   // heartbeat
  powerMonitor.on('resume', tick);          // wake from sleep → re-sync promptly
});

// Never quit just because there's no window (there isn't one).
app.on('window-all-closed', (e) => e.preventDefault());
