// ── Live screen view (agent side) ─────────────────────────────────────────────
// On demand, a manager watches this PC's screen in real time. WebRTC does the
// streaming, but RTCPeerConnection / getUserMedia are DOM APIs - they can't run
// in the main process. So this module owns a HIDDEN renderer window that does the
// actual capture + peer connection, while main handles the signaling relay to the
// Nexus backend (the browser can't reach us over localhost, so the offer/answer
// pass through the server's LiveSession mailbox).
//
// Disclosure: while a session is live the tray flips to "Live view active" (via
// onLiveChange) - the employee always sees when someone is actually watching.
// A session only ever starts while the person is clocked in and not on break;
// the server re-gates every poll and tells us to stop the instant that changes.

const path = require('path');
const { BrowserWindow, desktopCapturer, ipcMain, screen } = require('electron');
const api = require('./api');
const control = require('./control');

let win = null;                 // hidden renderer running the WebRTC
let current = null;             // { id } of the active session, or null
let getToken = () => null;
let logFn = () => {};
let onLiveChange = () => {};
let onControlChange = () => {};
let checking = false;
let answerTimer = null;
let controlState = '';          // server-relayed: '' | requested | active | declined | ended

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false, width: 320, height: 240,
    // Local, bundled page only - no remote content is ever loaded here, so node
    // integration in this hidden trusted window is acceptable and keeps the
    // capture/WebRTC glue simple (it talks to main over ipcRenderer directly).
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'live-window.html'));
  return win;
}

function sendToWindow(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents) {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => win.webContents.send(channel, payload));
    } else {
      win.webContents.send(channel, payload);
    }
  }
}

async function screenSources() {
  // types:['screen'] returns one source per physical display. Pair each with its
  // Electron Display (matched by display_id) so remote-control input can be mapped
  // onto that display's slice of the virtual desktop. Primary display first, so
  // screen index 0 always means the main screen for the viewer. A tiny thumbnail
  // keeps the lookup cheap - real frames come from getUserMedia in the renderer.
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  const displays = screen.getAllDisplays();
  const primaryId = String(screen.getPrimaryDisplay().id);
  const list = sources.map((s) => {
    const d = displays.find((x) => String(x.id) === String(s.display_id)) || null;
    return {
      sourceId: s.id,
      primary: d ? String(d.id) === primaryId : false,
      bounds: d ? d.bounds : null,           // DIP coords in the virtual desktop
    };
  });
  list.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
  return list;
}

async function startSession(sess) {
  current = { id: sess.id };
  controlState = '';
  onLiveChange(true);
  try {
    const sources = await screenSources();
    if (!sources.length) { logFn('live: no screen source'); stopSession('no-source'); return; }
    control.setDisplays(sources);
    ensureWindow();
    sendToWindow('live:start', {
      id: sess.id, iceServers: sess.iceServers, fps: sess.fps,
      sources: sources.map((s, i) => ({ sourceId: s.sourceId, i, primary: s.primary,
        w: s.bounds ? s.bounds.width : 0, h: s.bounds ? s.bounds.height : 0 })),
    });
    pollAnswer();
  } catch (e) { logFn(`live start failed: ${e.message || e}`); stopSession('start-error'); }
}

// Poll the server for the viewer's answer + the end signal, ~every 1.5s. Doubles
// as the agent-side keepalive so the server knows we're still streaming.
async function pollAnswer() {
  if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; }
  if (!current) return;
  const id = current.id;
  try {
    const r = await api.agentLivePoll(getToken(), id);
    if (!current || current.id !== id) return;
    if (r.state === 'ended') { stopSession(r.endedReason || 'ended'); return; }
    if (r.answerSdp) sendToWindow('live:answer', { id, sdp: r.answerSdp });
    handleControl(id, r.controlState || '', r.requesterName || '');
  } catch (e) { logFn(`live poll failed: ${e.message || e}`); }
  if (current && current.id === id) answerTimer = setTimeout(pollAnswer, 1500);
}

// ── Attended remote control state machine ─────────────────────────────────────
// Driven entirely by the server-relayed control_state on the ~1.5s poll. The
// employee's Accept is required before anything is injected; every exit path
// (decline, either side ending it, session teardown) lands in teardownControl.
function handleControl(id, next, requesterName) {
  if (!current || current.id !== id || next === controlState) return;
  const prev = controlState;
  controlState = next;
  if (next === 'requested') {
    logFn(`control requested by ${requesterName} (session ${id})`);
    control.showConsent(requesterName, async (accepted) => {
      if (!current || current.id !== id) return;
      logFn(`control ${accepted ? 'accepted' : 'declined'} by employee (session ${id})`);
      try { await api.agentLiveControl(getToken(), id, accepted ? 'accept' : 'decline'); }
      catch (e) { logFn(`control response failed: ${e.message || e}`); }
    });
  } else if (next === 'active') {
    control.closeConsent();
    control.start(requesterName, {
      onEnd: async () => {
        // Employee hit End Session on the banner: kill injection immediately,
        // then tell the server (the viewer learns on its next poll).
        teardownControl(id, 'employee ended');
        controlState = 'ended';
        try { await api.agentLiveControl(getToken(), id, 'end'); } catch (_) { /* poll re-syncs */ }
      },
      // Agent -> viewer messages (clipboard changes, file acks) ride the same
      // data channel, sent from the renderer that owns it.
      send: (m) => sendToWindow('control:tx', { id, m }),
    });
    sendToWindow('control:enable', { id });
    onControlChange(true);
    logFn(`control active (session ${id})`);
  } else {
    control.closeConsent();
    if (prev === 'active') teardownControl(id, next || 'cleared');
  }
}

function teardownControl(id, reason) {
  control.stop();
  sendToWindow('control:disable', { id });
  onControlChange(false);
  logFn(`control ended (session ${id}, ${reason})`);
}

function stopSession(reason) {
  if (!current) return;
  const id = current.id;
  current = null;
  if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; }
  control.closeConsent();
  if (controlState === 'active') teardownControl(id, `session ${reason}`);
  controlState = '';
  sendToWindow('live:stop', { id });
  logFn(`live session ${id} stopped (${reason})`);
  onLiveChange(false);
}

// Called frequently by main WHILE CLOCKED IN: has a manager asked to watch? The
// server returns a session (with fresh TURN creds) only when a request is waiting
// and the shift is still live, so a poll while nobody's watching is a cheap no-op.
async function checkPending() {
  if (checking || current) return;
  const token = getToken();
  if (!token) return;
  checking = true;
  try {
    const r = await api.agentLivePending(token);
    if (r && r.session) { logFn(`live request received (session ${r.session.id})`); await startSession(r.session); }
  } catch (e) { /* offline / transient - try again next tick */ }
  finally { checking = false; }
}

// The renderer reports the offer it built, its RTC connection state, and teardown.
ipcMain.on('live:offer', async (_e, { id, sdp }) => {
  if (!current || current.id !== id) return;
  try { await api.agentLiveOffer(getToken(), id, sdp); }
  catch (e) { logFn(`live offer post failed: ${e.message || e}`); stopSession('offer-post-failed'); }
});
ipcMain.on('live:rtcstate', (_e, { id, state }) => {
  if (current && current.id === id) logFn(`live ${id} rtc ${state}`);
});
ipcMain.on('live:ended', (_e, { id }) => { if (current && current.id === id) stopSession('rtc-closed'); });

// Viewer input arriving over the data channel (relayed by the hidden renderer).
// Injected ONLY while the employee-accepted control session is active - the
// control module drops everything otherwise, and so does this gate.
ipcMain.on('live:input', (_e, { id, m }) => {
  if (current && current.id === id && controlState === 'active') control.inject(m);
});
// Binary file chunk from the viewer (separate channel event from JSON input).
ipcMain.on('live:filechunk', (_e, { id, buf }) => {
  if (current && current.id === id && controlState === 'active') control.fileChunkBin(buf);
});

function isLive() { return !!current; }

function init(opts) {
  getToken = opts.getToken || (() => null);
  logFn = opts.log || (() => {});
  onLiveChange = opts.onLiveChange || (() => {});
  onControlChange = opts.onControlChange || (() => {});
  control.init({ log: logFn });
}

module.exports = { init, checkPending, isLive, stopSession };
