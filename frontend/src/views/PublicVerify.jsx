import { useState, useEffect } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion, Loader2, AlertTriangle } from 'lucide-react';
import { API_BASE } from '../api';

// ── Public certificate verification page — /verify/{token} ──────────────────
// Renders OUTSIDE the MSAL gate (same reasoning as PublicSign.jsx — auditors,
// opposing counsel, or the other party may scan this from a printed/emailed
// copy with no Nexus login at all). Talks to /esign/public/verify/* with a
// plain fetch, never MSAL. Deliberately shows a REDACTED summary — signer
// names and dates, document-integrity + audit-chain validity — never emails,
// IP addresses, user-agents, or the raw event log (those stay behind the
// internal, authenticated Certificate of Completion).

async function vfetch(token) {
  const res = await fetch(`${API_BASE}/esign/public/verify/${token}`);
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).detail; } catch { /* non-json error */ }
    throw new Error(msg || `Error ${res.status}`);
  }
  return res.json();
}

const badge = (ok, unknownLabel) => {
  if (ok === null || ok === undefined) {
    return { Icon: ShieldQuestion, color: 'hsl(220,10%,45%)', bg: 'hsla(220,10%,45%,0.1)', label: unknownLabel };
  }
  return ok
    ? { Icon: ShieldCheck, color: 'hsl(142,60%,35%)', bg: 'hsla(142,60%,35%,0.12)', label: 'Verified' }
    : { Icon: ShieldAlert, color: 'hsl(350,65%,48%)', bg: 'hsla(350,65%,48%,0.12)', label: 'FAILED' };
};

function Badge({ ok, title, unknownLabel, detail }) {
  const b = badge(ok, unknownLabel);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12, background: b.bg }}>
      <b.Icon size={22} style={{ color: b.color, flexShrink: 0 }} />
      <div>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink, #111827)' }}>{title}: {b.label}</div>
        {detail && <div style={{ fontSize: 11.5, color: 'var(--muted, #6b7280)', marginTop: 2 }}>{detail}</div>}
      </div>
    </div>
  );
}

export default function PublicVerify({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    vfetch(token)
      .then(setData)
      .catch(e => setError(/not found/i.test(e.message)
        ? 'No verification record found for this link — it may be invalid, or the document may not be completed yet.'
        : e.message));
  }, [token]);

  const shell = (children) => (
    <div style={{ minHeight: '100dvh', background: 'var(--bg, #f3f4f6)', fontFamily: 'Inter,sans-serif', padding: '28px 14px' }}>
      <div style={{ maxWidth: 620, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#14532d', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15 }}>G</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--ink, #111827)' }}>Greens Global</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted, #6b7280)' }}>Certificate verification</div>
          </div>
        </div>
        <div style={{ background: 'var(--card, #fff)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 16, padding: '24px 26px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          {children}
        </div>
        <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted, #9ca3af)', marginTop: 16 }}>
          This page shows a redacted summary only — signer emails, IP addresses, and the full
          audit log are not exposed publicly and remain available to authorized staff internally.
        </p>
      </div>
    </div>
  );

  if (error) return shell(
    <div style={{ textAlign: 'center', padding: '30px 10px' }}>
      <AlertTriangle size={34} style={{ color: 'hsl(30,80%,48%)', marginBottom: 12 }} />
      <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Can't verify this document</h2>
      <p style={{ fontSize: 13.5, color: 'var(--muted, #6b7280)', margin: 0 }}>{error}</p>
    </div>
  );

  if (!data) return shell(
    <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--muted, #6b7280)' }}>
      <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
    </div>
  );

  return shell(
    <>
      <h2 style={{ fontSize: 18, margin: '0 0 4px', color: 'var(--ink, #111827)' }}>{data.title}</h2>
      <p style={{ fontSize: 12.5, color: 'var(--muted, #6b7280)', margin: '0 0 18px' }}>
        Envelope {data.envelopeIdShort} · Completed {(data.completedAt || '').slice(0, 19).replace('T', '  ')} UTC
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
        <Badge ok={data.documentIntegrity?.valid} title="Document integrity"
          detail="Confirms the signed document's content hasn't been altered since it was sealed." />
        <Badge ok={data.auditChain?.chainAvailable ? data.auditChain.valid : null}
          title="Audit trail" unknownLabel="Not available for this envelope"
          detail={data.auditChain?.chainAvailable
            ? `${data.auditChain.eventCount} recorded actions, cryptographically chained — each commits to every action before it.`
            : 'This envelope was completed before the audit hash-chain feature existed.'} />
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted, #6b7280)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Signers</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(data.signers || []).map((s, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, padding: '8px 0', borderBottom: i < data.signers.length - 1 ? '1px solid var(--line, #e5e7eb)' : 'none' }}>
            <span style={{ fontWeight: 600, color: 'var(--ink, #111827)' }}>{s.name || '—'}</span>
            <span style={{ color: 'var(--muted, #6b7280)' }}>
              {s.signedAt ? `Signed ${s.signedAt.slice(0, 19).replace('T', '  ')} UTC` : 'Not yet signed'}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
