// ── Nexus API calls (device-token / X-Agent-Token auth) ───────────────────────
// Identity comes from the per-device token, not a Microsoft login. Node 18+
// (bundled with Electron) provides global fetch / FormData / Blob.

const config = require('./config');

// Heartbeat: report the machine + active/idle, learn whether to capture right now
// and the current monitoring policy. Auto-punch decisions are made server-side.
async function agentCheckin(token, body) {
  const r = await fetch(`${config.apiBase}/timeclock/agent/checkin`, {
    method: 'POST',
    headers: { 'X-Agent-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`checkin ${r.status}`);
  return r.json();
}

// Upload one screen's JPEG. Flows into the same storage bucket + time_screenshots
// table + gallery the web widget uses.
async function agentUploadShot(token, jpegBuffer, { idleSec, activeView, tzOffsetMin }) {
  const form = new FormData();
  form.append('file', new Blob([jpegBuffer], { type: 'image/jpeg' }), 'shot.jpg');
  form.append('idle_sec', String(Math.max(0, Math.round(idleSec || 0))));
  form.append('active_view', String(activeView || '').slice(0, 100));
  form.append('tz_offset_min', String(tzOffsetMin || 0));
  const r = await fetch(`${config.apiBase}/timeclock/agent/screenshot`, {
    method: 'POST', headers: { 'X-Agent-Token': token }, body: form,
  });
  // 409 = not clocked in, or screen capture disabled by policy — benign stop.
  if (r.status === 409) return { stopped: true };
  if (!r.ok) throw new Error(`upload ${r.status}`);
  return r.json();
}

// Post the window-activity report (seconds per foreground app/title + active %).
async function agentPostActivity(token, body) {
  const r = await fetch(`${config.apiBase}/timeclock/agent/activity`, {
    method: 'POST',
    headers: { 'X-Agent-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`activity ${r.status}`);
  return r.json();
}

// Claim a browser-supplied pairing nonce with THIS device's token, so the backend
// can bind the logged-in employee to this physical PC at clock-in. The browser
// never learns/sends the device_id itself - the agent proves it here.
async function agentPair(token, nonce) {
  const r = await fetch(`${config.apiBase}/timeclock/agent/pair`, {
    method: 'POST',
    headers: { 'X-Agent-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: nonce || '' }),
  });
  if (!r.ok) throw new Error(`pair ${r.status}`);
  return r.json();
}

module.exports = { agentCheckin, agentUploadShot, agentPostActivity, agentPair };
