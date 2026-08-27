/* eslint-disable react-refresh/only-export-components */
// Egnyte module - small presentational pieces shared by the browser, the
// property panel and the module shell. Inline styles on --wk-* tokens, matching
// the Work OS idiom used across the app.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CloudOff, ExternalLink, Link2, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';

export const CARD = {
  background: 'var(--wk-card)',
  border: '1px solid var(--wk-line2)',
  borderRadius: 'var(--wk-r)',
  boxShadow: 'var(--wk-shadow)',
};

export const HEADING = {
  fontFamily: 'var(--wk-font)',
  fontWeight: 700,
  color: 'var(--wk-ink)',
  letterSpacing: '-.01em',
};

export const BODY = { fontSize: 13, color: 'var(--wk-dim)', lineHeight: 1.55 };

// Long Egnyte names and paths must never widen the page - they ellipsize, and
// the row that holds them carries minWidth: 0 so flex actually allows it.
export const ELLIPSIS = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };

export function Spinner({ size = 18, style }) {
  return <Loader2 size={size} style={{ animation: 'spin 1s linear infinite', flexShrink: 0, ...style }} />;
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '46px 20px', color: 'var(--wk-dim)', fontSize: 13 }}>
      <Spinner /> {label}
    </div>
  );
}

// Recoverable problems (a failed listing, a rejected upload) read as a quiet
// note inside the surface, not as a page-level alarm.
export function Notice({ tone = 'error', children, onDismiss }) {
  const tones = {
    error:   { bg: 'var(--wk-red-bg)',    fg: 'var(--wk-red)' },
    warn:    { bg: 'var(--wk-orange-bg)', fg: 'var(--wk-orange)' },
    success: { bg: 'var(--wk-green-bg)',  fg: 'var(--wk-green)' },
    info:    { bg: 'var(--wk-blue-bg)',   fg: 'var(--wk-blue)' },
  };
  const t = tones[tone] || tones.error;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: t.bg, color: t.fg, borderRadius: 'var(--wk-r)', padding: '9px 12px', fontSize: 12.5, lineHeight: 1.5 }}>
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: 0, flexShrink: 0 }}>
          Dismiss
        </button>
      )}
    </div>
  );
}

// The state this module will actually be in until an admin adds the API key.
// It explains the situation and what unblocks it, rather than looking broken.
export function NotConnected({ compact = false, error = '', onRetry }) {
  return (
    <div style={{ ...CARD, padding: compact ? '22px 18px' : '40px 28px', textAlign: 'center', maxWidth: 560, margin: '0 auto' }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--wk-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
        <CloudOff size={22} style={{ color: 'var(--wk-faint)' }} />
      </div>
      <div style={{ ...HEADING, fontSize: compact ? 15 : 17, marginBottom: 8 }}>Egnyte Is Not Connected Yet</div>
      <div style={{ ...BODY, maxWidth: 420, margin: '0 auto' }}>
        This module reads and writes files straight from Egnyte, so nothing is stored twice.
        It stays empty until an administrator adds the Egnyte domain and API token to the
        Nexus backend. Once that is set, folders, uploads and search light up here with no
        further setup.
      </div>
      <div style={{ ...BODY, fontSize: 12, marginTop: 12, color: 'var(--wk-faint)' }}>
        Needs the <code style={{ fontFamily: 'ui-monospace, monospace' }}>EGNYTE_DOMAIN</code> and{' '}
        <code style={{ fontFamily: 'ui-monospace, monospace' }}>EGNYTE_TOKEN</code> settings.
      </div>
      {error && <div style={{ ...BODY, fontSize: 12, marginTop: 12, color: 'var(--wk-red)' }}>{error}</div>}
      {onRetry && (
        <button className="secondary-btn" style={{ marginTop: 16 }} onClick={onRetry}>Check Again</button>
      )}
    </div>
  );
}

export function EmptyFolder({ label = 'This folder is empty.', hint }) {
  return (
    <div style={{ padding: '38px 20px', textAlign: 'center' }}>
      <div style={{ ...BODY, fontSize: 13 }}>{label}</div>
      {hint && <div style={{ ...BODY, fontSize: 12, marginTop: 4, color: 'var(--wk-faint)' }}>{hint}</div>}
    </div>
  );
}

// Every file and folder Nexus shows carries its deep link back to Egnyte, where
// permissions, versions and sharing actually live.
export function OpenInEgnyte({ url, label = 'Open in Egnyte', iconOnly = false }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      onClick={e => e.stopPropagation()}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
        color: 'var(--wk-brand)', fontSize: 12, fontWeight: 600, textDecoration: 'none',
        padding: iconOnly ? 4 : '4px 8px', borderRadius: 6,
      }}
    >
      <ExternalLink size={13} />
      {!iconOnly && <span>{label}</span>}
    </a>
  );
}

export function ProblemNote({ message, onRetry }) {
  return (
    <div style={{ padding: '34px 20px', textAlign: 'center' }}>
      <AlertTriangle size={24} style={{ color: 'var(--wk-orange)', marginBottom: 10 }} />
      <div style={{ ...BODY, maxWidth: 380, margin: '0 auto' }}>{message}</div>
      {onRetry && <button className="secondary-btn" style={{ marginTop: 14 }} onClick={onRetry}>Try Again</button>}
    </div>
  );
}

// Floating action menu, anchored to the element that opened it (a row's "⋯").
// Portal to body so no card or scroll container can clip it; closes on outside
// click, Escape, scroll and resize - a stale-positioned menu is worse than a
// closed one. Items: {label, icon, onClick, danger, disabled, hint}, or
// 'divider'.
export function EgnyteMenu({ anchorRect, items, onClose, align = 'right' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!anchorRect || !ref.current) return;
    const w = ref.current.offsetWidth || 230;
    const h = ref.current.offsetHeight || 200;
    // align 'right': menu's right edge under the anchor (the "⋯" button).
    // align 'left': menu opens rightward from the point - the right-click case.
    let left = align === 'left' ? anchorRect.left : anchorRect.right - w;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = anchorRect.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchorRect.top - h - 4);
    setPos({ left, top });
  }, [anchorRect, align]);

  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    // Capture phase so a click that also does something else still closes us.
    document.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="egx-menu"
      role="menu"
      style={{
        position: 'fixed', zIndex: 6000, minWidth: 210, maxWidth: 280,
        left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        background: 'var(--wk-card)', border: '1px solid var(--wk-line2)',
        borderRadius: 10, boxShadow: '0 12px 32px rgba(29,33,57,.16)',
        padding: 5, visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {items.filter(Boolean).map((it, i) => it === 'divider' ? (
        <div key={`d${i}`} style={{ height: 1, background: 'var(--wk-line2)', margin: '5px 4px' }} />
      ) : (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          onClick={() => { onClose(); it.onClick?.(); }}
          className="egx-menu-item"
          style={{
            display: 'flex', alignItems: 'center', gap: 9, width: '100%',
            padding: '7px 9px', borderRadius: 7, border: 'none', background: 'none',
            cursor: it.disabled ? 'default' : 'pointer', fontFamily: 'inherit',
            fontSize: 13, textAlign: 'left', opacity: it.disabled ? 0.45 : 1,
            color: it.danger ? 'var(--wk-red)' : 'var(--wk-ink)',
          }}
        >
          {it.icon}
          <span style={{ flex: 1, minWidth: 0, ...ELLIPSIS }}>{it.label}</span>
          {it.hint && <span style={{ fontSize: 11, color: 'var(--wk-faint)', flexShrink: 0 }}>{it.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// Small centered dialog for the browser's confirm/rename moments. Deliberately
// tiny - the full-viewport sheet belongs to the file viewer only.
// `isDirty` + `onSave`: some callers use this shell for a rename/text-entry
// form rather than a pure confirm - with isDirty set, an unintentional exit
// (overlay click, Escape) confirms first instead of silently discarding what
// was typed. Defaults keep every existing caller's behavior unchanged.
export function EgnyteDialog({ title, children, footer, onClose, width = 420, isDirty = false, onSave }) {
  const guard = useUnsavedGuard(isDirty, onClose, onSave);
  return createPortal(
    <>
      <div
        className="egx-overlay"
        onMouseDown={e => { if (e.target === e.currentTarget) guard.requestClose(); }}
        style={{ position: 'fixed', inset: 0, zIndex: 6500, background: 'rgba(15,18,24,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      >
        <div className="egx-pop" role="dialog" aria-modal="true" aria-label={title}
          style={{ ...CARD, width: `min(${width}px, 100%)`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ ...HEADING, fontSize: 14.5 }}>{title}</div>
          <div style={{ ...BODY, fontSize: 13 }}>{children}</div>
          {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>{footer}</div>}
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt
          onKeepEditing={guard.keepEditing}
          onDiscard={onClose}
          onSave={onSave ? guard.saveAndClose : undefined}
          saving={guard.saving}
        />
      )}
    </>,
    document.body,
  );
}

// The API answered 428: per-user Egnyte OAuth is on and this person hasn't
// connected. Rendered by EVERY browse surface (module, person card, pickers)
// so "connect first" looks the same everywhere and is one click away.
export function ConnectRequired() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      const { url, error: err } = await api.egnyteOauthStart();
      if (url) { window.location.assign(url); return; }
      setError(err || 'Could not start the Egnyte connection.');
    } catch (e) { setError(e?.message || 'Could not start the Egnyte connection.'); }
    setBusy(false);
  };
  return (
    <div style={{ ...CARD, padding: '28px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <Link2 size={26} style={{ color: 'var(--wk-dim)' }} />
      <div style={{ ...HEADING, fontSize: 14.5 }}>Connect Your Egnyte Account</div>
      <div style={{ ...BODY, maxWidth: 420 }}>
        Files here are shown with your own Egnyte permissions - connect your Egnyte account
        once and you will see exactly the folders you have access to.
      </div>
      <button type="button" className="primary-btn" disabled={busy} onClick={connect} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {busy ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Link2 size={13} />} Connect Egnyte
      </button>
      {error && <div style={{ ...BODY, fontSize: 12, color: 'var(--wk-red)' }}>{error}</div>}
    </div>
  );
}
