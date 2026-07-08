/* Nexus Field — background location tracker.
 *
 * Talks to the SAME backend as the web portal, but authenticates with an
 * admin-minted device token (X-Agent-Token) instead of a Microsoft login —
 * see backend/routers/timeclock.py: get_agent_device + the /track/* endpoints.
 *
 * Tracking is DISTANCE-driven by the native plugin (fires on movement) and we
 * throttle-record a ping when >= TRACK_DISTANCE_M moved OR >= intervalSec passed
 * since the last recorded point. Pings buffer locally and flush in batches, so a
 * dead-zone stretch uploads on reconnect. The server rejects anything sent while
 * not clocked in, so tracking can never outlive a shift.
 */
const Cap = window.Capacitor;
const Preferences = Cap.Plugins.Preferences;
const Device = Cap.Plugins.Device;
const BackgroundGeolocation = Cap.registerPlugin('BackgroundGeolocation');
const BarcodeScanner = Cap.registerPlugin('BarcodeScanner');

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

const state = {
  apiBase: '', token: '', email: '',
  intervalSec: 300, distanceM: 100,
  watcherId: null, onShift: false,
  lastRecordedAt: 0, lastLat: null, lastLng: null,
  buffer: [],            // pings not yet accepted by the server
};

// ── storage ──────────────────────────────────────────────────────────────
async function load() {
  state.apiBase = (await Preferences.get({ key: 'apiBase' })).value || '';
  state.token   = (await Preferences.get({ key: 'token' })).value || '';
  const buf     = (await Preferences.get({ key: 'buffer' })).value;
  state.buffer  = buf ? JSON.parse(buf) : [];
}
async function saveBuffer() {
  await Preferences.set({ key: 'buffer', value: JSON.stringify(state.buffer.slice(-2000)) });
  $('buffered').textContent = String(state.buffer.length);
}

// ── backend ──────────────────────────────────────────────────────────────
async function apiRaw(path, method = 'GET', body) {
  const res = await fetch(state.apiBase.replace(/\/$/, '') + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': state.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}
async function api(path, method, body) {
  const res = await apiRaw(path, method, body);
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
  return res.json();
}

// ── screens ──────────────────────────────────────────────────────────────
async function route() {
  if (!state.apiBase || !state.token) { show('enroll', true); show('consent', false); show('main', false); return; }
  let cfg;
  try { cfg = await api('/timeclock/track/config'); }
  catch (e) { alert('Could not reach the server / pairing code rejected. Check setup.'); show('enroll', true); return; }
  state.intervalSec = cfg.intervalSec || 300;
  state.distanceM   = cfg.distanceM || 100;
  state.email       = cfg.email || '';
  $('whoami').textContent = state.email;
  show('enroll', false);
  if (!cfg.hasConsent) { show('consent', true); show('main', false); return; }
  show('consent', false); show('main', true);
  // resume tracking if the server still thinks we're on shift (e.g. app restarted)
  if (cfg.clockedIn && !state.onShift) startTracking(true);
  else setStatus(cfg.clockedIn);
}

function setStatus(on) {
  state.onShift = on;
  const dot = on ? '#16a34a' : '#64748b';
  $('status').innerHTML = `<span class="dot" style="background:${dot}"></span>${on ? 'on shift — tracking' : 'off shift'}`;
  show('startShift', !on); show('endShift', on);
}

// ── geo helpers ──────────────────────────────────────────────────────────
function metres(aLat, aLng, bLat, bLng) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
async function batteryPct() {
  try { const b = await Device.getBatteryInfo(); return Math.round((b.batteryLevel ?? -0.01) * 100); }
  catch { return -1; }
}

// A location arrived from the native watcher. Decide whether to record it.
async function onLocation(loc) {
  if (!loc || !state.onShift) return;
  const now = Date.now();
  const movedFar = state.lastLat == null ||
    metres(state.lastLat, state.lastLng, loc.latitude, loc.longitude) >= state.distanceM;
  const dueByTime = (now - state.lastRecordedAt) >= state.intervalSec * 1000;
  if (!movedFar && !dueByTime) return;   // throttle: 100 m OR 5 min, whichever first

  state.lastRecordedAt = now;
  state.lastLat = loc.latitude; state.lastLng = loc.longitude;
  state.buffer.push({
    lat: String(loc.latitude), lng: String(loc.longitude),
    accuracy_m: Math.round(loc.accuracy || 0),
    at: new Date(loc.time || now).toISOString().slice(0, 19),
    battery_pct: await batteryPct(),
    tz_offset_min: new Date().getTimezoneOffset(),
  });
  await saveBuffer();
  flush();
}

let flushing = false;
async function flush() {
  if (flushing || !state.buffer.length) return;
  flushing = true;
  try {
    const batch = state.buffer.slice(0, 200);
    await api('/timeclock/track/ping', 'POST', { pings: batch });
    state.buffer.splice(0, batch.length);   // drop only what the server accepted
    await saveBuffer();
    $('lastPing').textContent = new Date().toLocaleTimeString();
  } catch (e) {
    if (e.status === 409) {                 // server says not clocked in — stop cleanly
      await stopTracking(); setStatus(false);
    }
    // else: offline / transient — keep the buffer, retry on next location or tick
  } finally { flushing = false; }
}

// ── tracking lifecycle ───────────────────────────────────────────────────
async function startTracking(resumed) {
  if (state.watcherId) return;
  state.watcherId = await BackgroundGeolocation.addWatcher({
    backgroundTitle: 'Nexus Field — on shift',
    backgroundMessage: "Recording your location while you're clocked in. Ends when you clock out.",
    requestPermissions: true,
    stale: false,
    distanceFilter: Math.min(25, state.distanceM),   // let the OS wake us; we throttle in onLocation
  }, (location, error) => {
    if (error) { console.warn('geo error', error); return; }
    onLocation(location);
  });
  setStatus(true);
  if (!resumed) flush();
  // Foreground fallback so a stationary phone still pings ~every interval while
  // the app is open (backgrounded timers are throttled — this is best-effort).
  clearInterval(state._tick);
  state._tick = setInterval(() => { if (state.onShift) flush(); }, state.intervalSec * 1000);
}
async function stopTracking() {
  clearInterval(state._tick);
  if (state.watcherId) { await BackgroundGeolocation.removeWatcher({ id: state.watcherId }); state.watcherId = null; }
}

async function currentFix() {
  // best-effort one-shot fix to stamp the clock punch; ignore failure
  return new Promise((resolve) => {
    let done = false;
    BackgroundGeolocation.addWatcher({ requestPermissions: true, stale: true, distanceFilter: 0 },
      async (loc, err) => {
        if (done) return; done = true;
        resolve(err || !loc ? null : loc);
      }).then((id) => setTimeout(() => BackgroundGeolocation.removeWatcher({ id }), 1500));
  });
}

// ── actions ──────────────────────────────────────────────────────────────
async function pairWith(apiBase, token) {
  state.apiBase = apiBase.trim().replace(/\/$/, '');
  state.token = token.trim();
  await Preferences.set({ key: 'apiBase', value: state.apiBase });
  await Preferences.set({ key: 'token', value: state.token });
  route();
}

// One scan pairs the phone: the QR carries { api, code } — no typing.
$('scanQr').onclick = async () => {
  try {
    try {
      const a = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
      if (a && a.available === false) await BarcodeScanner.installGoogleBarcodeScannerModule();
    } catch { /* older devices / already present */ }
    const res = await BarcodeScanner.scan();
    const raw = res && res.barcodes && res.barcodes[0] && res.barcodes[0].rawValue;
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data.api || !data.code) throw new Error('Not a Nexus pairing QR');
    await pairWith(data.api, data.code);
  } catch (e) {
    alert('Could not read that QR. Make sure it’s the Nexus pairing QR, or use “Enter manually”.');
  }
};
$('manualToggle').onclick = () => show('manual', $('manual').classList.contains('hidden'));
$('saveEnroll').onclick = async () => {
  const apiBase = $('apiBase').value.trim(), token = $('token').value.trim();
  if (!apiBase || !token) return alert('Enter both the server URL and pairing code.');
  await pairWith(apiBase, token);
};
$('grant').onclick = async () => {
  try { await api('/timeclock/track/consent', 'POST', { granted: true }); route(); }
  catch { alert('Could not record consent — check connection.'); }
};
$('declineEnroll').onclick = () => show('consent', false) || show('main', false) || show('enroll', true);

$('startShift').onclick = async () => {
  const fix = await currentFix();
  try {
    const body = { kind: 'in', tz_offset_min: new Date().getTimezoneOffset() };
    if (fix) Object.assign(body, { lat: String(fix.latitude), lng: String(fix.longitude), accuracy_m: Math.round(fix.accuracy || 0) });
    await api('/timeclock/track/clock', 'POST', body);
    startTracking(false);
  } catch (e) { alert(e.status === 409 ? "Can't start a shift right now." : 'Could not clock in.'); }
};
$('endShift').onclick = async () => {
  await flush();                                   // push whatever we still hold
  try { await api('/timeclock/track/clock', 'POST', { kind: 'out', tz_offset_min: new Date().getTimezoneOffset() }); }
  catch { /* even if this fails, stop locally; server auto-closes on idle */ }
  await stopTracking(); setStatus(false);
};
$('revoke').onclick = async () => {
  if (!confirm('Withdraw consent and stop all tracking?')) return;
  await stopTracking();
  try { await api('/timeclock/track/consent', 'POST', { granted: false }); } catch {}
  setStatus(false); route();
};

// ── boot ─────────────────────────────────────────────────────────────────
(async () => { await load(); await saveBuffer(); route(); })();
