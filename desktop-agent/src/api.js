// ── Nexus API calls ───────────────────────────────────────────────────────────
// Uses the same endpoints the web app does. Node 18+ (bundled with Electron)
// provides global fetch / FormData / Blob.

const config = require('./config');

async function getStatus(token) {
  const r = await fetch(`${config.apiBase}/timeclock/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

// Interactive mode: fetch the employee's effective monitoring policy (cadence +
// what may be collected). The server is the source of truth; config.js values
// are only a fallback until this answers. Returns the `policy` object.
async function getPolicy(token) {
  const r = await fetch(`${config.apiBase}/timeclock/monitoring/policy`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`policy ${r.status}`);
  const j = await r.json();
  return j && j.policy ? j.policy : j;
}

// Upload one screen's JPEG. Mirrors the web widget's multipart shape exactly,
// so it flows into the same storage bucket + time_screenshots table + gallery.
async function uploadShot(token, jpegBuffer, { idleSec, activeView, tzOffsetMin }) {
  const form = new FormData();
  form.append('file', new Blob([jpegBuffer], { type: 'image/jpeg' }), 'shot.jpg');
  form.append('idle_sec', String(Math.max(0, Math.round(idleSec || 0))));
  form.append('active_view', String(activeView || '').slice(0, 100));
  form.append('tz_offset_min', String(tzOffsetMin || 0));
  const r = await fetch(`${config.apiBase}/timeclock/screenshot`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  // 409 = not clocked in (shift ended between our poll and now) — treat as a
  // benign stop signal, not an error.
  if (r.status === 409) return { stopped: true };
  if (!r.ok) throw new Error(`upload ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

// ── Silent (token) mode ───────────────────────────────────────────────────────
// Identity comes from the device token (X-Agent-Token), not a Microsoft login.

async function agentCheckin(token, body) {
  const r = await fetch(`${config.apiBase}/timeclock/agent/checkin`, {
    method: 'POST',
    headers: { 'X-Agent-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`checkin ${r.status}`);
  return r.json();
}

async function agentUploadShot(token, jpegBuffer, { idleSec, activeView, tzOffsetMin }) {
  const form = new FormData();
  form.append('file', new Blob([jpegBuffer], { type: 'image/jpeg' }), 'shot.jpg');
  form.append('idle_sec', String(Math.max(0, Math.round(idleSec || 0))));
  form.append('active_view', String(activeView || '').slice(0, 100));
  form.append('tz_offset_min', String(tzOffsetMin || 0));
  const r = await fetch(`${config.apiBase}/timeclock/agent/screenshot`, {
    method: 'POST', headers: { 'X-Agent-Token': token }, body: form,
  });
  // 409 = not clocked in, or screen capture disabled by policy — benign stop,
  // same as the interactive uploadShot path.
  if (r.status === 409) return { stopped: true };
  if (!r.ok) throw new Error(`upload ${r.status}`);
  return r.json();
}

async function agentPostActivity(token, body) {
  const r = await fetch(`${config.apiBase}/timeclock/agent/activity`, {
    method: 'POST',
    headers: { 'X-Agent-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`activity ${r.status}`);
  return r.json();
}

module.exports = { getStatus, getPolicy, uploadShot, agentCheckin, agentUploadShot, agentPostActivity };
