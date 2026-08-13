import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, MonitorSmartphone, X, Radio, MousePointer2, Maximize2, ExternalLink, Paperclip } from 'lucide-react';
import { api } from '../api';
import { Avatar } from '../tasks/components';

// Real-time screen view of one clocked-in employee (Discord-style), plus
// consent-based attended remote control. The browser is the WebRTC ANSWERER: we
// ask the server to start a session, the agent posts an offer carrying ONE VIDEO
// TRACK PER SCREEN (primary first) plus a data channel, we answer, and media
// flows peer-to-peer over Cloudflare TURN. Only the screens picked here actually
// send frames (the agent toggles track.enabled on our 'scr' message).
// States: connecting -> live (video) -> break (frozen last frame) / offline.
// Disclosure: the employee's tray shows the live state the whole time; control
// additionally requires their explicit Accept and shows an End Session banner.

const CLIP_MAX = 1024 * 1024;         // clipboard text sync cap, matches the agent
const FILE_MAX = 200 * 1024 * 1024;   // file send cap, matches the agent

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
  const stageWrapRef = useRef(null);   // fullscreen target + wheel/drag surface
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

  useEffect(() => { controlRef.current = control; }, [control]);
  useEffect(() => { selRef.current = sel; }, [sel]);
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

    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const closePc = () => {
      try { if (pc) pc.close(); } catch (_) { /* ignore */ }
      pc = null; answered = false; channelRef.current = null;
    };

    async function begin() {
      if (cancelled) return;
      let res;
      try { res = await api.timeLiveRequest(email, fps); }
      catch (_) { if (!cancelled) { setStatus('error'); } return; }
      if (cancelled) return;
      if (!res || !res.ok) {
        setStatus(res && res.subjectState === 'on_break' ? 'break' : 'offline');
        timer = setTimeout(begin, 4000);   // retry so it goes live when they return
        return;
      }
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
      try { r = await api.timeLivePoll(sid); }
      catch (_) { timer = setTimeout(poll, 1500); return; }
      if (cancelled) return;
      if (r.state === 'ended') {
        closePc();
        const reason = r.endedReason || '';
        // Keep the last video frame on screen; overlay the reason. subject_on_break
        // -> "On break"; anything else (subject_offline, agent_lost) -> offline.
        setStatus(reason.indexOf('on_break') >= 0 ? 'break' : 'offline');
        sid = null;
        sidRef.current = null;
        setControl('');
        timer = setTimeout(begin, 4000);
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
      if (s && el.srcObject !== s) el.srcObject = s;
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
  // While fullscreen AND controlling, the Keyboard Lock API routes even Ctrl+W /
  // Alt+Tab-class shortcuts to the remote PC instead of this browser.
  const toggleFullscreen = () => {
    const el = stageWrapRef.current;
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
    bar.textContent = `${name} - live screen view`;
    const stage = d.createElement('div');
    stage.style.cssText = 'position:relative;flex:1;min-height:0';
    const v = d.createElement('video');
    v.id = 'nx-pop-video';
    v.autoplay = true; v.muted = true; v.playsInline = true;
    v.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
    stage.appendChild(v);
    d.body.appendChild(bar);
    d.body.appendChild(stage);
    const idx = () => (selRef.current === 'all' ? 0 : selRef.current);
    const s0 = streamsRef.current[idx()];
    if (s0) v.srcObject = s0;
    const mm = (e) => { if (controlRef.current !== 'active') return; const c = remoteXYEl(e, v); if (c) send({ t: 'mv', ...c, s: idx() }); };
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
    send({ t: 'fs', id, name: file.name, size: file.size });
    const CHUNK = 48 * 1024;
    let off = 0;
    while (off < file.size) {
      if (channelRef.current !== ch || ch.readyState !== 'open' || controlRef.current !== 'active') { setFileProg(null); return; }
      const slice = file.slice(off, off + CHUNK);
      // eslint-disable-next-line no-await-in-loop
      const b64 = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(',')[1] || '');
        fr.onerror = rej;
        fr.readAsDataURL(slice);
      }).catch(() => null);
      if (b64 == null) { setFileProg(null); setNote('Could not read the file.'); return; }
      try { ch.send(JSON.stringify({ t: 'fc', id, d: b64 })); } catch (_) { setFileProg(null); return; }
      off += CHUNK;
      setFileProg({ name: file.name, pct: Math.min(99, Math.round((off * 100) / file.size)) });
      // Backpressure: don't let the channel buffer balloon past ~4MB.
      // eslint-disable-next-line no-await-in-loop
      while (ch.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 50));
    }
    send({ t: 'fe', id });
  }, [send, fileProg]);

  const fileInputRef = useRef(null);

  // ── Render ──────────────────────────────────────────────────────────────────
  const overlay = status === 'break'
    ? { text: 'On break', sub: 'Screen paused while this person is on break.', color: 'hsl(var(--color-orange))' }
    : status === 'offline'
      ? { text: 'Offline', sub: 'This person is not clocked in, or their agent is not reachable.', color: 'var(--muted)' }
      : status === 'error'
        ? { text: 'Could not connect', sub: 'Live view is unavailable right now.', color: 'hsl(var(--color-red))' }
        : status === 'connecting'
          ? { text: 'Connecting…', sub: 'Waiting for the screen stream.', color: 'var(--muted)' }
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'min(1560px, 96vw)', boxShadow: 'var(--shadow-lg, 0 20px 60px rgba(0,0,0,0.4))', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '96vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
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
          style={{ position: 'relative', background: '#0b1220', width: '100%',
                   height: isFs ? '100%' : 'min(72vh, 860px)', minHeight: 320,
                   cursor: controlling ? 'crosshair' : 'default',
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
            <div {...tileMouse(sel === 'all' ? 0 : sel)} style={{ width: '100%', height: '100%' }}>
              {videoTag(sel === 'all' ? 0 : Math.min(typeof sel === 'number' ? sel : 0, Math.max(0, streams.length - 1)))}
            </div>
          )}
          {overlay && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, textAlign: 'center', padding: 24 }}>
              {status === 'connecting'
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
                  <span style={{ display: 'block', height: '100%', width: `${fileProg.pct}%`, background: 'hsl(var(--color-blue))', transition: 'width 0.2s' }} />
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
