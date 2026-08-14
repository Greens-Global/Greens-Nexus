import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, MonitorSmartphone, X, Radio, MousePointer2, Maximize2, ExternalLink, Paperclip, ZoomIn, ZoomOut } from 'lucide-react';
import { api } from '../api';
import { Avatar } from '../tasks/components';
import { useRole } from '../contexts/RoleContext';
import { usePhotoMap } from '../lib/peoplePhotos';

// Real-time screen view of one clocked-in employee (Discord-style), plus
// consent-based attended remote control. The browser is the WebRTC ANSWERER: we
// ask the server to start a session, the agent posts an offer carrying ONE VIDEO
// TRACK PER SCREEN (primary first) plus a data channel, we answer, and media
// flows peer-to-peer over Cloudflare TURN. Only the screens picked here actually
// send frames (the agent toggles track.enabled on our 'scr' message).
// States: connecting -> live (video) -> break (frozen last frame) / offline.
// Disclosure: the employee's tray shows the live state the whole time; control
// additionally requires their explicit Accept and shows an End Session banner.

const CLIP_MAX = 1024 * 1024;              // clipboard text sync cap, matches the agent
// Effectively "any file". The only reason for a ceiling at all is so a mistaken
// send can't fill the employee's disk; 20 GB clears any real document/archive.
const FILE_MAX = 20 * 1024 * 1024 * 1024;  // file send cap, matches the agent

// Wait for ICE gathering to finish so the single answer SDP carries every
// candidate (non-trickle) - matches the agent side.
function waitIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve(); } };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, 3000);
  });
}

const btnOf = (e) => (e.button === 2 ? 2 : e.button === 1 ? 1 : 0);

// Map a mouse event to normalized 0..1 coordinates on the remote screen,
// accounting for the objectFit:contain letterbox around the video element.
function remoteXYEl(e, v) {
  if (!v || !v.videoWidth || !v.videoHeight) return null;
  const r = v.getBoundingClientRect();
  const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
  const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
  const x = (e.clientX - (r.left + (r.width - dw) / 2)) / dw;
  const y = (e.clientY - (r.top + (r.height - dh) / 2)) / dh;
  if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) return null;   // in the letterbox
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

const hdrBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700,
  padding: '5px 12px', borderRadius: 8, border: '1px solid var(--line)',
  background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer',
};
const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30,
  borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', cursor: 'pointer', color: 'var(--muted)',
};

export default function LiveView({ email, name, onClose }) {
  const { myEmail } = useRole();       // the support person - their avatar rides the control cursor
  const photos = usePhotoMap();
  const myPhoto = myEmail ? photos[myEmail.toLowerCase()] : '';
  const cardRef = useRef(null);        // fullscreen target (whole modal, so controls stay visible)
  const stageWrapRef = useRef(null);   // wheel/drag surface
  const videoEls = useRef({});         // screen index -> <video> element
  const sidRef = useRef(null);         // current session id, for the control buttons
  const channelRef = useRef(null);     // WebRTC data channel (input + clipboard + files)
  const popoutRef = useRef(null);      // popped-out window, if open
  const controlRef = useRef('');       // mirrors `control` for native/popout listeners
  const selRef = useRef(0);
  const streamsRef = useRef([]);
  const remoteClipRef = useRef('');    // last clipboard text that came FROM the remote
  const pendingClipRef = useRef('');   // clip we couldn't write while unfocused

  const [status, setStatus] = useState('connecting');   // connecting|live|break|offline|error
  const [fps, setFps] = useState(60);
  // Remote control: ''|requested|active|declined|ended, mirrored from the server.
  const [control, setControl] = useState('');
  const [screens, setScreens] = useState([]);   // [{i, primary, w, h}] from the agent
  const [streams, setStreams] = useState([]);   // MediaStream per screen, track order
  const [sel, setSel] = useState(0);            // screen index or 'all'
  const [isFs, setIsFs] = useState(false);
  const [popped, setPopped] = useState(false);
  const [fileProg, setFileProg] = useState(null);   // {name, pct} while sending
  const [note, setNote] = useState('');
  const [zoom, setZoom] = useState(1);              // 1..4, single-screen magnify for small displays
  const [cursorPos, setCursorPos] = useState(null); // support cursor overlay position (px in stage)

  useEffect(() => {
    controlRef.current = control;
    // Keep the popout's control bar (Send File / Stop Control) in sync.
    const w = popoutRef.current;
    if (w && !w.closed && typeof w.__syncBar === 'function') { try { w.__syncBar(); } catch (_) { /* ignore */ } }
  }, [control]);
  useEffect(() => { selRef.current = sel; setZoom(1); }, [sel]);
  useEffect(() => { streamsRef.current = streams; }, [streams]);

  const send = useCallback((m) => {
    const ch = channelRef.current;
    if (ch && ch.readyState === 'open') { try { ch.send(JSON.stringify(m)); } catch (_) { /* ignore */ } }
  }, []);

  // Clipboard text arriving from the remote PC (IT copied something over there).
  const receiveClip = useCallback((s) => {
    if (!s) return;
    remoteClipRef.current = s;
    navigator.clipboard.writeText(s).catch(() => { pendingClipRef.current = s; });
  }, []);
  useEffect(() => {
    const onFocus = () => {
      const p = pendingClipRef.current;
      if (p) { pendingClipRef.current = ''; navigator.clipboard.writeText(p).catch(() => {}); }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // ── Session lifecycle (request -> answer -> poll) ───────────────────────────
  useEffect(() => {
    let cancelled = false;
    let pc = null;
    let sid = null;
    let timer = null;
    let answered = false;

    let pollFails = 0;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const closePc = () => {
      try { if (pc) pc.close(); } catch (_) { /* ignore */ }
      pc = null; answered = false; channelRef.current = null;
    };
    // Self-heal: whenever the feed isn't live (the person locked their PC, went on
    // break, walked away, or the connection dropped), tear down and keep trying to
    // reconnect on a timer. The moment they're back and their agent is capturing,
    // begin() succeeds and the video resumes - the admin never has to reload.
    const scheduleRetry = (statusText, delay = 4000) => {
      if (cancelled) return;
      closePc();
      sid = null; sidRef.current = null;
      setControl('');
      setStatus(statusText);
      clearTimer();
      timer = setTimeout(begin, delay);
    };

    async function begin() {
      if (cancelled) return;
      let res;
      try { res = await api.timeLiveRequest(email, fps); }
      catch (_) { scheduleRetry('reconnecting'); return; }
      if (cancelled) return;
      if (!res || !res.ok) {
        // on_break -> frozen frame + "On break"; otherwise offline. Both retry.
        scheduleRetry(res && res.subjectState === 'on_break' ? 'break' : 'offline');
        return;
      }
      pollFails = 0;
      sid = res.sessionId;
      sidRef.current = sid;
      setFps(res.fps || 30);
      setStreams([]);
      pc = new RTCPeerConnection({ iceServers: res.iceServers || [] });
      pc.ontrack = (e) => {
        if (cancelled) return;
        const stream = e.streams && e.streams[0];
        if (!stream) return;
        // Tracks arrive in the agent's source order (primary screen first).
        setStreams((prev) => (prev.some((s) => s.id === stream.id) ? prev : [...prev, stream]));
        setStatus('live');
        // Mobile browsers gate autoplay even for muted video; nudge each element.
        setTimeout(() => Object.values(videoEls.current).forEach((v) => v && v.play && v.play().catch(() => {})), 0);
      };
      // On mobile/cellular, ICE can fail behind CGNAT even with TURN; surface it as
      // an error (with the retry loop) instead of an endless "connecting", and try
      // an ICE restart once before giving up.
      let iceRetried = false;
      pc.oniceconnectionstatechange = () => {
        if (cancelled || !pc) return;
        const st = pc.iceConnectionState;
        if (st === 'failed' && !iceRetried && pc.restartIce) { iceRetried = true; try { pc.restartIce(); } catch (_) { /* ignore */ } }
        else if (st === 'failed') { scheduleRetry('reconnecting'); }   // don't dead-end - reconnect
      };
      // The agent opens the channel with its offer; input over it stays inert
      // until the employee accepts a control request on their PC. Screen picking
      // and the agent's own messages (screen list, clipboard, file acks) flow
      // regardless.
      pc.ondatachannel = (e) => {
        if (!e.channel || e.channel.label !== 'control') return;
        channelRef.current = e.channel;
        e.channel.onmessage = (ev) => {
          let m;
          try { m = JSON.parse(ev.data); } catch (_) { return; }
          if (!m || typeof m.t !== 'string') return;
          if (m.t === 'screens') setScreens(Array.isArray(m.screens) ? m.screens : []);
          else if (m.t === 'clip') receiveClip(String(m.s || '').slice(0, CLIP_MAX));
          else if (m.t === 'file-done') { setFileProg(null); setNote(`Delivered ${m.name} to Downloads\\Nexus Support on their PC.`); }
          else if (m.t === 'file-err') { setFileProg(null); setNote(m.err || 'File transfer failed.'); }
        };
      };
      poll();
    }

    async function poll() {
      if (cancelled || !sid) return;
      let r;
      try { r = await api.timeLivePoll(sid); pollFails = 0; }
      catch (_) {
        // A dead/stale session (e.g. the API restarted, or the agent dropped) would
        // otherwise poll forever - after a few misses, reconnect from scratch.
        pollFails += 1;
        if (pollFails >= 3) { scheduleRetry('reconnecting'); } else { timer = setTimeout(poll, 1500); }
        return;
      }
      if (cancelled) return;
      if (r.state === 'ended') {
        // subject_on_break -> frozen frame + "On break"; anything else
        // (subject_offline, agent_lost, locked PC) -> offline. Both self-heal.
        const reason = r.endedReason || '';
        scheduleRetry(reason.indexOf('on_break') >= 0 ? 'break' : 'offline');
        return;
      }
      setControl(r.controlState || '');
      if (r.offerSdp && pc && !answered && pc.signalingState === 'stable') {
        answered = true;
        try {
          await pc.setRemoteDescription({ type: 'offer', sdp: r.offerSdp });
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          await waitIceGathering(pc);
          if (!cancelled) await api.timeLiveAnswer(sid, pc.localDescription.sdp);
        } catch (_) { answered = false; }
      }
      timer = setTimeout(poll, 1500);
    }

    begin();
    return () => {
      cancelled = true;
      clearTimer();
      closePc();
      sidRef.current = null;
      if (popoutRef.current && !popoutRef.current.closed) { try { popoutRef.current.close(); } catch (_) { /* ignore */ } }
      if (sid) api.timeLiveEnd(sid).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  // Tell the agent which screens should send frames (bandwidth follows the view).
  useEffect(() => {
    if (!screens.length) return;
    const on = sel === 'all' ? screens.map((s) => s.i) : [Math.min(typeof sel === 'number' ? sel : 0, screens.length - 1)];
    send({ t: 'scr', on });
  }, [sel, screens, send]);

  // Bind streams onto whatever video elements are currently mounted.
  const bindVideo = (idx) => (el) => {
    if (el) {
      videoEls.current[idx] = el;
      const s = streams[idx];
      if (s && el.srcObject !== s) { el.srcObject = s; el.play && el.play().catch(() => {}); }
    } else delete videoEls.current[idx];
  };
  useEffect(() => {
    Object.entries(videoEls.current).forEach(([k, el]) => {
      const s = streams[Number(k)];
      if (el && s && el.srcObject !== s) el.srcObject = s;
    });
    const w = popoutRef.current;
    if (w && !w.closed) {
      const v = w.document.getElementById('nx-pop-video');
      const idx = sel === 'all' ? 0 : sel;
      if (v && streams[idx] && v.srcObject !== streams[idx]) v.srcObject = streams[idx];
    }
  }, [streams, sel, popped]);

  // ── Remote control input ────────────────────────────────────────────────────
  const controlling = control === 'active' && status === 'live';

  // One key handler for the modal, fullscreen and the popout. Ctrl+V pushes the
  // local clipboard ahead of the keystroke so paste lands with YOUR clipboard.
  const handleKey = useCallback((e, t) => {
    e.preventDefault();
    const msg = { t, code: e.code, key: e.key, c: e.ctrlKey, a: e.altKey, s: e.shiftKey, m: e.metaKey };
    if (t === 'kd' && e.ctrlKey && !e.altKey && e.code === 'KeyV') {
      navigator.clipboard.readText()
        .then((s) => { if (typeof s === 'string' && s && s !== remoteClipRef.current) send({ t: 'clip', s: s.slice(0, CLIP_MAX) }); })
        .catch(() => {})
        .finally(() => send(msg));
      return;
    }
    send(msg);
  }, [send]);

  // Mouse handlers for a screen tile; `idx` is the remote screen the tile shows.
  const tileMouse = (idx) => (controlling ? {
    onMouseMove: (e) => { const c = remoteXYEl(e, videoEls.current[idx]); if (c) send({ t: 'mv', ...c, s: idx }); },
    onMouseDown: (e) => {
      const c = remoteXYEl(e, videoEls.current[idx]);
      if (!c) return;
      e.preventDefault();
      send({ t: 'mv', ...c, s: idx });
      send({ t: 'dn', b: btnOf(e) });
    },
    onMouseUp: (e) => { if (remoteXYEl(e, videoEls.current[idx])) send({ t: 'up', b: btnOf(e) }); },
    onContextMenu: (e) => e.preventDefault(),
  } : {});

  // Keyboard goes window-level while controlling (no focus juggling); wheel needs
  // a native non-passive listener because React registers wheel as passive.
  useEffect(() => {
    if (!controlling) return undefined;
    const kd = (e) => handleKey(e, 'kd');
    const ku = (e) => handleKey(e, 'ku');
    const wh = (e) => { e.preventDefault(); send({ t: 'wh', dx: e.deltaX, dy: e.deltaY }); };
    window.addEventListener('keydown', kd, true);
    window.addEventListener('keyup', ku, true);
    const stage = stageWrapRef.current;
    if (stage) stage.addEventListener('wheel', wh, { passive: false });
    return () => {
      window.removeEventListener('keydown', kd, true);
      window.removeEventListener('keyup', ku, true);
      if (stage) stage.removeEventListener('wheel', wh);
    };
  }, [controlling, handleKey, send]);

  const requestControl = () => { const id = sidRef.current; if (id) api.timeLiveControlRequest(id).then(() => setControl('requested')).catch(() => {}); };
  const cancelControl = () => { const id = sidRef.current; if (id) api.timeLiveControlCancel(id).then(() => setControl('')).catch(() => {}); };
  const stopControl = () => { const id = sidRef.current; if (id) api.timeLiveControlEnd(id).then(() => setControl('ended')).catch(() => {}); };

  // ── Fullscreen + system-shortcut capture ────────────────────────────────────
  // Fullscreen the WHOLE modal (not just the video) so the header controls -
  // screen picker, Send File, Stop Control, exit - stay reachable. While
  // fullscreen AND controlling, the Keyboard Lock API routes even Ctrl+W /
  // Alt+Tab-class system shortcuts to the remote PC instead of this browser.
  const toggleFullscreen = () => {
    const el = cardRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };
  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  useEffect(() => {
    const kb = navigator.keyboard;
    if (isFs && controlling && kb && kb.lock) kb.lock().catch(() => {});
    else if (kb && kb.unlock) { try { kb.unlock(); } catch (_) { /* ignore */ } }
  }, [isFs, controlling]);

  // ── Popout window ───────────────────────────────────────────────────────────
  // A separate movable/resizable window showing the selected screen (handy on a
  // second monitor). The modal stays open - it owns the session and the polls.
  const openPopout = () => {
    if (popoutRef.current && !popoutRef.current.closed) { popoutRef.current.focus(); return; }
    const w = window.open('', 'nexus-live-view', 'width=1380,height=840');
    if (!w) { setNote('Popup blocked - allow popups for this site to pop out the view.'); return; }
    popoutRef.current = w;
    const d = w.document;
    d.title = `${name} - Live View`;
    d.body.style.cssText = 'margin:0;background:#0b1220;height:100vh;display:flex;flex-direction:column;overflow:hidden;font-family:Inter,system-ui,sans-serif';
    const bar = d.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 14px;background:#0f172a;color:#e2e8f0;font-size:12.5px;font-weight:600;flex:none';
    const label = d.createElement('span');
    label.textContent = `${name} - live screen view`;
    label.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const mkBtn = (text, color) => {
      const b = d.createElement('button');
      b.textContent = text;
      b.style.cssText = `font:inherit;font-size:12px;font-weight:700;cursor:pointer;border-radius:8px;padding:6px 12px;border:1px solid #334155;background:#1e293b;color:${color || '#e2e8f0'}`;
      return b;
    };
    const stage = d.createElement('div');
    stage.style.cssText = 'position:relative;flex:1;min-height:0;overflow:hidden';
    // Zoom wrapper (grows past the stage so it scrolls) - mirrors the modal.
    const vwrap = d.createElement('div');
    vwrap.style.cssText = 'width:100%;height:100%';
    const v = d.createElement('video');
    v.id = 'nx-pop-video';
    v.autoplay = true; v.muted = true; v.playsInline = true;
    v.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
    vwrap.appendChild(v);
    // Support-PFP cursor (hidden until controlling) - the employee's real cursor
    // is already in the stream, so this is the second, larger cursor.
    const cur = d.createElement('div');
    cur.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:6;display:none';
    cur.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))"><path d="M5 3l14 8-6 1.5L9 20z" fill="#2b7fff" stroke="#fff" stroke-width="1.5"/></svg>';
    const ini = ((myEmail || 'IT').split('@')[0].replace(/[^a-z]/gi, '').slice(0, 2) || 'IT').toUpperCase();
    const avaCss = 'position:absolute;left:18px;top:18px;width:34px;height:34px;border-radius:50%;box-shadow:0 0 0 2px #2b7fff,0 2px 6px rgba(0,0,0,.5)';
    const ava = d.createElement(myPhoto ? 'img' : 'div');
    if (myPhoto) { ava.src = myPhoto; ava.style.cssText = avaCss + ';object-fit:cover'; }
    else { ava.textContent = ini; ava.style.cssText = avaCss + ';background:#2b7fff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px'; }
    cur.appendChild(ava);
    // Controls in the popout so you never have to return to the modal.
    const fileBtn = mkBtn('Send File');
    const fsBtn = mkBtn('Full Screen');
    const stopBtn = mkBtn('Stop Control', '#f87171');
    // Zoom controls.
    let popZoom = 1;
    const zLabel = d.createElement('span');
    zLabel.style.cssText = 'font:inherit;font-size:11px;font-weight:700;color:#94a3b8;min-width:36px;text-align:center';
    const applyZoom = () => {
      vwrap.style.width = `${popZoom * 100}%`;
      vwrap.style.height = `${popZoom * 100}%`;
      stage.style.overflow = popZoom > 1 ? 'auto' : 'hidden';
      zLabel.textContent = `${Math.round(popZoom * 100)}%`;
    };
    const zoomOut = mkBtn('−'); const zoomIn = mkBtn('+');
    zoomOut.onclick = () => { popZoom = Math.max(1, +(popZoom - 0.5).toFixed(1)); applyZoom(); };
    zoomIn.onclick = () => { popZoom = Math.min(4, +(popZoom + 0.5).toFixed(1)); applyZoom(); };
    const syncBar = () => {
      const on = controlRef.current === 'active';
      fileBtn.style.display = on ? '' : 'none';
      stopBtn.style.display = on ? '' : 'none';
      stage.style.cursor = on ? 'none' : 'default';
      if (!on) cur.style.display = 'none';
    };
    fileBtn.onclick = () => { const fi = fileInputRef.current; if (fi) fi.click(); };
    stopBtn.onclick = () => stopControl();
    fsBtn.onclick = () => {
      if (d.fullscreenElement) d.exitFullscreen().catch(() => {});
      else stage.requestFullscreen().then(() => {
        if (controlRef.current === 'active' && w.navigator.keyboard && w.navigator.keyboard.lock) w.navigator.keyboard.lock().catch(() => {});
      }).catch(() => {});
    };
    bar.appendChild(label);
    bar.appendChild(zoomOut);
    bar.appendChild(zLabel);
    bar.appendChild(zoomIn);
    bar.appendChild(fileBtn);
    bar.appendChild(fsBtn);
    bar.appendChild(stopBtn);
    stage.appendChild(vwrap);
    stage.appendChild(cur);
    d.body.appendChild(bar);
    d.body.appendChild(stage);
    popoutRef.current.__syncBar = syncBar;
    applyZoom();
    syncBar();
    const idx = () => (selRef.current === 'all' ? 0 : selRef.current);
    const s0 = streamsRef.current[idx()];
    if (s0) v.srcObject = s0;
    const mm = (e) => {
      // Move the support cursor overlay (in content coords, so it tracks scroll).
      if (controlRef.current === 'active') {
        const r = stage.getBoundingClientRect();
        cur.style.left = `${e.clientX - r.left + stage.scrollLeft}px`;
        cur.style.top = `${e.clientY - r.top + stage.scrollTop}px`;
        cur.style.display = 'block';
        const c = remoteXYEl(e, v); if (c) send({ t: 'mv', ...c, s: idx() });
      }
    };
    stage.addEventListener('mouseleave', () => { cur.style.display = 'none'; });
    const md = (e) => {
      if (controlRef.current !== 'active') return;
      const c = remoteXYEl(e, v);
      if (!c) return;
      e.preventDefault();
      send({ t: 'mv', ...c, s: idx() });
      send({ t: 'dn', b: btnOf(e) });
    };
    const mu = (e) => { if (controlRef.current !== 'active') return; if (remoteXYEl(e, v)) send({ t: 'up', b: btnOf(e) }); };
    const cm = (e) => { if (controlRef.current === 'active') e.preventDefault(); };
    const whh = (e) => { if (controlRef.current !== 'active') return; e.preventDefault(); send({ t: 'wh', dx: e.deltaX, dy: e.deltaY }); };
    const kd = (e) => { if (controlRef.current === 'active') handleKey(e, 'kd'); };
    const ku = (e) => { if (controlRef.current === 'active') handleKey(e, 'ku'); };
    stage.addEventListener('mousemove', mm);
    stage.addEventListener('mousedown', md);
    stage.addEventListener('mouseup', mu);
    stage.addEventListener('contextmenu', cm);
    stage.addEventListener('wheel', whh, { passive: false });
    w.addEventListener('keydown', kd, true);
    w.addEventListener('keyup', ku, true);
    w.addEventListener('beforeunload', () => { popoutRef.current = null; setPopped(false); });
    setPopped(true);
  };

  // ── File send (drag-drop or picker, only while controlling) ─────────────────
  const sendFile = useCallback(async (file) => {
    const ch = channelRef.current;
    if (!file || controlRef.current !== 'active' || !ch || ch.readyState !== 'open') return;
    if (file.size > FILE_MAX) { setNote('File is larger than 200MB.'); return; }
    if (fileProg) { setNote('One file at a time - a transfer is already running.'); return; }
    const id = Math.random().toString(36).slice(2);
    setNote('');
    setFileProg({ name: file.name, pct: 0 });
    // Binary chunks straight on the channel (no base64 = 33% fewer bytes and no
    // per-chunk FileReader): a 'fs' header, raw ArrayBuffer chunks in order, then
    // 'fe'. One file at a time, so the ordered channel needs no per-chunk id.
    send({ t: 'fs', id, name: file.name, size: file.size });
    // 16 KB per message. A WebRTC data channel's max message size defaults to 64 KB
    // when the SDP doesn't advertise one, and larger messages get silently
    // truncated/fragmented at the SCTP layer (the file "delivers" but arrives
    // corrupt). 16 KB is the universally-safe size for reliable transfer.
    const CHUNK = 16 * 1024;
    ch.bufferedAmountLowThreshold = 256 * 1024;
    let off = 0;
    try {
      while (off < file.size) {
        if (channelRef.current !== ch || ch.readyState !== 'open' || controlRef.current !== 'active') { setFileProg(null); return; }
        // eslint-disable-next-line no-await-in-loop
        const buf = await file.slice(off, off + CHUNK).arrayBuffer();
        ch.send(buf);
        off += CHUNK;
        setFileProg({ name: file.name, pct: Math.min(99, Math.round((off * 100) / file.size)) });
        // Pace against the send buffer so it never balloons (or overflows Chrome's
        // ~16 MB cap and starts dropping): pause until it drains below the threshold.
        if (ch.bufferedAmount > 4 * 1024 * 1024) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => {
            const onLow = () => { ch.removeEventListener('bufferedamountlow', onLow); r(); };
            ch.addEventListener('bufferedamountlow', onLow);
          });
        }
      }
    } catch (_) { setFileProg(null); setNote('Could not send the file.'); return; }
    send({ t: 'fe', id });
  }, [send, fileProg]);

  const fileInputRef = useRef(null);

  // ── Render ──────────────────────────────────────────────────────────────────
  const overlay = status === 'break'
    ? { text: 'On break', sub: 'Screen paused while this person is on break. Resumes automatically when they’re back.', color: 'hsl(var(--color-orange))' }
    : status === 'offline'
      ? { text: 'Offline', sub: 'Their screen is locked or the agent is unreachable. Reconnects automatically the moment they’re back.', color: 'var(--muted)' }
      : status === 'reconnecting'
        ? { text: 'Reconnecting…', sub: 'The connection dropped (locked PC or network). This resumes on its own - no need to reload.', color: 'var(--muted)', spin: true }
        : status === 'error'
          ? { text: 'Could not connect', sub: 'Live view is unavailable right now.', color: 'hsl(var(--color-red))' }
          : status === 'connecting'
            ? { text: 'Connecting…', sub: 'Waiting for the screen stream.', color: 'var(--muted)', spin: true }
            : null;

  const screenLabel = (s) => `Screen ${s.i + 1}${s.primary ? ' · Primary' : ''}`;
  const showPicker = screens.length > 1;
  const gridMode = sel === 'all' && streams.length > 1;

  const videoTag = (idx, extra) => (
    <video key={idx} ref={bindVideo(idx)} autoPlay muted playsInline
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block',
               filter: status === 'break' ? 'grayscale(0.6) brightness(0.7)' : 'none', ...extra }} />
  );

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(15,23,42,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div ref={cardRef} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: isFs ? 0 : 16, width: '100%', height: isFs ? '100vh' : undefined, maxWidth: isFs ? '100vw' : 'min(1560px, 96vw)', boxShadow: 'var(--shadow-lg, 0 20px 60px rgba(0,0,0,0.4))', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: isFs ? '100vh' : '96vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--line)', flex: 'none' }}>
          <Avatar email={email} name={name} size={28} card={false} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>Live screen view · {fps}fps</div>
          </div>
          {showPicker && (
            <div style={{ display: 'inline-flex', gap: 2, marginLeft: 10, padding: 2, borderRadius: 9, background: 'var(--mist, rgba(148,163,184,0.15))' }}>
              {screens.map((s) => (
                <button key={s.i} onClick={() => setSel(s.i)} title={screenLabel(s)}
                  style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
                           background: sel === s.i ? 'var(--card)' : 'transparent', color: sel === s.i ? 'var(--ink)' : 'var(--muted)' }}>
                  {`Screen ${s.i + 1}`}
                </button>
              ))}
              <button onClick={() => setSel('all')}
                style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
                         background: sel === 'all' ? 'var(--card)' : 'transparent', color: sel === 'all' ? 'var(--ink)' : 'var(--muted)' }}>
                All
              </button>
            </div>
          )}
          <div style={{ flex: 1 }} />
          {status === 'live' && control === 'requested' && (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Waiting for {name.split(' ')[0]} to accept…
              </span>
              <button onClick={cancelControl} style={hdrBtn}>Cancel</button>
            </>
          )}
          {status === 'live' && control === 'active' && (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.12)', padding: '3px 10px', borderRadius: 999 }}>
                <MousePointer2 size={12} /> CONTROLLING
              </span>
              <button onClick={() => fileInputRef.current && fileInputRef.current.click()} title="Send a file to their Downloads\Nexus Support folder" style={hdrBtn}>
                <Paperclip size={13} /> Send File
              </button>
              <button onClick={stopControl} style={{ ...hdrBtn, color: 'hsl(var(--color-red))' }}>Stop Control</button>
            </>
          )}
          {status === 'live' && control !== 'requested' && control !== 'active' && (
            <>
              {control === 'declined' && <span style={{ fontSize: 11, fontWeight: 700, color: 'hsl(var(--color-red))' }}>Declined</span>}
              <button onClick={requestControl} title={`Ask ${name} to allow remote control`} style={hdrBtn}>
                <MousePointer2 size={13} /> Request Control
              </button>
            </>
          )}
          {status === 'live' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, color: 'hsl(var(--color-red))', background: 'hsla(var(--color-red),0.1)', padding: '3px 10px', borderRadius: 999 }}>
              <Radio size={12} /> LIVE
            </span>
          )}
          {status === 'live' && !gridMode && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <button onClick={() => setZoom(z => Math.max(1, +(z - 0.5).toFixed(1)))} disabled={zoom <= 1} title="Zoom out"
                style={{ ...iconBtn, opacity: zoom <= 1 ? 0.4 : 1, cursor: zoom <= 1 ? 'default' : 'pointer' }}>
                <ZoomOut size={15} />
              </button>
              {zoom > 1 && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', minWidth: 30, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>}
              <button onClick={() => setZoom(z => Math.min(4, +(z + 0.5).toFixed(1)))} disabled={zoom >= 4} title="Zoom in"
                style={{ ...iconBtn, opacity: zoom >= 4 ? 0.4 : 1, cursor: zoom >= 4 ? 'default' : 'pointer' }}>
                <ZoomIn size={15} />
              </button>
            </div>
          )}
          <button onClick={toggleFullscreen} title={isFs ? 'Exit Full Screen' : 'Full Screen'} style={iconBtn}>
            <Maximize2 size={15} />
          </button>
          <button onClick={openPopout} title="Open in Its Own Window" style={{ ...iconBtn, ...(popped ? { color: 'hsl(var(--color-blue))' } : {}) }}>
            <ExternalLink size={15} />
          </button>
          <button onClick={onClose} title="Close" style={iconBtn}>
            <X size={16} />
          </button>
        </div>
        <input ref={fileInputRef} type="file" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) sendFile(f); }} />
        <div ref={stageWrapRef}
          onDragOver={controlling ? (e) => e.preventDefault() : undefined}
          onDrop={controlling ? (e) => { e.preventDefault(); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) sendFile(f); } : undefined}
          onMouseMove={controlling ? (e) => {
            const st = stageWrapRef.current; if (!st) return;
            const r = st.getBoundingClientRect();
            setCursorPos({ x: e.clientX - r.left + st.scrollLeft, y: e.clientY - r.top + st.scrollTop });
          } : undefined}
          onMouseLeave={() => setCursorPos(null)}
          style={{ position: 'relative', background: '#0b1220', width: '100%',
                   height: isFs ? 'auto' : 'min(72vh, 860px)', flex: isFs ? 1 : undefined, minHeight: isFs ? 0 : 320,
                   overflow: (!gridMode && zoom > 1) ? 'auto' : 'hidden',
                   // Hide the OS crosshair while controlling - the employee's real
                   // cursor shows in the stream, and we draw the support cursor below.
                   cursor: controlling ? 'none' : 'default',
                   outline: controlling ? '2px solid hsl(var(--color-green))' : 'none', outlineOffset: -2 }}>
          {gridMode ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 6, width: '100%', height: '100%', padding: 6, boxSizing: 'border-box' }}>
              {streams.map((_, idx) => (
                <div key={idx} {...tileMouse(idx)} style={{ position: 'relative', background: '#020617', borderRadius: 8, overflow: 'hidden', minHeight: 0 }}>
                  {videoTag(idx)}
                  <span style={{ position: 'absolute', top: 6, left: 8, fontSize: 10.5, fontWeight: 700, color: '#cbd5e1', background: 'rgba(2,6,23,0.7)', padding: '2px 8px', borderRadius: 999 }}>
                    {screens[idx] ? screenLabel(screens[idx]) : `Screen ${idx + 1}`}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            // Zoom magnifies by growing the wrapper past the stage so it scrolls
            // (transform scale wouldn't create scrollable overflow). Control coords
            // stay correct - remoteXY reads the video's live rect.
            <div {...tileMouse(sel === 'all' ? 0 : sel)} style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}>
              {videoTag(sel === 'all' ? 0 : Math.min(typeof sel === 'number' ? sel : 0, Math.max(0, streams.length - 1)))}
            </div>
          )}
          {controlling && cursorPos && (
            <div style={{ position: 'absolute', left: cursorPos.x, top: cursorPos.y, pointerEvents: 'none', zIndex: 6 }}>
              <MousePointer2 size={26} style={{ color: '#fff', fill: 'hsl(var(--color-blue))', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.55))' }} />
              <div style={{ position: 'absolute', left: 18, top: 18, borderRadius: '50%', boxShadow: '0 0 0 2px hsl(var(--color-blue)), 0 2px 6px rgba(0,0,0,0.5)' }}>
                <Avatar email={myEmail} size={34} card={false} />
              </div>
            </div>
          )}
          {overlay && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, textAlign: 'center', padding: 24 }}>
              {overlay.spin
                ? <Loader2 size={26} style={{ color: '#cbd5e1', animation: 'spin 1s linear infinite' }} />
                : <MonitorSmartphone size={26} style={{ color: overlay.color }} />}
              <div style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0' }}>{overlay.text}</div>
              <div style={{ fontSize: 12, color: '#94a3b8', maxWidth: 360, lineHeight: 1.5 }}>{overlay.sub}</div>
            </div>
          )}
        </div>
        {(fileProg || note) && (
          <div style={{ padding: '7px 16px', fontSize: 11.5, fontWeight: 600, color: 'var(--ink)', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
            {fileProg ? (
              <>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />
                <span>Sending {fileProg.name}… {fileProg.pct}%</span>
                <span style={{ flex: 1, height: 4, borderRadius: 999, background: 'var(--mist, rgba(148,163,184,0.2))', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: '100%', background: 'hsl(var(--color-blue))',
                    transform: `scaleX(${fileProg.pct / 100})`, transformOrigin: 'left', transition: 'transform 0.2s' }} />
                </span>
              </>
            ) : <span style={{ color: 'var(--muted)' }}>{note}</span>}
          </div>
        )}
        <div style={{ padding: '9px 16px', fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--line)', lineHeight: 1.5 }}>
          Disclosed monitoring - live viewing is covered in the employee's privacy policy, terms of service, and employment agreement. Remote control additionally requires the employee's explicit acceptance on their PC, shows them a persistent banner they can end at any time, and every session is recorded in the monitoring audit log. While controlling: drag a file onto the screen to copy it over, copy/paste text works both ways, and full screen also sends system shortcuts to their PC.
        </div>
      </div>
    </div>
  );
}
