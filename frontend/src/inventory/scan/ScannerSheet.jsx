// Items phase 4 - the camera scanner (lazy: its own chunk; jsqr behind it
// only for a browser with no BarcodeDetector, such as iPhone Safari).
//
// A sheet (full screen on a phone) with the live back camera, a frame to aim
// at, the torch where the camera has one, and "Type a Serial" for when the
// camera cannot be used. The camera stops on every way out: close, unmount,
// and the tab going to the background (it comes back on return).
// A code is matched to an item (resolve.js); a match closes the scanner and
// opens the item, anything else says so calmly and offers Scan Again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Flashlight, FlashlightOff, Keyboard, ScanLine, Lock, CameraOff, Search } from 'lucide-react';
import { Modal } from '../../tasks/components';
import { btn, NX } from '../../tasks/theme';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { cameraSupport, startCamera, stopStream, videoTrack, torchSupported, setTorch, cameraErrorKind, cameraHelp } from './camera';
import { createDecoder, startScanLoop } from './decoder';
import { resolveScannedCode, searchItems } from './resolve';
import { openPlace } from '../../maintenance/placeLink';

const fetchByCodeDefault = (code) => api.getItemByCode(code);
// A site or equipment tag (Scan to Request, 11/03/2026): its sheet in Tickets.
const defaultPlace = (r) => openPlace(r.propertyId, r.assetId);

/**
 * props: items (what the screen holds), onFound(item), onClose,
 * onPlace({ propertyId, assetId }) for a site / equipment tag (default: open
 * its sheet in Tickets), and for tests: deps { startCamera, createDecoder,
 * fetchByCode, support }.
 */
export default function ScannerSheet({ items = [], onFound, onPlace, onClose, deps = {} }) {
  const open = deps.startCamera || startCamera;
  const makeDecoder = deps.createDecoder || createDecoder;
  const fetchByCode = deps.fetchByCode || fetchByCodeDefault;
  const support = deps.support || cameraSupport();

  // phase: starting | live | resolving | result | camera-error | manual
  const [phase, setPhase] = useState(support === 'ok' ? 'starting' : 'camera-error');
  const [cameraIssue, setCameraIssue] = useState(support === 'ok' ? '' : support);
  const [result, setResult] = useState(null);       // a resolve result that is not "found"
  const [torch, setTorchState] = useState({ supported: false, on: false });
  const [typed, setTyped] = useState('');
  const [typedBusy, setTypedBusy] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const loopRef = useRef(null);
  const decoderRef = useRef(null);
  const wantCamera = useRef(support === 'ok');
  const runId = useRef(0);

  const stopAll = useCallback(() => {
    runId.current += 1;
    loopRef.current?.stop(); loopRef.current = null;
    stopStream(streamRef.current); streamRef.current = null;
    if (videoRef.current) { try { videoRef.current.srcObject = null; } catch { /* detached */ } }
    setTorchState({ supported: false, on: false });
  }, []);

  const handleCode = useCallback(async (code) => {
    setPhase('resolving');
    const id = runId.current;
    const r = await resolveScannedCode(code, { items, fetchByCode });
    if (id !== runId.current) return;   // closed or restarted while the lookup ran
    // The camera goes off either way: an item opens, or the answer is read
    // with the light off and Scan Again starts it fresh.
    stopAll();
    if (r.status === 'found') { onFound?.(r.item); return; }
    if (r.status === 'place') { (onPlace || defaultPlace)(r); return; }
    setResult({ ...r, raw: code });
    setPhase('result');
  }, [items, fetchByCode, onFound, onPlace, stopAll]);

  const begin = useCallback(async () => {
    stopAll();
    const id = runId.current;
    setResult(null); setPhase('starting'); setCameraIssue('');
    let stream;
    try { stream = await open(); } catch (e) {
      if (id !== runId.current) return;
      setCameraIssue(cameraErrorKind(e)); setPhase('camera-error'); return;
    }
    if (id !== runId.current) { stopStream(stream); return; }
    streamRef.current = stream;
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      try { await video.play?.(); } catch { /* autoplay with muted + playsInline normally works */ }
    }
    const track = videoTrack(stream);
    setTorchState({ supported: torchSupported(track), on: false });
    try {
      if (!decoderRef.current) decoderRef.current = await makeDecoder();
    } catch {
      if (id !== runId.current) return;
      stopAll(); setCameraIssue('error'); setPhase('camera-error'); return;
    }
    if (id !== runId.current) return;
    setPhase('live');
    loopRef.current = startScanLoop({ decode: decoderRef.current.decode, source: video, onCode: handleCode });
  }, [open, makeDecoder, handleCode, stopAll]);

  // Start once; stop on unmount.
  useEffect(() => {
    if (wantCamera.current) begin();
    return () => stopAll();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The tab goes to the background: put the camera away; back again: resume.
  useEffect(() => {
    const onVis = () => {
      // A lookup in flight is dropped too (stopAll moves runId on, so its
      // answer is ignored) and it pauses - returning starts a clean scan
      // instead of "Finding the item..." forever (review M2).
      if (document.visibilityState === 'hidden') { stopAll(); if (phase === 'live' || phase === 'starting' || phase === 'resolving') setPhase('paused'); }
      else if (phase === 'paused' && wantCamera.current) begin();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [phase, begin, stopAll]);

  const close = () => { wantCamera.current = false; stopAll(); onClose?.(); };
  const scanAgain = () => { wantCamera.current = true; begin(); };
  const toManual = () => { wantCamera.current = false; stopAll(); setPhase('manual'); };
  const toggleTorch = async () => {
    const track = videoTrack(streamRef.current);
    if (!track) return;
    try { await setTorch(track, !torch.on); setTorchState((t) => ({ ...t, on: !t.on })); } catch { setTorchState({ supported: false, on: false }); }
  };
  const findTyped = async (text) => {
    const code = String(text ?? typed).trim();
    if (!code) return;
    setTypedBusy(true);
    const r = await resolveScannedCode(code, { items, fetchByCode });
    setTypedBusy(false);
    if (r.status === 'found') { stopAll(); onFound?.(r.item); return; }
    if (r.status === 'place') { stopAll(); (onPlace || defaultPlace)(r); return; }
    setResult({ ...r, raw: code });
  };

  const matches = phase === 'manual' ? searchItems(items, typed) : [];
  const help = cameraHelp(cameraIssue);
  const cameraShown = phase === 'starting' || phase === 'live' || phase === 'resolving' || phase === 'paused';

  const footer = (
    <>
      {phase !== 'manual' && phase !== 'camera-error' && (
        <button type="button" style={{ ...btn('outline'), marginRight: 'auto' }} onClick={toManual}>
          <Keyboard size={14} /> Type a Serial
        </button>
      )}
      {phase === 'manual' && support === 'ok' && (
        <button type="button" style={{ ...btn('outline'), marginRight: 'auto' }} onClick={scanAgain}>
          <ScanLine size={14} /> Use the Camera
        </button>
      )}
      {torch.supported && phase === 'live' && (
        <button type="button" style={btn('outline')} onClick={toggleTorch} aria-pressed={torch.on}>
          {torch.on ? <FlashlightOff size={14} /> : <Flashlight size={14} />} {torch.on ? 'Light Off' : 'Light On'}
        </button>
      )}
      <button type="button" style={btn('ghost')} onClick={close}>Close</button>
    </>
  );

  return (
    <Modal title="Scan an Item" onClose={close} footer={footer} width={520} minHeight="70vh" zIndex={4300}>
      {/* The camera: a dark frame with the aiming square. The video stays
          mounted while it can be used so the stream has somewhere to play. */}
      <div className="nx-fill" style={{ position: 'relative', flex: 1, minHeight: 280, borderRadius: 14, overflow: 'hidden', background: '#0b0d12',
        display: cameraShown ? 'block' : 'none' }}>
        <video ref={videoRef} muted playsInline autoPlay aria-label="Camera" data-testid="nx-scan-video"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ width: 'min(64%, 260px)', aspectRatio: '1 / 1', borderRadius: 18, boxShadow: '0 0 0 9999px rgba(0,0,0,0.38)', outline: '2px solid rgba(255,255,255,0.9)', outlineOffset: -2 }} />
        </div>
        <div role="status" style={{ position: 'absolute', left: 0, right: 0, bottom: 16, textAlign: 'center', color: '#fff', fontSize: 14, fontWeight: 600, textShadow: '0 1px 3px rgba(0,0,0,.6)', padding: '0 16px' }}>
          {phase === 'starting' && <><Spinner size="inline" color="#fff" /> Starting the camera...</>}
          {phase === 'live' && 'Point the camera at the QR tag on the item'}
          {phase === 'resolving' && <><Spinner size="inline" color="#fff" /> Finding the item...</>}
          {phase === 'paused' && 'The camera is paused'}
        </div>
      </div>

      {phase === 'result' && result && <ScanResult result={result} onAgain={support === 'ok' ? scanAgain : null} onType={toManual} onPick={(i) => onFound?.(i)} />}

      {phase === 'camera-error' && (
        <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 2px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 38, height: 38, borderRadius: 12, background: 'hsla(var(--color-orange),0.12)', color: 'hsl(var(--color-orange))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><CameraOff size={19} /></span>
            <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>{help.title}</div>
          </div>
          <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: NX.dim, lineHeight: 1.5 }}>
            {help.steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {cameraIssue !== 'nocamera' && cameraIssue !== 'unsupported' && cameraIssue !== 'insecure' && (
              <button type="button" style={btn('primary')} onClick={scanAgain}>Try Again</button>
            )}
            <button type="button" style={btn('outline')} onClick={toManual}><Keyboard size={14} /> Type a Serial</button>
          </div>
        </div>
      )}

      {phase === 'manual' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label htmlFor="nx-scan-typed" style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>Serial or Item Name</label>
          {/* data-nx-noguard: the serial box is a lookup, not work - typing in it
              must not mark the sheet dirty, or opening the item it finds (a
              nexus:navigate while this sheet is still mounted) asks "Discard
              Unsaved Changes?" first (release smoke, 11/02/2026). */}
          <form data-nx-noguard onSubmit={(e) => { e.preventDefault(); findTyped(); }} style={{ display: 'flex', gap: 8 }}>
            <input id="nx-scan-typed" className="form-input" value={typed} autoFocus autoComplete="off" autoCapitalize="characters"
              placeholder="e.g. GG-00042" onChange={(e) => { setTyped(e.target.value); setResult(null); }}
              style={{ flex: 1, minWidth: 0, fontSize: /* type-ok: iOS zooms a field under 16px */ 16 }} />
            <button type="submit" style={btn('primary')} disabled={!typed.trim() || typedBusy}>
              {typedBusy ? <Spinner size="inline" color="#fff" /> : <Search size={14} />} Find
            </button>
          </form>
          <div style={{ fontSize: 13, color: NX.dim }}>The serial is printed under the QR code on the tag.</div>
          {matches.length > 0 && (
            <div role="list" aria-label="Matching items" style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
              {matches.map((i) => (
                <button key={i.id} type="button" role="listitem" onClick={() => { stopAll(); onFound?.(i); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', background: NX.surface, border: 'none', borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter, sans-serif', minHeight: 44 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
                    <span style={{ display: 'block', fontSize: 12, color: NX.dim }}>{[i.serialNumber, i.location].filter(Boolean).join(' - ')}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {result && <ScanResult result={result} onAgain={null} onType={null} onPick={(i) => { stopAll(); onFound?.(i); }} />}
        </div>
      )}
    </Modal>
  );
}

/** What a code that did not open an item says. Exported for the tests. */
export function ScanResult({ result, onAgain, onType, onPick }) {
  if (result.status === 'several') {
    // A loose serial that fits more than one item: the person picks (review L6).
    const list = (result.items || []).slice(0, 8);
    return (
      <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '6px 2px' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>Several Items Match - Pick One</div>
        <div style={{ fontSize: 13, color: NX.dim, lineHeight: 1.5 }}>{`More than one item has a serial like "${String(result.code || result.raw || '').slice(0, 80)}".`}</div>
        <div role="list" aria-label="Items that match" style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {list.map((i) => (
            <button key={i.id} type="button" role="listitem" onClick={() => onPick?.(i)}
              style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '11px 12px', background: NX.surface, border: 'none', borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter, sans-serif', minHeight: 44 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{i.name || 'Item'}</span>
              <span style={{ fontSize: 12, color: NX.dim }}>{[i.serialNumber, i.location].filter(Boolean).join(' - ')}</span>
            </button>
          ))}
        </div>
        {onAgain && <div><button type="button" style={btn('outline')} onClick={onAgain}><ScanLine size={14} /> Scan Again</button></div>}
      </div>
    );
  }
  const t = result.status === 'denied'
    ? { icon: <Lock size={19} />, title: 'You Do Not Have Access to This Item', body: 'This tag is for an item outside your company, or one that was deleted. If you think you should see it, ask whoever manages your items.' }
    : result.status === 'foreign'
      ? { icon: <ScanLine size={19} />, title: 'Not a Nexus Item Tag', body: 'That code points somewhere else. Scan the Nexus QR tag on the item, or type its serial.' }
      : result.status === 'error'
        ? { icon: <CameraOff size={19} />, title: 'Nexus Could Not Be Reached', body: result.message || 'Check your connection, then try again.' }
        : { icon: <ScanLine size={19} />, title: 'No Item Matches This Code', body: `Nothing you can see has the code "${String(result.code || result.raw || '').slice(0, 80)}". Check the tag, or type the serial.` };
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '6px 2px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 38, height: 38, borderRadius: 12, background: NX.surface2, color: NX.dim, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: `1px solid ${NX.border}` }}>{t.icon}</span>
        <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>{t.title}</div>
      </div>
      <div style={{ fontSize: 13, color: NX.dim, lineHeight: 1.5 }}>{t.body}</div>
      {(onAgain || onType) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {onAgain && <button type="button" style={btn('primary')} onClick={onAgain}><ScanLine size={14} /> Scan Again</button>}
          {onType && <button type="button" style={btn('outline')} onClick={onType}><Keyboard size={14} /> Type a Serial</button>}
        </div>
      )}
    </div>
  );
}
