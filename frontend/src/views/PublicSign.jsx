import { useState, useEffect, useCallback } from 'react';
import { FileSignature, Loader2, CheckCircle, XCircle, AlertTriangle, Lock, Download, Clock, Mail, Phone } from 'lucide-react';
import { API_BASE } from '../api';
import { SigningDoc } from '../components/ESign';

// ── Nexus Sign - public signing page, /sign/{token} ───────────────────────────
// Renders OUTSIDE the MSAL gate (external signers have no login); the URL token
// is the credential. Talks to /esign/public/* with plain fetch - never MSAL.
//
// The whole page is built for someone who has never seen Nexus: they get the
// sender's real identity before anything else, then consent, then a one-time
// code, and only then the document. That ordering is enforced by the server -
// the payload simply has no document URLs until both gates are cleared.

const legalLink = { color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 };

async function pfetch(path, opts = {}) {
  const { code, ...rest } = opts;   // access code travels as a header, never a query param (logs/history leak)
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(code ? { 'X-Access-Code': code } : {}) },
    ...rest,
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).detail; } catch { /* non-json error */ }
    throw new Error(msg || `Error ${res.status}`);
  }
  return res.json();
}

export default function PublicSign({ token }) {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');       // '' | 'signed' | 'signed-final' | 'declined'
  const [code, setCode] = useState('');       // access code (kept for sign/decline/download)
  const [codeInput, setCodeInput] = useState('');

  const load = (c = code) =>
    pfetch(`/esign/public/${token}`, { code: c })
      .then(p => { setPayload(p); if (!p.locked) setCode(c); return p; })
      .catch(e => setError(e.message === 'Error 404' || /not found/i.test(e.message)
        ? 'This signing link is invalid or no longer active.' : e.message));
  useEffect(() => { load(''); }, [token]);

  const post = (path, body) => pfetch(`/esign/public/${token}${path}`,
    { method: 'POST', body: JSON.stringify({ ...body, access_code: code }) });

  // Upload fields travel as multipart, so this cannot go through `post` - the
  // browser must set its own boundary, and pfetch's JSON header would break it.
  // Returning a signed paper copy. Multipart, like the upload fields, and on
  // success the payload reloads so the page shows the completed state rather
  // than the signing screen the person just stepped out of.
  const historyApi = useCallback(
    () => pfetch(`/esign/public/${token}/history`, { code }),
    [token, code]);

  const paperApi = async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    if (code) fd.append('access_code', code);
    const r = await fetch(`${API_BASE}/esign/public/${token}/paper`, {
      method: 'POST', body: fd, headers: code ? { 'X-Access-Code': code } : {},
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || `Error ${r.status}`);
    }
    const out = await r.json();
    setDone(out.status === 'completed' ? 'signed-final' : 'signed');
    return out;
  };

  const uploadApi = async (fieldId, file) => {
    const fd = new FormData();
    fd.append('field_id', fieldId);
    fd.append('file', file);
    if (code) fd.append('access_code', code);
    const r = await fetch(`${API_BASE}/esign/public/${token}/upload`, {
      method: 'POST', body: fd, headers: code ? { 'X-Access-Code': code } : {},
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || `Error ${r.status}`);
    }
    return r.json();
  };

  // The two gates. Each resolves, then the page reloads the payload and the
  // server decides what comes next - the client never advances itself.
  const gateApi = {
    consent:    ()        => post('/consent', { agreed: true }),
    otpRequest: (channel) => post('/otp/request', { channel }),
    otpVerify:  (c)       => post('/otp/verify', { code: c }),
  };

  async function submit(data) {
    setBusy(true);
    try {
      const r = await post('/sign', data);
      setDone(r.status === 'completed' ? 'signed-final' : 'signed');
    } catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function decline(reason) {
    setBusy(true);
    try { await post('/decline', { reason }); setDone('declined'); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function download() {
    setBusy(true);
    try {
      const r = await pfetch(`/esign/public/${token}/download`, { code });
      window.open(r.url, '_blank', 'noopener');
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  // Wide by default (review section 6.2): a letter page at a readable zoom does
  // not fit in 780px, and the gates are centered within this by their own
  // max-width rather than by squeezing the shell.
  const shell = (children, width = 1140) => (
    <div style={{ minHeight: '100dvh', background: 'var(--bg, #f3f4f6)', fontFamily: 'Inter,sans-serif', padding: '28px 16px' }}>
      <div style={{ maxWidth: width, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#14532d', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15 }}>G</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--ink, #111827)' }}>Nexus Sign</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted, #6b7280)' }}>Secure electronic signature</div>
          </div>
        </div>
        <div style={{ background: 'var(--card, #fff)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 16, padding: '24px 26px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          {children}
        </div>
        {/* The legal strip DocuSign carries bottom-left and the review asked
            for by name: powered-by, terms, privacy, copyright. An external
            signer has no other route to these - there is no Nexus shell here. */}
        <footer style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line, #e5e7eb)',
          display: 'flex', flexWrap: 'wrap', gap: '6px 16px', alignItems: 'center',
          justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted, #9ca3af)' }}>
          <span style={{ fontWeight: 600 }}>Powered by Nexus Sign</span>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
            <a href="/terms" target="_blank" rel="noreferrer" style={legalLink}>Terms of Use</a>
            <a href="/privacy" target="_blank" rel="noreferrer" style={legalLink}>Privacy Policy</a>
            <span>&copy; {new Date().getFullYear()} Greens Global</span>
          </span>
        </footer>
        <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted, #9ca3af)', marginTop: 10 }}>
          Your signature is captured with a tamper-evident audit trail.
        </p>
      </div>
    </div>
  );

  // Who asked - shown above the document, because an external signer is being
  // asked to trust a domain they have never seen. Same details as the email, so
  // the two can be checked against each other.
  const senderCard = (s) => !s ? null : (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', justifyContent: 'space-between',
      border: '1px solid var(--line, #e5e7eb)', background: 'var(--mist, #f6f7f9)', borderRadius: 12, padding: '12px 16px', marginBottom: 16 }}>
      <div style={{ minWidth: 200 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted, #6b7280)', letterSpacing: '.06em', textTransform: 'uppercase' }}>Sent by</div>
        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 3 }}>{s.name}</div>
        {(s.title || s.entity) && (
          <div style={{ fontSize: 12, color: 'var(--muted, #6b7280)' }}>
            {[s.title, s.entity].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5 }}>
        {s.email && (
          <a href={`mailto:${s.email}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#15803d', textDecoration: 'none', fontWeight: 600 }}>
            <Mail size={13} /> {s.email}
          </a>
        )}
        {s.phone && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted, #6b7280)' }}>
            <Phone size={13} /> {s.phone}
          </span>
        )}
      </div>
    </div>
  );

  if (error) return shell(
    <div style={{ textAlign: 'center', padding: '30px 10px' }}>
      <AlertTriangle size={34} style={{ color: 'hsl(30,80%,48%)', marginBottom: 12 }} />
      <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Can't open this document</h2>
      <p style={{ fontSize: 13.5, color: 'var(--muted, #6b7280)', margin: 0 }}>{error}</p>
    </div>, 620);

  // Completion. The three outcomes are deliberately distinct (review section
  // 13): this signer is done, others are still outstanding, or the document is
  // fully executed. None of them is allowed to read "Pending".
  if (done) return shell(
    <div style={{ textAlign: 'center', padding: '30px 10px' }}>
      {done === 'declined'
        ? <XCircle size={40} style={{ color: 'hsl(350,65%,48%)', marginBottom: 12 }} />
        : <CheckCircle size={44} style={{ color: 'hsl(142,60%,35%)', marginBottom: 12, animation: 'nexus-sign-pop .45s ease-out' }} />}
      <style>{'@keyframes nexus-sign-pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}'}</style>
      <h2 style={{ fontSize: 19, margin: '0 0 8px', fontWeight: 800 }}>
        {done === 'declined' ? 'Declined'
          : done === 'signed-final' ? 'Fully Executed'
            : 'Signed'}
      </h2>
      <p style={{ fontSize: 13.5, color: 'var(--muted, #6b7280)', margin: '0 auto', maxWidth: 440, lineHeight: 1.6 }}>
        {done === 'declined'
          ? 'The sender has been notified and will be in touch about signing on paper.'
          : done === 'signed-final'
            ? 'Every required signer has signed. Keep a copy for your records - it includes the signing certificate.'
            : 'Thank you. The remaining signers have been notified, and you will be emailed the fully executed copy once everyone has signed.'}
      </p>
      {done === 'signed-final' && (
        <button onClick={download} disabled={busy}
          style={{ marginTop: 18, display: 'inline-flex', alignItems: 'center', gap: 8, background: '#15803d', color: '#fff', border: 'none', borderRadius: 9, padding: '12px 26px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
          <Download size={15} /> Download Signed Copy
        </button>
      )}
      {done === 'signed' && (
        <div style={{ marginTop: 18, display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--muted, #6b7280)' }}>
          <Clock size={14} /> Waiting for the other signers
        </div>
      )}
    </div>, 620);

  if (!payload) return shell(
    <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--muted, #6b7280)' }}>
      <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
    </div>, 620);

  // Access-code gate - the sender shared a code with this signer out-of-band.
  // This sits BEFORE consent because it is a property of the link itself, not
  // a step of the signing experience.
  if (payload.locked) return shell(
    <form onSubmit={e => { e.preventDefault(); if (codeInput.trim()) load(codeInput.trim()); }}
      style={{ textAlign: 'center', padding: '26px 10px' }}>
      <Lock size={32} style={{ color: '#14532d', marginBottom: 12 }} />
      <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>{payload.title}</h2>
      <p style={{ fontSize: 13.5, color: 'var(--muted, #6b7280)', margin: '0 0 4px' }}>
        This document is protected - enter the access code the sender shared with you.
      </p>
      {payload.wrongCode && (
        <p style={{ fontSize: 12.5, color: 'hsl(350,65%,48%)', margin: '6px 0 0', fontWeight: 600 }}>
          That code wasn't right - try again.
        </p>
      )}
      <input autoFocus value={codeInput} onChange={e => setCodeInput(e.target.value)} placeholder="Access code"
        style={{ marginTop: 16, width: 240, textAlign: 'center', fontSize: 15, padding: '10px 14px', borderRadius: 9, border: '1.5px solid var(--line, #d1d5db)', fontFamily: 'Inter,sans-serif' }} />
      <div>
        <button type="submit" disabled={!codeInput.trim()}
          style={{ marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 8, background: '#15803d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 26px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif', opacity: codeInput.trim() ? 1 : 0.55 }}>
          Unlock
        </button>
      </div>
    </form>, 620);

  const gated = !!payload.gate;

  return shell(
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <FileSignature size={19} style={{ color: '#14532d', flexShrink: 0 }} />
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, flex: 1 }}>{payload.title}</h1>
        {payload.status === 'completed' && (
          <button onClick={download} disabled={busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
            <Download size={13} /> Download Signed Copy
          </button>
        )}
      </div>
      {senderCard(payload.sender)}
      <details style={{ margin: '0 0 12px' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted, #6b7280)', fontWeight: 600 }}>
          Details
        </summary>
        {/* The identifiers a signer (or their lawyer) quotes when asking about
            this exact request. Shown, not hidden, because the envelope ID is
            also stamped on every page of the finished PDF. */}
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', margin: '10px 0 0',
          fontSize: 12, color: 'var(--muted, #6b7280)' }}>
          <dt style={{ fontWeight: 600 }}>Envelope ID</dt>
          <dd style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflowWrap: 'anywhere' }}>{payload.requestId}</dd>
          <dt style={{ fontWeight: 600 }}>Recipient ID</dt>
          <dd style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflowWrap: 'anywhere' }}>{payload.partyId}</dd>
          <dt style={{ fontWeight: 600 }}>Signing as</dt>
          <dd style={{ margin: 0 }}>{payload.myName}</dd>
          {payload.expiresOn && (<>
            <dt style={{ fontWeight: 600 }}>Expires</dt>
            <dd style={{ margin: 0 }}>{payload.expiresOn}</dd>
          </>)}
        </dl>
      </details>
      {/* UETA section 8: the right to keep a copy while deciding is never
          gated on consent or on the code, so it is offered on the gates too. */}
      {gated && payload.copyUrl && (
        <p style={{ textAlign: 'center', margin: '0 0 8px' }}>
          <a href={payload.copyUrl} target="_blank" rel="noreferrer" download
            style={{ color: 'var(--muted, #6b7280)', fontSize: 12.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Download size={13} /> Download a copy to read or print
          </a>
        </p>
      )}
      <SigningDoc payload={payload} busy={busy} onSubmit={submit} onDecline={decline}
        gateApi={gateApi} onCleared={() => load()} uploadApi={uploadApi} paperApi={paperApi} historyApi={historyApi} />
    </>,
    gated ? 760 : 1140);
}
