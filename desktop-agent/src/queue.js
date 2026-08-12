// ── Offline screenshot spool ──────────────────────────────────────────────────
// When a screenshot upload fails because the network is down, the JPEG is written
// to a machine-wide spool folder and retried on later ticks, so nothing captured
// during a live shift is lost to a brief outage. Bounded by count and age so a
// long outage can never fill the disk.
//
// Note: the server re-gates screenshot uploads on the CURRENT punch state, so a
// queued frame only lands if it's flushed while the employee is still clocked in
// (the common case - flush runs every tick). Frames still spooled past clock-out
// are dropped by the server; the queue's job is surviving mid-shift blips.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DIR = path.join(process.env.PROGRAMDATA || app.getPath('userData'),
  'Greens Nexus Agent', 'spool');
const MAX_ITEMS = 500;                 // oldest dropped past this
const MAX_AGE_MS = 24 * 3600 * 1000;   // and anything older than a day

function ensure() { try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* best effort */ } }

// Spool names start with the capture timestamp, so a plain sort is chronological.
function list() {
  ensure();
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5)).sort();
  } catch { return []; }
}

function remove(n) {
  try { fs.unlinkSync(path.join(DIR, n + '.jpg')); } catch { /* gone */ }
  try { fs.unlinkSync(path.join(DIR, n + '.json')); } catch { /* gone */ }
}

function trim() {
  const now = Date.now();
  for (const n of list()) {
    let ts = 0;
    try { ts = JSON.parse(fs.readFileSync(path.join(DIR, n + '.json'), 'utf8')).ts || 0; } catch { /* corrupt */ }
    if (!ts || now - ts > MAX_AGE_MS) remove(n);
  }
  const still = list();
  for (let i = 0; i < still.length - MAX_ITEMS; i++) remove(still[i]);   // drop oldest
}

function enqueue(jpegBuffer, meta) {
  ensure();
  const n = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(path.join(DIR, n + '.jpg'), jpegBuffer);
    fs.writeFileSync(path.join(DIR, n + '.json'), JSON.stringify({ meta: meta || {}, ts: Date.now() }));
    trim();
  } catch { /* disk full / locked - drop this frame rather than crash */ }
}

function read(n) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, n + '.json'), 'utf8'));
    return { jpeg: fs.readFileSync(path.join(DIR, n + '.jpg')), meta: meta.meta || {} };
  } catch { return null; }
}

function size() { return list().length; }

module.exports = { enqueue, list, read, remove, size };
