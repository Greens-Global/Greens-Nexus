// ── Live screen view (renderer) ───────────────────────────────────────────────
// Runs in the hidden helper window. Captures the primary screen and offers it to
// the manager's browser over WebRTC. Non-trickle ICE: we wait for gathering to
// finish so the single offer SDP carries every candidate, which keeps signaling
// to one offer + one answer through the server mailbox (no candidate stream).

const { ipcRenderer } = require('electron');

let pc = null;
let stream = null;
let curId = null;

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
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ }
  stream = null;
  curId = null;
}

async function start({ id, sourceId, iceServers, fps }) {
  await stop();
  curId = id;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: fps || 30,
        },
      },
    });
  } catch (e) {
    ipcRenderer.send('live:ended', { id });
    return;
  }
  if (curId !== id) { return; }   // a stop/replace raced in while we awaited

  pc = new RTCPeerConnection({ iceServers: iceServers || [] });
  for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);
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
