// Nexus dialog system - the styled, on-brand replacement for the browser's
// native alert() / confirm() / prompt(). Native dialogs can't match the app's
// theme (they ignore dark mode entirely), read as "not part of the product",
// and prompt() returning null on cancel was the source of the "cancel still
// rejects" bugs in the module audit.
//
// Drop-in usage - the only change at a call site is `await`:
//   window.confirm(msg)        -> await dialog.confirm(msg)          // true / false
//   window.prompt(msg, def)    -> await dialog.prompt(msg, { defaultValue })  // string / null
//   window.alert(msg)          -> await dialog.alert(msg)            // (resolves when dismissed)
//
// Options (all optional): { title, confirmText, cancelText, danger, placeholder,
// defaultValue, required, multiline }. `danger:true` styles the confirm button as
// destructive. `hold:true` (confirm) makes it a press-and-hold button instead
// (ui/HoldButton.jsx, Neil, Oct 30 2026) for an action that cannot be taken
// back: `holdMs` (default HOLD_MAJOR_MS), `doneText` ("Deleted"), `holdIcon`
// (a lucide icon for an action that is not a delete; the trash by default), and
// `onConfirm` - an async action the dialog waits for, staying open with the
// reason when it throws, so the button finishes only when the server did.
// A prompt may hold too: its `onConfirm` gets the typed text.
// `dialog.undo(message, onUndo)` shows a short Undo toast. `required:true` (prompt) disables OK until non-empty;
// `minLength:n` keeps it disabled until n characters, with a hint saying so.
//
// One <DialogHost/> is mounted at the app root (main.jsx). Calls made before it
// mounts are queued and shown once it does. One dialog shows at a time: a call
// made while another is open waits its turn behind it, so every caller's
// promise resolves (a second call used to replace the first, which then hung).
//
// The dialog is the top layer (z 100000): Escape, Enter and Tab are heard on
// the window, so they work wherever focus sits and nothing under the dialog
// hears them. Tab stays inside the card and focus goes back to the opener.
import { useState, useEffect, useRef, useCallback } from 'react';
import { MOTION, motionWait } from '../lib/motion';
import { trapTabIn } from '../lib/useDialogFocus';
import HoldButton, { HOLD_MAJOR_MS } from './HoldButton';

let _present = null;          // set by the mounted DialogHost
const _queue = [];            // calls waiting: made before the host mounted, or while a dialog is open
let _presentUndo = null;      // the Undo toast, same host
let _seq = 0;                 // one id per call: a new dialog never inherits the last one's hold button

function _show(opts) {
  return new Promise((resolve) => {
    _seq += 1;
    const item = { ...opts, resolve, _id: _seq };
    if (_present) _present(item);
    else _queue.push(item);
  });
}

// Accept either (message) or (message, opts) or ({ message, ...opts }).
function _norm(message, opts) {
  if (message && typeof message === 'object') return message;
  return { message: message ?? '', ...(opts || {}) };
}

export const dialog = {
  alert:   (message, opts) => _show({ kind: 'alert',   ..._norm(message, opts) }),
  confirm: (message, opts) => _show({ kind: 'confirm', ..._norm(message, opts) }),
  prompt:  (message, opts) => _show({ kind: 'prompt',  ..._norm(message, opts) }),
  // A short Undo after a hold-confirmed action the server can still put back.
  undo:    (message, onUndo, ms = 6000) => { _presentUndo?.({ message, onUndo, ms, at: Date.now() }); },
};

function UndoToast() {
  const [u, setU] = useState(null);
  useEffect(() => {
    _presentUndo = setU;
    return () => { _presentUndo = null; };
  }, []);
  useEffect(() => {
    if (!u) return undefined;
    const t = setTimeout(() => setU(null), u.ms);
    return () => clearTimeout(t);
  }, [u]);
  if (!u) return null;
  return (
    <div className="nx-undo" role="status">
      <span>{u.message}</span>
      <button type="button" onClick={() => { setU(null); u.onUndo?.(); }}>Undo</button>
    </div>
  );
}

export function DialogHost() {
  return (
    <>
      <DialogCard />
      <UndoToast />
    </>
  );
}

function DialogCard() {
  const [item, setItem] = useState(null);
  const [value, setValue] = useState('');
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // Exit motion (lib/motion.js): the promise resolves at once so the caller
  // gets on with it, while the card plays `.is-closing` and is removed on a
  // timer. A dialog presented during that window replaces it straight away.
  const [closing, setClosing] = useState(false);
  // A hold action in flight, or showing its check before the dialog closes
  // (ui/HoldButton.jsx `onBusy`): Cancel, Escape and the scrim wait for it -
  // cancelling then resolved false while the server went on and did it.
  const [holdBusy, setHoldBusy] = useState(false);
  const exitTimer = useRef(null);
  // The dialog on screen. Written by hand wherever `item` is set, never from
  // an effect: the next call must know at once whether one is open.
  const itemRef = useRef(null);
  const inputRef = useRef(null);
  const okRef = useRef(null);
  const cardRef = useRef(null);
  const openerRef = useRef(null);   // what had focus before the dialog took it
  const keyRef = useRef(null);

  // Shows the call at the head of the queue - unless a dialog is open and
  // staying. One that is on its way out is replaced straight away.
  const showNext = useCallback(() => {
    if (itemRef.current && !exitTimer.current) return;
    const it = _queue.shift();
    if (!it) return;
    if (!openerRef.current) openerRef.current = document.activeElement;
    clearTimeout(exitTimer.current); exitTimer.current = null; setClosing(false);
    itemRef.current = it;
    setValue(it.defaultValue || ''); setConfirmingDiscard(false); setHoldBusy(false); setItem(it);
  }, []);

  useEffect(() => {
    _present = (it) => { if (it) _queue.push(it); showNext(); };
    _present();     // the calls made before the host mounted
    return () => { _present = null; clearTimeout(exitTimer.current); };
  }, [showNext]);

  const close = useCallback((result) => {
    const cur = itemRef.current;
    if (!cur || exitTimer.current) return;      // nothing open, or already leaving
    cur.resolve(result);
    const finish = () => {
      exitTimer.current = null;
      itemRef.current = null;
      // show the next queued dialog, if any
      if (_queue.length) setTimeout(() => _present && showNext(), 0);
      else {
        // The last one: focus goes back to whatever had it (the button that
        // asked), unless it has since moved somewhere else on purpose.
        const prev = openerRef.current; openerRef.current = null;
        const now = document.activeElement;
        const lost = !now || now === document.body || !now.isConnected || !!cardRef.current?.contains(now);
        if (lost && prev && prev !== document.body && prev.isConnected && typeof prev.focus === 'function') {
          try { prev.focus({ preventScroll: true }); } catch { /* ignore */ }
        }
      }
      setItem(null); setClosing(false); setValue('');
    };
    const wait = motionWait(MOTION.exit);
    if (wait === 0) { finish(); return; }
    setClosing(true);
    exitTimer.current = setTimeout(finish, wait);
  }, [showNext]);

  // Focus the input (prompt) or the primary button when a dialog opens, and
  // the first button of "Save your changes?" (Keep Editing) when that shows.
  useEffect(() => {
    if (!item) return;
    const t = setTimeout(() => {
      if (confirmingDiscard) cardRef.current?.querySelector('button')?.focus();
      else if (item.kind === 'prompt' && inputRef.current) inputRef.current.focus();
      else if (okRef.current) okRef.current.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [item, confirmingDiscard]);

  const isPrompt = item?.kind === 'prompt';
  const isAlert = item?.kind === 'alert';
  const short = isPrompt && item.minLength > 0 && value.trim().length < item.minLength;
  const okDisabled = isPrompt && ((item.required && !value.trim()) || short);
  const confirmResult = () => close(isPrompt ? value : true);
  const cancelResult = () => close(isPrompt ? null : false);
  // A typed prompt whose value has diverged from the default is "dirty" -
  // an unintentional exit (overlay click, Escape) asks first instead of
  // silently dropping what was typed. The prompt's own visible Cancel
  // button stays an immediate, deliberate discard.
  const dirty = isPrompt && value !== (item.defaultValue || '');
  const requestCancel = () => { if (holdBusy) return; if (dirty) setConfirmingDiscard(true); else cancelResult(); };

  // Heard on the window, in the capture phase: the keys do not depend on
  // where focus sits (a click on the message leaves it on the card or the
  // page), and an Escape never reaches the sheet under the dialog.
  const onKey = (e) => {
    if (!item) return;
    const card = cardRef.current;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (confirmingDiscard) setConfirmingDiscard(false); else requestCancel();
      return;
    }
    if (e.key === 'Tab') { trapTabIn(card, e); return; }
    if (e.key !== 'Enter') return;
    const at = document.activeElement;
    const inside = !!card && card.contains(at);
    // Focus still on the page under the dialog (it moves in a beat after the
    // dialog opens): the key is neither the page's nor a confirmation.
    if (!inside && at && at !== document.body) { e.preventDefault(); e.stopPropagation(); return; }
    // A hold-to-confirm dialog is never confirmed by Enter alone (the hold
    // button takes its own Enter / Space hold).
    if (confirmingDiscard || item.hold || (isPrompt && item.multiline)) return;
    // A button or a link in focus has its own action: Enter presses IT
    // (Enter on Cancel cancels), it does not confirm the dialog.
    if (inside && at.closest('button, a[href], [role="button"]')) return;
    e.preventDefault();
    if (!okDisabled) confirmResult();
  };
  useEffect(() => { keyRef.current = onKey; });
  useEffect(() => {
    if (!item) return undefined;
    const onDown = (e) => keyRef.current?.(e);
    window.addEventListener('keydown', onDown, true);
    return () => window.removeEventListener('keydown', onDown, true);
  }, [item]);

  if (!item) return null;

  const btnBase = {
    padding: '9px 20px', borderRadius: 9, fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'Inter, sans-serif', border: '1px solid transparent',
  };

  if (confirmingDiscard) {
    return (
      <div
        role="presentation"
        data-nx-esc-layer=""
        className={`nx-overlay${closing ? ' is-closing' : ''}`}
        onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmingDiscard(false); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 100000,
          background: 'rgba(15, 21, 18, 0.42)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 20, backdropFilter: 'blur(2px)',
        }}
      >
        <div
          ref={cardRef}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          className="nx-panel nx-popup"
          style={{
            background: 'var(--card, var(--paper, #fff))',
            border: '1px solid var(--line, #e6e8e2)',
            borderRadius: 16, padding: '24px 24px 20px', display: 'flex', flexDirection: 'column',
            boxShadow: '0 12px 40px rgba(0,0,0,.22)', fontFamily: 'Inter, sans-serif',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink, #17211c)', marginBottom: 8 }}>Save your changes?</div>
          <div style={{ fontSize: 14, color: 'var(--muted, #5b675f)', lineHeight: 1.55 }}>
            You have unsaved changes. Closing now will discard them.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 'auto', paddingTop: 20, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setConfirmingDiscard(false)}
              style={{ ...btnBase, background: 'transparent', color: 'var(--ink, #17211c)', borderColor: 'var(--line, #e6e8e2)' }}>Keep Editing</button>
            <button type="button" onClick={cancelResult}
              style={{ ...btnBase, background: 'transparent', color: 'var(--ink, #17211c)', borderColor: 'var(--line, #e6e8e2)' }}>Discard</button>
            <button type="button" onClick={confirmResult} disabled={okDisabled}
              style={{ ...btnBase, background: 'var(--ink, #17211c)', color: 'var(--paper, #fff)', opacity: okDisabled ? 0.5 : 1, cursor: okDisabled ? 'not-allowed' : 'pointer' }}>
              {item.confirmText || 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="presentation"
      data-nx-esc-layer=""
      className={`nx-overlay${closing ? ' is-closing' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) requestCancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100000,
        background: 'rgba(15, 21, 18, 0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, backdropFilter: 'blur(2px)',
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="nx-panel nx-popup"
        style={{
          background: 'var(--card, var(--paper, #fff))',
          border: '1px solid var(--line, #e6e8e2)',
          borderRadius: 16, padding: '24px 24px 20px', display: 'flex', flexDirection: 'column',
          boxShadow: '0 12px 40px rgba(0,0,0,.22)', fontFamily: 'Inter, sans-serif',
        }}
      >
        {item.title && (
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink, #17211c)', marginBottom: 8 }}>
            {item.title}
          </div>
        )}
        {item.message && (
          <div style={{ fontSize: 14, color: 'var(--muted, #5b675f)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
            {item.message}
          </div>
        )}

        {isPrompt && (
          item.multiline ? (
            // nx-fill: the note grows into the popup's 60% height (CLAUDE.md).
            <div className="nx-fill" style={{ marginTop: 14 }}>
              <textarea
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={item.placeholder || ''}
                rows={3}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 9,
                  border: '1px solid var(--line, #e6e8e2)', background: 'var(--paper, #fff)',
                  color: 'var(--ink, #17211c)', fontSize: 14, fontFamily: 'Inter, sans-serif',
                  resize: 'vertical', boxSizing: 'border-box',
                }}
              />
            </div>
          ) : (
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={item.placeholder || ''}
              style={{
                width: '100%', marginTop: 14, padding: '10px 12px', borderRadius: 9,
                border: '1px solid var(--line, #e6e8e2)', background: 'var(--paper, #fff)',
                color: 'var(--ink, #17211c)', fontSize: 14, fontFamily: 'Inter, sans-serif',
                boxSizing: 'border-box',
              }}
            />
          )
        )}
        {short && (
          <div style={{ fontSize: 12, color: 'var(--muted, #5b675f)', marginTop: 6 }}>
            At least {item.minLength} characters ({value.trim().length} so far).
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 'auto', paddingTop: 20 }}>
          {!isAlert && (
            <button
              ref={item.hold ? okRef : undefined}
              type="button"
              onClick={cancelResult}
              disabled={holdBusy}
              style={{ ...btnBase, background: 'transparent', color: 'var(--ink, #17211c)', borderColor: 'var(--line, #e6e8e2)', ...(holdBusy ? { opacity: 0.5, cursor: 'not-allowed' } : null) }}
            >
              {item.cancelText || 'Cancel'}
            </button>
          )}
          {item.hold ? (
            <HoldButton key={item._id} label={item.confirmText || 'Delete'} doneLabel={item.doneText || 'Done'} holdMs={item.holdMs || HOLD_MAJOR_MS}
              icon={item.holdIcon} clickRuns onDone={() => close(true)} onBusy={setHoldBusy}
              onConfirm={item.onConfirm && (() => item.onConfirm(isPrompt ? value : undefined))} />
          ) : (
          <button
            ref={okRef}
            type="button"
            onClick={confirmResult}
            disabled={okDisabled}
            style={{
              ...btnBase,
              background: item.danger ? 'hsl(var(--color-red, 4 74% 49%))' : 'var(--ink, #17211c)',
              color: item.danger ? '#fff' : 'var(--paper, #fff)',
              opacity: okDisabled ? 0.5 : 1,
              cursor: okDisabled ? 'not-allowed' : 'pointer',
            }}
          >
            {item.confirmText || (isAlert ? 'OK' : isPrompt ? 'Submit' : 'Confirm')}
          </button>
          )}
        </div>
      </div>
    </div>
  );
}
