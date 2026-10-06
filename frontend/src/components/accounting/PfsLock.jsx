import { useCallback, useEffect, useState } from 'react';
import { History, KeyRound, Loader2, Lock, LockOpen, X } from 'lucide-react';
import { api } from '../../api';
import { useNameResolver } from '../../lib/useNameResolver';
import { formatDateTime, formatTime } from '../../lib/datetime';
import { control } from './reportControls';

// PFS file lock (Charmi, 10/04): "Add a lock icon next to the different files
// and when we try to click it, it should ask for OTP to the file and not to
// the module, and it should send a notification to the borrowers via email
// that your PFS was accessed by this person at this time, and it should
// maintain a log."
//
// The server is the lock (routers/pfs_access.py answers 423 on every route of
// a file that is not open); this screen only follows it. A code goes to the
// viewer's own email and opens ONE file in THIS tab for 30 minutes. When the
// status cannot be read the screen simply tries the file - the server still
// decides, and a 423 brings the lock panel up.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };

/** Which files are open in this tab. `isOpen(id)` is true when the server says
 * so - or when the lock is off, or its status could not be read (the server
 * still answers 423 then, and `markLocked` closes it here). */
export function usePfsLocks() {
  const [state, setState] = useState({ known: false, enabled: true, unlocked: {} });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getPfsAccessStatus())
      .then((s) => { if (alive) setState({ known: true, enabled: s?.lockEnabled !== false, unlocked: s?.unlocked || {} }); })
      .catch(() => { if (alive) setState((x) => ({ ...x, known: false })); });
    return () => { alive = false; };
  }, []);
  // The 30 minutes run out on their own: look again every half minute.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const isOpen = useCallback((id) => {
    if (!id) return false;
    if (!state.enabled) return true;
    const until = state.unlocked[id];
    if (until === 'locked') return false;
    if (!state.known) return true;
    return !!until && Date.parse(until) > now;
  }, [state, now]);
  const markOpen = useCallback((id, until) => setState((x) => ({ ...x, unlocked: { ...x.unlocked, [id]: until } })), []);
  const markLocked = useCallback((id) => setState((x) => ({ ...x, unlocked: { ...x.unlocked, [id]: 'locked' } })), []);
  const untilOf = useCallback((id) => { const u = state.unlocked[id]; return u && u !== 'locked' ? u : ''; }, [state]);
  return { ready: true, enabled: state.enabled, isOpen, markOpen, markLocked, untilOf };
}

/** True for the server's "this file is locked" answer. */
export const isLockedError = (e) => e?.status === 423 || e?.detail?.code === 'pfs_locked';

/** The small lock beside each file in the list. */
export function PfsLockIcon({ open }) {
  const Icon = open ? LockOpen : Lock;
  return (
    <Icon size={13} aria-label={open ? 'Open in this tab' : 'Locked'} role="img"
      style={{ flexShrink: 0, color: open ? 'var(--ok-fg, #15803d)' : 'var(--text-muted)' }} />
  );
}

/** What a locked file shows instead of its statement: send a code, type it. */
export function PfsUnlockPanel({ file, onUnlocked }) {
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const send = () => {
    setBusy('send');
    setError('');
    api.requestPfsCode(file.id)
      .then((r) => { setSentTo(r?.sentTo || 'your email'); setCode(''); })
      .catch((e) => setError(e?.message || 'Could not send the code.'))
      .finally(() => setBusy(''));
  };
  const verify = (e) => {
    e.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy('verify');
    setError('');
    api.verifyPfsCode(file.id, code)
      .then((r) => onUnlocked(file.id, r?.unlockedUntil || ''))
      .catch((err) => { setError(err?.message || 'That code did not work.'); setBusy(''); });
  };
  return (
    <div style={{ ...card, padding: 22, display: 'grid', gap: 12, justifyItems: 'start', maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)' }}><Lock size={18} /></span>
        <div>
          <div style={{ fontSize: '0.98rem', fontWeight: 700 }}>{file?.name || 'This File'} Is Locked</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Opening it takes a one-time code sent to your email.</div>
        </div>
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        The code opens this one file, in this tab, for 30 minutes. The borrowers are emailed each time their file is opened, and every open is kept in the access log.
      </div>
      {!sentTo && (
        <button type="button" className="primary-btn" onClick={send} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
          {busy === 'send' ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} Send Code
        </button>
      )}
      {sentTo && (
        <form onSubmit={verify} style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
          <label htmlFor="pfs-otp" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Code sent to {sentTo}. It expires in 10 minutes.</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input id="pfs-otp" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} value={code} aria-label="One-time code"
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000"
              style={{ ...control, width: 140, fontSize: '1.05rem', letterSpacing: 4, fontVariantNumeric: 'tabular-nums' }} />
            <button type="submit" className="primary-btn" disabled={code.length !== 6 || !!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
              {busy === 'verify' ? <Loader2 size={14} className="spin" /> : <LockOpen size={14} />} Open File
            </button>
            <button type="button" className="secondary-btn" onClick={send} disabled={!!busy} style={{ fontSize: '0.78rem' }}>Send a New Code</button>
          </div>
        </form>
      )}
      {error && <div role="alert" style={bad}>{error}</div>}
    </div>
  );
}

/** "Lock Now": closes the open file in this tab before its 30 minutes are up. */
export function PfsLockNow({ fileId, until, onLocked }) {
  const [busy, setBusy] = useState(false);
  if (!fileId) return null;
  return (
    <button type="button" className="secondary-btn" disabled={busy} title={until ? `Open until ${formatTime(until)}` : undefined}
      onClick={() => { setBusy(true); api.lockPfsFile(fileId).catch(() => {}).finally(() => { setBusy(false); onLocked(fileId); }); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
      <Lock size={14} /> Lock Now
    </button>
  );
}

const ACTION_LABEL = {
  otp_sent: 'Code Sent', unlocked: 'Opened', failed: 'Wrong Code', viewed: 'Viewed', exported: 'Exported', locked: 'Locked', notified: 'Borrowers Notified',
};

/** The access log (owners and editors): who opened which file, when, and what they did. */
export function PfsAccessLog({ files = [], initialFileId = '', onClose }) {
  const nameOf = useNameResolver();
  const [fileId, setFileId] = useState(initialFileId);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api.getPfsAccessLog(fileId)
      .then((r) => { if (alive) setRows(r || []); })
      .catch((e) => { if (alive) { setRows([]); setError(e?.message || 'Could not load the access log.'); } });
    return () => { alive = false; };
  }, [fileId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const detail = (r) => {
    const d = r.details || {};
    if (r.action === 'notified') return `${(d.to || []).join(', ')}${d.sent === false ? ' - not sent' : ''}`;
    if (r.action === 'otp_sent') return d.to ? `To ${d.to}` : '';
    if (r.action === 'failed') return d.attempt ? `Try ${d.attempt} of 5` : '';
    if (r.action === 'unlocked') return d.how === 'created' ? 'Created the file' : d.until ? `Until ${formatTime(d.until)}` : '';
    if (r.action === 'exported') return d.statement ? 'Kept statement reopened' : 'Statement produced';
    return '';
  };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Access log" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><History size={18} /> Access Log</h3>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>Every code sent, every file opened, viewed and exported. Kept for good.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '12px 24px 18px', display: 'grid', gap: 10 }}>
          <select value={fileId} onChange={(e) => { setRows(null); setError(''); setFileId(e.target.value); }} aria-label="File" style={{ ...control, maxWidth: 320 }}>
            <option value="">Every File</option>
            {files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {error && <div style={bad}>{error}</div>}
          {rows === null && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={14} className="spin" /> Loading...</div>}
          {rows && !rows.length && !error && <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>Nothing yet.</div>}
          {rows && rows.length > 0 && (
            <div className="acct-lines-wrap" style={{ maxHeight: '60vh' }}>
              <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">File</th><th scope="col">Action</th><th scope="col">Details</th><th scope="col">IP Address</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.at)}</td>
                      <td>{nameOf(r.email) || r.email}</td>
                      <td>{r.fileName}</td>
                      <td style={{ whiteSpace: 'nowrap', fontWeight: 600, color: r.action === 'failed' ? 'var(--bad-fg, #dc2626)' : 'var(--text-primary)' }}>{ACTION_LABEL[r.action] || r.action}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{detail(r)}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{r.ip}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
