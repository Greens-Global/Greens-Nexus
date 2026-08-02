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
// destructive. `required:true` (prompt) disables OK until non-empty.
//
// One <DialogHost/> is mounted at the app root (main.jsx). Calls made before it
// mounts are queued and shown once it does.
import { useState, useEffect, useRef, useCallback } from 'react';

let _present = null;          // set by the mounted DialogHost
const _queue = [];            // calls made before the host mounted

function _show(opts) {
  return new Promise((resolve) => {
    const item = { ...opts, resolve };
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
};

export function DialogHost() {
  const [item, setItem] = useState(null);
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  const okRef = useRef(null);

  useEffect(() => {
    _present = (it) => { setValue(it.defaultValue || ''); setItem(it); };
    if (_queue.length) _present(_queue.shift());
    return () => { _present = null; };
  }, []);

  const close = useCallback((result) => {
    setItem((cur) => { cur?.resolve(result); return null; });
    setValue('');
    // show the next queued dialog, if any
    if (_queue.length) setTimeout(() => _present && _present(_queue.shift()), 0);
  }, []);

  // Focus the input (prompt) or the primary button when a dialog opens.
  useEffect(() => {
    if (!item) return;
    const t = setTimeout(() => {
      if (item.kind === 'prompt' && inputRef.current) inputRef.current.focus();
      else if (okRef.current) okRef.current.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [item]);

  if (!item) return null;

  const isPrompt = item.kind === 'prompt';
  const isAlert = item.kind === 'alert';
  const okDisabled = isPrompt && item.required && !value.trim();
  const confirmResult = () => close(isPrompt ? value : true);
  const cancelResult = () => close(isPrompt ? null : false);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelResult(); }
    else if (e.key === 'Enter' && !(isPrompt && item.multiline)) {
      e.preventDefault();
      if (!okDisabled) confirmResult();
    }
  };

  const btnBase = {
    padding: '9px 20px', borderRadius: 9, fontSize: 13.5, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'Inter, sans-serif', border: '1px solid transparent',
  };

  return (
    <div
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) cancelResult(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100000,
        background: 'rgba(15, 21, 18, 0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, backdropFilter: 'blur(2px)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onKeyDown={onKeyDown}
        style={{
          background: 'var(--card, var(--paper, #fff))',
          border: '1px solid var(--line, #e6e8e2)',
          borderRadius: 16, padding: '24px 24px 20px', width: '100%', maxWidth: 430,
          boxShadow: '0 12px 40px rgba(0,0,0,.22)', fontFamily: 'Inter, sans-serif',
        }}
      >
        {item.title && (
          <div style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--ink, #17211c)', marginBottom: 8 }}>
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
            <textarea
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={item.placeholder || ''}
              rows={3}
              style={{
                width: '100%', marginTop: 14, padding: '10px 12px', borderRadius: 9,
                border: '1px solid var(--line, #e6e8e2)', background: 'var(--paper, #fff)',
                color: 'var(--ink, #17211c)', fontSize: 14, fontFamily: 'Inter, sans-serif',
                resize: 'vertical', boxSizing: 'border-box',
              }}
            />
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

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 20 }}>
          {!isAlert && (
            <button
              type="button"
              onClick={cancelResult}
              style={{ ...btnBase, background: 'transparent', color: 'var(--ink, #17211c)', borderColor: 'var(--line, #e6e8e2)' }}
            >
              {item.cancelText || 'Cancel'}
            </button>
          )}
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
        </div>
      </div>
    </div>
  );
}
