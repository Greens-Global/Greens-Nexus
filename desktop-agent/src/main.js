// ── Greens Nexus Agent — headless time & activity tracker ─────────────────────
// A background companion to the Nexus Time Clock. While the employee is CLOCKED
// IN it records, per the disclosed monitoring policy:
//   • the foreground app + window title (→ the Activity Log), and
//   • a periodic screenshot of each monitor (→ the Screenshots gallery),
// and reports an active/idle %. It posts to the same /timeclock/agent/* APIs the
// system already exposes, authenticating with a per-device token.
//
// This build has NO tray icon and NO window — it runs as an auto-start background
// process (see registerLoginStart) under its real name, "Greens Nexus Agent". It
// is NOT hidden: it appears in Task Manager, in the Startup list, and in Installed
// Programs, and employees are told about it at first login and sign a disclosure.
// Nothing here disguises the process, blocks Task Manager, or resists being
// stopped — it is a disclosed, consent-gated, clocked-in-only tracker.
//
// Why a login-start background process and not a session-0 Windows service:
// screen capture (desktopCapturer) and foreground-window reads (active-win) only
// work inside the interactive user session. A classic session-0 service cannot
// see the user's desktop at all, so this runs in the user session with no UI.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, powerMonitor } = require('electron');
const config = require('./config');
const api = require('./api');
const activity = require('./activity');
const { captureAllScreens } = require('./capture');

// ── Simple rotating-ish log (discoverable, for the employee/IT to inspect) ─────
const LOG_DIR = path.join(process.env.PROGRAMDATA || app.getPath('userData'), 'Greens Nexus Agent');
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

// ── Effective monitoring policy (server-driven) ───────────────────────────────
// The SERVER decides cadence + what may be collected (/agent/checkin's `policy`).
// config.js only supplies fallbacks until the server first answers.
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

// ── Device token (identity) ───────────────────────────────────────────────────
// The agent is provisioned with a per-device token (X-Agent-Token). Checked in
// order: env var, machine-wide ProgramData, then per-user userData. ProgramData
// is machine-wide so the token is found regardless of which user runs the agent.
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

function firstMac() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
    }
  }
  return '';
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
let ticking = false;
let lastEmail = '';

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // Pick up a token that appeared after launch (installer writes it post-install).
    if (!deviceToken) {
      deviceToken = readDeviceToken();
      if (!deviceToken) { ticking = false; return; }   // nothing to do until provisioned
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
    }

    // Flush the accumulated window activity (→ Activity Log). Titles only when
    // trackWindows; activity % only when trackInput.
    const act = activity.flush();
    if ((policy.trackWindows && act.segments.length) || policy.trackInput) {
      const body = { tz_offset_min: new Date().getTimezoneOffset() };
      if (policy.trackWindows) body.segments = act.segments;
      if (policy.trackInput) body.active_pct = act.activePct;
      api.agentPostActivity(deviceToken, body).catch((e) => log(`activity post failed: ${e.message || e}`));
    }

    // Screenshots on the (optionally randomized) policy cadence while capturing.
    const canCapture = markCapturing(capture && policy.enabled && policy.trackScreens);
    if (canCapture && Date.now() >= nextDueAt) {
      try {
        const screens = await captureAllScreens();
        for (const s of screens) {
          const label = `desktop agent${s.total > 1 ? ` · screen ${s.index}/${s.total}` : ''}`;
          const res = await api.agentUploadShot(deviceToken, s.jpeg,
            { idleSec, activeView: label, tzOffsetMin: new Date().getTimezoneOffset() });
          if (res && res.stopped) break;    // benign 409 → stop this pass
        }
      } catch (e) { log(`capture failed: ${e.message || e}`); }
      scheduleNext();
    }
  } finally { ticking = false; }
}

// ── Auto-start at login (user session, no UI) ─────────────────────────────────
// Registers the agent to launch hidden at login so it's always running while the
// employee is signed in. This is a normal, VISIBLE Startup entry (Task Manager →
// Startup shows "Greens Nexus Agent") — not a concealed one. Employees may see it
// there; disclosure + the signed agreement cover that it runs.
function registerLoginStart() {
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: true,
        name: 'Greens Nexus Agent',
        args: ['--background'],
      });
    }
  } catch (e) { log(`could not register login start: ${e.message || e}`); }
}

// Single instance — a second launch just exits.
if (!app.requestSingleInstanceLock()) { app.quit(); }

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();   // no dock icon
  log(`Greens Nexus Agent starting — host ${os.hostname()}, user ${os.userInfo().username}`);
  registerLoginStart();

  tick();                                       // first heartbeat now
  setInterval(tick, config.statusPollMs);       // heartbeat loop
  powerMonitor.on('resume', tick);              // re-sync promptly on wake

  // Sample the foreground app between heartbeats. Skips when policy collects
  // neither titles nor activity %. active-win / idle reads are cheap.
  setInterval(() => {
    if (!policy.enabled || (!policy.trackWindows && !policy.trackInput)) return;
    const idle = powerMonitor.getSystemIdleTime();
    activity.sample(idle, config.sampleMs / 1000, config.idleActiveSec,
      { trackWindows: policy.trackWindows }).catch(() => {});
  }, config.sampleMs);
});

// No window exists; never quit on "all windows closed".
app.on('window-all-closed', (e) => e.preventDefault());
