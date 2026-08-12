// ── Plugin — time & activity tracker with a visible indicator ─────
// A background companion to the Nexus Time Clock. While the employee is CLOCKED
// IN it records, per the disclosed monitoring policy:
//   • the foreground app + window title (→ the Activity Log), and
//   • a periodic screenshot of each monitor (→ the Screenshots gallery),
// and reports an active/idle %. It posts to the same /timeclock/agent/* APIs the
// system already exposes, authenticating with a per-device token.
//
// It is DISCLOSED, not covert. A system-tray icon is always visible while the
// agent runs and turns green with the tooltip "Plugin - Monitoring active" whenever
// it is actually capturing; the process appears in Task Manager, Startup, and
// Installed Programs under its real name. Nothing here hides the process, blocks
// Task Manager, or resists being stopped. "Standard users can't uninstall it"
// comes from deploying it as a per-machine MANAGED company application (MSI via
// Intune) on company-owned devices where the employee lacks admin - NOT from the
// app fighting the user. Capture happens only while clocked in and not on break.
//
// Runs in the interactive user session (not a session-0 service) because screen
// capture (desktopCapturer) and foreground-window reads (active-win) can't see
// the user's desktop from session 0. Auto-starts at login; auto-relaunches on a
// hard crash so a live shift keeps reporting.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, powerMonitor, Tray, Menu, nativeImage, shell } = require('electron');
const config = require('./config');
const api = require('./api');
const activity = require('./activity');
const queue = require('./queue');
const { startPairServer } = require('./pairserver');
const { captureAllScreens } = require('./capture');
const live = require('./live');

// ── Discoverable log (for the employee / IT to inspect) ───────────────────────
const LOG_DIR = path.join(process.env.PROGRAMDATA || app.getPath('userData'), 'Plugin');
const LOG_FILE = path.join(LOG_DIR, 'agent.log');
function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1_000_000) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');   // keep one previous log
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* logging is best-effort */ }
}

// ── Service-managed mode ──────────────────────────────────────────────────────
// On company PCs the Nexus Monitor Service (a privileged Windows service standard
// users can't stop) launches this agent into the interactive user session and
// respawns it if it exits - that's what enforces "only IT can stop monitoring",
// through normal Windows service permissions, with nothing hidden. In that mode
// the agent hands lifecycle to the service: it does NOT self-register at login
// (the service owns startup) and on a crash it just exits so the SERVICE restarts
// it. Run standalone (dev) without the flag and it self-manages as before.
const SERVICE_MANAGED = process.argv.includes('--service-managed')
  || process.env.NEXUS_SERVICE_MANAGED === '1';

// ── Crash auto-restart ────────────────────────────────────────────────────────
// A hard crash relaunches the agent so a live shift keeps reporting - but a fast
// crash LOOP backs off (relaunch at most once per minute) so a persistent fault
// surfaces honestly as "agent offline" on the dashboard instead of thrashing.
// Under the service, we exit instead and let the service's recovery respawn us.
const RELAUNCH_STAMP = path.join(LOG_DIR, 'last-relaunch');
function relaunchAfterCrash() {
  if (SERVICE_MANAGED) { app.exit(1); return; }   // the service respawns us
  try {
    const prev = Number(fs.readFileSync(RELAUNCH_STAMP, 'utf8')) || 0;
    if (Date.now() - prev < 60_000) { app.exit(1); return; }
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(RELAUNCH_STAMP, String(Date.now()));
  } catch { /* if we can't even stamp, still try one relaunch */ }
  try { app.relaunch({ args: ['--background'] }); } catch { /* ignore */ }
  app.exit(1);
}
process.on('uncaughtException', (e) => { log(`FATAL uncaughtException: ${(e && e.stack) || e}`); relaunchAfterCrash(); });
process.on('unhandledRejection', (e) => { log(`unhandledRejection: ${(e && e.stack) || e}`); });

// ── Effective monitoring policy (server-driven) ───────────────────────────────
const DEFAULT_POLICY = {
  enabled: true,
  intervalMinutes: config.captureIntervalMs / 60000,
  randomize: false,
  trackScreens: true,
  trackWindows: true,
  trackInput: true,
};
let policy = { ...DEFAULT_POLICY };

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

let nextDueAt = 0;          // when the next screenshot pass is allowed
let wasCapturing = false;   // capturing-state edge → shoot promptly at shift start

function scheduleNext() {
  const base = baseIntervalMs();
  const ms = policy.randomize ? base * (0.75 + Math.random() * 0.5) : base;
  nextDueAt = Date.now() + Math.round(ms);
}
function markCapturing(canCapture) {
  if (canCapture && !wasCapturing) nextDueAt = 0;   // first shot due NOW at shift start
  wasCapturing = canCapture;
  return canCapture;
}

// ── Visible tray indicator ────────────────────────────────────────────────────
// A circle rendered from a raw bitmap - no binary asset to ship. Green while
// actually capturing, gray otherwise; hover text is just "Plugin". The menu points
// to the Time Clock and the local log, and states plainly that it's company-run.
let tray = null;
function trayImage(rgb) {
  const w = 16, h = 16, buf = Buffer.alloc(w * h * 4);
  const cx = 7.5, cy = 7.5, r2 = 7 * 7;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2;
      buf[i] = rgb[2]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[0]; buf[i + 3] = inside ? 255 : 0;  // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}
const GREEN = [34, 197, 94], GRAY = [148, 163, 184], BLUE = [59, 130, 246];

// A manager is watching this screen live right now. Surfaced in the tray so the
// employee always SEES when they're being watched - live view stays disclosed.
let liveActive = false;
let lastCapturing = false, lastDetail = '';

function setTray(capturing, detail) {
  if (!tray) return;
  lastCapturing = capturing; lastDetail = detail || '';
  // Hover text is just the app name (the signed policy is the disclosure of record;
  // the tray need not repeat "monitoring"). State stays visible via the icon, and
  // the menu below still plainly identifies it as a company-managed app - so it
  // remains disclosed and named, not hidden. Blue = someone is live-viewing now.
  const title = 'Plugin';
  const liveLine = liveActive ? 'Live view active' : '';
  const lines = [liveLine, detail].filter(Boolean).join('\n');
  tray.setImage(trayImage(liveActive ? BLUE : (capturing ? GREEN : GRAY)));
  tray.setToolTip(lines ? `${title}\n${lines}` : title);
  // INTENTIONALLY no Exit / Quit / Pause / Stop item: an employee cannot stop
  // monitoring from here. Only read-only/benign entries. Closing this tray does
  // NOT stop capture (capture runs in the heartbeat loop, and the service respawns
  // the process anyway). Do not add a quit/stop action - stopping is an IT-admin
  // action via the Windows service (services.msc / sc stop), which needs admin.
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: title, enabled: false },
    ...(liveActive ? [{ label: 'Live view active', enabled: false }] : []),
    ...(detail ? [{ label: detail, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Open Time Clock', click: () => shell.openExternal(`${config.webBase}/timeclock`) },
    { label: 'View activity log', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: 'Company-managed application', enabled: false },
  ]));
}

// ── Device token (identity) ───────────────────────────────────────────────────
const TOKEN_FILE = path.join(app.getPath('userData'), 'device-token.txt');
const MACHINE_TOKEN_FILE = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData', 'Plugin', 'device-token.txt');
function readDeviceToken() {
  if (process.env.NEXUS_AGENT_TOKEN) return process.env.NEXUS_AGENT_TOKEN.trim();
  for (const f of [MACHINE_TOKEN_FILE, TOKEN_FILE]) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch { /* next */ }
  }
  return null;
}
let deviceToken = readDeviceToken();

function firstMac() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
    }
  }
  return '';
}

// ── Screenshot upload with offline spooling ───────────────────────────────────
async function uploadOrQueue(jpeg, meta) {
  try {
    return await api.agentUploadShot(deviceToken, jpeg, meta);   // {ok} | {stopped} (409)
  } catch (e) {
    queue.enqueue(jpeg, meta);   // network failure → spool, retry on a later tick
    log(`upload failed, queued (spool ${queue.size()}): ${e.message || e}`);
    return { queued: true };
  }
}

// Drain a bounded slice of the spool each tick; stops on the first still-offline
// failure (keeps order) and on a benign 409 (server says capture is paused now).
async function flushQueue() {
  if (!deviceToken) return;
  for (const n of queue.list().slice(0, 20)) {
    const item = queue.read(n);
    if (!item) { queue.remove(n); continue; }
    try {
      const res = await api.agentUploadShot(deviceToken, item.jpeg, item.meta);
      queue.remove(n);                       // success OR 409 → dealt with, drop it
      if (res && res.stopped) break;
    } catch { break; }                       // still offline → keep the rest
  }
}

// ── Heartbeat + capture loop ──────────────────────────────────────────────────
let ticking = false;
let lastEmail = '';
let clockedIn = false;   // last-known clock state; gates the live-view pending poll

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!deviceToken) {
      deviceToken = readDeviceToken();
      if (!deviceToken) { setTray(false, 'Waiting for enrollment'); ticking = false; return; }
      log('device token found — agent active');
    }
    const idleSec = powerMonitor.getSystemIdleTime();
    const r = await api.agentCheckin(deviceToken, {
      active: idleSec < config.idleActiveSec,
      idle_sec: idleSec,
      device_name: os.hostname(),
      device_user: (os.userInfo().username || ''),
      mac: firstMac(),
      platform: process.platform,
      tz_offset_min: new Date().getTimezoneOffset(),
    }).catch((e) => { log(`checkin failed: ${e.message || e}`); return null; });

    let capture = false;
    if (r) {
      if (r.email && r.email !== lastEmail) { lastEmail = r.email; log(`checked in as ${r.email}`); }
      capture = !!r.capture;                 // server clears this off-shift / on break / policy-off
      applyPolicy(r.policy);
      // Live view only exists while clocked in; the fast pending-poll below is
      // gated on this. If the shift ended mid-view, the server also ends the
      // session and the agent tears it down on its own poll - this is a backstop.
      clockedIn = !!r.clockedIn;
      if (!clockedIn && live.isLive()) live.stopSession('clocked-out');
    }

    // Window-activity report (titles when trackWindows; active % when trackInput).
    const act = activity.flush();
    if ((policy.trackWindows && act.segments.length) || policy.trackInput) {
      const body = { tz_offset_min: new Date().getTimezoneOffset() };
      if (policy.trackWindows) body.segments = act.segments;
      if (policy.trackInput) body.active_pct = act.activePct;
      api.agentPostActivity(deviceToken, body).catch((e) => log(`activity post failed: ${e.message || e}`));
    }

    const canCapture = markCapturing(capture && policy.enabled && policy.trackScreens);

    // Retry anything spooled during an earlier outage, while we still have a link.
    if (r) await flushQueue();

    // New frames on the (optionally randomized) policy cadence while capturing.
    if (canCapture && Date.now() >= nextDueAt) {
      try {
        const screens = await captureAllScreens();
        for (const s of screens) {
          const label = `desktop agent${s.total > 1 ? ` · screen ${s.index}/${s.total}` : ''}`;
          const meta = { idleSec, activeView: label, tzOffsetMin: new Date().getTimezoneOffset() };
          const res = await uploadOrQueue(s.jpeg, meta);
          if (res && res.stopped) break;    // benign 409 → stop this pass
        }
      } catch (e) { log(`capture failed: ${e.message || e}`); }
      scheduleNext();
    }

    const detail = r
      ? `Last sync ${new Date().toLocaleTimeString()}${queue.size() ? ` · ${queue.size()} queued offline` : ''}`
      : `Offline${queue.size() ? ` · ${queue.size()} queued` : ''} - retrying`;
    setTray(canCapture, detail);
  } finally { ticking = false; }
}

// ── Auto-start at login (user session) ────────────────────────────────────────
function registerLoginStart() {
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: true, name: 'Plugin', args: ['--background'] });
    }
  } catch (e) { log(`could not register login start: ${e.message || e}`); }
}

// Single instance — a second launch just exits.
if (!app.requestSingleInstanceLock()) { app.quit(); }

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();   // no dock icon
  log(`Plugin starting — host ${os.hostname()}, user ${os.userInfo().username}`
    + (SERVICE_MANAGED ? ' [service-managed]' : ''));
  // Under the service, the SERVICE owns startup - don't also add a login item
  // (avoids a second, unmanaged copy the employee could later toggle off).
  if (!SERVICE_MANAGED) registerLoginStart();

  try { tray = new Tray(trayImage(GRAY)); setTray(false, 'Starting…'); }
  catch (e) { log(`tray unavailable: ${e.message || e}`); }   // headless fallback

  // Localhost pairing bridge: lets the Nexus page bind the logged-in employee to
  // THIS PC at clock-in (shared-PC attribution). Reads the current device token.
  try { startPairServer(() => deviceToken, log); }
  catch (e) { log(`pair server unavailable: ${e.message || e}`); }

  // Live screen view: when live, flip the tray to "Live view active" (disclosure).
  live.init({
    getToken: () => deviceToken,
    log,
    onLiveChange: (on) => { liveActive = on; setTray(lastCapturing, lastDetail); },
  });

  tick();                                       // first heartbeat now
  setInterval(tick, config.statusPollMs);       // heartbeat loop
  powerMonitor.on('resume', tick);              // re-sync promptly on wake

  // Fast poll for a manager's live-view request - but ONLY while clocked in, so a
  // machine that's off-shift makes no extra calls. ~3s gives a click-to-live start
  // of a couple seconds without the constant polling an always-on loop would add.
  setInterval(() => { if (clockedIn) live.checkPending().catch(() => {}); }, 3000);

  // Sample the foreground app between heartbeats.
  setInterval(() => {
    if (!policy.enabled || (!policy.trackWindows && !policy.trackInput)) return;
    const idle = powerMonitor.getSystemIdleTime();
    activity.sample(idle, config.sampleMs / 1000, config.idleActiveSec,
      { trackWindows: policy.trackWindows }).catch(() => {});
  }, config.sampleMs);
});

// The tray IS the UI; never quit just because no window is open.
app.on('window-all-closed', (e) => e.preventDefault());
