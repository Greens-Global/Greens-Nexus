// ── Greens Nexus Agent — tray-resident time-tracking companion ─────────────────
// Signs in as the employee (Entra), and WHILE THEY ARE CLOCKED IN captures every
// monitor every 5 minutes and posts to the same /timeclock/screenshot API the
// web app uses. No window, no Chrome sharing bar — it lives in the system tray.
// Capture is gated on clock state and pausable by the employee from the menu.

const { app, Tray, Menu, nativeImage, powerMonitor, shell, dialog } = require('electron');
const config = require('./config');
const auth = require('./auth');
const api = require('./api');
const { captureAllScreens } = require('./capture');

let tray = null;
let token = null;
let signedIn = false;
let paused = false;
let status = null;
let lastShotAt = 0;
let ticking = false;

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
  if (!signedIn) return 'Not signed in';
  if (!status) return 'Connecting…';
  if (!clockedIn()) return 'Off the clock — not capturing';
  if (paused) return 'Clocked in — capture PAUSED';
  return 'Clocked in — capturing every 5 min';
}

function refreshTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: stateLabel(), enabled: false },
    { type: 'separator' },
    {
      label: paused ? 'Resume capture' : 'Pause capture',
      enabled: signedIn,
      click: () => { paused = !paused; refreshTray(); },
    },
    { label: 'Capture now', enabled: signedIn && clockedIn() && !paused, click: () => doCapture(true) },
    { label: 'Open Time Clock', click: () => shell.openExternal(`${config.webBase}/timeclock`) },
    { type: 'separator' },
    signedIn
      ? { label: 'Sign out', click: signOut }
      : { label: 'Sign in', click: () => signIn(true) },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip(`Greens Nexus Agent — ${stateLabel()}`);
  tray.setContextMenu(menu);
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

// Master heartbeat: refresh token + clock state, then capture if it's time.
async function tick() {
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
  await signIn(true);                       // prompt on first ever launch
  setInterval(tick, config.statusPollMs);   // heartbeat
  powerMonitor.on('resume', tick);          // wake from sleep → re-sync promptly
});

// Never quit just because there's no window (there isn't one).
app.on('window-all-closed', (e) => e.preventDefault());
