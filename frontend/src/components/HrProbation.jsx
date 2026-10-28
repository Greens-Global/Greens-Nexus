// Probation (Neil, Oct 27 2026) - the rules live in backend/hr_probation.py.
//
//   ProbationBadge     - the People list / profile header chip: Probation
//                        Ending (inside the reminder window) or Probation
//                        Overdue (past the end, undecided).
//   ProbationCard      - the profile's Probation section: status, dates,
//                        length, the manager's recommendation, the letter,
//                        the history; Decide / Recommend, and HR's Start
//                        Tracking / Edit / Remove From Probation / Send
//                        Letter / Start A New Probation.
//
// Past the window (Neil, Oct 29 2026): a probation past its end with no
// decision and no recommendation waiting becomes Passed Probation by itself
// (no letter - HR can Send Letter); someone never tracked whose window is
// over reads Past Probation; HR can Remove From Probation (Removed From
// Probation, nothing restarts it).
//   ProbationSettings  - Settings > Hiring & Onboarding > Probation: length,
//                        reminder, the two letter templates and the letterhead,
//                        a default and each company's own.
//
// HR (the company's HR contact, an administrator, a Full People grant)
// finalizes; a manager's Confirm / Extend / End is a recommendation HR
// approves or declines. End Employment opens the existing Offboard flow.
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, CalendarClock, CheckCircle2, Hourglass, LogOut, Eye, Send, Pencil, Play, MinusCircle, History } from 'lucide-react';
import { api } from '../api';
import { Spinner, SkeletonBlocks, ErrorBanner } from './AsyncState';
import { StatusLabel } from './StatusLabel';
import { DateField } from '../tasks/components';
import { formatDate, toDateInputValue } from '../lib/datetime';
import { SettingCard, SettingRow, NumberBox } from './settings/SettingsUI';

const COLORS = {
  in_probation: '#2563eb', extended: '#d97706', confirmed: '#16a34a', ended: '#dc2626', '': '#64748b',
  passed: '#16a34a', past: '#64748b', removed: '#64748b',
};
const OPEN = ['in_probation', 'extended'];
const LETTER_STATUS = {
  sent: ['Out For Signature', '#2563eb'], awaiting_sender: ['Out For Signature', '#2563eb'],
  completed: ['Signed', '#16a34a'], declined: ['Declined', '#dc2626'], voided: ['Voided', '#64748b'],
  expired: ['Expired', '#d97706'], failed: ['Not Sent', '#dc2626'],
};
const ACTIONS = {
  started: 'Started tracking', edited: 'Changed the dates', stopped: 'Stopped tracking', recommended: 'Recommended',
  recommendation_declined: 'Declined the recommendation', confirmed: 'Confirmed', extended: 'Extended', ended: 'Ended',
  letter_sent: 'Sent the letter', letter_signed: 'Signed the letter',
  passed: 'Passed probation automatically', removed: 'Removed from probation',
};
const CHOICES = [
  ['confirm', 'Confirm', CheckCircle2, '#16a34a', 'They passed probation. The confirmation letter goes to them to sign.'],
  ['extend', 'Extend', Hourglass, '#d97706', 'More time before a decision. Pick the new end date; the extension letter says why.'],
  ['end', 'End Employment', LogOut, '#dc2626', 'Probation ends without confirmation. HR then runs the offboarding.'],
];
const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '12px 0 4px', textTransform: 'uppercase', letterSpacing: '.04em' };
const usDay = (iso) => formatDate(iso, '-');

function daysText(days) {
  if (days === null || days === undefined) return '';
  if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`;
  if (days === 0) return 'today';
  return `${-days} day${days === -1 ? '' : 's'} ago`;
}

// The People list and the profile header: only while a decision is due.
export function ProbationBadge({ p, size = 'sm' }) {
  if (!p || !OPEN.includes(p.status) || !p.ending) return null;
  const overdue = (p.daysLeft ?? 0) < 0;
  return (
    <StatusLabel size={size} label={overdue ? 'Probation Overdue' : 'Probation Ending'} color={overdue ? '#dc2626' : '#d97706'}
      title={`Probation ${overdue ? 'ended' : 'ends'} ${usDay(p.endDate)} (${daysText(p.daysLeft)})${p.pending ? ' - a recommendation is waiting for HR' : ''}`} />
  );
}

// One popup shape for every probation dialog: 60vw, the body a flex column.
function Popup({ title, sub, onClose, children, footer }) {
  return (
    <div onClick={ev => ev.target === ev.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="nx-popup" role="dialog" aria-label={title}
        style={{ background: 'var(--card)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <CalendarClock size={17} style={{ color: 'var(--pine)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>{title}</div>
            {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{sub}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 22px 18px', display: 'flex', flexDirection: 'column' }}>{children}</div>
        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>{footer}</div>
      </div>
    </div>
  );
}

// Confirm / Extend / End. `mode`: 'decide' (HR finalizes, a manager
// recommends) or 'approve' (HR reviewing a manager's recommendation).
export function ProbationDecisionModal({ employee: e, data, mode = 'decide', onClose, onDone, toastErr }) {
  const pending = mode === 'approve' ? data.pending : null;
  const hr = !!data.canFinalize;
  const [decision, setDecision] = useState(pending?.decision || '');
  const [newEnd, setNewEnd] = useState(pending?.newEndDate || '');
  const [reason, setReason] = useState(pending?.reason || '');
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [pdf, setPdf] = useState('');
  const made = useRef('');
  useEffect(() => () => { if (made.current) URL.revokeObjectURL(made.current); }, []);
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ');
  const needsReason = decision === 'extend' || decision === 'end';
  const ready = decision && (!needsReason || reason.trim()) && (decision !== 'extend' || newEnd);
  const letter = hr && (decision === 'confirm' || decision === 'extend');

  const pick = (d) => { if (!pending) { setDecision(d); setPdf(''); } };
  async function preview() {
    setBusy('preview');
    try {
      const { blob } = await api.probationLetterPreview(e.id, { decision, new_end_date: newEnd, reason });
      if (made.current) URL.revokeObjectURL(made.current);
      made.current = URL.createObjectURL(blob);
      setPdf(made.current);
    } catch (err) { toastErr?.(err?.message || 'Could not prepare the letter.'); }
    setBusy('');
  }
  async function submit() {
    setBusy('save');
    try {
      const out = pending
        ? await api.probationApprove(e.id, { new_end_date: decision === 'extend' ? newEnd : undefined, reason })
        : await api.probationDecide(e.id, { decision, new_end_date: decision === 'extend' ? newEnd : '', reason });
      onDone(out, { decision, reason });
    } catch (err) { toastErr?.(err?.message || 'Could not save the decision.'); setBusy(''); }
  }
  async function decline() {
    setBusy('decline');
    try { onDone(await api.probationDecline(e.id, note), { declined: true }); }
    catch (err) { toastErr?.(err?.message || 'Could not decline it.'); setBusy(''); }
  }
  const primary = !hr ? 'Send Recommendation'
    : decision === 'confirm' ? 'Confirm Employment' : decision === 'extend' ? 'Extend Probation'
      : decision === 'end' ? 'End Employment' : 'Save';
  const footer = declining ? (
    <>
      <button className="secondary-btn" onClick={() => setDeclining(false)} disabled={!!busy}>Back</button>
      <button className="primary-btn" onClick={decline} disabled={!note.trim() || !!busy}>{busy === 'decline' ? 'Declining…' : 'Decline Recommendation'}</button>
    </>
  ) : (
    <>
      <button className="secondary-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
      {pending && <button className="secondary-btn" onClick={() => setDeclining(true)} disabled={!!busy}>Decline</button>}
      {letter && <button className="secondary-btn" onClick={preview} disabled={!ready || !!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {busy === 'preview' ? <Spinner size={13} /> : <Eye size={13} />} Preview Letter</button>}
      <button className="primary-btn" onClick={submit} disabled={!ready || !!busy}
        style={decision === 'end' && hr ? { background: 'hsl(var(--color-red))' } : undefined}>
        {busy === 'save' ? 'Saving…' : pending ? `Approve - ${primary}` : primary}
      </button>
    </>
  );
  return (
    <Popup title={pending ? `Review Recommendation - ${name}` : `${hr ? 'Decide' : 'Recommend'} Probation - ${name}`}
      sub={`Probation ${data.status === 'extended' ? 'extended to' : 'ends'} ${usDay(data.endDate)}`} onClose={onClose} footer={footer}>
      {declining ? (
        <div className="nx-fill" style={{ marginTop: 8 }}>
          <label style={lbl} htmlFor="prob-decline">Note For {pending?.byName || 'The Manager'} *</label>
          <textarea id="prob-decline" className="form-input" value={note} onChange={ev => setNote(ev.target.value)}
            placeholder="Why the recommendation is declined" style={{ width: '100%' }} />
        </div>
      ) : (
        <>
          {pending && (
            <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'hsla(var(--color-blue),0.08)', fontSize: 12.5, lineHeight: 1.5 }}>
              <b>{pending.byName}</b> recommends <b>{pending.label}</b>{pending.newEndDate ? ` to ${usDay(pending.newEndDate)}` : ''} ({usDay(pending.at)}). Adjust it below if needed, then approve or decline.
            </div>
          )}
          {!hr && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
              Your choice goes to HR as a recommendation - HR approves it, and only then does anything change or a letter go out.
            </div>
          )}
          <div role="radiogroup" aria-label="Decision" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 10, marginTop: 12 }}>
            {CHOICES.map(([key, title, Icon, color, sub]) => {
              const on = decision === key;
              return (
                <button key={key} type="button" role="radio" aria-checked={on} onClick={() => pick(key)} disabled={!!pending && !on}
                  style={{ display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', padding: '12px 14px', borderRadius: 12, fontFamily: 'Inter,sans-serif', color: 'var(--ink)',
                    cursor: pending ? 'default' : 'pointer', opacity: pending && !on ? 0.45 : 1,
                    border: `1.5px solid ${on ? color : 'var(--line)'}`, background: on ? `${color}12` : 'var(--card)' }}>
                  <Icon size={18} style={{ color, flexShrink: 0, marginTop: 1 }} />
                  <span><span style={{ display: 'block', fontWeight: 700, fontSize: 13.5 }}>{title}</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{sub}</span></span>
                </button>
              );
            })}
          </div>
          {decision === 'extend' && (
            <div style={{ maxWidth: 260 }}>
              <label style={lbl}>New End Date *</label>
              <DateField value={newEnd} onChange={v => { setNewEnd(v || ''); setPdf(''); }} placeholder="MM/DD/YYYY" title="New end date" style={{ width: '100%' }} />
            </div>
          )}
          {decision && (
            <div className={pdf ? undefined : 'nx-fill'}>
              <label style={lbl} htmlFor="prob-reason">Reason{needsReason ? ' *' : ' (Optional)'}</label>
              <textarea id="prob-reason" className="form-input" value={reason} rows={pdf ? 2 : 3} onChange={ev => { setReason(ev.target.value); setPdf(''); }}
                placeholder={decision === 'extend' ? 'Printed on the extension letter - for example, more time to learn the month-end close'
                  : decision === 'end' ? 'Kept on the record and carried into the offboarding' : 'Kept in the probation history'}
                style={{ width: '100%' }} />
            </div>
          )}
          {decision === 'end' && hr && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
              Nothing is offboarded yet: the Offboard screen opens next with Termination and this reason filled in.
            </div>
          )}
          {pdf && (
            <div className="nx-fill" style={{ marginTop: 12, minHeight: 320 }}>
              <iframe title="Letter preview" src={pdf} style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 10, minHeight: 320 }} />
            </div>
          )}
        </>
      )}
    </Popup>
  );
}

// Start Tracking / Start A New Probation / Edit / Remove From Probation - HR only.
function ManageModal({ employee: e, data, mode, onClose, onDone, toastErr }) {
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ');
  // A new probation (after a decision, a removal, or past the window - say,
  // a new role) counts from a day HR picks: today unless changed.
  const fresh = mode === 'start' && !!data.status;
  const [own, setOwn] = useState(data.monthsOverride != null);
  const [months, setMonths] = useState(String(data.monthsOverride ?? data.companyMonths ?? 3));
  const [end, setEnd] = useState(data.endDate || '');
  const [from, setFrom] = useState(() => (fresh ? toDateInputValue(new Date()) : ''));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      let out;
      if (mode === 'start') {
        const body = { months: own ? Number(months) : null, reason };
        if (fresh && from) body.start_date = from;
        out = await api.probationStart(e.id, body);
      } else if (mode === 'remove') out = await api.probationRemove(e.id, reason);
      else {
        const body = { reason };
        if (end && end !== data.endDate) body.end_date = end;
        else if (own && Number(months) !== data.monthsOverride) body.months = Number(months);
        else if (!own && data.monthsOverride != null) body.use_company_length = true;
        out = await api.probationEdit(e.id, body);
      }
      onDone(out);
    } catch (err) { toastErr?.(err?.message || 'Could not save.'); setBusy(false); }
  }
  const startLabel = fresh ? 'Start A New Probation' : 'Start Tracking';
  const title = mode === 'start' ? `${startLabel} - ${name}` : mode === 'remove' ? `Remove From Probation - ${name}` : `Edit Probation - ${name}`;
  const ok = mode === 'remove' ? !!reason.trim() : mode !== 'start' || !fresh || !!from;
  const sub = mode === 'start' ? (fresh ? 'A new probation, from the day you pick' : `Counts from their start date, ${usDay(e.startDate)}`)
    : `Probation ends ${usDay(data.endDate)}`;
  return (
    <Popup title={title} sub={sub}
      onClose={onClose} footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" onClick={save} disabled={busy || !ok}>{busy ? 'Saving…' : mode === 'start' ? startLabel : mode === 'remove' ? 'Remove From Probation' : 'Save'}</button>
      </>}>
      {fresh && (
        <div style={{ maxWidth: 260 }}>
          <label style={lbl}>Counts From *</label>
          <DateField value={from} onChange={v => setFrom(v || '')} placeholder="MM/DD/YYYY" title="Counts from" style={{ width: '100%' }} />
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>For example, the day they moved into the new role.</div>
        </div>
      )}
      {mode !== 'remove' && data.status !== 'extended' && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13 }}>
            <input type="checkbox" checked={own} onChange={ev => setOwn(ev.target.checked)} />
            A length of their own (the company&apos;s is {data.companyMonths} months)
          </label>
          {own && (
            <div style={{ marginTop: 8 }}>
              <NumberBox label="Probation length" min={1} max={24} unit="months" value={months} onChange={setMonths} />
            </div>
          )}
        </>
      )}
      {mode === 'edit' && (
        <div style={{ maxWidth: 260 }}>
          <label style={lbl}>End Date</label>
          <DateField value={end} onChange={v => setEnd(v || '')} placeholder="MM/DD/YYYY" title="End date" style={{ width: '100%' }} />
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>A date typed here stays put if their start date changes.</div>
        </div>
      )}
      {mode === 'remove' && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          They come off probation now: no reminder, no decision and no letter{data.pending ? ', and the waiting recommendation is closed' : ''}.
          Nothing starts it again by itself - HR can start a new probation later. The history stays.
        </div>
      )}
      <div className="nx-fill">
        <label style={lbl} htmlFor="prob-manage-reason">Reason{mode === 'remove' ? ' *' : ' (Optional)'}</label>
        <textarea id="prob-manage-reason" className="form-input" value={reason} onChange={ev => setReason(ev.target.value)}
          placeholder="Kept in the probation history" style={{ width: '100%' }} />
      </div>
    </Popup>
  );
}

const Row = ({ k, children }) => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 13.5 }}>
    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', width: 110, flexShrink: 0 }}>{k}</span>
    <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
  </div>
);

// The profile's Probation section. Renders nothing for someone it never
// applies to (a contractor with no record) or a viewer the server refuses.
export function ProbationCard({ employee: e, focus = false, onOffboard, onChanged, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(null);          // 'decide' | 'approve' | 'start' | 'edit' | 'remove'
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const ref = useRef(null);
  const load = useCallback(() => {
    api.probationGet(e.id).then(d => { setErr(''); setData(d); }).catch(x => {
      if (x?.status === 404 || x?.status === 403) setData({ hidden: true });
      else setErr(x?.message || 'Could not load the probation.');
    });
  }, [e.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (focus && data && !data.hidden) ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); }, [focus, data]);

  if (err) return <div style={{ marginBottom: 14 }}><ErrorBanner message={err} onRetry={() => { setErr(''); load(); }} /></div>;
  if (!data) return <div style={{ marginBottom: 14 }}><SkeletonBlocks count={1} height={72} borderRadius={12} /></div>;
  if (data.hidden || (!data.applies && !data.status)) return null;

  const st = data.status || '';
  const open = OPEN.includes(st);
  const after = (out, info = {}) => {
    setModal(null);
    if (out?.probation) setData(out.probation); else load();
    onChanged?.();
    if (info.declined) { toastOk?.('Recommendation declined - the manager is told why.'); return; }
    if (out?.pending) { toastOk?.('Recommendation sent to HR.'); return; }
    if (out?.letter && !out.letter.sent) toastErr?.(`Saved, but the letter did not go out: ${out.letter.error}`);
    else if (out?.letter?.sent) toastOk?.(`Saved - ${out.letter.title} sent to ${e.firstName} to sign.`);
    else toastOk?.('Saved.');
    if (out?.startSeparation) onOffboard?.({ exit_type: 'termination', reason: info.reason || '' });
  };
  async function sendLetter() {
    setBusy(true);
    try { after(await api.probationSendLetter(e.id)); } catch (x) { toastErr?.(x?.message || 'Could not send the letter.'); }
    setBusy(false);
  }
  const letter = data.letter || {};
  const [lw, lc] = LETTER_STATUS[letter.status] || [];
  // The server says when a letter can go (again) - a passed record has none until HR sends it.
  const canResend = !!data.canSendLetter;
  const history = all ? data.history : (data.history || []).slice(0, 4);
  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '5px 12px' };
  const d = data.decision || {};
  // Start A New Probation: a small link once a probation is closed or past (a new role, say).
  const startNew = data.canManage && data.applies && st && !open && (
    <button onClick={() => setModal('start')}
      style={{ background: 'none', border: 'none', color: 'var(--pine)', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '2px 0', marginTop: 6 }}>
      Start A New Probation
    </button>
  );
  const sendBtn = canResend && (
    <button className="secondary-btn" style={{ ...btn, marginTop: 6 }} disabled={busy} onClick={sendLetter}>
      {busy ? <Spinner size={13} /> : <Send size={13} />} Send Letter
    </button>
  );

  return (
    <section ref={ref} aria-label="Probation" style={{ marginBottom: 16, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: focus ? 'var(--wk-brand-tint)' : 'transparent' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase' }}>
          <CalendarClock size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Probation
        </span>
        <StatusLabel label={data.label} color={COLORS[st]} size="sm" />
        {open && data.ending && <ProbationBadge p={data} />}
        <span style={{ flex: 1 }} />
        {data.canDecide && !data.pending && (
          <button className="primary-btn" style={btn} onClick={() => setModal('decide')}>
            <CheckCircle2 size={13} /> {data.canFinalize ? 'Decide' : 'Recommend'}
          </button>
        )}
        {data.canManage && !st && data.applies && (
          <button className="secondary-btn" style={btn} onClick={() => setModal('start')} disabled={!e.startDate}
            title={e.startDate ? 'Probation counts from their start date' : 'Add their start date first'}>
            <Play size={13} /> Start Tracking
          </button>
        )}
        {data.canManage && open && <button className="secondary-btn" style={btn} onClick={() => setModal('edit')}><Pencil size={13} /> Edit</button>}
        {(data.canRemove ?? (data.canManage && open)) && (
          <button className="secondary-btn" style={btn} onClick={() => setModal('remove')}><MinusCircle size={13} /> Remove From Probation</button>
        )}
      </div>

      {!st ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
          {data.awaitingStart ? 'Starts by itself once their start date is added.'
            : e.startDate ? 'Not tracked. HR can start it from their start date.' : 'Not tracked. Add their start date - probation counts from it.'}
        </div>
      ) : st === 'past' ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
          <div>Past Probation since {usDay(data.pastSince)}. They were here past the probation window before it was tracked, so there is nothing to decide.</div>
          {startNew}
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          <Row k="Started">{usDay(data.startDate)}</Row>
          <Row k={open ? 'Ends' : st === 'removed' ? 'Was Due' : 'Ended'}>
            {usDay(data.endDate)}
            {open && data.daysLeft !== null && <span style={{ color: data.daysLeft < 0 ? 'hsl(var(--color-red))' : data.ending ? 'hsl(var(--color-orange))' : 'var(--muted)', marginLeft: 8, fontSize: 12.5 }}>({daysText(data.daysLeft)})</span>}
          </Row>
          {st !== 'extended' && <Row k="Length">{data.months} months{data.monthsOverride != null ? ' (set for them)' : ' (company length)'}{data.endManual ? ' - end date set by hand' : ''}</Row>}
          {data.decision && !open && (
            <Row k="Decision">
              {st === 'passed' ? (
                d.automatic || d.by === 'system'
                  ? `Passed Probation on ${usDay(data.endDate)} - automatically, no decision was recorded`
                  : `Passed Probation on ${usDay(data.endDate)}${d.byName ? ` by ${d.byName}` : ''}`
              ) : st === 'removed' ? (
                <>Removed From Probation on {usDay(d.at)}{d.byName ? ` by ${d.byName}` : ''}{d.reason ? `: ${d.reason}` : ''}</>
              ) : (
                <>
                  {data.label} {d.byName ? `by ${d.byName} ` : ''}on {usDay(d.at)}
                  {d.reason ? <span style={{ color: 'var(--muted)' }}> - {d.reason}</span> : null}
                </>
              )}
            </Row>
          )}
          {lw ? (
            <Row k="Letter">
              <StatusLabel size="sm" label={lw} color={lc} /> <span style={{ marginLeft: 6 }}>{letter.title}</span>
              {letter.error && <div style={{ fontSize: 12, color: 'hsl(var(--color-red))', marginTop: 4 }}>{letter.error}</div>}
              {sendBtn}
            </Row>
          ) : st === 'passed' && (
            <Row k="Letter">
              <span style={{ color: 'var(--muted)' }}>No letter went out by itself.{canResend ? ' Send them the confirmation letter if you want one on file.' : ''}</span>
              {sendBtn && <div>{sendBtn}</div>}
            </Row>
          )}
          {startNew}
        </div>
      )}

      {data.pending && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'hsla(var(--color-blue),0.08)', fontSize: 12.5, lineHeight: 1.5, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 200 }}>
            <b>{data.pending.byName}</b> recommends <b>{data.pending.label}</b>{data.pending.newEndDate ? ` to ${usDay(data.pending.newEndDate)}` : ''}
            {data.pending.reason ? `: ${data.pending.reason}` : ''}. {data.canFinalize ? '' : 'Waiting for HR.'}
          </span>
          {data.canFinalize && <button className="primary-btn" style={btn} onClick={() => setModal('approve')}>Review Recommendation</button>}
        </div>
      )}

      {st === 'ended' && data.canManage && data.employeeActive && (
        <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
          <span style={{ flex: 1, minWidth: 200, color: 'var(--muted)' }}>Probation ended without confirmation. The offboarding is not scheduled yet.</span>
          <button className="secondary-btn" style={{ ...btn, color: 'hsl(var(--color-red))', borderColor: 'hsla(var(--color-red),0.35)' }}
            onClick={() => onOffboard?.({ exit_type: 'termination', reason: data.decision?.reason || '' })}>
            <LogOut size={13} /> Start Offboarding
          </button>
        </div>
      )}

      {(data.history || []).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5 }}>
            <History size={11} /> History
          </div>
          {history.map((h, i) => (
            <div key={`${h.at}-${i}`} style={{ fontSize: 12.5, padding: '4px 0', display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--muted)', width: 82, flexShrink: 0 }}>{usDay(h.at)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{h.byName || 'Nexus'}</b> {(ACTIONS[h.action] || h.action).toLowerCase()}
                {h.note ? ` (${h.note})` : ''}{h.endDate && ['started', 'edited', 'extended'].includes(h.action) ? ` - ends ${usDay(h.endDate)}` : ''}
                {h.reason ? <span style={{ color: 'var(--muted)' }}> - {h.reason}</span> : null}
              </span>
            </div>
          ))}
          {(data.history || []).length > 4 && (
            <button onClick={() => setAll(a => !a)} style={{ background: 'none', border: 'none', color: 'var(--pine)', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '2px 0' }}>
              {all ? 'Show Less' : `Show All (${data.history.length})`}
            </button>
          )}
        </div>
      )}

      {(modal === 'decide' || modal === 'approve') && (
        <ProbationDecisionModal employee={e} data={data} mode={modal} onClose={() => setModal(null)} onDone={after} toastErr={toastErr} />
      )}
      {['start', 'edit', 'remove'].includes(modal) && (
        <ManageModal employee={e} data={data} mode={modal} onClose={() => setModal(null)} onDone={out => after(out)} toastErr={toastErr} />
      )}
    </section>
  );
}

// Settings > Hiring & Onboarding > Probation (layered: a default, and each
// company's own). Same save pattern as the other layered panels.
const NUMBER_FIELDS = [
  ['months', 'Probation Length', 'How long a new hire is on probation, from their start date. A person can have a length of their own on their profile.', 'months'],
  ['reminderDays', 'Reminder', 'Days before the end date the manager and the company HR contact are told, once. 0 turns the reminder off.', 'days before'],
];

export function ProbationSettings({ company: scoped, onOverride, toastOk, toastErr }) {
  const [meta, setMeta] = useState(null);
  const [vals, setVals] = useState({});
  const [saved, setSaved] = useState({});
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const company = scoped || '';
  const load = useCallback(() => {
    api.probationSettings(company).then(m => {
      const s = (m && m.settings) || {};
      setLoadErr('');
      setMeta(m && !Array.isArray(m) ? m : { settings: {}, templates: [], letterheads: [], limits: {} });
      setVals(s); setSaved(s);
    }).catch(x => setLoadErr(x?.message || 'Could not load the probation settings.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (meta && company) onOverride?.(!!meta.override); }, [meta, company, onOverride]);

  async function save(reset = false) {
    setBusy(true);
    try {
      const r = await api.probationSaveSettings({ company, settings: vals, reset });
      setVals(r.settings || vals); setSaved(r.settings || vals);
      setMeta(m => ({ ...m, override: r.override }));
      toastOk?.(reset ? 'Probation settings reset to the default.' : 'Probation settings saved.');
    } catch (x) { toastErr?.(x?.message || 'Could not save the probation settings.'); }
    setBusy(false);
  }
  if (loadErr) return <ErrorBanner message={loadErr} onRetry={() => { setLoadErr(''); load(); }} />;
  if (!meta) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;
  const canEdit = !!meta.canEdit;
  const keys = ['months', 'reminderDays', 'confirmTemplateId', 'extendTemplateId', 'letterheadId'];
  const dirty = keys.some(k => String(vals[k] ?? '') !== String(saved[k] ?? ''));
  const templates = meta.templates || [];
  const select = (k, label, options, none) => (
    <select className="form-input" aria-label={label} value={vals[k] ?? ''} disabled={!canEdit || busy}
      onChange={ev => setVals(v => ({ ...v, [k]: ev.target.value }))} style={{ fontSize: 13, maxWidth: 260 }}>
      <option value="">{none}</option>
      {options.map(o => <option key={o.id} value={o.id}>{o.name}{o.published === false ? ' (Not Published)' : ''}</option>)}
    </select>
  );
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <p className="nx-set-pad" style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
        New hires are on probation from their start date. A probation past its end with no decision or recommendation waiting passes by itself (no letter - HR can send one), and people who were already past the window read Past Probation.
        {company ? (meta.override ? ' This company has its own probation settings.' : ' This company uses the default.') : ' Each company can keep its own.'}
      </p>
      <SettingCard>
        {NUMBER_FIELDS.map(([k, title, desc, unit]) => {
          const [lo, hi] = meta.limits?.[k] || [0, 90];
          return (
            <SettingRow key={k} title={title} desc={desc}
              control={<NumberBox label={title} min={lo} max={hi} unit={unit} width={70} disabled={!canEdit || busy} value={vals[k] ?? ''}
                onChange={(v) => setVals(prev => ({ ...prev, [k]: v === '' ? '' : Number(v) }))} />} />
          );
        })}
        <SettingRow title="Confirmation Letter" desc="The Documents template sent when HR confirms - the employee signs it, the company signatory is printed."
          control={select('confirmTemplateId', 'Confirmation letter', templates, 'No Letter')} />
        <SettingRow title="Extension Letter" desc="The Documents template sent when HR extends probation, with the new end date and the reason."
          control={select('extendTemplateId', 'Extension letter', templates, 'No Letter')} />
        <SettingRow title="Letterhead" desc="Printed on the letters when the template uses one. Blank = the template's own, else the default letterhead."
          control={select('letterheadId', 'Letterhead', meta.letterheads || [], "The Template's Own")} />
      </SettingCard>
      {!canEdit ? (
        <p className="nx-set-pad" style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
          {!company && (meta.companies || []).length ? 'The default for every company is changed by an administrator. Pick your company in Applies To to set its own.' : 'Only HR editors and administrators can change these.'}
        </p>
      ) : (
        <div className="nx-set-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {dirty && <button type="button" className="primary-btn" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</button>}
          {dirty && <button type="button" className="secondary-btn" disabled={busy} onClick={() => setVals(saved)}>Discard Changes</button>}
          {!!company && !!meta.override && <button type="button" className="secondary-btn" disabled={busy} onClick={() => save(true)}>Use the Default</button>}
        </div>
      )}
    </div>
  );
}

export default ProbationCard;
