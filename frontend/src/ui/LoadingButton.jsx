// A button that says what it is doing (Neil, 11/07/2026 - effects rebuilt
// from interior.dev): "Save" -> spinner "Saving…" -> a check that draws
// itself, "Saved" -> back to "Save". The faces swap in place (a short fade
// and rise, none under reduced motion) and the button keeps the width of its
// widest face, so nothing beside it jumps.
//
// Two ways to drive it:
//   onClick returns a promise  -> the button runs busy / Saved itself (a
//                                 rejection just ends busy; the caller shows
//                                 the error).
//   busy / done props          -> the caller's own flags; `done` turning true
//                                 shows Saved for a moment (SaveRow).
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '../components/AsyncState';
import SavedCheck from '../components/SavedCheck';

const DONE_MS = 1600;

export default function LoadingButton({
  children, icon = null, busy: busyProp, done = false, onClick,
  busyLabel = 'Saving…', doneLabel = 'Saved', className = 'primary-btn', disabled = false, style, ...rest
}) {
  const [ownBusy, setOwnBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [prevDone, setPrevDone] = useState(done);
  const timer = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  // The caller's `done` rising is a save that just landed; falling (a new
  // edit) ends the Saved face at once, so it never sits over unsaved changes.
  if (prevDone !== done) {
    setPrevDone(done);
    setFlash(done);
  }
  useEffect(() => {
    if (!flash) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (alive.current) setFlash(false); }, DONE_MS);
    return undefined;
  }, [flash]);

  const busy = busyProp ?? ownBusy;
  const state = busy ? 'busy' : flash ? 'done' : 'idle';
  const click = (e) => {
    const out = onClick?.(e);
    if (busyProp !== undefined || !out || typeof out.then !== 'function') return;
    setOwnBusy(true);
    out.then(() => { if (alive.current) { setOwnBusy(false); setFlash(true); } },
      () => { if (alive.current) setOwnBusy(false); });
  };
  return (
    <button type="button" {...rest} className={`${className} nx-lbtn`} data-state={state} aria-busy={busy || undefined}
      disabled={disabled || busy} onClick={click} style={style}
      data-w-busy={busyLabel} data-w-done={doneLabel}>
      <span key={state} className="nx-lbtn-face">
        {state === 'busy' ? <><Spinner size={13} /> {busyLabel}</>
          : state === 'done' ? <SavedCheck show label={doneLabel} style={{ color: 'inherit', fontSize: 'inherit' }} />
            : <>{icon}{children}</>}
      </span>
    </button>
  );
}
