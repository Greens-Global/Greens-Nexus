import { useEffect, useState } from 'react';
import { Eye, Lock, X, AlertTriangle, ClipboardList, FileText } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import PublicIntake, { LABELS, SECTIONS } from '../views/PublicIntake';

// What The New Hire Will Be Asked (Pranshu, Oct 23: "I don't know how that
// intake form is going to be in the hiring packet"). One place that lists,
// live, the hire's whole form for this packet as the editor has it now: the
// details every form asks, every field a document marks The New Hire (Intake
// Form) with the documents that print it, then the packet's own extra fields
// (the editable list, passed as children). Plus what HR answers at the offer.
// The list is the server's (POST /hr/packets/intake-preview, the intake
// page's own FormView), never a second rule in the browser.

const card = { border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--card)', marginTop: 18 };
const sub = { fontSize: 12, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: '14px 0 6px' };
const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, padding: '5px 0', borderBottom: '1px solid var(--line)' };
const chip = { padding: '2px 8px', borderRadius: 10, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap', background: 'var(--mist)', color: 'var(--muted)' };
const docNote = (docs) => <span style={{ fontSize: 12, color: 'var(--muted)' }}><FileText size={11} style={{ verticalAlign: -1 }} /> {docs.join(', ')}</span>;

const payload = (docIds, extraDocs, detailsForm, companyId, roleIds) => ({
  doc_template_ids: docIds,
  entity_id: companyId || '',
  role_ids: roleIds || [],
  extra_docs: (extraDocs || []).map(r => ({ templateIds: r.templateIds || [] })),
  // A field still being typed (no label yet) is left out rather than refused.
  details_form: (detailsForm || []).filter(f => String(f.label || '').trim())
    .map(({ key, label, type, required, sensitive, last4, options, help }) => ({
      key: key || '', label, type, required: !!required, sensitive: !!sensitive, last4: !!last4, options: options || [], help: help || '' })),
});

export default function PacketIntakePanel({ docIds, extraDocs, detailsForm, companyId, roleIds, companyName, children }) {
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const key = JSON.stringify(payload(docIds, extraDocs, detailsForm, companyId, roleIds));

  useEffect(() => {
    let live = true;
    // Typing a label re-asks after a pause, not on every key.
    const t = setTimeout(() => {
      api.packetIntakePreview(JSON.parse(key))
        .then(d => { if (live) { setData(d); setProblem(''); } })
        .catch(e => { if (live) setProblem(e?.message || 'Could not work out the intake form.'); });
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [key]);

  const form = data?.form || [];
  const fromDocs = form.filter(f => f.type !== 'heading' && f.documents?.length);
  const required = new Set((data?.standard || []).filter(f => f.required).map(f => f.key));
  const page = data && {
    state: 'open', company: companyName || '', role: '', expiresOn: '', prefill: {}, afterOffer: true,
    fields: data.standard, form,
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <ClipboardList size={16} style={{ color: 'var(--pine)' }} />
        <div style={{ flex: '1 1 220px', fontSize: 14, fontWeight: 800, color: 'var(--ink)' }}>What The New Hire Will Be Asked</div>
        <button type="button" className="secondary-btn" disabled={!page} onClick={() => setPreviewOpen(true)}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Eye size={13} /> Preview Intake Form
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.55 }}>
        One form, on their phone, no login. Each question is asked once, however many documents print it.
      </div>
      {problem && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: 'hsl(var(--color-orange))', fontSize: 12.5, marginTop: 8 }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} /><span>{problem}</span>
        </div>
      )}
      {!data && !problem && <div style={{ padding: 10 }}><Spinner size={14} /></div>}

      {data && (<>
        <div style={sub}>Always Asked</div>
        {SECTIONS.map(([title, , keys]) => (
          <div key={title} style={row}>
            <b style={{ minWidth: 140 }}>{title}</b>
            <span style={{ color: 'var(--muted)' }}>
              {keys.map(k => `${LABELS[k]}${required.has(k) ? ' *' : ''}`).join(', ')}
            </span>
          </div>
        ))}

        <div style={sub}>From The Documents</div>
        {fromDocs.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            None yet. In a template&apos;s Template Fields, set a field to The New Hire (Intake Form) and it is asked here.
          </div>
        ) : fromDocs.map(f => (
          <div key={f.key} style={row} data-testid={`asked-${f.key}`}>
            <span style={{ fontWeight: 600 }}>{f.label}{f.required ? ' *' : ''}</span>
            {f.sensitive && <span style={chip} title="Only people with Pay & Benefits access see the answer"><Lock size={10} style={{ verticalAlign: -1 }} /> Private</span>}
            {f.packetOnly && <span style={chip} title="Defined on this packet below">Set On This Packet</span>}
            {docNote(f.documents)}
          </div>
        ))}

        <div style={sub}>Each Role&apos;s Own Documents</div>
        {(data.roles || []).length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            {roleIds?.length ? 'This role has no hiring documents of its own.'
              : `None of ${companyName || 'this company'}'s roles has hiring documents of its own yet. When one does, its documents and their questions are added here for hires in that role.`}
          </div>
        ) : (<>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Added to this packet for a hire in that role - their questions are asked too.</div>
          {data.roles.map(r => (
            <div key={r.id} style={row} data-testid={`role-${r.id}`}>
              <b style={{ minWidth: 140 }}>{r.name}</b>
              {docNote(r.documents)}
              {r.replaces?.length > 0 && <span style={chip}>Replaces {r.replaces.join(', ')}</span>}
              <span style={{ color: 'var(--muted)' }}>{r.asks?.length ? `Also asks: ${r.asks.join(', ')}` : 'No extra questions'}</span>
            </div>
          ))}
        </>)}
      </>)}

      <div style={sub}>Also Ask (Saved To Their Record, Not Printed In A Document)</div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        Anything else HR needs from them - an ID, a bank account. Each field is also a {'{{variable}}'} a template could print later.
      </div>
      {children}

      {data?.hrAtOffer?.length > 0 && (<>
        <div style={sub}>Filled At The Offer By HR</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Asked on the Make An Offer form, before anything is sent.</div>
        {data.hrAtOffer.map(q => (
          <div key={q.token} style={row}>
            <span style={{ fontWeight: 600 }}>{q.label}{q.required ? ' *' : ''}</span>
            {q.pay && <span style={chip}>Pay</span>}
            {docNote(q.documents)}
          </div>
        ))}
      </>)}

      {previewOpen && page && (
        <div onClick={e => e.target === e.currentTarget && setPreviewOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div className="nx-popup" role="dialog" aria-label="Intake form preview"
            style={{ background: 'var(--card)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 14 }}>Intake Form - Preview</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Exactly what the new hire sees on their link. Nothing here is sent.</div>
              </div>
              <button type="button" onClick={() => setPreviewOpen(false)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
            </div>
            <div className="nx-fill" style={{ overflowY: 'auto' }}>
              <PublicIntake preview={page} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
