// Hold to confirm (Neil, Oct 30 2026; plan https://claude.ai/artifact/MU1RMFQ9nHYxSB31XjDwQ1).
// The confirmation for an action that cannot be taken back: press and hold
// until the red fills the button. Modeled on dqnamo's Hold To Confirm (a
// clip-path wipe, an even fill, a fast ease-out rewind) and taken further:
//
//   - the hold length follows the stakes: HOLD_MAJOR_MS for many records or
//     other people (Delete Project, Void an envelope), HOLD_RECORD_MS for one
//     record (a note, a credential) - a record holds right on its row, a
//     major action holds inside the dialog that says what goes;
//   - a quick tap nudges the fill and says "Hold to delete" instead of
//     doing nothing;
//   - Space / Enter hold too; screen readers hear "<label>, press and hold"
//     and the progress and result are announced;
//   - a click with no press behind it (a screen reader's double tap, which
//     cannot hold) opens the ordinary confirm dialog instead - the WCAG 2.5
//     alternative path;
//   - the phone's long-press menu is blocked, scrolling or sliding off the
//     button cancels;
//   - the finish waits for the server: `onConfirm` may return a promise; a
//     refusal rewinds the button and shows the reason under it, success
//     turns it solid with a check and the past tense ("Deleted") and gives
//     one short buzz where phones support it. If it resolves to { undo }
//     an Undo toast follows (dialog.undo);
//   - reduced motion: the fill moves in four steps and the hint counts down.
//
// <HoldButton label="Delete Forever" doneLabel="Deleted" onConfirm={...} />
// dialog.confirm(message, { hold: true, confirmText, doneText, onConfirm })
// puts one in the shared dialog.
import { useEffect, useRef, useState } from 'react';
import { Trash2, Check } from 'lucide-react';
import { prefersReducedMotion } from '../lib/reducedMotion';

export const HOLD_MAJOR_MS = 1800;
export const HOLD_RECORD_MS = 1200;
const TAP_MS = 250;          // released sooner than this = a tap, not a hold
const SLIP_PX = 8;           // the finger may wander this far off the button
const DONE_MS = 1800;        // how long the check shows before the button resets

const hintWord = (label) => `Hold to ${String(label || 'confirm').toLowerCase().replace(/\s+(forever|permanently|now)$/, '')}`;

export default function HoldButton({
  label, doneLabel = 'Done', onConfirm, onDone, holdMs = HOLD_RECORD_MS, icon: Icon = Trash2,
  size = 'md', disabled = false, fallbackMessage, clickRuns = false, ariaLabel, autoFocus = false, style, className = '',
}) {
  const [phase, setPhase] = useState('idle');       // idle | holding | working | done
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const [nudge, setNudge] = useState(false);
  const [step, setStep] = useState(0);              // reduced-motion fill, 0-4
  const [said, setSaid] = useState('');             // polite live region
  const btn = useRef(null);
  const timer = useRef(null);
  const stepper = useRef(null);
  const pressedAt = useRef(0);
  const lastPress = useRef(0);
  const firing = useRef(false);
  const live = useRef(true);
  const reduced = useRef(false);

  useEffect(() => () => { live.current = false; clearTimeout(timer.current); clearInterval(stepper.current); }, []);

  const announce = (t) => { setSaid(''); setTimeout(() => { if (live.current) setSaid(t); }, 30); };

  async function run() {
    if (firing.current) return;
    firing.current = true;
    setPhase('working'); setHint(''); setError('');
    try {
      const r = await onConfirm?.();
      if (!live.current) return;
      setPhase('done');
      try { navigator.vibrate?.(20); } catch { /* not a phone */ }
      announce(`${doneLabel}.${r?.undo ? ' Undo available.' : ''}`);
      if (r?.undo) {
        const { dialog } = await import('./dialog');
        dialog.undo(r.undoMessage || `${doneLabel}.`, r.undo);
      }
      // onDone (the shared dialog closes on it) after the check has been seen.
      if (onDone) setTimeout(() => { if (live.current) onDone(r); }, 650);
      setTimeout(() => { if (live.current) { setPhase('idle'); firing.current = false; } }, DONE_MS);
    } catch (e) {
      firing.current = false;
      if (!live.current) return;
      setPhase('idle');
      const msg = e?.message || 'That did not go through.';
      setError(msg); announce(msg);
    }
  }

  function begin() {
    if (disabled || firing.current || phase !== 'idle') return;
    reduced.current = prefersReducedMotion();
    pressedAt.current = Date.now(); lastPress.current = pressedAt.current;
    setNudge(false); setError(''); setStep(0);
    setPhase('holding');
    setHint('Keep holding');
    announce(`Keep holding to ${String(label).toLowerCase()}`);
    if (reduced.current) {
      let n = 0;
      stepper.current = setInterval(() => {
        n += 1; setStep(n);
        setHint(`Keep holding - ${((holdMs - (n * holdMs) / 4) / 1000).toFixed(1)} s`);
      }, holdMs / 4);
    }
    timer.current = setTimeout(() => { clearInterval(stepper.current); timer.current = null; run(); }, holdMs);
  }

  function cancel() {
    if (!timer.current) return;
    clearTimeout(timer.current); timer.current = null; clearInterval(stepper.current);
    lastPress.current = Date.now();
    setPhase('idle'); setStep(0);
    if (Date.now() - pressedAt.current < TAP_MS) {
      setNudge(true); setTimeout(() => { if (live.current) setNudge(false); }, 180);
      setHint(hintWord(label));
      announce(`${hintWord(label)}. A tap does nothing.`);
    } else {
      setHint('');
      announce('Cancelled.');
    }
  }

  // A click that no press or key led to comes from assistive tech, which
  // cannot hold: ask with the ordinary dialog instead.
  async function onClick(e) {
    e.preventDefault();
    if (e.detail !== 0 || Date.now() - lastPress.current < 600 || disabled || firing.current) return;
    // Inside the shared dialog the dialog already asked (a second dialog would replace it).
    if (clickRuns) { run(); return; }
    const { dialog } = await import('./dialog');
    const ok = await dialog.confirm(fallbackMessage || `${label}? This cannot be undone.`, { danger: true, confirmText: label });
    if (ok) run();
  }

  const onPointerDown = (e) => {
    if (e.button > 0) return;     // primary button or a touch only
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* old browser */ }
    begin();
  };
  const onPointerMove = (e) => {
    if (!timer.current || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    if (e.clientX < r.left - SLIP_PX || e.clientX > r.right + SLIP_PX || e.clientY < r.top - SLIP_PX || e.clientY > r.bottom + SLIP_PX) cancel();
  };
  const onKeyDown = (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!e.repeat) begin();
  };
  const onKeyUp = (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    cancel();
  };

  const done = phase === 'done';
  const working = phase === 'working';
  const face = (
    <>
      {done ? <Check size={size === 'sm' ? 13 : 15} aria-hidden="true" /> : Icon ? <Icon size={size === 'sm' ? 13 : 15} aria-hidden="true" /> : null}
      <span>{done ? doneLabel : label}</span>
    </>
  );
  return (
    <span className="nx-hold-wrap">
      <button
        ref={btn}
        type="button"
        autoFocus={autoFocus}
        className={`nx-hold nx-hold-${size} ${className}`.trim()}
        style={{ '--nx-hold-ms': `${holdMs}ms`, '--nx-hold-left': `${100 - step * 25}%`, ...style }}
        data-holding={phase === 'holding' ? '' : undefined}
        data-working={working ? '' : undefined}
        data-done={done ? '' : undefined}
        data-nudge={nudge ? '' : undefined}
        data-reduced={phase === 'holding' && reduced.current ? '' : undefined}
        disabled={disabled}
        aria-label={`${ariaLabel || label}, press and hold`}
        aria-busy={working || undefined}
        onPointerDown={onPointerDown}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onPointerMove={onPointerMove}
        onBlur={cancel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onClick={onClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className="nx-hold-face">{face}</span>
        <span className="nx-hold-fill" aria-hidden="true">{face}</span>
      </button>
      {hint && !error && <span className="nx-hold-hint" aria-hidden="true">{hint}</span>}
      {error && <span className="nx-hold-error" role="alert">{error}</span>}
      <span className="nx-hold-sr" aria-live="polite">{said}</span>
    </span>
  );
}
