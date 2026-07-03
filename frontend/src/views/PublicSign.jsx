import { useState, useEffect } from 'react';
import { FileSignature, Loader2, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { API_BASE } from '../api';
import { SigningDoc } from '../components/ESign';

// ── Public signing page — /sign/{token} ───────────────────────────────────────
// Renders OUTSIDE the MSAL gate (external signers have no login); the URL token
// is the credential. Talks to /esign/public/* with plain fetch — never MSAL.

async function pfetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
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
  const [done, setDone] = useState('');       // '' | 'signed' | 'declined'

  useEffect(() => {
    pfetch(`/esign/public/${token}`).then(setPayload)
      .catch(e => setError(e.message === 'Error 404' || /not found/i.test(e.message)
        ? 'This signing link is invalid or no longer active.' : e.message));
  }, [token]);

  async function submit(data) {
    setBusy(true);
    try {
      const r = await pfetch(`/esign/public/${token}/sign`, { method: 'POST', body: JSON.stringify(data) });
      setDone(r.status === 'completed' ? 'signed-final' : 'signed');
    } catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function decline(reason) {
    setBusy(true);
    try { await pfetch(`/esign/public/${token}/decline`, { method: 'POST', body: JSON.stringify({ reason }) }); setDone('declined'); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  const shell = (children) => (
    <div style={{ minHeight: '100dvh', background: 'var(--bg, #f3f4f6)', fontFamily: 'Inter,sans-serif', padding: '28px 14px' }}>
      <div style={{ maxWidth: 780, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#14532d', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15 }}>G</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--ink, #111827)' }}>Greens Global</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted, #6b7280)' }}>Secure e-signature</div>
          </div>
        </div>
        <div style={{ background: 'var(--card, #fff)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 16, padding: '24px 26px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          {children}
        </div>
        <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted, #9ca3af)', marginTop: 16 }}>
          Powered by Greens Nexus E-Sign · Your signature is captured with a tamper-evident audit trail.
        </p>
      </div>
    </div>
  );

  if (error) return shell(
    <div style={{ textAlign: 'center', padding: '30px 10px' }}>
      <AlertTriangle size={34} style={{ color: 'hsl(30,80%,48%)', marginBottom: 12 }} />
      <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Can't open this document</h2>
      <p style={{ fontSize: 13.5, color: 'var(--muted, #6b7280)', margin: 0 }}>{error}</p>
    </div>
  );
  if (done) return shell(
    <div style={{ textAlign: 'center', padding: '30px 10px' }}>
      {done === 'declined'
        ? <XCircle size={38} style={{ color: 'hsl(350,65%,48%)', marginBottom: 12 }} />
        : <CheckCircle size={38} style={{ color: 'hsl(142,60%,35%)', marginBottom: 12 }} />}
      <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>
        {done === 'declined' ? 'Declined' : done === 'signed-final' ? 'All done — document complete!' : 'Signed!'}
      </h2>
      <p style={{ fontSize: 13.5, color: 'var(--muted, #6b7280)', margin: 0 }}>
        {done === 'declined'
          ? 'The sender has been notified of your decision.'
          : done === 'signed-final'
            ? 'Every party has signed. You will receive the sealed copy by email.'
            : 'Thank you. The remaining signers have been notified, and you\'ll get the final copy once everyone has signed.'}
      </p>
    </div>
  );
  if (!payload) return shell(
    <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--muted, #6b7280)' }}>
      <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
    </div>
  );

  return shell(
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <FileSignature size={19} style={{ color: '#14532d', flexShrink: 0 }} />
        <h1 style={{ fontSize: 17, fontWeight: 800, margin: 0, flex: 1 }}>{payload.title}</h1>
      </div>
      <SigningDoc payload={payload} busy={busy} onSubmit={submit} onDecline={decline} />
    </>
  );
}
