// The review of an HR packet built from Documents (Neil, Oct 14): "then the HR
// manager has to verify that it's all accurate". Every document generated for
// the person, as it will be signed; what HR picked and the person's details
// (both correctable here - the documents regenerate); who signs, in order;
// and Verify And Send, which only the verifier sees. Nothing reaches the
// person before the verifier sends it.
//
// GET .../review is a pure read: when it reports a document out of date (a
// template was published meanwhile) this screen asks for one regenerate and
// reloads - it never treats the read as a writer.
import { useEffect, useRef, useState } from 'react';
import { X, FileText, Eye, Send, Ban, CheckCircle, AlertTriangle, Pencil, Lock, RefreshCw, Copy, Mail } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime, formatHHMM } from '../lib/datetime';
import { Spinner } from './AsyncState';

const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '.04em' };
const section = { border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', marginTop: 12 };
const DAY_LABELS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const STATUS_LABEL = { intake: 'Waiting On Details', review: 'Ready For Review', awaiting_sender: 'Awaiting Company Sign-Off', sent: 'Out For Signature', completed: 'Fully Signed', declined: 'Declined', voided: 'Voided', expired: 'Expired' };

const Problem = ({ children }) => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 8 }}>
    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{children}</span>
  </div>
);
const Chip = ({ tone = 'gray', children }) => (
  <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
    background: tone === 'gray' ? 'var(--mist)' : `hsla(var(--color-${tone}),0.12)`,
    color: tone === 'gray' ? 'var(--muted)' : `hsl(var(--color-${tone}))` }}>{children}</span>
);
const Row = ({ k, v }) => (
  <div style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '3px 0' }}>
    <span style={{ width: 130, flexShrink: 0, color: 'var(--muted)' }}>{k}</span>
    <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{v || <span style={{ color: 'var(--muted)' }}>-</span>}</span>
  </div>
);

function DocPreview({ eventId, doc, onClose, toastErr }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let made = '';
    api.packetDocumentPdf(eventId, doc.documentId)
      .then(({ blob }) => { made = URL.createObjectURL(blob); setUrl(made); })
      .catch(e => { toastErr?.(e?.message || 'Could not open the document.'); onClose(); });
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [eventId, doc.documentId]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1450, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 60vw, 1000px)', height: 'min(94dvh, 940px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0, fontWeight: 800, fontSize: 14 }}>{doc.title}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        {url ? <iframe title={doc.title} src={url} style={{ flex: 1, border: 'none', borderRadius: '0 0 16px 16px' }} />
          : <div style={{ display: 'flex', justifyContent: 'center', padding: 50 }}><Spinner size="section" /></div>}
      </div>
    </div>
  );
}

export default function PacketReview({ eventId, onClose, onChanged, onSignNow, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [editing, setEditing] = useState('');           // '' | 'offer' | 'details'
  const [form, setForm] = useState({});
  const [checked, setChecked] = useState(false);
  const [ack, setAck] = useState(false);
  const regenerated = useRef(false);

  const load = () => api.getPacketReview(eventId).then(setData).catch(e => { toastErr?.(e?.message || 'Could not load the packet.'); onClose(); });
  useEffect(() => { load(); }, [eventId]);   // eslint-disable-line react-hooks/exhaustive-deps
  // A template was published while this packet waited: regenerate once, then reload.
  useEffect(() => {
    if (!data?.outdated || data.event?.status !== 'review' || regenerated.current) return;
    regenerated.current = true;
    api.regeneratePacket(eventId).then(d => { setData(d); setChecked(false); }).catch(() => {});
  }, [data, eventId]);

  if (!data) {
    return (
      <Shell onClose={onClose} title="Packet" sub="">
        <div style={{ display: 'flex', justifyContent: 'center', padding: 50 }}><Spinner size="section" /></div>
      </Shell>
    );
  }
  const ev = data.event || {};
  const o = data.offer || {};
  const d = data.details || {};
  const inReview = ev.status === 'review';
  const isHire = ev.kind === 'hire';
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const startEdit = (what) => {
    setEditing(what);
    if (what === 'details') setForm({ ...d });
    else setForm({ start_date: o.startDate || '', offer_expires: o.offerExpires || '', work_start: o.workStart || '', work_end: o.workEnd || '',
      work_days: o.workDays || [], timings_text: o.timingsText || '', pay_text: data.payValues?.salary || '' });
  };
  async function saveEdit() {
    setBusy('save');
    try {
      const body = editing === 'details' ? { details: form } : {
        inputs: { start_date: form.start_date, offer_expires: form.offer_expires, work_start: form.work_start,
          work_end: form.work_end, work_days: form.work_days, timings_text: form.timings_text },
        ...(data.pay !== undefined && form.pay_text !== (data.payValues?.salary || '')
          ? { pay_values: { ...(data.payValues || {}), salary: form.pay_text } } : {}),
      };
      setData(await api.patchPacketValues(eventId, body));
      setEditing(''); setChecked(false);
      toastOk?.('Saved - the documents were regenerated.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy('');
  }
  async function send() {
    setBusy('send');
    try {
      const out = await api.verifyAndSendPacket(eventId, { excluded_ack: ack, seen: data.seen });
      onChanged?.();
      onClose();
      if (out.senderPartyId) onSignNow?.(out.senderPartyId);
      else toastOk?.(out.status === 'sent' ? `Sent - ${ev.subjectName} has been emailed the documents to sign.` : 'Sent for signature.');
    } catch (e) {
      toastErr?.(e?.message || 'Could not send the packet.');
      load();
    }
    setBusy('');
  }
  async function askAgain() {
    setBusy('ask');
    try {
      const out = await api.reopenPacketIntake(eventId);
      try { await navigator.clipboard.writeText(out.intakeUrl); } catch { /* clipboard is a convenience */ }
      toastOk?.(`A fresh link was emailed to ${out.subjectEmail} (and copied) - the old one no longer works.`);
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not send the link.'); }
    setBusy('');
  }
  async function voidIt() {
    setBusy('void');
    try { await api.voidLifeEvent(eventId); onChanged?.(); onClose(); toastOk?.('Packet voided - nothing was sent.'); }
    catch (e) { toastErr?.(e?.message || 'Could not void it.'); }
    setBusy('');
  }

  const v = data.verifier || {};
  const field = (label, key, props = {}) => (
    <div><label style={lbl}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={form[key] || ''} onChange={e => set(key, e.target.value)} {...props} /></div>
  );

  return (
    <Shell onClose={onClose} title={`${ev.title || 'Packet'} - ${ev.subjectName || ''}`}
      sub={data.packetName ? `Packet: ${data.packetName}` : ''} status={STATUS_LABEL[ev.status] || ev.status}>
      <div style={{ overflowY: 'auto', flex: 1, padding: '4px 22px 18px' }}>
        {ev.status === 'intake' && (
          <div style={{ ...section, background: 'var(--mist)', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Mail size={14} style={{ color: 'var(--muted)' }} />
            <span style={{ flex: 1, minWidth: 200 }}>Waiting for {ev.subjectName} to fill in their details at {ev.subjectEmail}. The documents are generated the moment they do.</span>
            <button type="button" className="secondary-btn" onClick={askAgain} disabled={!!busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              {busy === 'ask' ? <Spinner size={12} /> : <Copy size={12} />} Send Link Again
            </button>
          </div>
        )}
        {!inReview && ev.status !== 'intake' && (
          <div style={{ ...section, background: 'var(--mist)', fontSize: 12.5 }}>This packet was sent{ev.verifiedBy ? ` after ${ev.verifiedBy} verified it` : ''}. What went out is in Nexus Sign; it is never edited.</div>
        )}

        <div style={section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <b style={{ fontSize: 13 }}>{isHire ? 'Offer' : ev.kind === 'promotion' ? 'The Change' : 'Leaving'}</b>
            {inReview && editing !== 'offer' && <button type="button" className="secondary-btn" onClick={() => startEdit('offer')} style={{ marginLeft: 'auto', fontSize: 11.5, padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Pencil size={11} /> Edit</button>}
          </div>
          {editing === 'offer' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              {isHire && field('Start Date', 'start_date', { type: 'date' })}
              {isHire && field('Offer Expires', 'offer_expires', { type: 'date' })}
              {field('Starts At', 'work_start', { type: 'time' })}
              {field('Ends At', 'work_end', { type: 'time' })}
              <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Work Days</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {DAY_LABELS.map(([k, l]) => {
                    const on = (form.work_days || []).includes(k);
                    return <button key={k} type="button" onClick={() => set('work_days', on ? form.work_days.filter(x => x !== k) : [...(form.work_days || []), k])}
                      style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid var(--line)', fontSize: 12, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                        background: on ? 'var(--pine)' : 'var(--card)', color: on ? '#fff' : 'var(--ink)' }}>{l}</button>;
                  })}
                </div></div>
              <div style={{ gridColumn: '1 / -1' }}>{field('Or Describe The Timings', 'timings_text', { placeholder: 'e.g. Rotating shifts, 40 hours a week' })}</div>
              {data.pay !== undefined && <div style={{ gridColumn: '1 / -1' }}>{field('Pay As Written (Optional)', 'pay_text', { placeholder: 'Leave blank to print the pay entered on the offer' })}</div>}
            </div>
          ) : (
            <>
              {isHire && <Row k="Role" v={o.jobTitle && `${o.jobTitle}${o.department ? ` - ${o.department}` : ''}`} />}
              {isHire && <Row k="Start Date" v={formatDate(o.startDate)} />}
              {isHire && <Row k="Offer Expires" v={formatDate(o.offerExpires)} />}
              {isHire && <Row k="Supervisor" v={o.managerName} />}
              {ev.kind === 'promotion' && <Row k="New Role" v={o.jobTitle} />}
              {ev.kind === 'promotion' && <Row k="Effective" v={formatDate(o.effectiveDate)} />}
              {ev.kind === 'separation' && <Row k="Last Day" v={formatDate(o.lastDay)} />}
              <Row k="Timings" v={o.schedule || (o.workStart && o.workEnd ? `${formatHHMM(o.workStart)} - ${formatHHMM(o.workEnd)}` : '')} />
              {isHire && <Row k="Job Description" v={o.jdName} />}
              {o.employeeCode && <Row k="Employee Number" v={o.employeeCode} />}
              {data.pay !== undefined
                ? <Row k="Pay" v={data.payText} />
                : <Row k="Pay" v={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}><Lock size={12} /> Pay & Benefits access needed</span>} />}
            </>
          )}
        </div>

        {(isHire || Object.keys(d).length > 0) && (
          <div style={section}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <b style={{ fontSize: 13 }}>Details</b>
              {inReview && editing !== 'details' && <button type="button" className="secondary-btn" onClick={() => startEdit('details')} style={{ marginLeft: 'auto', fontSize: 11.5, padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Pencil size={11} /> Edit</button>}
            </div>
            {editing === 'details' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                {field('Legal First Name *', 'first_name')}
                {field('Legal Last Name *', 'last_name')}
                {field('Preferred Name', 'preferred_name')}
                {field('Phone', 'phone')}
                <div style={{ gridColumn: '1 / -1' }}>{field('Current Address', 'address')}</div>
                <div style={{ gridColumn: '1 / -1' }}>{field('Permanent Address', 'permanent_address')}</div>
                {field('Emergency Contact', 'emergency_name')}
                {field('Relationship', 'emergency_relationship')}
                {field('Emergency Phone', 'emergency_phone')}
              </div>
            ) : (
              <>
                <Row k="Legal Name" v={[d.first_name, d.last_name].filter(Boolean).join(' ')} />
                {d.preferred_name && <Row k="Preferred Name" v={d.preferred_name} />}
                <Row k="Phone" v={d.phone} />
                <Row k="Address" v={d.address} />
                {d.permanent_address && <Row k="Permanent Address" v={d.permanent_address} />}
                <Row k="Emergency Contact" v={d.emergency_name && `${d.emergency_name}${d.emergency_relationship ? ` (${d.emergency_relationship})` : ''}${d.emergency_phone ? ` - ${d.emergency_phone}` : ''}`} />
              </>
            )}
          </div>
        )}
        {editing && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="secondary-btn" onClick={() => setEditing('')} disabled={!!busy}>Cancel</button>
            <button className="primary-btn" onClick={saveEdit} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy === 'save' ? <Spinner size={13} /> : <CheckCircle size={13} />} Save And Regenerate
            </button>
          </div>
        )}

        <div style={section}>
          <b style={{ fontSize: 13 }}>Documents</b>
          {(data.documents || []).map((doc, i) => (
            <div key={doc.documentId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
              <span style={{ width: 20, color: 'var(--muted)', fontWeight: 700, fontSize: 12 }}>{i + 1}</span>
              <FileText size={15} style={{ color: 'var(--pine)', flexShrink: 0 }} />
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{doc.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                  {doc.templateName} - template v{doc.templateVersion}{doc.publishedAt ? `, published ${formatDateTime(doc.publishedAt)}${doc.publishedBy ? ` by ${doc.publishedBy}` : ''}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 5, marginTop: 4, flexWrap: 'wrap' }}>
                  {doc.printsPay && <Chip tone="blue">Shows Pay</Chip>}
                  {doc.outdated && <Chip tone="orange">Updating...</Chip>}
                  {doc.unresolved?.length > 0 && <Chip tone="orange">{doc.unresolved.length} Unfilled</Chip>}
                </div>
              </div>
              {doc.canOpen
                ? <button type="button" className="secondary-btn" onClick={() => setPreview(doc)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Eye size={12} /> Preview</button>
                : <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Lock size={12} /> Needs Pay & Benefits Access</span>}
            </div>
          ))}
          {data.outdated && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}><RefreshCw size={12} /> A template was updated - refreshing the documents...</div>}
        </div>

        <div style={section}>
          <b style={{ fontSize: 13 }}>Signing Order</b>
          {(data.recipients || []).map(r => (
            <div key={`${r.order}-${r.email}`} style={{ fontSize: 12.5, padding: '4px 0', display: 'flex', gap: 8 }}>
              <span style={{ width: 20, color: 'var(--muted)', fontWeight: 700 }}>{r.order}</span>
              <span style={{ flex: 1 }}>{r.name} <span style={{ color: 'var(--muted)' }}>({r.isSubject ? 'the person' : r.roleLabel}) - {r.actionLabel}</span></span>
            </div>
          ))}
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            Verified by {v.name ? <b style={{ color: 'var(--ink)' }}>{v.name}</b> : 'nobody yet'} ({v.roleLabel || 'HR'}).
          </div>
        </div>

        {(data.problems || []).map(p => <Problem key={p}>{p}</Problem>)}

        {inReview && data.isVerifier && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12.5 }}>
              <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} style={{ marginTop: 2, accentColor: 'var(--pine)' }} />
              I checked every document - the names, dates, pay and wording are right.
            </label>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12.5 }}>
              <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ marginTop: 2, accentColor: 'var(--pine)' }} />
              This is not a record that cannot be signed electronically.
            </label>
          </div>
        )}
      </div>
      <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, flexWrap: 'wrap' }}>
        {inReview && !data.isVerifier && (
          <span style={{ fontSize: 12.5, color: 'var(--muted)', marginRight: 'auto' }}>Waiting For {v.name || 'the verifier'} ({v.roleLabel || 'HR'}) To Verify</span>
        )}
        {['intake', 'review'].includes(ev.status) && (
          <button className="secondary-btn" onClick={voidIt} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'void' ? <Spinner size={13} /> : <Ban size={13} />} Void Packet
          </button>
        )}
        <button className="secondary-btn" onClick={onClose} disabled={busy === 'send'}>Close</button>
        {inReview && data.isVerifier && (
          <button className="primary-btn" onClick={send} disabled={!!busy || !data.canVerify || !checked || !ack || !!editing}
            title={!data.canVerify ? 'Fix the problems listed first' : !checked || !ack ? 'Tick both boxes first' : ''}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'send' ? <Spinner size={13} /> : <Send size={13} />} Verify And Send
          </button>
        )}
      </div>
      {preview && <DocPreview eventId={eventId} doc={preview} onClose={() => setPreview(null)} toastErr={toastErr} />}
    </Shell>
  );
}

function Shell({ title, sub, status, onClose, children }) {
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1350, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 60vw, 1000px)', maxHeight: 'min(94dvh, 920px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {title} {status && <Chip tone="orange">{status}</Chip>}
            </div>
            {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{sub}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
