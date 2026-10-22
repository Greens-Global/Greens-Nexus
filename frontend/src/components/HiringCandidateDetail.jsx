// The candidate card in Hiring (Neil, Oct 8 and Oct 14). Each stage has ONE
// obvious next step and nothing that belongs to a later stage:
//
//   Applied    - the resume came in: Move To Screening, or Reject
//   Screening  - screening notes, then Schedule Interview, or Reject
//                ("the action should not be moved to interview. It should be
//                schedule an interview")
//   Interview  - the rounds with date, time and who it is with; Open the
//                Interview Room when they come in; Move To Decision, or Reject
//   Decision   - (Neil, Oct 19) every interviewer answers Yes or No and why on
//                their "Decide on" task, the department head makes the final
//                call; then Make Offer (green) or Reject (red)
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
         RotateCcw, Trophy, Undo2, Check, CheckCircle2, Circle, AlertTriangle, Settings, ThumbsUp, ThumbsDown, Clock } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDateTime } from '../lib/datetime';
import { Spinner } from './AsyncState';
import { HiringPacketStatus, packetIsActive, usDay } from './HiringPacket';
import { useEntities } from '../lib/queries';
import { RecordingLine } from './Interviews';
import CandidateNotes from './CandidateNotes';

export const STAGES = ['applied', 'screening', 'interview', 'decision', 'offer', 'hired'];
export const STAGE_META = {
  applied:   { label: 'Applied',   hue: '215,15%,55%' },
  screening: { label: 'Screening', hue: '215,75%,45%' },
  interview: { label: 'Interview', hue: '30,80%,48%' },
  decision:  { label: 'Decision',  hue: '190,70%,36%' },
  offer:     { label: 'Offer',     hue: '271,60%,48%' },
  hired:     { label: 'Hired',     hue: '142,60%,35%' },
  rejected:  { label: 'Rejected',  hue: '350,65%,48%' },
};
export const candName = c => [c.firstName, c.lastName].filter(Boolean).join(' ');

// Where the offer stands, one step per line (Pranshu, Oct 15 2026: "it
// should show that the candidate has signed and HR too"). From the latest
// offer letter that was not voided; the hiring packet step reads the packet
// that follows it - it goes out by itself once both have signed.
export function offerSteps(events, firstName = '') {
  const all = events || [];
  const offers = all.filter(e => e.kind === 'offer');
  const ev = offers.find(e => e.status !== 'voided') || null;
  if (!ev) return null;
  const parties = ev.parties || [];
  const company = parties.filter(p => !p.isSubject);
  const cand = parties.find(p => p.isSubject);
  const when = (iso) => (iso ? formatDateTime(iso) : '');
  const verified = !!ev.verifiedAt || !['review', 'intake'].includes(ev.status);
  const companySigned = company.length > 0 && company.every(p => p.signedAt);
  const candSigned = !!cand?.signedAt || ev.status === 'completed';
  const hire = all.find(e => e.kind === 'hire' && e.status !== 'voided');
  const stuck = (ev.flags || []).find(f => f.code === 'packet_not_started');
  const who = firstName || 'The candidate';
  const steps = [
    { key: 'prepared', label: 'Offer letter prepared', done: true, at: when(ev.createdAt) },
    { key: 'verified', label: verified ? 'Checked by HR' : 'Waiting for HR to check the letter', done: verified, at: when(ev.verifiedAt) },
    { key: 'company', label: companySigned ? `Signed by ${company.map(p => p.name).filter(Boolean).join(', ') || 'the company'}` : 'Waiting for the company (HR) to sign',
      done: companySigned, at: when(company.map(p => p.signedAt).filter(Boolean).sort().pop()) },
    { key: 'candidate', label: candSigned ? `Signed by ${who}` : `Waiting for ${who} to sign (no login)`, done: candSigned, at: when(cand?.signedAt) },
    { key: 'packet', label: hire ? 'Hiring packet sent' : stuck ? `Hiring packet did not start - ${stuck.message}` : 'Hiring packet - goes out by itself once both have signed',
      done: !!hire, error: !hire && !!stuck, at: when(hire?.createdAt) },
  ];
  const ended = ['declined', 'expired'].includes(ev.status) ? ev.status : '';
  return { steps, ended, declineReason: ev.declineReason || '' };
}

function OfferProgress({ events, firstName }) {
  const st = offerSteps(events, firstName);
  if (!st) return null;
  return (
    <div role="list" aria-label="Offer progress" style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', marginBottom: 12, display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>Offer Progress</div>
      {st.ended && (
        <div style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', fontWeight: 600 }}>
          The offer was {st.ended}{st.declineReason ? ` - ${st.declineReason}` : ''}. Make the offer again to continue.
        </div>
      )}
      {st.steps.map(s => (
        <div key={s.key} role="listitem" data-step={s.key} data-done={s.done || undefined}
          style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: s.done ? 'var(--ink)' : s.error ? 'hsl(var(--color-orange))' : 'var(--muted)' }}>
          {s.done ? <CheckCircle2 size={16} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />
            : s.error ? <AlertTriangle size={16} style={{ flexShrink: 0 }} />
              : <Circle size={16} style={{ flexShrink: 0, opacity: 0.6 }} />}
          <span style={{ flex: 1, minWidth: 0, fontWeight: s.done ? 600 : 500 }}>{s.label}</span>
          {s.at && <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{s.at}</span>}
        </div>
      ))}
    </div>
  );
}

// The Decision step (Neil, Oct 19): each interviewer's Yes / No and why, from
// their "Decide on" task, and the department head's final call.
function DecisionPanel({ candidateId, refreshKey, onReload }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.candidateDecision(candidateId).then(setD).catch(() => setD(false)); }, [candidateId, refreshKey]);
  if (d === null) return <div style={{ marginBottom: 16 }}><Spinner size={16} /></div>;
  if (!d) {
    return (
      <div style={{ fontSize: 13, color: 'hsl(var(--color-red))', marginBottom: 16 }}>
        Could not load the interview feedback. <button className="secondary-btn" style={{ fontSize: 12, padding: '2px 10px', marginLeft: 6 }} onClick={onReload}>Try Again</button>
      </div>
    );
  }
  const final = d.decision === 'hire' ? ['Hire', 'green'] : d.decision === 'reject' ? ['Reject', 'red'] : null;
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', marginBottom: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 800 }}>Interview Feedback</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Answered on the "Decide on" task with Yes or No and why.</div>
      {d.votes.length === 0 ? (
        <div style={{ fontSize: 13, color: 'hsl(var(--color-orange))', padding: '8px 0' }}>Nobody to ask - set the department&apos;s lead in Company Settings &gt; Departments.</div>
      ) : d.votes.map(v => (
        <div key={v.email} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)', alignItems: 'flex-start' }}>
          {v.vote === 'yes' ? <ThumbsUp size={15} style={{ color: 'hsl(var(--color-green))', flexShrink: 0, marginTop: 2 }} aria-label="Yes" />
            : v.vote === 'no' ? <ThumbsDown size={15} style={{ color: 'hsl(var(--color-red))', flexShrink: 0, marginTop: 2 }} aria-label="No" />
              : <Clock size={15} style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 2 }} aria-label="Waiting" />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {v.name}
              {v.final && <span style={{ marginLeft: 8, padding: '1px 8px', borderRadius: 10, fontSize: 10.5, fontWeight: 700, background: 'var(--mist)', color: 'var(--muted)' }}>Final Call</span>}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', wordBreak: 'break-word', marginTop: 1 }}>{v.vote ? v.note : 'Waiting for their answer'}</div>
          </div>
          {v.at && <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatDateTime(v.at)}</span>}
        </div>
      ))}
      <div style={{ marginTop: 10, fontSize: 13 }}>
        {final
          ? <><b style={{ color: `hsl(var(--color-${final[1]}))` }}>Final Call: {final[0]}</b><span style={{ color: 'var(--muted)' }}> - {d.decisionByName}, {formatDateTime(d.decisionAt)}</span></>
          : <span style={{ color: 'var(--muted)' }}>Waiting on {d.deciderName || 'the department head'} for the final call.</span>}
      </div>
    </div>
  );
}

const NEXT_STEP = {
  applied: 'Read the resume, then move them to Screening - or reject.',
  screening: 'Add your screening notes, then schedule the interview - or reject.',
  interview: 'Open the Interview Room when they come in. When it is over (End Interview, or Nexus sees the meeting has ended) they move to Decision.',
  decision: 'Everyone who interviewed them answers Yes or No and why on their "Decide on" task, and the department head makes the final call. Then Make Offer - or Reject.',
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
// Reject is red and the way forward green (Neil, Oct 19: "red or green").
const rejectBtn = { background: 'hsl(var(--color-red))', border: '1px solid hsl(var(--color-red))', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, cursor: 'pointer', color: '#fff', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'Inter,sans-serif' };
const goGreen = { background: 'hsl(var(--color-green))', borderColor: 'hsl(var(--color-green))', color: '#fff' };

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
    <div role="list" aria-label="Hiring stages" style={{ display: 'flex', alignItems: 'center', padding: '14px 10px 6px 4px', overflow: 'visible' }}>
      {STAGES.map((s, i) => {
        const done = i < at, here = i === at;
        const hue = STAGE_META[s].hue;
        return (
          <div key={s} role="listitem" aria-current={here ? 'step' : undefined} style={{ display: 'flex', alignItems: 'center', flex: i < STAGES.length - 1 ? 1 : 'none', minWidth: 0 }}>
            {/* The stage they are at stands out; the others stay small. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: here ? 8 : 6, whiteSpace: 'nowrap',
              padding: here ? '6px 14px 6px 8px' : '0', borderRadius: 999,
              background: here ? `hsla(${hue},0.12)` : 'transparent', boxShadow: here ? `0 0 0 1.5px hsla(${hue},0.35)` : 'none',
              transform: here ? 'scale(1.04)' : 'none', transformOrigin: 'center', transition: 'transform .15s' }}>
              <span style={{ width: here ? 26 : 22, height: here ? 26 : 22, borderRadius: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: here ? 12.5 : 11, fontWeight: 800,
                background: here ? `hsl(${hue})` : done ? 'hsla(var(--color-green),0.15)' : 'var(--mist)',
                color: here ? '#fff' : done ? 'hsl(var(--color-green))' : 'var(--muted)', border: here ? 'none' : '1px solid var(--line)' }}>
                {done ? <Check size={11} /> : i + 1}
              </span>
              <span style={{ fontSize: here ? 14 : 12.5, fontWeight: here ? 800 : 600, color: here ? `hsl(${hue})` : done ? 'var(--ink)' : 'var(--muted)' }}>{STAGE_META[s].label}</span>
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
  const [decisionKey, setDecisionKey] = useState(0);

  useEffect(() => { api.ivList(c.id).then(setRounds).catch(() => setRounds([])); }, [c.id, c.stage, refreshKey]);

  const sm = STAGE_META[c.stage] || STAGE_META.applied;
  const closed = c.stage === 'hired' || c.stage === 'rejected';
  const live = (rounds || []).filter(r => r.status !== 'canceled');
  const upcoming = live.filter(r => ['scheduled', 'live'].includes(r.status));
  const hadInterview = live.some(r => ['completed', 'scored'].includes(r.status));
  const roomAllowed = ['interview', 'decision', 'offer'].includes(c.stage) && live.length > 0;
  const packetOut = packetIsActive(packetEvents);
  // HR's own turn on the offer or packet: the footer's Sign & Offer (Pranshu, Oct 8).
  const awaitingMe = (packetEvents || []).find(e => ['offer', 'hire'].includes(e.kind) && e.status === 'awaiting_sender' && e.senderPartyId) || null;
  // Offer letters this company can send (Oct 14). The offer comes first
  // (Pranshu, Oct 15): with none set up, Move To Offer says so instead of
  // quietly moving the stage, and the hiring packet waits for a signed offer.
  // A failed check is an error (offerErr), never read as "none set up".
  const [offerChoices, setOfferChoices] = useState(null);
  const [offerErr, setOfferErr] = useState(false);
  const loadOfferChoices = () => api.offerOptions(c.id)
    .then(o => { const list = o.choices || []; setOfferChoices(list); setOfferErr(false); return list; })
    .catch(() => { setOfferErr(true); return null; });
  useEffect(() => {
    if (!['decision', 'offer'].includes(c.stage) || !onMakeOffer) { setOfferChoices(null); setOfferErr(false); return; }
    loadOfferChoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only whether there is an offer flow, not the callback's identity
  }, [c.id, c.stage, refreshKey, !!onMakeOffer]);
  const offers = onMakeOffer && (offerChoices === null || offerChoices.length > 0);
  const noOfferLetter = !!onMakeOffer && Array.isArray(offerChoices) && offerChoices.length === 0;
  const offerSigned = (packetEvents || []).some(e => e.kind === 'offer' && e.status === 'completed');
  const goHiringSettings = () => { onClose?.(); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'admin-console', sub: 'global-hiring' } })); };
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
    // An interview skipped on purpose (Skip Interview) is not a missing one.
    if (!hadInterview && !c.interviewSkippedBy && !await dialog.confirm('No interview has been completed yet. Make the offer anyway?', { title: 'Make Offer', confirmText: 'Continue' })) return;
    if (c.stage === 'decision' && c.decision !== 'hire' && !await dialog.confirm(
      c.decision === 'reject' ? 'The department head said No. Make the offer anyway?' : 'The department head has not made the final call yet. Make the offer anyway?',
      { title: 'Make Offer', confirmText: 'Continue' })) return;
    // The offer questions come up right here (Neil: "right when you click move
    // to offer, these questions should come up").
    if (!onMakeOffer) { move('offer'); return; }   // a screen with no offer flow
    // Not loaded yet, or the last check failed: ask again before deciding.
    const list = (offerChoices === null || offerErr) ? await loadOfferChoices() : offerChoices;
    if (list === null) { toastErr?.('Could not check the offer letters for this company - try again.'); return; }
    if (!list.length) {
      // No offer letter set up: say so here, not by silently moving the stage
      // (Pranshu, Oct 15). The hiring packet follows a signed offer.
      const go = await dialog.confirm(
        `No offer letter is set up for ${companyName || 'this company'} yet. The offer letter comes first - once ${c.firstName || 'they'} and HR have signed it, the hiring packet goes out by itself.\n\nAdd one under Settings > Hiring > Hiring Documents > Offer Letter, then click Move To Offer again.`,
        { title: 'Set Up an Offer Letter First', confirmText: 'Open Hiring Documents' });
      if (go) goHiringSettings();
      return;
    }
    onMakeOffer(c);
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

  const primary = (label, onClick, icon, disabled, look) => (
    <button className="primary-btn" onClick={onClick} disabled={busy || disabled} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...look }}>
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
      primary('Move To Decision', () => move('decision'), <ChevronRight size={14} />)],
    decision: [reject,
      secondary('Another Round', () => onSchedule(c), <CalendarDays size={13} />),
      roomAllowed && secondary('Interview Room', () => onOpenRoom(c), <ClipboardList size={13} />),
      primary('Make Offer', toOffer, <FileSignature size={14} />, false, goGreen)],
    offer: [reject,
      secondary('Another Interview', () => onSchedule(c), <Undo2 size={13} />),
      secondary('Mark Hired By Hand', markHiredByHand, null),
      awaitingMe && onSignPacket && primary('Sign & Offer', () => onSignPacket(awaitingMe.senderPartyId), <FileSignature size={14} />),
      noOfferLetter && secondary('Set Up Offer Letter', goHiringSettings, <Settings size={13} />),
      !packetOut && offers && !offerSigned && primary('Make Offer', () => onMakeOffer(c), <FileSignature size={14} />, packetEvents === null, goGreen),
      // The hiring packet follows a signed offer (Pranshu, Oct 15): shown, but
      // not clickable, until the candidate and HR have both signed - it then
      // goes out by itself; Send is only for when that could not happen.
      onMakeOffer && !offerSigned && !(packetEvents || []).some(e => e.kind === 'hire' && e.status !== 'voided') && (
        <button key="packet-wait" className="secondary-btn" disabled title={`Goes out by itself once ${c.firstName || 'the candidate'} and HR have both signed the offer letter`}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, opacity: 0.55, cursor: 'not-allowed' }}>
          <FileText size={13} /> Send Hiring Packet
        </button>
      ),
      // Screens with no offer flow keep the plain packet send.
      !packetOut && !onMakeOffer && primary(packetPick?.picked?.engine === 'documents' ? 'Start Hiring Packet' : 'Send Hiring Packet',
        () => onSendPacket(c), <FileText size={14} />, packetEvents === null)],
    rejected: [!c.inactive && secondary('Remove From Board', () => removeFromBoard(true), <XCircle size={13} />),
      primary('Reopen', () => move('applied', 'Reopened'), <RotateCcw size={14} />)],
    hired: [c.employeeId && onOpenPerson && primary('Open In People', () => onOpenPerson(c), <ChevronRight size={14} />)],
  }[c.stage] || [];

  const TABS = [
    ['overview', 'Overview & Notes'],
    ...(live.length > 0 || ['interview', 'decision', 'offer'].includes(c.stage) ? [['interviews', `Interviews${live.length ? ` (${live.length})` : ''}`]] : []),
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
  const overview = (<>
    {(c.stage === 'decision' || c.decision) && <DecisionPanel candidateId={c.id} refreshKey={`${refreshKey}-${c.stage}-${decisionKey}`} onReload={() => setDecisionKey(k => k + 1)} />}
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
  </>);

  const interviews = (
    <div>
      {rounds === null ? <Spinner size={16} /> : live.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No interview scheduled.</div>
      ) : live.map((r, i) => {
        const [label, tone] = ROUND_STATUS[r.status] || [r.status, 'gray'];
        return (
          <div key={r.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13.5 }}>Interview {i + 1}</b>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>{formatDateTime(r.at)}</span>
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
      <OfferProgress events={packetEvents} firstName={c.firstName} />
      <HiringPacketStatus candidateId={c.id} refreshKey={refreshKey} onEvents={setPacketEvents} hideSign
        onSignNow={onSignPacket} onChanged={() => onUpdated?.(null)} toastOk={toastOk} toastErr={toastErr} />
      {c.stage === 'offer' && !packetOut && packetEvents !== null && !(packetEvents || []).length && (
        <div style={{ fontSize: 13, color: 'var(--muted)', padding: '14px 0' }}>
          {noOfferLetter ? (
            <span style={{ color: 'hsl(var(--color-orange))' }}>
              No offer letter is set up for {companyName || 'this company'} yet. The offer letter comes first - add one under
              Settings &gt; Hiring &gt; Hiring Documents &gt; Offer Letter (Set Up Offer Letter below), then Make Offer.
            </span>
          ) : offerErr ? (
            <span style={{ color: 'hsl(var(--color-red))' }}>Could not check the offer letters for this company - close and reopen the card to try again.</span>
          ) : onMakeOffer ? 'No offer made yet - click Make Offer below. The hiring packet goes out by itself once they and HR have signed it.'
            : packetPick?.picked
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
