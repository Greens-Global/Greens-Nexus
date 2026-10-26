// The review of an HR packet built from Documents (Neil, Oct 14): "then the HR
// manager has to verify that it's all accurate". Every document generated for
// the person, as it will be signed; what HR picked and the person's details
// (both correctable here - the documents regenerate); who signs, in order;
// and Verify And Send, which only the verifier sees. Nothing reaches the
// person before the verifier sends it.
//
// Laid out as the three things the verifier does (Pranshu, Oct 15: "simple,
// spacious"): 1 read the documents, 2 check what is printed in them, 3 confirm
// and send. One Edit for everything printed, not one per box.
//
// GET .../review is a pure read: when it reports a document out of date (a
// template was published meanwhile) this screen asks for one regenerate and
// reloads - it never treats the read as a writer.
import { useEffect, useRef, useState } from 'react';
import { X, FileText, Eye, Send, Ban, CheckCircle, AlertTriangle, Pencil, Lock, RefreshCw, Copy, Mail, PenTool, Info } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime, formatHHMM } from '../lib/datetime';
import { Spinner } from './AsyncState';
import DetailsFormFields from './DetailsFormFields';
import SignOnceModal from './SignOnceModal';
import { REPORTS_TO } from './OfferModal';

const lbl = { fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', display: 'block', margin: '0 0 5px' };
const h3 = { fontSize: 15, fontWeight: 800, margin: '24px 0 10px', color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 10 };
const num = (n) => <span style={{ width: 22, height: 22, borderRadius: 11, background: 'var(--pine)', color: '#fff', fontSize: 11.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>;
const card = { border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' };
const DAY_LABELS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const STATUS_LABEL = { intake: 'Waiting On Details', review: 'Ready For Review', awaiting_sender: 'Awaiting Company Sign-Off', sent: 'Out For Signature', completed: 'Fully Signed', declined: 'Declined', voided: 'Voided', expired: 'Expired' };

const Problem = ({ children }) => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginTop: 8 }}>
    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} /><span>{children}</span>
  </div>
);
const Chip = ({ tone = 'gray', children }) => (
  <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
    background: tone === 'gray' ? 'var(--mist)' : `hsla(var(--color-${tone}),0.12)`,
    color: tone === 'gray' ? 'var(--muted)' : `hsl(var(--color-${tone}))` }}>{children}</span>
);
const Row = ({ k, v }) => (
  <div style={{ display: 'flex', gap: 10, fontSize: 13, padding: '4px 0' }}>
    <span style={{ width: 120, flexShrink: 0, color: 'var(--muted)' }}>{k}</span>
    <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{v || <span style={{ color: 'var(--muted)' }}>-</span>}</span>
  </div>
);
const Locked = () => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}><Lock size={12} /> Pay & Benefits access needed</span>;

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
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'max(60vw, 560px)', height: 'min(94dvh, 940px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
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

export default function PacketReview({ eventId, onClose, onChanged, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [editing, setEditing] = useState(false);       // everything printed, edited together
  const [form, setForm] = useState({});
  const [checked, setChecked] = useState(false);
  const [ack, setAck] = useState(false);
  const [signing, setSigning] = useState(null);        // a Signs Once step being signed (Oct 14)
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
  const v = data.verifier || {};
  const inReview = ev.status === 'review';
  const isHire = ['offer', 'hire'].includes(ev.kind);      // the offer letter reads like a hire (Oct 14)
  // An offer only asks "do you accept?" - the emergency contact and permanent
  // address come later, on the hiring packet's form (Neil, Oct 22).
  const isOffer = ev.kind === 'offer';
  const first = (ev.subjectName || '').split(' ')[0] || 'them';
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const startEdit = () => {
    setEditing(true);
    setForm({ ...d, answers: Object.fromEntries((data.answers || []).filter(a => a.key).map(a => [a.key, a.value])),
      start_date: o.startDate || '', offer_expires: o.offerExpires || '', work_start: o.workStart || '', work_end: o.workEnd || '',
      work_days: o.workDays || [], timings_text: o.timingsText || '', pay_text: data.payValues?.salary || '' });
  };
  async function saveEdit() {
    setBusy('save');
    try {
      const { start_date, offer_expires, work_start, work_end, work_days, timings_text, pay_text, ...details } = form;
      const body = {
        details,
        inputs: { start_date, offer_expires, work_start, work_end, work_days, timings_text },
        ...(data.pay !== undefined && pay_text !== (data.payValues?.salary || '')
          ? { pay_values: { ...(data.payValues || {}), salary: pay_text } } : {}),
      };
      setData(await api.patchPacketValues(eventId, body));
      setEditing(false); setChecked(false);
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
      // Verify is a check, never a signature: the person signs first and the
      // company countersigns after them (Neil, Oct 22 2026).
      toastOk?.(out.status === 'sent' ? `Sent - ${ev.subjectName} has been emailed the documents to sign.` : 'Sent for signature.');
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

  const field = (label, key, props = {}) => (
    <div><label style={lbl} htmlFor={`rv-${key}`}>{label}</label>
      <input id={`rv-${key}`} className="form-input" style={{ width: '100%' }} value={form[key] || ''} onChange={e => set(key, e.target.value)} {...props} /></div>
  );
  const todo = ev.status === 'intake' ? `Waiting for ${first} to fill in their details - the documents are generated the moment they do.`
    : inReview && data.isVerifier ? 'Read each document, check what is printed in it, then confirm and send.'
      : inReview ? `Waiting for ${v.name || 'the verifier'} (${v.roleLabel || 'HR'}) to check and send it.`
        : `Sent${ev.verifiedBy ? ` after ${ev.verifiedBy} checked it` : ''}. What went out is in Nexus Sign and is never edited.`;

  return (
    <Shell onClose={onClose} title={`${ev.title || 'Packet'} - ${ev.subjectName || ''}`}
      sub={todo} status={STATUS_LABEL[ev.status] || ev.status}>
      <div style={{ overflowY: 'auto', flex: 1, padding: '0 28px 20px' }}>
        {ev.status === 'intake' && (
          <div style={{ ...card, background: 'var(--mist)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 18 }}>
            <Mail size={15} style={{ color: 'var(--muted)' }} />
            <span style={{ flex: 1, minWidth: 200 }}>Their link went to {ev.subjectEmail}.</span>
            <button type="button" className="secondary-btn" onClick={askAgain} disabled={!!busy} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              {busy === 'ask' ? <Spinner size={12} /> : <Copy size={12} />} Send Link Again
            </button>
          </div>
        )}

        {/* 1. The documents - the thing being checked, first and largest. */}
        <h3 style={h3}>{num(1)} Read the documents</h3>
        {(data.documents || []).length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)' }}>No documents yet.</div>}
        {(data.documents || []).map((doc, i) => (
          <div key={doc.documentId} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ width: 22, color: 'var(--muted)', fontWeight: 700, fontSize: 12.5 }}>{i + 1}</span>
            <FileText size={18} style={{ color: 'var(--pine)', flexShrink: 0 }} />
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{doc.title}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                {doc.templateName} v{doc.templateVersion}{doc.publishedAt ? ` - published ${formatDateTime(doc.publishedAt)}${doc.publishedBy ? ` by ${doc.publishedBy}` : ''}` : ''}
              </div>
              {(doc.printsPay || doc.outdated || doc.unresolved?.length > 0) && (
                <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
                  {doc.printsPay && <Chip tone="blue">Shows Pay</Chip>}
                  {doc.outdated && <Chip tone="orange">Updating...</Chip>}
                  {doc.unresolved?.length > 0 && <Chip tone="orange">{doc.unresolved.length} Unfilled</Chip>}
                </div>
              )}
            </div>
            {doc.canOpen
              ? <button type="button" className="primary-btn" onClick={() => setPreview(doc)} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Eye size={13} /> Open</button>
              : <span style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Lock size={12} /> Needs Pay & Benefits Access</span>}
          </div>
        ))}
        {data.outdated && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}><RefreshCw size={12} /> A template was updated - refreshing the documents...</div>}

        {/* 2. What is printed - one summary, one Edit. */}
        <h3 style={h3}>
          {num(2)} Check what is printed
          {inReview && !editing && <button type="button" className="secondary-btn" onClick={startEdit} style={{ marginLeft: 'auto', fontSize: 12.5, padding: '4px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Pencil size={12} /> Edit</button>}
        </h3>
        {editing ? (
          <div style={card}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              {isHire && field('Start Date', 'start_date', { type: 'date' })}
              {isHire && field('Offer Expires', 'offer_expires', { type: 'date' })}
              {field('Legal First Name', 'first_name')}
              {field('Legal Last Name', 'last_name')}
              {field('Preferred Name', 'preferred_name')}
              {field('Phone', 'phone')}
              <div style={{ gridColumn: '1 / -1' }}>{field('Current Address', 'address')}</div>
              {!isOffer && <div style={{ gridColumn: '1 / -1' }}>{field('Permanent Address', 'permanent_address')}</div>}
              {!isOffer && field('Emergency Contact', 'emergency_name')}
              {!isOffer && field('Relationship', 'emergency_relationship')}
              {!isOffer && field('Emergency Phone', 'emergency_phone')}
              {field('Work Starts At', 'work_start', { type: 'time' })}
              {field('Work Ends At', 'work_end', { type: 'time' })}
              <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Work Days</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {DAY_LABELS.map(([k, l]) => {
                    const on = (form.work_days || []).includes(k);
                    return <button key={k} type="button" aria-pressed={on} onClick={() => set('work_days', on ? form.work_days.filter(x => x !== k) : [...(form.work_days || []), k])}
                      style={{ padding: '5px 12px', borderRadius: 999, border: '1px solid var(--line)', fontSize: 12.5, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                        background: on ? 'var(--pine)' : 'var(--card)', color: on ? '#fff' : 'var(--ink)' }}>{l}</button>;
                  })}
                </div></div>
              <div style={{ gridColumn: '1 / -1' }}>{field('Or Describe The Timings', 'timings_text', { placeholder: 'e.g. Rotating shifts, 40 hours a week' })}</div>
              {data.pay !== undefined && <div style={{ gridColumn: '1 / -1' }}>{field('Pay As Written (Optional)', 'pay_text', { placeholder: 'Leave blank to print the pay entered on the offer' })}</div>}
              {(data.answers || []).length > 0 && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <DetailsFormFields form={data.answers} values={form.answers} onChange={answers => set('answers', answers)}
                    className="form-input" labelStyle={lbl} gridMin={200} idPrefix="rv" />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="secondary-btn" onClick={() => setEditing(false)} disabled={!!busy}>Cancel</button>
              <button className="primary-btn" onClick={saveEdit} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy === 'save' ? <Spinner size={13} /> : <CheckCircle size={13} />} Save And Regenerate
              </button>
            </div>
          </div>
        ) : (
          <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '4px 28px' }}>
            <div>
              {isHire && <Row k="Role" v={o.jobTitle && `${o.jobTitle}${o.department ? ` - ${o.department}` : ''}`} />}
              {isHire && <Row k="Start Date" v={formatDate(o.startDate)} />}
              {isHire && <Row k="Offer Expires" v={formatDate(o.offerExpires)} />}
              {isHire && <Row k={<span title={REPORTS_TO} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Supervisor <Info size={12} aria-label={REPORTS_TO} style={{ cursor: 'help' }} /></span>} v={o.managerName} />}
              {ev.kind === 'promotion' && <Row k="New Role" v={o.jobTitle} />}
              {ev.kind === 'promotion' && <Row k="Effective" v={formatDate(o.effectiveDate)} />}
              {ev.kind === 'separation' && <Row k="Last Day" v={formatDate(o.lastDay)} />}
              <Row k="Pay" v={data.pay !== undefined ? data.payText : <Locked />} />
              <Row k="Timings" v={o.schedule || (o.workStart && o.workEnd ? `${formatHHMM(o.workStart)} - ${formatHHMM(o.workEnd)}` : '')} />
              {isHire && o.jdName && <Row k="Job Description" v={o.jdName} />}
              {o.employeeCode && <Row k="Employee Number" v={o.employeeCode} />}
            </div>
            {(isHire || Object.keys(d).length > 0) && (
              <div>
                <Row k="Legal Name" v={[d.first_name, d.last_name].filter(Boolean).join(' ')} />
                {d.preferred_name && <Row k="Preferred Name" v={d.preferred_name} />}
                <Row k="Phone" v={d.phone} />
                <Row k="Address" v={d.address} />
                {d.permanent_address && <Row k="Permanent Address" v={d.permanent_address} />}
                {!isOffer && <Row k="Emergency Contact" v={d.emergency_name && `${d.emergency_name}${d.emergency_relationship ? ` (${d.emergency_relationship})` : ''}${d.emergency_phone ? ` - ${d.emergency_phone}` : ''}`} />}
                {(data.answers || []).map((a, i) => a.type === 'heading'
                  ? <div key={`h-${i}`} style={{ fontSize: 12.5, fontWeight: 800, marginTop: 8 }}>{a.label}</div>
                  : <Row key={a.key} k={a.label} v={a.locked ? <Locked /> : a.value} />)}
              </div>
            )}
          </div>
        )}

        {/* 3. Who signs, then confirm. */}
        <h3 style={h3}>{num(3)} Confirm and send</h3>
        <div style={card}>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>Signing order</div>
          {(data.recipients || []).map(r => (
            <div key={`${r.order}-${r.email}`} style={{ fontSize: 13, padding: '4px 0', display: 'flex', gap: 10 }}>
              <span style={{ width: 20, color: 'var(--muted)', fontWeight: 700 }}>{r.order}</span>
              <span style={{ flex: 1 }}>{r.name} <span style={{ color: 'var(--muted)' }}>- {r.isSubject ? 'the person, no login needed' : r.roleLabel} - {r.actionLabel}</span></span>
            </div>
          ))}
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>
            Checked and sent by {v.name ? <b style={{ color: 'var(--ink)' }}>{v.name}</b> : 'nobody yet'} ({v.roleLabel || 'HR'}).
          </div>
        </div>

        {(data.signOnce || []).length > 0 && (
          <div style={{ ...card, marginTop: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>Company Signature</div>
            {data.signOnce.map(s => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 13, flexWrap: 'wrap' }}>
                <PenTool size={14} style={{ color: s.signed ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))' }} />
                <span style={{ flex: 1, minWidth: 200 }}>
                  {s.signed ? `${s.name} (${s.roleLabel}) signed this packet once on ${formatDate(s.adoptedAt)} - it goes on by itself.`
                    : `${s.name} (${s.roleLabel}) signs this packet once before it can be sent.`}
                </span>
                {!s.signed && s.isMe && (
                  <button type="button" className="primary-btn" onClick={() => setSigning(s)} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <PenTool size={12} /> Sign Once
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {(data.problems || []).map(p => <Problem key={p}>{p}</Problem>)}
        {(data.warnings || []).map(w => <Problem key={w}>{w}</Problem>)}

        {inReview && data.isVerifier && (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13.5 }}>
              <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--pine)' }} />
              I checked every document - the names, dates, pay and wording are right.
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13.5 }}>
              <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--pine)' }} />
              This is not a record that cannot be signed electronically.
            </label>
          </div>
        )}
      </div>
      <div style={{ padding: '14px 28px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, flexWrap: 'wrap' }}>
        {inReview && !data.isVerifier && (
          <span style={{ fontSize: 13, color: 'var(--muted)', marginRight: 'auto' }}>Waiting For {v.name || 'the verifier'} ({v.roleLabel || 'HR'}) To Verify</span>
        )}
        {['intake', 'review'].includes(ev.status) && (
          <button className="secondary-btn" onClick={voidIt} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'void' ? <Spinner size={13} /> : <Ban size={13} />} Void
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
      {signing && (
        <SignOnceModal packetId={data.packetId} entityId={data.entityId} step={signing} packetName={data.packetName}
          companyName={data.companyName} toastErr={toastErr} onClose={() => setSigning(null)}
          onDone={() => { setSigning(null); toastOk?.('Signed once - your signature now goes on this packet automatically.'); load(); }} />
      )}
    </Shell>
  );
}

function Shell({ title, sub, status, onClose, children }) {
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1350, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 18, width: 'max(min(100%, 560px), 60vw)', maxWidth: '100%', minHeight: 'min(60vh, 90dvh)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '18px 28px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'flex-start', gap: 10, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 17, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {title} {status && <Chip tone="orange">{status}</Chip>}
            </div>
            {sub && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>{sub}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
