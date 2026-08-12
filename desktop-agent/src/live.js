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
const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const api = require('./api');

let win = null;                 // hidden renderer running the WebRTC
let current = null;             // { id } of the active session, or null
let getToken = () => null;
let logFn = () => {};
let onLiveChange = () => {};
let checking = false;
let answerTimer = null;

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

async function primarySourceId() {
  // types:['screen'] returns one source per physical display; the primary is the
  // first Electron reports. A tiny thumbnail keeps this lookup cheap (we only want
  // the id - the real frames come from getUserMedia in the renderer).
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  return sources.length ? sources[0].id : null;
}

async function startSession(sess) {
  current = { id: sess.id };
  onLiveChange(true);
  try {
    const sourceId = await primarySourceId();
    if (!sourceId) { logFn('live: no screen source'); stopSession('no-source'); return; }
    ensureWindow();
    sendToWindow('live:start', { id: sess.id, sourceId, iceServers: sess.iceServers, fps: sess.fps });
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
  } catch (e) { logFn(`live poll failed: ${e.message || e}`); }
  if (current && current.id === id) answerTimer = setTimeout(pollAnswer, 1500);
}

function stopSession(reason) {
  if (!current) return;
  const id = current.id;
  current = null;
  if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; }
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

function isLive() { return !!current; }

function init(opts) {
  getToken = opts.getToken || (() => null);
  logFn = opts.log || (() => {});
  onLiveChange = opts.onLiveChange || (() => {});
}

module.exports = { init, checkPending, isLive, stopSession };
