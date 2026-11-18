import { useEffect, useState } from 'react';
import { KeyRound, Mail, MessageCircle, Copy, Check, ExternalLink, Lock, AlertTriangle, Clock } from 'lucide-react';
import { fetchVaultShare, sendVaultShareCode, verifyVaultShare } from '../api';
import { formatDateTime } from '../lib/datetime';
import { Spinner } from '../components/AsyncState';

// ── A login shared with someone OUTSIDE Nexus - /vault-share/{token} ───────
// (Pranshu, 11/13/2026; backend vault_external.py + routers/vault_share.py.)
// The person has no Nexus login. Renders OUTSIDE the sign-in gate like
// /sign/{token}: the emailed link names the login and who shared it, and the
// username, link and password come only after a one-time code we send to the
// invited email (or by SMS when the sharer gave a mobile number). The details
// stay on screen until the share ends, then they are wiped from the page.

const ink = 'var(--ink, #111827)';
const muted = 'var(--muted, #6b7280)';
const card = { width: '100%', maxWidth: 520, background: 'var(--card, #fff)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 16, padding: 24, boxShadow: '0 10px 30px rgba(15,23,42,.08)', boxSizing: 'border-box' };
const btn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 15, fontWeight: 700, cursor: 'pointer', background: '#1f7a3a', color: '#fff', fontFamily: 'Inter,sans-serif' };
const ghost = { ...btn, background: 'transparent', color: ink, border: '1px solid var(--line, #d1d5db)', fontWeight: 600 };
const input = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--line, #d1d5db)', borderRadius: 10, padding: '12px', fontSize: /* type-ok: iOS zooms a field under 16px */ 16, fontFamily: 'Inter,sans-serif', textAlign: 'center', letterSpacing: '0.35em' };
const row = { display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--line, #e5e7eb)', borderRadius: 10, padding: '10px 12px', marginTop: 8 };

function Field({ label, value, secret = false, href = '' }) {
  const [done, setDone] = useState(false);
  const [show, setShow] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* the field still shows it */ }
  }
  if (!value) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: muted }}>{label}</div>
      <div style={row}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: secret ? 'ui-monospace,monospace' : 'inherit', color: ink }}>
          {href ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#1f7a3a' }}>{value} <ExternalLink size={12} /></a> : secret && !show ? '•'.repeat(Math.min(16, value.length)) : value}
        </span>
        {secret && <button type="button" style={{ ...ghost, padding: '6px 10px', fontSize: 13 }} onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>}
        <button type="button" style={{ ...ghost, padding: '6px 10px', fontSize: 13 }} onClick={copy} aria-label={`Copy ${label}`}>{done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

export default function PublicVaultShare({ token }) {
  const [info, setInfo] = useState(null);       // { state, name, company, sharedBy, until, email, sms }
  const [error, setError] = useState('');
  const [channel, setChannel] = useState('email');
  const [consent, setConsent] = useState(false);
  const [sent, setSent] = useState(null);       // { challengeId, target, devCode }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(null); // the login, once verified
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    fetchVaultShare(token).then(setInfo).catch((e) => setError(e.message || 'This link is not valid.'));
  }, [token]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const until = details?.until || info?.until || 0;
  const over = !!until && now >= until;
  const shown = over ? null : details;            // the password leaves the page when the share ends

  async function getCode() {
    setBusy(true); setError('');
    try { setSent(await sendVaultShareCode(token, channel)); setCode(''); }
    catch (e) { setError(e.message || 'Could not send the code.'); }
    setBusy(false);
  }
  async function authenticate() {
    if (code.length !== 6) return;
    setBusy(true); setError('');
    try { setDetails(await verifyVaultShare(token, sent.challengeId, code)); }
    catch (e) { setError(e.message || 'That code did not work.'); }
    setBusy(false);
  }

  const left = Math.max(0, until - now);
  const leftText = left > 3600000 ? `${Math.floor(left / 3600000)}h ${Math.floor((left % 3600000) / 60000)}m` : `${Math.floor(left / 60000)}m ${Math.floor((left % 60000) / 1000)}s`;
  const ended = info && (info.state !== 'active' || over);

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'var(--bg, #f3f4f6)', fontFamily: 'Inter,sans-serif', boxSizing: 'border-box' }}>
      <div style={card} data-vault-share="">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, background: '#e8f3ec', color: '#1f7a3a', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><KeyRound size={18} /></span>
          <strong style={{ fontSize: 18, color: ink }}>{info?.name || 'Shared Login'}</strong>
        </div>
        {!info && !error && <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}
        {error && !info && <p style={{ color: '#b91c1c', display: 'flex', gap: 8 }}><AlertTriangle size={18} /> {error}</p>}
        {info && (
          <p style={{ color: muted, margin: '0 0 14px', fontSize: 14 }}>
            {info.sharedBy} at {info.company} shared this login with you{info.until ? ` until ${formatDateTime(new Date(info.until))}` : ''}.
          </p>
        )}
        {ended && <p style={{ color: ink, display: 'flex', gap: 8, alignItems: 'center' }}><Lock size={18} /> This share has ended. Ask {info.sharedBy} for a new one if you still need it.</p>}

        {info && !ended && !shown && !sent && (<>
          <p style={{ fontSize: 14, color: ink, margin: '0 0 8px' }}>To see the details, confirm it is you with a one-time code.</p>
          <label style={{ ...row, cursor: 'pointer', borderColor: channel === 'email' ? '#1f7a3a' : undefined }}>
            <input type="radio" name="code-channel" checked={channel === 'email'} onChange={() => setChannel('email')} />
            <Mail size={18} /> <span>Email a code to <b>{info.email}</b></span>
          </label>
          {info.sms && (
            <label style={{ ...row, cursor: 'pointer', borderColor: channel === 'sms' ? '#1f7a3a' : undefined }}>
              <input type="radio" name="code-channel" checked={channel === 'sms'} onChange={() => setChannel('sms')} />
              <MessageCircle size={18} /> <span>Text a code to <b>{info.sms}</b></span>
            </label>
          )}
          {channel === 'sms' && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: muted, marginTop: 8 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>I agree to receive a one-time text message with this code. Msg &amp; data rates may apply.</span>
            </label>
          )}
          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" style={{ ...btn, opacity: busy || (channel === 'sms' && !consent) ? 0.6 : 1 }} disabled={busy || (channel === 'sms' && !consent)} onClick={getCode}>{busy ? 'Sending…' : 'Get Code'}</button>
          </div>
        </>)}

        {info && !ended && !shown && sent && (<>
          <p style={{ fontSize: 14, color: ink, margin: '0 0 8px' }}>We sent a 6-digit code to <b>{sent.target}</b>. It works for 10 minutes.</p>
          {sent.devCode && <p style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', padding: '6px 10px', borderRadius: 8 }}>Local test: the code is {sent.devCode}.</p>}
          <input style={input} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" autoFocus aria-label="One-time code"
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => { if (e.key === 'Enter') authenticate(); }} />
          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <button type="button" style={ghost} onClick={() => { setSent(null); setError(''); }}>Back</button>
            <button type="button" style={{ ...btn, opacity: busy || code.length !== 6 ? 0.6 : 1 }} disabled={busy || code.length !== 6} onClick={authenticate}>{busy ? 'Checking…' : 'Authenticate'}</button>
          </div>
        </>)}

        {shown && !ended && (<>
          <p style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: muted, margin: 0 }}><Clock size={14} /> Available for {leftText} more - then this page clears.</p>
          <Field label="Username" value={shown.username} />
          <Field label="Password" value={shown.secret} secret />
          {shown.totp && <Field label="Authenticator Code (changes every 30 seconds)" value={shown.totp.code} />}
          <Field label="Link" value={shown.url} href={shown.url} />
          <p style={{ fontSize: 12, color: muted, marginTop: 16 }}>Do not save this password anywhere else. Every view is recorded.</p>
        </>)}
        {error && info && <p style={{ color: '#b91c1c', fontSize: 13, marginTop: 10 }} role="alert">{error}</p>}
      </div>
    </div>
  );
}
