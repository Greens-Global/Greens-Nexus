import { useEffect, useState } from 'react';
import { CheckCircle, AlertTriangle, Send } from 'lucide-react';
import { fetchPublicIntake, submitPublicIntake } from '../api';
import { formatDate } from '../lib/datetime';
import { Spinner } from '../components/AsyncState';

// ── A candidate's details page - /intake/{token} (Oct 14) ───────────────────
// "Hey, tell me your name, your address ... You fill it all in. Then it
// generates that hiring paperwork instantly" (Neil). Renders OUTSIDE the MSAL
// gate like /sign/{token}: the candidate has no Nexus login; the link's token
// is the credential (stored hashed, used once, dead after the offer expires).
// Shows nothing beyond the company and the role - never pay. The documents
// come later, in their own signing email, once HR has checked them.

const LABELS = {
  first_name: 'Legal First Name', last_name: 'Legal Last Name', preferred_name: 'Preferred Name',
  phone: 'Phone', address: 'Current Address', permanent_address: 'Permanent Address (If Different)',
  emergency_name: 'Emergency Contact Name', emergency_relationship: 'Relationship', emergency_phone: 'Emergency Contact Phone',
};
const WIDE = ['address', 'permanent_address'];
const lbl = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted, #6b7280)', display: 'block', margin: '12px 0 5px' };
const input = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--line, #d1d5db)', borderRadius: 10, padding: '10px 12px', fontSize: 14, fontFamily: 'Inter,sans-serif', background: 'var(--card, #fff)', color: 'var(--ink, #111827)' };

export default function PublicIntake({ token }) {
  const [page, setPage] = useState(null);
  const [error, setError] = useState('');
  const [v, setV] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetchPublicIntake(token)
      .then(p => { setPage(p); setV({ first_name: p.firstName || '', last_name: p.lastName || '', phone: p.phone || '' }); })
      .catch(e => setError(e.message || 'This link is not valid - please contact HR.'));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setProblem('');
    try { await submitPublicIntake(token, v); setDone(true); }
    catch (err) { setProblem(err.message || 'Could not send your details - please try again.'); }
    setBusy(false);
  }

  const shell = (children) => (
    <div style={{ minHeight: '100dvh', background: 'var(--bg, #f3f4f6)', fontFamily: 'Inter,sans-serif', padding: '28px 16px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#14532d', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15 }}>
            {(page?.company || 'G').slice(0, 1)}
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--ink, #111827)' }}>{page?.company || 'Nexus'}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted, #6b7280)' }}>Human Resources</div>
          </div>
        </div>
        <div style={{ background: 'var(--card, #fff)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 16, padding: '24px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          {children}
        </div>
      </div>
    </div>
  );
  const message = (Icon, color, title, text) => shell(
    <div style={{ textAlign: 'center', padding: '18px 4px' }}>
      <Icon size={34} style={{ color }} />
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 10, color: 'var(--ink, #111827)' }}>{title}</div>
      <div style={{ fontSize: 14, color: 'var(--muted, #6b7280)', marginTop: 6, lineHeight: 1.6 }}>{text}</div>
    </div>,
  );

  if (error) return message(AlertTriangle, 'hsl(30,80%,48%)', 'This Link Is Not Valid', error);
  if (!page) return shell(<div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size="section" /></div>);
  if (done || page.state === 'submitted') {
    return message(CheckCircle, 'hsl(142,60%,35%)', 'Thank You',
      `Your details are with ${page.company || 'HR'}. You will receive your documents to sign in a separate email once HR has prepared them.`);
  }
  if (page.state === 'expired') return message(AlertTriangle, 'hsl(30,80%,48%)', 'This Link Has Expired', 'Please contact HR for a new one.');
  if (page.state !== 'open') return message(AlertTriangle, 'hsl(30,80%,48%)', 'This Link Is No Longer Active', 'Please contact HR.');

  const required = new Set((page.fields || []).filter(f => f.required).map(f => f.key));
  return shell(
    <form onSubmit={submit}>
      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--ink, #111827)' }}>Complete Your Details</div>
      <div style={{ fontSize: 14, color: 'var(--muted, #6b7280)', marginTop: 6, lineHeight: 1.6 }}>
        HR uses these to prepare your hiring documents{page.role ? <> for <b>{page.role}</b></> : null}. You will sign them in a separate email.
        {page.expiresOn ? ` This link works through ${formatDate(page.expiresOn)}.` : ''}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 14px', marginTop: 8 }}>
        {(page.fields || []).map(({ key }) => (
          <div key={key} style={WIDE.includes(key) ? { gridColumn: '1 / -1' } : undefined}>
            <label style={lbl} htmlFor={`f-${key}`}>{LABELS[key] || key}{required.has(key) ? ' *' : ''}</label>
            <input id={`f-${key}`} style={input} value={v[key] || ''} required={required.has(key)}
              autoComplete={{ first_name: 'given-name', last_name: 'family-name', phone: 'tel', address: 'street-address' }[key] || 'off'}
              onChange={e => setV(p => ({ ...p, [key]: e.target.value }))} />
          </div>
        ))}
      </div>
      {problem && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(30,80%,48%,0.1)', color: 'hsl(30,80%,40%)', borderRadius: 10, padding: '9px 12px', fontSize: 13, marginTop: 14 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} /><span>{problem}</span>
        </div>
      )}
      <button type="submit" disabled={busy}
        style={{ marginTop: 20, width: '100%', border: 'none', borderRadius: 12, padding: '12px 16px', background: '#14532d', color: '#fff', fontSize: 15, fontWeight: 700, cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'Inter,sans-serif', opacity: busy ? 0.7 : 1 }}>
        {busy ? <Spinner size={16} /> : <Send size={16} />} Send To HR
      </button>
      <div style={{ fontSize: 12, color: 'var(--muted, #9ca3af)', textAlign: 'center', marginTop: 12 }}>
        This link is unique to you - please do not share it.
      </div>
    </form>,
  );
}
