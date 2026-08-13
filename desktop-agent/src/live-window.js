// ── Live screen view (renderer) ───────────────────────────────────────────────
// Runs in the hidden helper window. Captures EVERY display and offers them to
// the manager's browser over one WebRTC connection - one video track per screen,
// added in source order (primary first) so the viewer can map tracks to screens
// by m-line order. Only the screens the viewer asks for actually send frames
// (track.enabled), so a single-screen watch costs single-screen bandwidth.
// Non-trickle ICE: we wait for gathering to finish so the single offer SDP
// carries every candidate, which keeps signaling to one offer + one answer
// through the server mailbox (no candidate stream).

const { ipcRenderer } = require('electron');

let pc = null;
let streams = [];           // one MediaStream per captured display, source order
let tracks = [];            // the video track of each, same order
let channel = null;
let screenMeta = [];        // [{i, primary, w, h}] shared with the viewer on open
let curId = null;
let inputEnabled = false;   // set by main ONLY while employee-accepted control is active

function waitIceGathering(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { peer.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (peer.iceGatheringState === 'complete') done(); };
    peer.addEventListener('icegatheringstatechange', check);
    // Don't block forever if a candidate source hangs - relay candidates are
    // usually in well under a second; ship what we have after 3s.
    setTimeout(resolve, 3000);
  });
}

async function stop() {
  try { if (pc) pc.close(); } catch (_) { /* ignore */ }
  pc = null;
  channel = null;
  for (const s of streams) { try { s.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ } }
  streams = [];
  tracks = [];
  screenMeta = [];
  curId = null;
  inputEnabled = false;
}

async function captureSource(sourceId, fps) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: fps || 60,
      },
    },
  });
}

async function start({ id, sources, iceServers, fps }) {
  await stop();
  curId = id;
  for (const src of sources || []) {
    try {
      const stream = await captureSource(src.sourceId, fps);
      streams.push(stream);
      tracks.push(stream.getVideoTracks()[0] || null);
      screenMeta.push({ i: screenMeta.length, primary: !!src.primary, w: src.w || 0, h: src.h || 0 });
    } catch (_) { /* a display that refuses capture is skipped, the rest still stream */ }
  }
  if (curId !== id) return;   // a stop/replace raced in while we awaited
  if (!tracks.filter(Boolean).length) { ipcRenderer.send('live:ended', { id }); return; }

  pc = new RTCPeerConnection({ iceServers: iceServers || [] });
  // Remote-support channel, created BEFORE the offer so it rides the original
  // offer/answer (no renegotiation). It exists on every session but input is
  // inert: messages are forwarded to main only while control:enable is set,
  // i.e. only after the employee accepted the consent prompt AND the server
  // went active. Screen selection ('scr') is view config, not input - it works
  // without control, matching the already-disclosed live view scope.
  channel = pc.createDataChannel('control', { ordered: true });
  channel.onopen = () => {
    try { channel.send(JSON.stringify({ t: 'screens', screens: screenMeta })); } catch (_) { /* ignore */ }
  };
  channel.onmessage = (ev) => {
    // Binary = a file chunk (viewer -> this PC). Only accept while control is
    // active; forward the bytes to main to append to the open file.
    if (typeof ev.data !== 'string') {
      if (inputEnabled && curId === id) ipcRenderer.send('live:filechunk', { id, buf: Buffer.from(ev.data) });
      return;
    }
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'scr') {
      // Viewer picked which screens should send frames right now.
      const on = Array.isArray(m.on) ? m.on : [0];
      tracks.forEach((t, i) => { if (t) t.enabled = on.includes(i); });
      return;
    }
    if (!inputEnabled || curId !== id) return;
    ipcRenderer.send('live:input', { id, m });
  };

  // Default: only the primary screen streams until the viewer asks for more.
  tracks.forEach((t, i) => { if (t) t.enabled = i === 0; });
  streams.forEach((stream, i) => { if (tracks[i]) pc.addTrack(tracks[i], stream); });

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    ipcRenderer.send('live:rtcstate', { id, state: pc.connectionState });
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      ipcRenderer.send('live:ended', { id });
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc);
  if (curId === id && pc && pc.localDescription) {
    ipcRenderer.send('live:offer', { id, sdp: pc.localDescription.sdp });
  }
}

async function applyAnswer({ id, sdp }) {
  if (!pc || id !== curId) return;
  if (pc.signalingState !== 'have-local-offer') return;   // already answered
  try { await pc.setRemoteDescription({ type: 'answer', sdp }); } catch (_) { /* ignore */ }
}

ipcRenderer.on('live:start', (_e, m) => { start(m); });
ipcRenderer.on('live:answer', (_e, m) => { applyAnswer(m); });
ipcRenderer.on('live:stop', () => { stop(); });
ipcRenderer.on('control:enable', (_e, { id }) => { if (id === curId) inputEnabled = true; });
ipcRenderer.on('control:disable', () => { inputEnabled = false; });
// Agent -> viewer messages (clipboard sync, file acks) from main, out the channel.
ipcRenderer.on('control:tx', (_e, { id, m }) => {
  if (id !== curId || !channel || channel.readyState !== 'open') return;
  try { channel.send(JSON.stringify(m)); } catch (_) { /* ignore */ }
});
