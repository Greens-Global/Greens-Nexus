/* Nexus Fields — background location tracker.
 *
 * Talks to the SAME backend as the web portal, authenticating with an
 * admin-minted device token (X-Agent-Token) — see backend/routers/timeclock.py.
 * Tracking runs only while clocked in; pings buffer offline and flush on
 * reconnect. Plain no-bundler www: plugins are resolved lazily from the native
 * Capacitor bridge (see plugin()).
 */
const $ = (id) => document.getElementById(id);
const show = (id, on) => { const el = $(id); if (el) el.classList.toggle('hidden', !on); };

// Resolve a Capacitor plugin LAZILY and freshly on each call. In a no-bundler
// build the native bridge may not be ready at module-eval time, and different
// bridge versions expose either registerPlugin() or Plugins[name] — try both.
function plugin(name) {
  const C = window.Capacitor;
  if (!C) return null;
  if (typeof C.registerPlugin === 'function') return C.registerPlugin(name);
  if (C.Plugins && C.Plugins[name]) return C.Plugins[name];
  return null;
}
const P   = () => plugin('Preferences');
const Dev = () => plugin('Device');
const BG  = () => plugin('BackgroundGeolocation');
const BS  = () => plugin('BarcodeScanner');

function trackDbg(msg) { const el = $('diag'); if (el) el.textContent = capInfo() + '\n▶ ' + msg; }

function capInfo() {
  const C = window.Capacitor;
  return 'cap=' + (typeof C) +
    ' platform=' + (C && C.getPlatform ? C.getPlatform() : '?') +
    ' registerPlugin=' + (C ? typeof C.registerPlugin : '-') +
    ' Plugins=' + (C ? typeof C.Plugins : '-') +
    ' keys=' + (C && C.Plugins ? Object.keys(C.Plugins).join('|') : '-');
}

const state = {
  apiBase: '', token: '', email: '',
  intervalSec: 300, distanceM: 100,
  watcherId: null, onShift: false,
  lastRecordedAt: 0, lastLat: null, lastLng: null,
  buffer: [], _tick: null,
};

// ── storage ──────────────────────────────────────────────────────────────
async function load() {
  const pf = P();
  if (!pf) return;
  try {
    state.apiBase = (await pf.get({ key: 'apiBase' })).value || '';
    state.token   = (await pf.get({ key: 'token' })).value || '';
    const buf     = (await pf.get({ key: 'buffer' })).value;
    state.buffer  = buf ? JSON.parse(buf) : [];
  } catch (e) { console.warn('load: prefs unavailable', e); }
}
async function saveBuffer() {
  const pf = P();
  if (pf) { try { await pf.set({ key: 'buffer', value: JSON.stringify(state.buffer.slice(-2000)) }); } catch { /* ignore */ } }
  const el = $('buffered'); if (el) el.textContent = String(state.buffer.length);
}
async function savePair(apiBase, token) {
  const pf = P();
  if (!pf) return;
  await pf.set({ key: 'apiBase', value: apiBase });
  await pf.set({ key: 'token', value: token });
}

// ── backend ──────────────────────────────────────────────────────────────
async function apiRaw(path, method = 'GET', body) {
  return fetch(state.apiBase.replace(/\/$/, '') + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': state.token },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function api(path, method, body) {
  const res = await Promise.race([
    apiRaw(path, method, body),
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('request timed out'), { status: 0 })), 15000)),
  ]);
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
  return res.json();
}

// ── screens ──────────────────────────────────────────────────────────────
async function route() {
  if (!state.apiBase || !state.token) { show('enroll', true); show('consent', false); show('main', false); return; }
  let cfg;
  try { cfg = await api('/timeclock/track/config'); }
  catch { alert('Could not reach the server / pairing code rejected. Check setup.'); show('enroll', true); show('consent', false); show('main', false); return; }
  state.intervalSec = cfg.intervalSec || 300;
  state.distanceM   = cfg.distanceM || 100;
  state.email       = cfg.email || '';
  const who = $('whoami'); if (who) who.textContent = state.email;
  show('enroll', false);
  if (!cfg.hasConsent) { show('consent', true); show('main', false); return; }
  show('consent', false); show('main', true);
  if (cfg.clockedIn && !state.onShift) startTracking(true);
  else setStatus(cfg.clockedIn);
}

function setStatus(on) {
  state.onShift = on;
  const dot = on ? '#16a34a' : '#64748b';
  const el = $('status');
  if (el) el.innerHTML = `<span class="dot" style="background:${dot}"></span>${on ? 'on shift — tracking' : 'off shift'}`;
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
  const d = Dev();
  if (!d || !d.getBatteryInfo) return -1;
  try { const b = await d.getBatteryInfo(); return Math.round((b.batteryLevel ?? -0.01) * 100); }
  catch { return -1; }
}

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
    state.buffer.splice(0, batch.length);
    await saveBuffer();
    const lp = $('lastPing'); if (lp) lp.textContent = new Date().toLocaleTimeString();
  } catch (e) {
    if (e.status === 409) { await stopTracking(); setStatus(false); }
  } finally { flushing = false; }
}

// One-shot fix — covers a stationary phone. enableHighAccuracy:false so it uses
// the network (WiFi/cell) provider, which returns fast and works INDOORS instead
// of waiting on a GPS lock that never comes at a desk. Prefers the native
// Geolocation plugin (fused provider) and falls back to the WebView API.
async function pollFix() {
  const opts = { enableHighAccuracy: false, timeout: 20000, maximumAge: 600000 };
  const geo = plugin('Geolocation');
  if (geo && geo.getCurrentPosition) {
    try {
      if (geo.requestPermissions) { try { await geo.requestPermissions(); } catch (e) { /* */ } }
      const pos = await geo.getCurrentPosition(opts);
      onLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy, time: pos.timestamp });
      return;
    } catch (e) { trackDbg('geo plugin: ' + (e && e.message ? e.message : e)); }
  }
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => onLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy, time: pos.timestamp }),
      (err) => trackDbg('poll error: ' + (err && err.message ? err.message : err)),
      opts
    );
  }
}

// ── tracking lifecycle ───────────────────────────────────────────────────
async function startTracking(resumed) {
  if (state.watcherId) return;
  setStatus(true);   // clocked in — reflect it now, independent of the GPS watcher
  const bg = BG();
  if (bg && bg.addWatcher) {
    trackDbg('starting watcher…');
    try {
      state.watcherId = await bg.addWatcher({
        backgroundTitle: 'Nexus Fields — on shift',
        backgroundMessage: "Recording your location while you're clocked in. Ends when you clock out.",
        requestPermissions: true, stale: true,
        distanceFilter: Math.min(25, state.distanceM),
      }, (location, error) => {
        if (error) {
          trackDbg('geo error: ' + (error.code || '') + ' ' + (error.message || ''));
          if (!state._geoAlerted && /NOT_AUTHORIZED|denied|permission/i.test((error.code || '') + (error.message || ''))) {
            state._geoAlerted = true;
            alert('Location permission is off.\nEnable it: Settings → Apps → Nexus Fields → Permissions → Location → “Allow all the time”, then tap Start shift again.');
          }
          return;
        }
        trackDbg('fix ' + (+location.latitude).toFixed(5) + ',' + (+location.longitude).toFixed(5) + ' ±' + Math.round(location.accuracy || 0) + 'm');
        onLocation(location);
      });
      trackDbg('watcher active (' + state.watcherId + ')');
    } catch (e) { trackDbg('watcher failed: ' + (e && e.message ? e.message : e)); }
  } else {
    alert('Location tracking is unavailable on this device.\n' + capInfo());
  }
  pollFix();   // grab an immediate foreground fix so the first ping lands fast
  if (!resumed) flush();
  clearInterval(state._tick);
  state._tick = setInterval(() => { if (state.onShift) { pollFix(); flush(); } }, state.intervalSec * 1000);
}
async function stopTracking() {
  clearInterval(state._tick);
  const bg = BG();
  if (state.watcherId && bg) { try { await bg.removeWatcher({ id: state.watcherId }); } catch { /* gone */ } state.watcherId = null; }
}
// ── pairing / QR scan ──────────────────────────────────────────────────────
async function pairWith(apiBase, token) {
  state.apiBase = apiBase.trim().replace(/\/$/, '');
  state.token = token.trim();
  await savePair(state.apiBase, state.token);
  route();
}

let _scanListener = null;
async function stopScanning() {
  document.body.classList.remove('scanning');
  try { if (_scanListener) { await _scanListener.remove(); _scanListener = null; } } catch { /* gone */ }
  const bs = BS(); if (bs && bs.stopScan) { try { await bs.stopScan(); } catch { /* not scanning */ } }
}
async function onScanned(raw) {
  await stopScanning();
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (!data.api || !data.code) throw new Error('missing fields');
    await pairWith(data.api, data.code);
  } catch {
    alert('That isn’t a Nexus pairing QR. Use the one from HR → Time → Live map → Enrol phone.');
  }
}

// Uses startScan() (device camera + the ML Kit model bundled in the APK) — not
// scan(), which needs Google's code-scanner module (Play Services).
$('scanQr').onclick = async () => {
  const bs = BS();
  if (!bs || !bs.startScan) { alert('Scanner unavailable on this device.\n' + capInfo() + '\nUse “Enter manually”.'); return; }
  try {
    if (bs.requestPermissions) {
      const perm = await bs.requestPermissions();
      const cam = perm && perm.camera;
      if (cam && cam !== 'granted' && cam !== 'limited') {
        alert('Camera access is needed to scan the QR. Turn it on in Settings, or use “Enter manually”.');
        return;
      }
    }
    document.body.classList.add('scanning');
    _scanListener = await bs.addListener('barcodeScanned', (ev) => {
      onScanned(ev && ev.barcode && ev.barcode.rawValue);
    });
    await bs.startScan({ formats: ['QR_CODE'] });
  } catch (e) {
    await stopScanning();
    alert('Scan couldn’t start: ' + (e && e.message ? e.message : e) + '\nUse “Enter manually” instead.');
  }
};
$('scanCancel').onclick = () => stopScanning();
$('manualToggle').onclick = () => show('manual', $('manual').classList.contains('hidden'));
$('saveEnroll').onclick = async () => {
  const apiBase = $('apiBase').value.trim(), token = $('token').value.trim();
  if (!apiBase || !token) return alert('Enter both the server URL and pairing code.');
  await pairWith(apiBase, token);
};

// ── actions ──────────────────────────────────────────────────────────────
$('grant').onclick = async () => {
  try { await api('/timeclock/track/consent', 'POST', { granted: true }); route(); }
  catch { alert('Could not record consent — check connection.'); }
};
$('declineEnroll').onclick = () => { show('consent', false); show('main', false); show('enroll', true); };

$('startShift').onclick = async () => {
  const btn = $('startShift');
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Starting…';
  try {
    // Clock in immediately — no GPS pre-fetch on the critical path. Location is
    // supplied by the continuous tracker's first ping moments later.
    await api('/timeclock/track/clock', 'POST', { kind: 'in', tz_offset_min: new Date().getTimezoneOffset() });
    startTracking(false);   // not awaited — starts the location watcher in the background
  } catch (e) {
    alert(e.status === 409 ? "Can't start a shift right now — you may already be clocked in." : 'Could not clock in: ' + (e.message || e));
  }
  btn.disabled = false; btn.textContent = label;
};
$('endShift').onclick = async () => {
  await flush();
  try { await api('/timeclock/track/clock', 'POST', { kind: 'out', tz_offset_min: new Date().getTimezoneOffset() }); }
  catch { /* stop locally; server auto-closes on idle */ }
  await stopTracking(); setStatus(false);
};
$('revoke').onclick = async () => {
  if (!confirm('Withdraw consent and stop all tracking?')) return;
  await stopTracking();
  try { await api('/timeclock/track/consent', 'POST', { granted: false }); } catch { /* */ }
  setStatus(false); route();
};

// ── boot ─────────────────────────────────────────────────────────────────
(async () => {
  const dg = $('diag'); if (dg) dg.textContent = capInfo();
  try { await load(); } catch (e) { console.warn('boot: load failed', e); }
  try { await saveBuffer(); } catch (e) { console.warn('boot: buffer failed', e); }
  try { route(); } catch (e) { console.warn('boot: route failed', e); show('enroll', true); }
})();
