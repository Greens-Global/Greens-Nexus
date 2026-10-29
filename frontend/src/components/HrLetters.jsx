// HR letters (Neil, Oct 27 2026). Employees request a standard HR letter
// from My HR - Employment Verification, Salary Certificate, Experience
// Letter, Address Proof, Visa NOC - and HR for their company issues it:
// they review the letter generated from its Documents template with every
// value filled, change any of them, then Issue it (a Nexus Sign envelope to
// the company's Authorized Signatory, its only signer) or Decline it with a
// reason. The signed letter lands in the employee's My Documents.
//   MyLettersCard        My HR: my requests and Request a Letter
//   LetterRequestsPanel  People: the requests waiting on HR
//   HrLettersSettings    Settings > Hiring & Onboarding > HR Letters
// Server side: routers/hr_letters.py + hr_letters.py.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Download, FileSignature, RefreshCw, Send, X } from 'lucide-react';
import { api } from '../api';
import { StatusLabel } from './StatusLabel';
import { SkeletonBlocks, Spinner } from './AsyncState';
import { SettingCard, SettingRow, SwitchRow } from './settings/SettingsUI';
import { formatDate } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { DateField, Modal, AvatarName } from '../tasks/components';

const STATUS_COLOR = {
  requested: '#64748b', in_review: '#2563eb', awaiting_signature: '#b45309', issued: '#15803d', declined: '#b91c1c',
};
const lbl = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '12px 0 4px' };
const full = { width: '100%' };
const small = { fontSize: 12, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 };

export function LetterStatus({ r }) {
  return <StatusLabel label={r.statusLabel} color={STATUS_COLOR[r.status]} size="sm" />;
}

const whenLine = (r) => [
  `Requested ${formatDate(r.createdAt, '-')}`,
  r.neededBy ? `Needed by ${formatDate(r.neededBy)}` : '',
].filter(Boolean).join(' · ');

// ── My HR ────────────────────────────────────────────────────────────────────

export function MyLettersCard({ flash }) {
  const [rows, setRows] = useState(null);       // null = loading, false = failed
  const [types, setTypes] = useState([]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState('');
  // The requests waiting on ME as HR - here too, so a company's HR contact
  // without People access still has a place to prepare them (their bells
  // open this page).
  const [queue, setQueue] = useState([]);
  const [reviewing, setReviewing] = useState('');
  const loadQueue = useCallback(() => {
    api.hrLetterQueue('open').then(q => setQueue(q?.canReview && Array.isArray(q.requests) ? q.requests : [])).catch(() => setQueue([]));
  }, []);
  const load = useCallback(() => {
    api.hrLettersMine().then(r => setRows(Array.isArray(r) ? r : [])).catch(() => setRows(false));
    api.hrLetterTypes().then(t => setTypes(Array.isArray(t) ? t : [])).catch(() => setTypes([]));
    loadQueue();
  }, [loadQueue]);
  useEffect(() => { load(); }, [load]);

  const download = async (r) => {
    setBusy(r.id);
    try { const { url } = await api.myHrDocDownload(r.documentId); window.open(url, '_blank', 'noopener'); }
    catch (e) { flash?.(e?.message || 'Could not download the letter', false); }
    finally { setBusy(''); }
  };

  return (
    <div className="dash-card myhr-span2" data-testid="my-letters">
      <div className="dash-card-head">
        <div>
          <div className="dash-card-title">HR Letters</div>
          <div className="dash-card-sub">Employment verification, salary certificates, visa letters and more - prepared and signed by HR</div>
        </div>
        {types.length > 0 && (
          <button type="button" className="secondary-btn" onClick={() => setAsking(true)} style={small}>
            <FileSignature size={13} /> Request a Letter
          </button>
        )}
      </div>
      {queue.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'hsl(var(--color-blue))', margin: '2px 0 8px' }}>Waiting on You as HR - {queue.length}</div>
          <QueueRows rows={queue} onOpen={setReviewing} />
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', margin: '14px 0 2px' }}>Your Own Letters</div>
        </div>
      )}
      {reviewing && (
        <LetterReviewModal id={reviewing} onClose={() => setReviewing('')} onChanged={loadQueue}
          toastOk={(t) => flash?.(t)} toastErr={(t) => flash?.(t, false)} />
      )}
      {rows === null ? <SkeletonBlocks count={2} height={44} borderRadius={10} />
        : rows === false ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>Your letters could not be loaded right now.</div>
          : rows.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>
              {types.length ? 'No letters requested yet - ask for one and HR prepares it for you.' : 'HR letters are not offered for your company yet.'}
            </div>
          ) : rows.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
              <FileSignature size={15} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{r.typeLabel}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{whenLine(r)}{r.purpose ? ` · ${r.purpose}` : ''}</div>
                {r.status === 'declined' && r.declineReason && (
                  <div style={{ fontSize: 12, color: 'var(--ink)', marginTop: 5, padding: '6px 10px', background: 'var(--mist)', borderRadius: 8 }}>
                    <strong>HR:</strong> {r.declineReason}
                  </div>
                )}
              </div>
              <LetterStatus r={r} />
              {r.status === 'issued' && r.documentId && (
                <button type="button" className="secondary-btn" onClick={() => download(r)} disabled={busy === r.id} style={small}>
                  {busy === r.id ? <Spinner size={12} /> : <Download size={12} />} PDF
                </button>
              )}
            </div>
          ))}
      {asking && (
        <RequestLetterModal types={types} onClose={() => setAsking(false)}
          onCreated={(r) => { setAsking(false); setRows(rs => [r, ...(Array.isArray(rs) ? rs : [])]); flash?.('Sent to HR - you will hear here when it is ready'); }} />
      )}
    </div>
  );
}

export function RequestLetterModal({ types, onClose, onCreated }) {
  const [form, setForm] = useState({ letter_type: types[0]?.key || '', purpose: '', addressed_to: '', needed_by: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const dirty = !!(form.purpose || form.addressed_to || form.needed_by || form.notes);
  const picked = types.find(t => t.key === form.letter_type);
  const submit = async () => {
    setBusy(true); setError('');
    try { onCreated(await api.hrLetterRequest(form)); }
    catch (e) { setError(e?.message || 'Could not send the request'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Request a Letter" onClose={onClose} isDirty={dirty}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={submit} disabled={busy || !form.letter_type || !form.purpose.trim()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={13} /> : <Send size={13} />} Send Request
        </button>
      </>}>
      <label style={{ ...lbl, marginTop: 0 }}>Which Letter?</label>
      <div role="radiogroup" aria-label="Which letter" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 }}>
        {types.map(t => {
          const on = t.key === form.letter_type;
          return (
            <button key={t.key} type="button" role="radio" aria-checked={on} onClick={() => set('letter_type')(t.key)}
              style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                border: `1.5px solid ${on ? 'hsl(var(--color-blue))' : 'var(--line)'}`,
                background: on ? 'hsla(var(--color-blue),0.06)' : 'var(--card)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{t.label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.4 }}>{t.desc}</div>
            </button>
          );
        })}
      </div>
      {picked?.printsPay && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>This letter shows your pay. Only HR with Pay &amp; Benefits access prepares it.</div>
      )}
      <label style={lbl} htmlFor="letter-purpose">What Is It For?</label>
      <input id="letter-purpose" className="form-input" style={full} value={form.purpose} onChange={e => set('purpose')(e.target.value)}
        placeholder='e.g. "Apartment lease application" or "Tourist visa for Japan, 12/10 - 12/20"' />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div>
          <label style={lbl} htmlFor="letter-to">Addressed To (Optional)</label>
          <input id="letter-to" className="form-input" style={full} value={form.addressed_to} onChange={e => set('addressed_to')(e.target.value)}
            placeholder="Blank = To Whom It May Concern" />
        </div>
        <div>
          <span style={lbl}>Needed By (Optional)</span>
          <DateField value={form.needed_by} onChange={set('needed_by')} noPast placeholder="Pick a date" />
        </div>
      </div>
      <div className="nx-fill">
        <label style={lbl} htmlFor="letter-notes">Notes for HR (Optional)</label>
        <textarea id="letter-notes" className="form-input" style={{ ...full, flex: 1, minHeight: 96, resize: 'vertical' }} value={form.notes}
          onChange={e => set('notes')(e.target.value)} placeholder="Anything the letter must say, or who it should go to" />
      </div>
      {error && <div role="alert" style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}

// ── People: the HR queue ─────────────────────────────────────────────────────

export function LetterRequestsPanel({ toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState('');
  const load = useCallback(() => { api.hrLetterQueue('open').then(setData).catch(() => setData(null)); }, []);
  useEffect(() => { load(); }, [load]);
  const rows = Array.isArray(data?.requests) ? data.requests : [];
  if (!data?.canReview || rows.length === 0) return null;
  return (
    <div data-testid="letter-requests" style={{ border: '1px solid hsla(var(--color-blue),0.25)', borderRadius: 12, background: 'hsla(var(--color-blue),0.03)', padding: '14px 16px', marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'hsl(var(--color-blue))', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>
        Letter Requests - {rows.length} open
      </div>
      <QueueRows rows={rows} onOpen={setOpen} />
      {open && <LetterReviewModal id={open} onClose={() => setOpen('')} onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
    </div>
  );
}

// The requests waiting on HR, one card each. A date it is needed by within
// three days reads in orange.
function QueueRows({ rows, onOpen }) {
  const soon = (r) => r.neededBy && (new Date(`${r.neededBy}T00:00:00`) - new Date()) < 3 * 86400000;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map(r => (
        <div key={r.id} style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <AvatarName email={r.employeeEmail} name={r.employeeName} size={22} style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }} />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}> · {r.typeLabel}{r.companyName ? ` · ${r.companyName}` : ''}</span>
            <div style={{ fontSize: 12, color: soon(r) ? 'hsl(var(--color-orange))' : 'var(--muted)', marginTop: 2, fontWeight: soon(r) ? 600 : 400 }}>{whenLine(r)}</div>
            <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 3 }}>{r.purpose}</div>
            {r.note && <div style={{ fontSize: 12, color: 'hsl(var(--color-orange))', marginTop: 3 }}>{r.note}</div>}
          </div>
          <LetterStatus r={r} />
          <button type="button" className="secondary-btn" onClick={() => onOpen(r.id)} style={small}>
            {r.status === 'awaiting_signature' ? 'Open' : 'Review'} <ArrowRight size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function LetterReviewModal({ id, onClose, onChanged, toastOk, toastErr }) {
  const narrow = useIsMobile('(max-width: 900px)');
  const [review, setReview] = useState(null);
  const [failed, setFailed] = useState('');
  const [values, setValues] = useState({});
  const [payValues, setPayValues] = useState({});
  const [pdfUrl, setPdfUrl] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState('');
  const [ack, setAck] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const urlRef = useRef('');

  const adopt = (r) => {
    setReview(r);
    setValues(Object.fromEntries((r.fields || []).map(f => [f.token, f.value])));
    setPayValues(Object.fromEntries((r.payFields || []).map(f => [f.token, f.value])));
  };
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let r = await api.hrLetterReview(id);
        if (r.request?.status === 'requested') {
          await api.hrLetterStartReview(id);
          r = await api.hrLetterReview(id);
          onChanged?.();
        }
        if (live) { if (r?.request) adopt(r); else setFailed('This request could not be loaded.'); }
      } catch (e) { if (live) setFailed(e?.message || 'This request could not be loaded.'); }
    })();
    return () => { live = false; };
  }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const req = review?.request;
  const editable = req && ['requested', 'in_review'].includes(req.status);
  const saved = review ? Object.fromEntries((review.fields || []).map(f => [f.token, f.value])) : {};
  const savedPay = review ? Object.fromEntries((review.payFields || []).map(f => [f.token, f.value])) : {};
  const dirty = !!review && (JSON.stringify(values) !== JSON.stringify(saved) || JSON.stringify(payValues) !== JSON.stringify(savedPay));
  const body = () => ({ values, ...(review?.canSeePay ? { pay_values: payValues } : {}) });

  const refresh = useCallback(async () => {
    if (!review) return;
    setPreviewing(true);
    try {
      const { blob } = await api.hrLetterPreview(id, body());
      const url = URL.createObjectURL(blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setPdfUrl(url);
    } catch (e) { toastErr?.(e?.message || 'Could not build the preview'); }
    finally { setPreviewing(false); }
  }, [review, values, payValues]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The preview follows the values, a moment after typing stops.
  useEffect(() => {
    if (!review) return undefined;
    const t = setTimeout(refresh, pdfUrl ? 700 : 0);
    return () => clearTimeout(t);
  }, [review, values, payValues]);   // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (what, fn) => {
    setBusy(what);
    try { await fn(); } catch (e) { toastErr?.(e?.message || 'Something went wrong'); } finally { setBusy(''); }
  };
  const save = () => run('save', async () => { adopt(await api.hrLetterSaveValues(id, body())); toastOk?.('Letter saved.'); });
  const issue = () => run('issue', async () => {
    const out = await api.hrLetterIssue(id, { ...body(), excluded_ack: ack });
    onChanged?.();
    onClose();
    if (out?.signPartyId) {
      toastOk?.('Issued - it is waiting for your signature.');
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'myhr', sub: `sign:${out.signPartyId}` } }));
    } else toastOk?.(`Issued - sent to ${review.signer?.name || 'the signatory'} to sign.`);
  });
  const decline = () => run('decline', async () => {
    await api.hrLetterDecline(id, reason);
    onChanged?.();
    onClose();
    toastOk?.('Declined - the employee has been told why.');
  });

  const field = (f, pay = false) => (
    <div key={f.token}>
      <label style={lbl} htmlFor={`lv-${f.token}`}>{f.label}{pay ? ' (Pay)' : ''}</label>
      <input id={`lv-${f.token}`} className="form-input" style={full} disabled={!editable}
        value={(pay ? payValues : values)[f.token] ?? ''}
        onChange={e => (pay ? setPayValues : setValues)(v => ({ ...v, [f.token]: e.target.value }))} />
      {f.auto && ((pay ? payValues : values)[f.token] ?? '') !== f.auto && editable && (
        <button type="button" className="link-btn" style={{ fontSize: 11, marginTop: 3 }}
          onClick={() => (pay ? setPayValues : setValues)(v => ({ ...v, [f.token]: f.auto }))}>Use &quot;{f.auto}&quot;</button>
      )}
    </div>
  );

  const footer = editable ? (
    declining ? (<>
      <button type="button" className="secondary-btn" onClick={() => setDeclining(false)} disabled={!!busy}>Back</button>
      <button type="button" className="primary-btn" onClick={decline} disabled={!!busy || !reason.trim()}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}>
        {busy === 'decline' ? <Spinner size={13} /> : <X size={13} />} Decline Request
      </button>
    </>) : (<>
      <button type="button" className="secondary-btn" onClick={() => setDeclining(true)} disabled={!!busy}>Decline</button>
      <div style={{ flex: 1 }} />
      <button type="button" className="secondary-btn" onClick={save} disabled={!!busy || !dirty}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {busy === 'save' ? <Spinner size={13} /> : <Check size={13} />} Save
      </button>
      <button type="button" className="primary-btn" onClick={issue} disabled={!!busy || !ack || !review?.signer?.email}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {busy === 'issue' ? <Spinner size={13} /> : <Send size={13} />} Issue for Signature
      </button>
    </>)
  ) : <button type="button" className="secondary-btn" onClick={onClose}>Close</button>;

  return (
    <Modal title={req ? `${req.typeLabel} - ${req.employeeName}` : 'Letter Request'} onClose={onClose} isDirty={dirty} onSave={editable ? save : undefined}
      footer={review ? footer : null}>
      {failed ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: 30, textAlign: 'center' }}>{failed}</div>
        : !review ? <SkeletonBlocks count={3} height={90} borderRadius={10} />
          : (
            <div className="nx-fill" style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(240px, 320px) 1fr', gap: 18 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <LetterStatus r={req} />
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{whenLine(req)}{req.companyName ? ` · ${req.companyName}` : ''}</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 8 }}><strong>For:</strong> {req.purpose}</div>
                {req.addressedTo && <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 3 }}><strong>To:</strong> {req.addressedTo}</div>}
                {req.notes && <div style={{ fontSize: 12, color: 'var(--ink)', marginTop: 6, padding: '7px 10px', background: 'var(--mist)', borderRadius: 8 }}>{req.notes}</div>}
                {req.note && <div style={{ fontSize: 12, color: 'hsl(var(--color-orange))', marginTop: 6 }}>{req.note}</div>}
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
                  {review.signer?.email
                    ? <>Signed by <AvatarName email={review.signer.email} name={review.signer.name} size={18}><strong style={{ color: 'var(--ink)' }}>{review.signer.name}</strong></AvatarName>{review.signer.title ? `, ${review.signer.title}` : ''} ({review.signer.role}) - the only signer.</>
                    : 'Nobody can sign this letter yet.'}
                </div>
                {review.template && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>From the template &quot;{review.template.name}&quot; (version {review.template.version}).</div>}
                {(review.fields || []).map(f => field(f))}
                {(review.payFields || []).map(f => field(f, true))}
                {review.printsPay && !review.canSeePay && (
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>This letter shows pay. The preview prints [Pay]; issuing it needs Pay &amp; Benefits access.</div>
                )}
                {editable && review.problems?.length > 0 && (
                  <div role="status" style={{ marginTop: 12, padding: '8px 11px', borderRadius: 9, background: 'hsla(var(--color-orange),0.1)', color: 'var(--ink)', fontSize: 12 }}>
                    {review.problems.map(p => <div key={p}>{p}</div>)}
                  </div>
                )}
                {editable && !declining && (
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--ink)', marginTop: 14, cursor: 'pointer' }}>
                    <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>This letter is not a record excluded from electronic signature.</span>
                  </label>
                )}
                {editable && declining && (
                  <div>
                    <label style={lbl} htmlFor="letter-decline">Why Are You Declining It?</label>
                    <textarea id="letter-decline" className="form-input" rows={3} style={{ ...full, resize: 'vertical' }} autoFocus value={reason}
                      onChange={e => setReason(e.target.value)} placeholder="The employee reads this on My HR" />
                  </div>
                )}
              </div>
              <div className="nx-fill" style={{ minHeight: narrow ? 420 : 0, border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', position: 'relative', background: 'var(--mist)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--line)', background: 'var(--card)' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', flex: 1 }}>Preview</span>
                  <button type="button" className="secondary-btn" onClick={refresh} disabled={previewing} style={{ ...small, padding: '3px 10px' }}>
                    {previewing ? <Spinner size={12} /> : <RefreshCw size={12} />} Refresh
                  </button>
                </div>
                {pdfUrl
                  ? <iframe title="Letter preview" src={pdfUrl} style={{ flex: 1, width: '100%', border: 'none', minHeight: 380 }} />
                  : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size="section" label="Building the preview" /></div>}
              </div>
            </div>
          )}
    </Modal>
  );
}

// ── Settings > Hiring & Onboarding > HR Letters ──────────────────────────────
// Which letters a company offers, the template each prints from and the
// letterhead: one setting for every company that a company may override.
// Switches and selects save on change.
// A malformed answer reads as "could not load", never a crash.
const settingsShape = (r) => (r && Array.isArray(r.types)
  ? { ...r, templates: Array.isArray(r.templates) ? r.templates : [], letterheads: Array.isArray(r.letterheads) ? r.letterheads : [] }
  : null);

export function HrLettersSettings({ company = '', toastOk, toastErr, onOverride }) {
  // What was loaded, for which company: another company's answer never shows.
  const [loaded, setLoaded] = useState({ company: null, cfg: null, failed: false });
  const [saving, setSaving] = useState('');
  useEffect(() => {
    let live = true;
    api.hrLetterSettings(company).then(r => {
      if (live) { const c = settingsShape(r); setLoaded({ company, cfg: c, failed: !c }); }
    }).catch(() => { if (live) setLoaded({ company, cfg: null, failed: true }); });
    return () => { live = false; };
  }, [company]);
  const mine = loaded.company === company;
  const cfg = mine ? loaded.cfg : null;
  const failed = mine && loaded.failed;
  const setCfg = (c) => setLoaded({ company, cfg: c, failed: false });
  useEffect(() => { if (cfg && company) onOverride?.(!!cfg.hasOverride); }, [cfg, company, onOverride]);

  const save = async (next, what, reset = false) => {
    setSaving(what);
    try {
      const body = reset ? { reset: true } : {
        types: Object.fromEntries(next.types.map(t => [t.key, { on: t.on, templateId: t.templateId }])),
        letterhead_id: next.letterheadId,
      };
      const saved = settingsShape(await api.hrLetterSettingsSave(company, body));
      if (saved) setCfg(saved);
      toastOk?.(reset ? 'Back to the default for every company.' : 'HR letters saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save the HR letters.'); }
    finally { setSaving(''); }
  };
  if (failed) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>The HR letter settings could not be loaded right now.</div>;
  if (!cfg) return <SkeletonBlocks count={3} height={48} borderRadius={10} />;
  const setType = (key, patch) => save({ ...cfg, types: cfg.types.map(t => (t.key === key ? { ...t, ...patch } : t)) }, key);
  const picker = (t) => (
    <select className="form-input" aria-label={`${t.label} template`} value={t.templateId} disabled={saving === t.key}
      onChange={e => setType(t.key, { templateId: e.target.value })} style={{ fontSize: 12.5, maxWidth: 280 }}>
      <option value="">Nexus Default</option>
      {cfg.templates.filter(x => x.id !== t.defaultTemplateId).map(x => (
        <option key={x.id} value={x.id} disabled={!x.published}>{x.name}{x.published ? '' : ' (Not Published)'}</option>
      ))}
    </select>
  );
  return (
    <div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
        The letters employees can request from My HR. Each prints from a Documents template (the &quot;HR Letter&quot; templates by default - edit them in Documents &gt; Templates and Publish) and is signed by the company&apos;s Authorized Signatory through Nexus Sign.
      </div>
      <SettingCard>
        {cfg.types.map(t => (
          <SwitchRow key={t.key} id={`hr-letter-${t.key}`} title={t.label} checked={t.on} disabled={!!saving}
            desc={`${t.desc}${t.printsPay ? ' Shows pay: prepared only by HR with Pay & Benefits access.' : ''}`}
            onChange={(on) => setType(t.key, { on })}>
            {t.on && <SettingRow nested title="Template" desc={t.templateId ? '' : `Prints "${t.templateName || 'the Nexus default'}".`} control={picker(t)} />}
          </SwitchRow>
        ))}
        <SettingRow title="Letterhead" desc="Printed on every HR letter whose template asks for one."
          control={(
            <select className="form-input" aria-label="Letterhead" value={cfg.letterheadId} disabled={!!saving}
              onChange={e => save({ ...cfg, letterheadId: e.target.value }, 'letterhead')} style={{ fontSize: 12.5, maxWidth: 240 }}>
              <option value="">The Template&apos;s Own</option>
              {cfg.letterheads.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefault ? ' (Default)' : ''}</option>)}
            </select>
          )} />
      </SettingCard>
      {company && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {cfg.hasOverride ? 'This company has HR letter settings of its own.' : 'Using the default for every company; a change here is this company\'s alone.'}
          {cfg.hasOverride && (
            <button type="button" className="secondary-btn" onClick={() => save(cfg, 'reset', true)} disabled={!!saving} style={{ fontSize: 11.5 }}>Use the Default</button>
          )}
        </div>
      )}
    </div>
  );
}
