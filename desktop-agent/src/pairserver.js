// ── Localhost pairing server ──────────────────────────────────────────────────
// The Nexus website (in the browser) needs to learn which physical PC it's on so
// clock-in can bind employee + device. It cannot trust a device_id typed by the
// browser, and it must not let some other site bind a device. So:
//
//   1. The website mints a one-time nonce for the logged-in employee (backend).
//   2. The website's JS calls THIS server: GET http://127.0.0.1:47615/nexus/pair?nonce=..
//   3. This server claims the nonce by POSTing it to the backend with the agent's
//      OWN device token (api.agentPair) - proving which PC it is. The browser never
//      sees or sends the device_id.
//
// Locked down: binds to 127.0.0.1 only (not reachable off-box); CORS restricted to
// the Nexus web origin so no other website's JS can read a response or drive a
// pairing; a rogue localhost process still can't help an attacker because a nonce
// is only issued to an authenticated Nexus session and is single-use at clock-in.
const http = require('http');
const config = require('./config');
const api = require('./api');

const PAIR_PORT = 47615;

// Which browser origins may talk to the agent - the Nexus web app only.
function allowedOrigin(origin) {
  if (!origin) return null;
  const allowed = new Set([
    config.webBase,
    'https://nexus.greensglobal.com',
    'https://dev.nexus.greensglobal.com',
  ]);
  return allowed.has(origin) ? origin : null;
}

function cors(allow, extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function startPairServer(getToken, log) {
  const server = http.createServer(async (req, res) => {
    const allow = allowedOrigin(req.headers.origin || '');
    // CORS + Chrome Private Network Access preflight (public https -> 127.0.0.1).
    if (req.method === 'OPTIONS') {
      res.writeHead(allow ? 204 : 403, cors(allow, {
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Private-Network': 'true',
      }));
      res.end();
      return;
    }
    let pathname = '/';
    try { pathname = new URL(req.url, `http://127.0.0.1:${PAIR_PORT}`).pathname; } catch { /* bad url */ }

    // Liveness probe - lets the page detect a Nexus agent is present (no side effects).
    if (req.method === 'GET' && pathname === '/nexus/ping') {
      res.writeHead(200, cors(allow)); res.end(JSON.stringify({ agent: 'greens-nexus' })); return;
    }

    if (req.method === 'GET' && pathname === '/nexus/pair') {
      if (!allow) { res.writeHead(403); res.end('origin not allowed'); return; }
      const nonce = new URL(req.url, `http://127.0.0.1:${PAIR_PORT}`).searchParams.get('nonce') || '';
      const token = getToken();
      if (!token) { res.writeHead(409, cors(allow)); res.end(JSON.stringify({ error: 'agent not enrolled' })); return; }
      try {
        const r = await api.agentPair(token, nonce);   // claim the nonce with the device token
        res.writeHead(200, cors(allow)); res.end(JSON.stringify({ ok: true, deviceId: r.deviceId, deviceName: r.deviceName }));
      } catch (e) {
        if (log) log(`pair failed: ${e.message || e}`);
        res.writeHead(502, cors(allow)); res.end(JSON.stringify({ error: 'pair failed' }));
      }
      return;
    }
    res.writeHead(404, cors(allow)); res.end();
  });
  server.on('error', (e) => { if (log) log(`pair server error: ${e.message || e}`); });
  server.listen(PAIR_PORT, '127.0.0.1', () => { if (log) log(`pair server on 127.0.0.1:${PAIR_PORT}`); });
  return server;
}

module.exports = { startPairServer, PAIR_PORT };
