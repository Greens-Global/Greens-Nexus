/* eslint-disable react-refresh/only-export-components */
// Egnyte module - small presentational pieces shared by the browser, the
// property panel and the module shell. Inline styles on --wk-* tokens, matching
// the Work OS idiom used across the app.
import { useState } from 'react';
import { AlertTriangle, CloudOff, ExternalLink, Link2, Loader2 } from 'lucide-react';
import { api } from '../api';

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
