// The candidate card in Hiring (Neil, Oct 8 and Oct 14). Each stage has ONE
// obvious next step and nothing that belongs to a later stage:
//
//   Applied    - the resume came in: Move To Screening, or Reject
//   Screening  - screening notes, then Schedule Interview, or Reject
//                ("the action should not be moved to interview. It should be
//                schedule an interview")
//   Interview  - the rounds with date, time and who it is with; Open the
//                Interview Room when they come in; Move To Offer, or Reject
//   Offer      - the offer letter (Neil, Oct 14): Move To Offer opens Make An
//                Offer, the letter is verified and signed by both sides, and
//                that signature is the hire; another round still possible
//                (moves them back to Interview); Mark Hired By Hand for paper
//   Hired      - the hiring packet ("right to work compliance") follows the
//                signed offer by itself - its status shows here
//   Rejected   - Reopen, or Remove From Board
//
// Laid out so it is clear where they are (Neil: "I'm not clear on what step
// I'm on"): the stages as a progress bar across the top, one Next box with
// the one thing to do, and the rest in tabs - Overview, Notes, Interviews,
// Offer & Documents - instead of one long scroll (Pranshu, Oct 15).
// Scheduling is one path (HiringSchedule.jsx) - it sends the Teams invite
// and moves the stage.
import { useEffect, useRef, useState } from 'react';
import { X, CalendarDays, FileText, FileSignature, XCircle, ChevronRight, Video, ClipboardList,
         RotateCcw, Trophy, Undo2, Check } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDateTime } from '../lib/datetime';
import { Spinner } from './AsyncState';
import { HiringPacketStatus, packetIsActive, usDay } from './HiringPacket';
import { useEntities } from '../lib/queries';
import { RecordingLine } from './Interviews';
import CandidateNotes from './CandidateNotes';

export const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired'];
export const STAGE_META = {
  applied:   { label: 'Applied',   hue: '215,15%,55%' },
  screening: { label: 'Screening', hue: '215,75%,45%' },
  interview: { label: 'Interview', hue: '30,80%,48%' },
  offer:     { label: 'Offer',     hue: '271,60%,48%' },
  hired:     { label: 'Hired',     hue: '142,60%,35%' },
  rejected:  { label: 'Rejected',  hue: '350,65%,48%' },
};
export const candName = c => [c.firstName, c.lastName].filter(Boolean).join(' ');

const NEXT_STEP = {
  applied: 'Read the resume, then move them to Screening - or reject.',
  screening: 'Add your screening notes, then schedule the interview - or reject.',
  interview: 'Open the Interview Room when they come in. Afterward, Move To Offer - you answer the offer questions and Nexus fills in the right letter.',
  offer: 'The offer letter is checked, then signed by the company and by them (no login). When both have signed, they are hired and their hiring packet goes out by itself.',
  rejected: 'Closed. Reopen to put them back in the pipeline, or remove them from the board.',
  hired: 'Hired - their record is in People. Their hiring packet (right to work paperwork) is tracked below and on their Checklist.',
};
const ROUND_STATUS = {
  scheduled: ['Scheduled', 'blue'], live: ['In Progress', 'orange'], completed: ['Completed', 'gray'],
  scored: ['Scored', 'green'], canceled: ['Canceled', 'gray'],
};
const chip = (tone) => ({ padding: '2px 9px', borderRadius: 12, fontSize: 11, fontWeight: 700,
  background: tone === 'gray' ? 'var(--mist)' : `hsla(var(--color-${tone}),0.12)`, color: tone === 'gray' ? 'var(--muted)' : `hsl(var(--color-${tone}))` });
const rejectBtn = { background: 'none', border: '1px solid hsla(var(--color-red),0.4)', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, cursor: 'pointer', color: 'hsl(var(--color-red))', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'Inter,sans-serif' };

// The stages as a bar: done, here, still to come. Rejected shows on its own.
function StageBar({ stage }) {
  if (stage === 'rejected') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0 4px', fontSize: 13, fontWeight: 700, color: `hsl(${STAGE_META.rejected.hue})` }}>
        <XCircle size={15} /> Rejected
      </div>
    );
  }
  const at = STAGES.indexOf(stage);
  return (
    <div role="list" aria-label="Hiring stages" style={{ display: 'flex', alignItems: 'center', padding: '12px 0 4px', overflowX: 'auto' }} className="scroll-tabs">
      {STAGES.map((s, i) => {
        const done = i < at, here = i === at;
        const hue = STAGE_META[s].hue;
        return (
          <div key={s} role="listitem" aria-current={here ? 'step' : undefined} style={{ display: 'flex', alignItems: 'center', flex: i < STAGES.length - 1 ? 1 : 'none', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
              <span style={{ width: 22, height: 22, borderRadius: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800,
                background: here ? `hsl(${hue})` : done ? 'hsla(var(--color-green),0.15)' : 'var(--mist)',
                color: here ? '#fff' : done ? 'hsl(var(--color-green))' : 'var(--muted)', border: here ? 'none' : '1px solid var(--line)' }}>
                {done ? <Check size={12} /> : i + 1}
              </span>
              <span style={{ fontSize: 12.5, fontWeight: here ? 800 : 600, color: here ? 'var(--ink)' : done ? 'var(--ink)' : 'var(--muted)' }}>{STAGE_META[s].label}</span>
            </div>
            {i < STAGES.length - 1 && <span style={{ flex: 1, height: 2, margin: '0 10px', background: done ? 'hsla(var(--color-green),0.4)' : 'var(--line)', minWidth: 14 }} />}
          </div>
        );
      })}
    </div>
  );
}

export default function CandidateDetailModal({
  candidate: c, onClose, onStage, onUpdated, busy, refreshKey,
  onEdit, onSchedule, onOpenRoom, onSendPacket, onMakeOffer, onSignPacket, onSendForSignature, onOpenPerson, onMarkHired, toastOk, toastErr,
}) {
  const [rounds, setRounds] = useState(null);
  const [packetEvents, setPacketEvents] = useState(null);
  const [packetPick, setPacketPick] = useState(null);   // which packet Send will use (Offer stage)
  useEffect(() => {
    if (c.stage !== 'offer') { setPacketPick(null); return; }
    api.hiringPacketOptions(c.id).then(setPacketPick).catch(() => setPacketPick({ picked: null, options: [] }));
  }, [c.id, c.stage, c.roleId, refreshKey]);
  // The draft in the Notes box goes along with a move made from this card.
  const [note, setNote] = useState('');
  const [notesKey, setNotesKey] = useState(0);
  const [resumeBusy, setResumeBusy] = useState(false);
  const resumeRef = useRef(null);
  // The tab that matters for the stage opens first.
  const [tab, setTab] = useState(() => (c.stage === 'interview' ? 'interviews' : ['offer', 'hired'].includes(c.stage) ? 'documents' : 'overview'));

  useEffect(() => { api.ivList(c.id).then(setRounds).catch(() => setRounds([])); }, [c.id, c.stage, refreshKey]);

  const sm = STAGE_META[c.stage] || STAGE_META.applied;
  const closed = c.stage === 'hired' || c.stage === 'rejected';
  const live = (rounds || []).filter(r => r.status !== 'canceled');
  const upcoming = live.filter(r => ['scheduled', 'live'].includes(r.status));
  const hadInterview = live.some(r => ['completed', 'scored'].includes(r.status));
  const roomAllowed = ['interview', 'offer'].includes(c.stage) && live.length > 0;
  const packetOut = packetIsActive(packetEvents);
  // HR's own turn on the offer or packet: the footer's Sign & Offer (Pranshu, Oct 8).
  const awaitingMe = (packetEvents || []).find(e => ['offer', 'hire'].includes(e.kind) && e.status === 'awaiting_sender' && e.senderPartyId) || null;
  // Offer letters this company can send (Oct 14). With none set up, the old
  // packet-only send stays available so nothing is stuck.
  const [offerChoices, setOfferChoices] = useState(null);
  useEffect(() => {
    if (!['interview', 'offer'].includes(c.stage) || !onMakeOffer) { setOfferChoices(null); return; }
    api.offerOptions(c.id).then(o => setOfferChoices(o.choices || [])).catch(() => setOfferChoices([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only whether there is an offer flow, not the callback's identity
  }, [c.id, c.stage, refreshKey, !!onMakeOffer]);
  const offers = onMakeOffer && (offerChoices === null || offerChoices.length > 0);
  const offerSigned = (packetEvents || []).some(e => e.kind === 'offer' && e.status === 'completed');
  // Once an interview is on the books the record is settled - no more editing
  // of who they are or which company; the email goes with the packet.
  const canEdit = ['applied', 'screening'].includes(c.stage);
  const { data: entities } = useEntities();
  const companyName = (entities || []).find(e => e.id === c.company)?.name || '';
  // A move takes the note being written with it, then the box is clear.
  const move = (stage, fallback = '') => { onStage(c, stage, note.trim() || fallback); setNote(''); setNotesKey(k => k + 1); };
  async function uploadResume(file) {
    if (!file) return;
    setResumeBusy(true);
    try { const f = new FormData(); f.append('file', file); onUpdated?.(await api.candidateResumeUpload(c.id, f)); toastOk?.('Resume uploaded.'); }
    catch (e) { toastErr?.(e?.message || 'Could not upload the resume.'); }
    setResumeBusy(false);
    if (resumeRef.current) resumeRef.current.value = '';
  }
  async function viewResume() {
    try { const { url } = await api.candidateResumeUrl(c.id); window.open(url, '_blank', 'noopener'); }
    catch (e) { toastErr?.(e?.message || 'Could not open the resume.'); }
  }
  async function cancelRound(r) {
    if (!await dialog.confirm('Cancel this interview? The Teams invite is withdrawn.', { title: 'Cancel Interview', confirmText: 'Cancel Interview' })) return;
    try { await api.ivCancel(r.id); setRounds(await api.ivList(c.id)); onUpdated?.(null); toastOk?.('Interview canceled.'); }
    catch (e) { toastErr?.(e?.message || 'Could not cancel it.'); }
  }
  async function toOffer() {
    if (!hadInterview && !await dialog.confirm('No interview has been completed yet. Make the offer anyway?', { title: 'Move To Offer', confirmText: 'Continue' })) return;
    // The offer questions come up right here (Neil: "right when you click move
    // to offer, these questions should come up").
    if (offers) onMakeOffer(c);
    else move('offer');
  }
  async function markHiredByHand() {
    // Neil, Oct 14: hiring "backwards" outside Nexus is what we are getting
    // away from - so a hire by hand always says why.
    if (onMarkHired) { onMarkHired(c); return; }
    const why = note.trim() || await dialog.prompt(`Mark ${candName(c)} hired without the hiring packet? Say why - for example "signed the offer on paper".`,
      { title: 'Mark Hired By Hand', confirmText: 'Mark Hired', required: true });
    if (why) onStage(c, 'hired', why);
  }
  async function removeFromBoard(inactive) {
    try { onUpdated?.(await api.updateCandidate(c.id, { inactive })); toastOk?.(inactive ? `${candName(c)} removed from the board - find them under Inactive.` : `${candName(c)} is back on the board.`); }
    catch (e) { toastErr?.(e?.message || 'Could not update them.'); }
  }

  const primary = (label, onClick, icon, disabled) => (
    <button className="primary-btn" onClick={onClick} disabled={busy || disabled} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {busy ? <Spinner size={14} /> : icon} {label}
    </button>
  );
  const secondary = (label, onClick, icon, disabled) => (
    <button className="secondary-btn" onClick={onClick} disabled={busy || disabled} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {icon} {label}
    </button>
  );
  const reject = <button onClick={() => move('rejected')} disabled={busy} style={rejectBtn}><XCircle size={13} /> Reject</button>;

  const footer = {
    applied: [reject, primary('Move To Screening', () => move('screening'), <ChevronRight size={14} />)],
    screening: [reject, primary('Schedule Interview', () => c.email ? onSchedule(c)
      : toastErr?.('Add the candidate\'s email first (Edit, top right) - the Teams invite goes there.'), <Video size={14} />)],
    interview: [reject,
      secondary('Another Round', () => onSchedule(c), <CalendarDays size={13} />),
      roomAllowed && secondary('Interview Room', () => onOpenRoom(c), <ClipboardList size={13} />),
      primary('Move To Offer', toOffer, <ChevronRight size={14} />)],
    offer: [reject,
      secondary('Another Interview', () => onSchedule(c), <Undo2 size={13} />),
      secondary('Mark Hired By Hand', markHiredByHand, null),
      awaitingMe && onSignPacket && primary('Sign & Offer', () => onSignPacket(awaitingMe.senderPartyId), <FileSignature size={14} />),
      !packetOut && offers && !offerSigned && primary('Make Offer', () => onMakeOffer(c), <FileSignature size={14} />, packetEvents === null),
      // No letter fits this hire (say only an India contractor letter exists
      // and this is a US employee): the old packet send stays reachable.
      !packetOut && offers && !offerSigned && packetPick?.picked && secondary('Send Hiring Packet Without An Offer Letter', () => onSendPacket(c), <FileText size={13} />),
      !packetOut && !offers && primary(packetPick?.picked?.engine === 'documents' ? 'Start Hiring Packet' : 'Send Hiring Packet',
        () => onSendPacket(c), <FileText size={14} />, packetEvents === null)],
    rejected: [!c.inactive && secondary('Remove From Board', () => removeFromBoard(true), <XCircle size={13} />),
      primary('Reopen', () => move('applied', 'Reopened'), <RotateCcw size={14} />)],
    hired: [c.employeeId && onOpenPerson && primary('Open In People', () => onOpenPerson(c), <ChevronRight size={14} />)],
  }[c.stage] || [];

  const TABS = [
    ['overview', 'Overview & Notes'],
    ...(live.length > 0 || ['interview', 'offer'].includes(c.stage) ? [['interviews', `Interviews${live.length ? ` (${live.length})` : ''}`]] : []),
    ...(['offer', 'hired'].includes(c.stage) ? [['documents', 'Offer & Documents']] : []),
  ];
  const shownTab = TABS.some(([k]) => k === tab) ? tab : 'overview';

  // About on the left, the notes thread on the right - a busy candidate
  // never pushes the notes off the bottom (Pranshu, Oct 15).
  const about = (label, value, missing) => (
    <div style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 13, marginTop: 2, wordBreak: 'break-word', color: missing ? 'hsl(var(--color-orange))' : 'var(--ink)' }}>{value}</div>
    </div>
  );
  const overview = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0 28px' }}>
      <div style={{ gridColumn: 'span 1', maxWidth: 320 }}>
        {about('Email', c.email || (canEdit ? 'No email yet - add it with Edit' : 'No email yet'), !c.email)}
        {c.phone && about('Phone', c.phone)}
        {c.expectedStart && about('Expected Start', usDay(c.expectedStart))}
        {c.expectedInterviewOn && ['applied', 'screening'].includes(c.stage) && about('Interview Expected By', `${usDay(c.expectedInterviewOn)} - screening due the business day before`)}
        {c.source && about('Came From', c.source)}
        <div style={{ padding: '7px 0' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Resume</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            {c.resumeUrl ? <button onClick={viewResume} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'hsl(var(--color-blue))', fontFamily: 'Inter,sans-serif', padding: 0 }}>View Resume</button>
              : <span style={{ fontSize: 13, color: 'var(--muted)' }}>None on file</span>}
            <input ref={resumeRef} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} onChange={e => uploadResume(e.target.files?.[0])} />
            {!closed && <button className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }} disabled={resumeBusy} onClick={() => resumeRef.current?.click()}>
              {resumeBusy ? 'Uploading...' : c.resumeUrl ? 'Replace' : 'Upload'}</button>}
          </div>
        </div>
        {c.inactive && <div style={{ fontSize: 12.5, color: 'hsl(var(--color-orange))', padding: '7px 0' }}>Inactive - off the board (removed, or rejected more than 90 days ago). Reopen to bring them back.</div>}
      </div>
      <div style={{ gridColumn: 'span 1', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 800, margin: '4px 0 10px' }}>Notes</div>
        <CandidateNotes candidateId={c.id} refreshKey={`${refreshKey}-${c.stage}-${notesKey}`} draft={note} onDraft={setNote}
          canAdd={c.stage !== 'hired'} toastErr={toastErr} />
        {!closed && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>A note still in the box goes with the next move you make here.</div>}
      </div>
    </div>
  );

  const interviews = (
    <div>
      {rounds === null ? <Spinner size={16} /> : live.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No interview scheduled.</div>
      ) : live.map(r => {
        const [label, tone] = ROUND_STATUS[r.status] || [r.status, 'gray'];
        return (
          <div key={r.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13.5 }}>{formatDateTime(r.at)}</b>
              <span style={chip(tone)}>{label}</span>
              {r.status === 'scored' && <span style={{ fontSize: 12.5, fontWeight: 800, color: 'hsl(var(--color-green))' }}><Trophy size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />{Math.round(r.totalScore)}/100</span>}
              <span style={{ flex: 1 }} />
              {r.status === 'scheduled' && !closed && <>
                <button className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => onSchedule(c, r)}>Reschedule</button>
                <button className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => cancelRound(r)}>Cancel</button>
              </>}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 5 }}>
              With {(r.interviewerNames || r.interviewerEmails || []).join(', ') || 'no one set'} · {r.durationMin} minutes
              {r.templateName ? ` · Questionnaire: ${r.templateName}` : ' · No questionnaire'}
            </div>
            <div style={{ marginTop: 8 }}><RecordingLine iv={r} toastErr={toastErr} compact /></div>
          </div>
        );
      })}
      {upcoming.length === 0 && c.stage === 'interview' && live.length > 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nothing coming up - schedule another round, or move them on.</div>}
    </div>
  );

  const documents = (
    <div>
      <HiringPacketStatus candidateId={c.id} refreshKey={refreshKey} onEvents={setPacketEvents} hideSign
        onSignNow={onSignPacket} onChanged={() => onUpdated?.(null)} toastOk={toastOk} toastErr={toastErr} />
      {c.stage === 'offer' && !packetOut && packetEvents !== null && !(packetEvents || []).length && (
        <div style={{ fontSize: 13, color: 'var(--muted)', padding: '14px 0' }}>
          {offers ? 'No offer made yet - click Make Offer below.' : packetPick?.picked
            ? <><b style={{ color: 'var(--ink)' }}>Hiring packet:</b> {packetPick.picked.templateName} <span>- {packetPick.picked.why}</span></>
            : <span style={{ color: 'hsl(var(--color-orange))' }}>No hiring packet is set up for this company and role - add one in Settings &gt; Hiring &gt; Hiring Documents before sending.</span>}
        </div>
      )}
      {c.stage === 'offer' && c.email && onSendForSignature && (
        <button onClick={() => { onSendForSignature(c); onClose(); }}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)', textDecoration: 'underline', fontFamily: 'Inter,sans-serif', marginTop: 8 }}>
          Send a different document for signature
        </button>
      )}
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 18, width: 'max(min(100%, 560px), 60vw)', maxWidth: '100%', minHeight: 'min(60vh, 90dvh)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '18px 28px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 18 }}>{candName(c)}</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
                {[c.roleTitle, c.department, companyName].filter(Boolean).join(' · ')}
              </div>
            </div>
            {onEdit && canEdit && <button className="secondary-btn" onClick={() => onEdit(c)} style={{ fontSize: 12.5, padding: '5px 12px', flexShrink: 0 }}>Edit</button>}
            <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
          </div>
          <StageBar stage={c.stage} />
          <div style={{ background: `hsla(${sm.hue},0.08)`, borderRadius: 12, padding: '11px 14px', fontSize: 13.5, display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 10, lineHeight: 1.5 }}>
            <ChevronRight size={16} style={{ color: `hsl(${sm.hue})`, flexShrink: 0, marginTop: 2 }} />
            <span><b>Next:</b> {NEXT_STEP[c.stage]}</span>
          </div>
          <div role="tablist" aria-label="Candidate sections" className="scroll-tabs" style={{ display: 'flex', gap: 2, marginTop: 14, borderBottom: '1px solid var(--line)', overflowX: 'auto' }}>
            {TABS.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={shownTab === k} onClick={() => setTab(k)}
                style={{ padding: '8px 14px 10px', border: 'none', borderBottom: `2px solid ${shownTab === k ? 'var(--pine)' : 'transparent'}`, background: 'none', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: shownTab === k ? 800 : 600, color: shownTab === k ? 'var(--ink)' : 'var(--muted)', whiteSpace: 'nowrap' }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 28px 20px' }}>
          {shownTab === 'overview' && overview}
          {shownTab === 'interviews' && interviews}
          {shownTab === 'documents' && documents}
          {/* The packet status is read even when its tab is not open - the footer depends on it. */}
          {shownTab !== 'documents' && ['offer', 'hired'].includes(c.stage) && (
            <div style={{ display: 'none' }}>
              <HiringPacketStatus candidateId={c.id} refreshKey={refreshKey} onEvents={setPacketEvents} hideSign onSignNow={onSignPacket} onChanged={() => onUpdated?.(null)} toastOk={toastOk} toastErr={toastErr} />
            </div>
          )}
        </div>
        {footer.filter(Boolean).length > 0 && (
          <div style={{ padding: '14px 28px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', flexShrink: 0 }}>
            {footer.filter(Boolean).map((el, i) => <span key={i} style={{ display: 'contents' }}>{el}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}
