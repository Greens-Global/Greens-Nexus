// Peer feedback (Neil, Oct 29 2026: "add all the bigger features"). Two
// questions, one button. Asked about yourself = yours to read; asked by a
// manager or HR about someone = for the reporting chain and HR, never the
// person. backend/perf_feedback.py holds the rules; this draws what it says.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquareQuote, Plus, Search, Lock } from 'lucide-react';
import { api } from '../api';
import { Modal, Avatar, usePeople } from '../tasks/components';
import { StatusLabel } from '../components/StatusLabel';
import { SkeletonBlocks, LoadingState, ErrorBanner } from '../components/AsyncState';
import { formatDate } from '../lib/datetime';
import { NX } from '../tasks/theme';
import { Segmented } from './MyNumbers';
import { card, cardHead, HD, LBL, muted, TAP } from './lib';

const STATUS_COLOR = { requested: NX.amber, submitted: NX.green, declined: '#64748b', canceled: '#64748b' };
const QUESTIONS = [
  { id: 'well', text: 'What do they do well?' },
  { id: 'better', text: 'What could they do better?' },
];
const MAX_ASK = 10;

// Several colleagues from Nexus People, with a search - the list grows into
// the popup (nx-fill).
export function PeoplePicker({ value, onChange, exclude = [], max = MAX_ASK, label = 'Who' }) {
  const people = usePeople();
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = people.filter(p => !p.external && !exclude.includes(p.email)
      && (!needle || `${p.name} ${p.email}`.toLowerCase().includes(needle)));
    // Picked first, so they stay in sight.
    return out.sort((a, b) => (value.includes(b.email) - value.includes(a.email)) || a.name.localeCompare(b.name));
  }, [people, q, exclude, value]);
  const toggle = (email) => onChange(value.includes(email) ? value.filter(x => x !== email) : value.length >= max ? value : [...value, email]);
  return (
    <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 200 }}>
      <span style={LBL}>{label} <span style={{ fontWeight: 400 }}>({value.length} of {max} picked)</span></span>
      <span style={{ position: 'relative', display: 'flex' }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} aria-hidden="true" />
        <input className="form-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Search people" aria-label="Search people"
          style={{ paddingLeft: 30, width: '100%', fontSize: 16 }} />
      </span>
      <div role="group" aria-label={label} style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: '1px solid var(--line)' }}>
        {shown.length ? shown.map(p => (
          <label key={p.email} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', minHeight: 44, borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
            <input type="checkbox" checked={value.includes(p.email)} onChange={() => toggle(p.email)}
              disabled={!value.includes(p.email) && value.length >= max} />
            <Avatar email={p.email} name={p.name} size={26} card={false} />
            <span style={{ fontSize: 13.5 }}>{p.name}</span>
          </label>
        )) : <div style={{ ...muted, padding: 10 }}>Nobody matches.</div>}
      </div>
    </div>
  );
}

export function AskFeedbackModal({ me, subject = '', subjectName = '', reviewId = '', onClose, onDone, toastErr }) {
  const [givers, setGivers] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const self = !subject || subject === me;
  const first = (subjectName || '').split(' ')[0];
  async function send() {
    if (!givers.length) { toastErr?.('Pick who to ask.'); return; }
    setBusy(true);
    try {
      const out = await api.perfFeedbackAsk({ subject: self ? '' : subject, givers, note, review_id: reviewId });
      onDone?.(out);
    } catch (e) { toastErr?.(e?.message || 'Could not send the ask.'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={self ? 'Ask for Feedback' : `Ask for Feedback About ${first || 'Them'}`} onClose={onClose} isDirty={givers.length > 0 || !!note.trim()}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-btn" disabled={busy || !givers.length} onClick={send}>{busy ? 'Sending' : `Send${givers.length ? ` (${givers.length})` : ''}`}</button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ ...muted, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          {self ? 'They answer two questions about you: what you do well, and what you could do better. Only you read the answers.'
            : <><Lock size={13} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" /> They answer two questions about {first || 'them'}. The answers are for {first ? `${first}'s` : 'their'} managers and HR - {first ? `${first} never sees` : 'they never see'} them.</>}
        </div>
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={LBL}>Note (Optional)</span>
          <textarea className="form-input" rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={1000}
            placeholder={self ? 'Anything you would like them to think about' : 'The project or period you would like them to think about'} style={{ fontSize: 16, resize: 'vertical' }} />
        </label>
        <PeoplePicker value={givers} onChange={setGivers} exclude={[me, subject].filter(Boolean)} label="Ask" />
      </div>
    </Modal>
  );
}

export function FeedbackModal({ id, onClose, onChanged, toastOk, toastErr }) {
  const [f, setF] = useState(null);
  const [err, setErr] = useState('');
  const [answers, setAnswers] = useState({});
  const [declining, setDeclining] = useState(false);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.perfFeedback(id).then(x => { if (live) { setF(x); setAnswers(x.answers || {}); } })
      .catch(e => { if (live) setErr(e?.message || 'Could not load the feedback.'); });
    return () => { live = false; };
  }, [id]);
  const dirty = !!f?.can.answer && QUESTIONS.some(q => (answers[q.id] || '') !== (f.answers?.[q.id] || ''));
  const act = async (fn, ok) => {
    setBusy(true);
    try { const x = await fn(); setF(x); setAnswers(x.answers || {}); toastOk?.(ok); onChanged?.(); return x; }
    catch (e) { toastErr?.(e?.message || 'Could not do that.'); return null; }
    finally { setBusy(false); }
  };
  const about = f ? (f.subjectEmail === f.requestedBy ? 'themselves' : f.subjectName) : '';
  return (
    <Modal title={f ? `Feedback About ${f.subjectName}` : 'Feedback'} onClose={onClose} isDirty={dirty}
      onSave={dirty ? () => act(() => api.perfFeedbackAnswer(id, { answers }), 'Saved.') : undefined}
      footer={f?.can.answer ? <>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => setDeclining(true)}>Decline</button>
        <button type="button" className="secondary-btn" disabled={busy || !dirty} onClick={() => act(() => api.perfFeedbackAnswer(id, { answers }), 'Saved.')}>Save Draft</button>
        <button type="button" className="primary-btn" disabled={busy}
          onClick={async () => { if (await act(() => api.perfFeedbackAnswer(id, { answers, submit: true }), 'Sent - thank you.')) onClose(); }}>Submit</button>
      </> : <>
        {f?.can.cancel && <button type="button" className="secondary-btn" disabled={busy} onClick={() => act(() => api.perfFeedbackCancel(id), 'Canceled.')}>Cancel the Ask</button>}
        <button type="button" className="primary-btn" onClick={onClose}>Done</button>
      </>}>
      {err ? <ErrorBanner message={err} /> : !f ? <LoadingState size="section" label="Loading the feedback" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <StatusLabel label={f.statusLabel} color={STATUS_COLOR[f.status]} size="md" />
            <span style={muted}>{f.requestedByName} asked {f.giverName} about {about} · {formatDate(f.requestedAt)}</span>
            {f.private && <span style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Lock size={12} aria-hidden="true" /> Managers and HR only</span>}
          </div>
          {f.note && <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', borderLeft: '2px solid var(--line)', paddingLeft: 10 }}>{f.note}</div>}
          {declining ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={LBL}>Why Not (Optional)</span>
                <textarea className="form-input" rows={2} value={why} onChange={e => setWhy(e.target.value)} style={{ fontSize: 16 }} />
              </label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="secondary-btn" onClick={() => setDeclining(false)}>Keep It</button>
                <button type="button" className="primary-btn" disabled={busy}
                  onClick={async () => { if (await act(() => api.perfFeedbackDecline(id, why), 'Declined.')) onClose(); }}>Decline the Ask</button>
              </div>
            </div>
          ) : QUESTIONS.map((q, i) => (
            <label key={q.id} className={i === QUESTIONS.length - 1 && f.can.answer ? 'nx-fill' : undefined}
              style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: i === QUESTIONS.length - 1 && f.can.answer ? 1 : undefined }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{q.text}</span>
              {f.can.answer ? (
                <textarea className="form-input" rows={4} value={answers[q.id] || ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                  style={{ fontSize: 16, resize: 'vertical', flex: 1, minHeight: 96 }} />
              ) : <span style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{f.answers?.[q.id] || <span style={muted}>-</span>}</span>}
            </label>
          ))}
          {f.status === 'declined' && f.declineNote && <div style={muted}>Declined: {f.declineNote}</div>}
        </div>
      )}
    </Modal>
  );
}

function FeedbackRows({ items, onOpen, who = 'giver', empty }) {
  if (!items.length) return <div style={muted}>{empty}</div>;
  return (
    <div className="nx-perf-list" role="list">
      {items.map(f => {
        const email = who === 'giver' ? f.giverEmail : who === 'asker' ? f.requestedBy : f.subjectEmail;
        const name = who === 'giver' ? f.giverName : who === 'asker' ? f.requestedByName : f.subjectName;
        const said = f.answers?.well || f.answers?.better || '';
        return (
          <div key={f.id} className="nx-perf-row" role="listitem">
            <button type="button" className="nx-perf-fb" onClick={() => onOpen(f)}>
              <Avatar email={email} name={name} size={28} card={false} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{name}</span>
                <span style={{ display: 'block', ...muted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {said || (who === 'asker' ? `About ${f.subjectEmail === f.requestedBy ? 'themselves' : f.subjectName}` : f.note || `Asked ${formatDate(f.requestedAt)}`)}
                </span>
              </span>
              <StatusLabel label={f.statusLabel} color={STATUS_COLOR[f.status]} size="sm" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// The Feedback card. `email` '' = me (asks waiting on me, and feedback I
// asked for about myself); someone else = what I may read about them.
export function FeedbackCard({ ctx, email = '', name = '', focusId = '', toastOk, toastErr }) {
  const self = !email || email === ctx?.email;
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('waiting');
  const [ask, setAsk] = useState(false);
  const [open, setOpen] = useState(focusId);
  const [prevFocus, setPrevFocus] = useState(focusId);
  if (focusId !== prevFocus) { setPrevFocus(focusId); if (focusId) setOpen(focusId); }
  const load = useCallback(() => api.perfFeedbackList(self ? '' : email).then(r => { setErr(''); setData(r); })
    .catch(e => setErr(e?.message || 'Could not load the feedback.')), [self, email]);
  useEffect(() => { load(); }, [load]);
  const first = (name || '').split(' ')[0];
  const waiting = data?.toAnswer || [];
  const aboutMe = data?.aboutMe || [];
  const about = data?.about || [];
  const view = self && !waiting.length && tab === 'waiting' ? 'mine' : tab;
  return (
    <section style={card} aria-label="Feedback">
      <div style={cardHead}>
        <span className="wkc-chip"><MessageSquareQuote size={14} /></span>
        <span style={HD}>Feedback</span>
        <button type="button" className="secondary-btn" onClick={() => setAsk(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', minHeight: 36 }}>
          <Plus size={14} /> {self ? 'Ask for Feedback' : 'Ask About Them'}
        </button>
      </div>
      {err ? <ErrorBanner message={err} onRetry={load} /> : data === null ? <SkeletonBlocks count={2} height={44} /> : self ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <div><Segmented label="Feedback" value={view} onChange={setTab}
            options={[{ key: 'waiting', label: `Waiting on You${waiting.length ? ` (${waiting.length})` : ''}` }, { key: 'mine', label: 'About You' }]} /></div>
          {view === 'waiting'
            ? <FeedbackRows items={waiting} onOpen={f => setOpen(f.id)} who="asker" empty="Nobody is waiting on your feedback." />
            : <FeedbackRows items={aboutMe} onOpen={f => setOpen(f.id)} empty="Ask a few colleagues what you do well and what you could do better - only you read the answers." />}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ ...muted, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Lock size={12} aria-hidden="true" /> For managers and HR - {first ? `${first} never sees` : 'they never see'} these.</div>
          <FeedbackRows items={about} onOpen={f => setOpen(f.id)} empty={`No feedback about ${first || 'them'} yet. Ask a few colleagues who work with them.`} />
        </div>
      )}
      {ask && <AskFeedbackModal me={ctx?.email} subject={self ? '' : email} subjectName={name} onClose={() => setAsk(false)} toastErr={toastErr}
        onDone={(out) => { setAsk(false); setTab('mine'); load(); toastOk?.(out.asked ? `Asked ${out.asked} ${out.asked === 1 ? 'person' : 'people'}.` : 'They were already asked.'); }} />}
      {open && <FeedbackModal id={open} onClose={() => { setOpen(''); load(); }} onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
    </section>
  );
}

// Beside the review form: what colleagues said, and Ask for more.
export function ReviewFeedback({ r, me, toastOk, toastErr, onAsked }) {
  const [ask, setAsk] = useState(false);
  const [open, setOpen] = useState('');
  const items = r.peerFeedback || [];
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <FeedbackRows items={items} onOpen={f => setOpen(f.id)} empty="No feedback from colleagues for this period." />
      {r.can?.askFeedback && (
        <div><button type="button" className="secondary-btn" onClick={() => setAsk(true)}
          style={{ ...TAP, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Ask Colleagues</button></div>
      )}
      {ask && <AskFeedbackModal me={me} subject={r.employeeEmail} subjectName={r.employeeName} reviewId={r.id} onClose={() => setAsk(false)} toastErr={toastErr}
        onDone={(out) => { setAsk(false); onAsked?.(); toastOk?.(out.asked ? `Asked ${out.asked} - their answers show here.` : 'They were already asked.'); }} />}
      {open && <FeedbackModal id={open} onClose={() => setOpen('')} toastOk={toastOk} toastErr={toastErr} />}
    </div>
  );
}
