import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, AlertTriangle, Send, Lock, User, MapPin, HeartPulse, FileText } from 'lucide-react';
import { fetchPublicIntake, submitPublicIntake } from '../api';
import { formatDate } from '../lib/datetime';
import { Spinner } from '../components/AsyncState';
import DetailsFormFields from '../components/DetailsFormFields';

// ── A new hire's details form - /intake/{token} (Oct 14) ────────────────────
// Neil: "make a Nexus workflow that collects this data ... a massive intake
// where they can do it on their phone quickly ... publicly accessible. They
// don't need a Nexus account to fill it out." Once the offer is signed, the
// hiring packet starts here: the person answers once - their details, then
// every question their documents ask (built from the documents themselves) -
// and every document fills itself in. Renders OUTSIDE the sign-in gate like
// /sign/{token}: the emailed token is the credential (stored hashed, used
// once, dead after its date). Never shows pay.
//
// `preview` (Oct 23): the packet editor's Preview Intake Form renders this
// same page from the packet's computed form (POST /hr/packets/intake-preview)
// - inert, nothing is fetched or sent - so HR sees exactly what the hire sees.

export const LABELS = {
  first_name: 'Legal First Name', last_name: 'Legal Last Name', preferred_name: 'Preferred Name',
  phone: 'Phone', address: 'Current Address', permanent_address: 'Permanent Address',
  emergency_name: 'Name', emergency_relationship: 'Relationship', emergency_phone: 'Phone',
};
export const SECTIONS = [
  ['About You', User, ['first_name', 'last_name', 'preferred_name', 'phone']],
  ['Your Address', MapPin, ['address', 'permanent_address']],
  ['Emergency Contact', HeartPulse, ['emergency_name', 'emergency_relationship', 'emergency_phone']],
];
const WIDE = ['address', 'permanent_address'];
const AUTO = { first_name: 'given-name', last_name: 'family-name', phone: 'tel', address: 'street-address', emergency_phone: 'tel' };
const ink = 'var(--ink, #111827)';
const muted = 'var(--muted, #6b7280)';
const lbl = { fontSize: 12, fontWeight: 700, color: muted, display: 'block', margin: '12px 0 5px' };
const input = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--line, #d1d5db)', borderRadius: 10, padding: '11px 12px', fontSize: 16, fontFamily: 'Inter,sans-serif', background: 'var(--card, #fff)', color: ink };
const head = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: ink, margin: '22px 0 2px', paddingTop: 14, borderTop: '1px solid var(--line, #e5e7eb)' };

export default function PublicIntake({ token, preview }) {
  const [page, setPage] = useState(preview || null);
  const [error, setError] = useState('');
  const [v, setV] = useState({});
  const [sameAddress, setSameAddress] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (preview) return;
    fetchPublicIntake(token)
      .then(p => {
        setPage(p);
        const known = p.prefill || {};
        setV({ first_name: p.firstName || '', last_name: p.lastName || '', phone: p.phone || '', ...known });
        setSameAddress(!known.permanent_address || known.permanent_address === known.address);
      })
      .catch(e => setError(e.message || 'This link is not valid - please contact HR.'));
  }, [token, preview]);

  const required = useMemo(() => new Set((page?.fields || []).filter(f => f.required).map(f => f.key)), [page]);
  const keys = useMemo(() => new Set((page?.fields || []).map(f => f.key)), [page]);
  // The documents' own questions, with a note on the private ones.
  const docForm = useMemo(() => (page?.form || []).map(f => (f.type === 'heading' ? f : {
    ...f, help: [f.help, f.sensitive ? 'Private - only the payroll team sees it.' : ''].filter(Boolean).join(' '),
  })), [page]);
  const toAnswer = [...[...keys].filter(k => required.has(k)), ...docForm.filter(f => f.type !== 'heading' && f.required).map(f => `a:${f.key}`)];
  const answered = toAnswer.filter(k => (k.startsWith('a:') ? String(v.answers?.[k.slice(2)] || '').trim() : String(v[k] || '').trim())).length;

  async function submit(e) {
    e.preventDefault();
    if (preview) return;
    setBusy(true); setProblem('');
    const values = { ...v, ...(sameAddress ? { permanent_address: v.address || '' } : {}) };
    try { await submitPublicIntake(token, values); setDone(true); }
    catch (err) { setProblem(err.message || 'Could not send your details - please try again.'); }
    setBusy(false);
  }

  const shell = (children) => (
    <div style={{ minHeight: preview ? 0 : '100dvh', background: 'var(--bg, #f3f4f6)', fontFamily: 'Inter,sans-serif', padding: '24px 16px 40px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#14532d', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15 }}>
            {(page?.company || 'G').slice(0, 1)}
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: ink }}>{page?.company || 'Nexus'}</div>
            <div style={{ fontSize: 11.5, color: muted }}>Human Resources</div>
          </div>
        </div>
        <div style={{ background: 'var(--card, #fff)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 16, padding: '22px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          {children}
        </div>
      </div>
    </div>
  );
  const message = (Icon, color, title, text) => shell(
    <div style={{ textAlign: 'center', padding: '18px 4px' }}>
      <Icon size={34} style={{ color }} />
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 10, color: ink }}>{title}</div>
      <div style={{ fontSize: 14, color: muted, marginTop: 6, lineHeight: 1.6 }}>{text}</div>
    </div>,
  );

  if (error) return message(AlertTriangle, 'hsl(30,80%,48%)', 'This Link Is Not Valid', error);
  if (!page) return shell(<div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size="section" /></div>);
  if (done || page.state === 'submitted') {
    return message(CheckCircle, 'hsl(142,60%,35%)', `Thank You${v.first_name ? `, ${v.first_name}` : ''}`,
      page.afterOffer
        ? `Your documents are being filled in from your answers. You will get an email from ${page.company || 'HR'} to sign them - no account or password needed.`
        : `Your details are with ${page.company || 'HR'}. You will receive your documents to sign in a separate email once HR has prepared them.`);
  }
  if (page.state === 'expired') return message(AlertTriangle, 'hsl(30,80%,48%)', 'This Link Has Expired', 'Please contact HR for a new one.');
  if (page.state !== 'open') return message(AlertTriangle, 'hsl(30,80%,48%)', 'This Link Is No Longer Active', 'Please contact HR.');

  const field = (key) => {
    if (!keys.has(key)) return null;
    if (key === 'permanent_address' && sameAddress) return null;
    return (
      <div key={key} style={WIDE.includes(key) ? { gridColumn: '1 / -1' } : undefined}>
        <label style={lbl} htmlFor={`f-${key}`}>{LABELS[key] || key}{required.has(key) ? ' *' : ''}</label>
        {WIDE.includes(key) ? (
          <textarea id={`f-${key}`} rows={2} style={{ ...input, resize: 'vertical' }} value={v[key] || ''} required={required.has(key)}
            autoComplete={AUTO[key] || 'off'} onChange={e => setV(p => ({ ...p, [key]: e.target.value }))} />
        ) : (
          <input id={`f-${key}`} style={input} value={v[key] || ''} required={required.has(key)} type={key.endsWith('phone') ? 'tel' : 'text'}
            autoComplete={AUTO[key] || 'off'} onChange={e => setV(p => ({ ...p, [key]: e.target.value }))} />
        )}
      </div>
    );
  };

  return shell(
    <form onSubmit={submit} inert={!!preview}>
      <div style={{ fontSize: 20, fontWeight: 800, color: ink }}>{page.afterOffer ? 'Your Onboarding Details' : 'Complete Your Details'}</div>
      <div style={{ fontSize: 14, color: muted, marginTop: 6, lineHeight: 1.6 }}>
        {page.afterOffer
          ? <>Welcome aboard{page.role ? <> as <b>{page.role}</b></> : null}! Answer once - every onboarding document fills itself in from what you enter here. You sign them next, in a separate email.</>
          : <>HR uses these to prepare your hiring documents{page.role ? <> for <b>{page.role}</b></> : null}. You will sign them in a separate email.</>}
        {page.expiresOn ? ` This link works through ${formatDate(page.expiresOn)}.` : ''}
      </div>
      {toAnswer.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--mist, #eef0f2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round((answered / toAnswer.length) * 100)}%`, background: '#15803d', transition: 'width .2s' }} />
          </div>
          <div style={{ fontSize: 12, color: muted, marginTop: 4 }}>{answered} of {toAnswer.length} required answers</div>
        </div>
      )}

      {SECTIONS.map(([title, Icon, list]) => list.some(k => keys.has(k)) && (
        <div key={title}>
          <div style={head}><Icon size={16} style={{ color: '#15803d' }} /> {title}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '0 14px' }}>
            {list.map(field)}
            {title === 'Your Address' && keys.has('permanent_address') && (
              <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: ink, marginTop: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={sameAddress} onChange={e => setSameAddress(e.target.checked)} style={{ width: 18, height: 18, accentColor: '#15803d' }} />
                My permanent address is the same
              </label>
            )}
          </div>
        </div>
      ))}

      {docForm.length > 0 && (
        <div>
          <div style={head}><FileText size={16} style={{ color: '#15803d' }} /> For Your Documents</div>
          <div style={{ fontSize: 12.5, color: muted, marginTop: 2 }}>
            Your documents need these too.{docForm.some(f => f.sensitive) && <> <Lock size={11} style={{ verticalAlign: 'middle' }} /> Private answers are seen only by the payroll team.</>}
          </div>
          <DetailsFormFields form={docForm} values={v.answers} idPrefix="a"
            onChange={answers => setV(p => ({ ...p, answers }))}
            inputStyle={input} labelStyle={lbl} gridMin={230}
            headingStyle={{ fontSize: 14, color: ink, marginTop: 18 }} />
        </div>
      )}

      {problem && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(30,80%,48%,0.1)', color: 'hsl(30,80%,40%)', borderRadius: 10, padding: '9px 12px', fontSize: 13, marginTop: 14 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} /><span>{problem}</span>
        </div>
      )}
      <button type="submit" disabled={busy}
        style={{ marginTop: 22, width: '100%', border: 'none', borderRadius: 12, padding: '13px 16px', background: '#14532d', color: '#fff', fontSize: 15.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'Inter,sans-serif', opacity: busy ? 0.7 : 1 }}>
        {busy ? <Spinner size={16} /> : <Send size={16} />} {preview ? 'Preview Only - Nothing Is Sent' : page.afterOffer ? 'Send - Prepare My Documents' : 'Send To HR'}
      </button>
      <div style={{ fontSize: 12, color: muted, textAlign: 'center', marginTop: 12, lineHeight: 1.5 }}>
        No account or password needed. This link is unique to you - please do not share it.
      </div>
    </form>,
  );
}
