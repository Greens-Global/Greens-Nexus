// The candidate card in Hiring (Neil, Oct 8 call). Each stage has ONE obvious
// next step and nothing that belongs to a later stage:
//
//   Applied    - the resume came in: Move To Screening, or Reject
//   Screening  - screening notes, then Schedule Interview, or Reject
//                ("the action should not be moved to interview. It should be
//                schedule an interview")
//   Interview  - the rounds with date, time and who it is with; Open the
//                Interview Room when they come in; Move To Offer, or Reject
//   Offer      - Send Hiring Packet; another round still possible (moves them
//                back to Interview); Mark Hired By Hand for a paper offer
//   Rejected   - Reopen
//
// The Interview Room only exists once screening is done. Scheduling is one
// path (HiringSchedule.jsx) - it sends the Teams invite and moves the stage.
import { useEffect, useRef, useState } from 'react';
import { X, Mail, Phone, CalendarDays, FileText, FileSignature, History, XCircle, ChevronRight, Video, Users, ClipboardList,
         RotateCcw, Trophy, Undo2 } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDate, formatDateTime } from '../lib/datetime';
import { Spinner } from './AsyncState';
import { HiringPacketStatus, packetIsActive, usDay } from './HiringPacket';
import { useEntities } from '../lib/queries';
import { RecordingLine } from './Interviews';

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
  applied: 'Look at the resume, then move them to Screening - or reject.',
  screening: 'Write your screening notes, then schedule the interview - or reject.',
  interview: 'Open the Interview Room when they come in. After the interview, move them to Offer - or reject.',
  offer: 'Send the hiring packet. When they sign it, they are hired automatically.',
  rejected: 'Closed. Reopen to put them back in the pipeline.',
  hired: 'Hired - their record is in People.',
};
const ROUND_STATUS = {
  scheduled: ['Scheduled', 'blue'], live: ['In Progress', 'orange'], completed: ['Completed', 'gray'],
  scored: ['Scored', 'green'], canceled: ['Canceled', 'gray'],
};
const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em', textTransform: 'uppercase' };
const section = { marginTop: 16 };
const sectionHead = { fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 };
const chip = (tone) => ({ padding: '2px 9px', borderRadius: 12, fontSize: 11, fontWeight: 700,
  background: tone === 'gray' ? 'var(--mist)' : `hsla(var(--color-${tone}),0.12)`, color: tone === 'gray' ? 'var(--muted)' : `hsl(var(--color-${tone}))` });
const rejectBtn = { background: 'none', border: '1px solid hsla(var(--color-red),0.4)', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, cursor: 'pointer', color: 'hsl(var(--color-red))', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'Inter,sans-serif' };

export default function CandidateDetailModal({
  candidate: c, onClose, onStage, onUpdated, busy, refreshKey,
  onEdit, onSchedule, onOpenRoom, onSendPacket, onSignPacket, onSendForSignature, onOpenPerson, toastOk, toastErr,
}) {
  const [history, setHistory] = useState(null);
  const [rounds, setRounds] = useState(null);
  const [packetEvents, setPacketEvents] = useState(null);
  const [note, setNote] = useState('');
  const [notes, setNotes] = useState(c.notes || '');
  const [notesBusy, setNotesBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const resumeRef = useRef(null);

  useEffect(() => { api.getCandidateHistory(c.id).then(setHistory).catch(() => setHistory([])); }, [c.id, c.stage, refreshKey]);
  useEffect(() => { api.ivList(c.id).then(setRounds).catch(() => setRounds([])); }, [c.id, c.stage, refreshKey]);

  const sm = STAGE_META[c.stage] || STAGE_META.applied;
  const closed = c.stage === 'hired' || c.stage === 'rejected';
  const live = (rounds || []).filter(r => r.status !== 'canceled');
  const upcoming = live.filter(r => ['scheduled', 'live'].includes(r.status));
  const hadInterview = live.some(r => ['completed', 'scored'].includes(r.status));
  const roomAllowed = ['interview', 'offer'].includes(c.stage) && live.length > 0;
  const packetOut = packetIsActive(packetEvents);
  // HR's own turn on the hiring packet: the footer's Sign & Offer (Pranshu, Oct 8).
  const awaitingMe = (packetEvents || []).find(e => e.kind === 'hire' && e.status === 'awaiting_sender' && e.senderPartyId) || null;
  // Once an interview is on the books the record is settled - no more editing
  // of who they are or which company; the email goes with the packet.
  const canEdit = ['applied', 'screening'].includes(c.stage);
  const { data: entities } = useEntities();
  const companyName = (entities || []).find(e => e.id === c.company)?.name || '';
  const notesDirty = (notes || '') !== (c.notes || '');

  async function saveNotes() {
    setNotesBusy(true);
    try { onUpdated?.(await api.updateCandidate(c.id, { notes })); toastOk?.('Notes saved.'); }
    catch (e) { toastErr?.(e?.message || 'Could not save the notes.'); }
    setNotesBusy(false);
  }
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
    if (!hadInterview && !await dialog.confirm('No interview has been completed yet. Move them to Offer anyway?', { title: 'Move To Offer', confirmText: 'Move To Offer' })) return;
    onStage(c, 'offer', note);
  }
  async function markHiredByHand() {
    if (!await dialog.confirm(`Mark ${candName(c)} hired without the hiring packet? Use this only when they signed on paper - nothing is sent or filed.`,
      { title: 'Mark Hired', confirmText: 'Mark Hired' })) return;
    onStage(c, 'hired', note || 'Marked hired by hand (no hiring packet)');
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
  const reject = <button onClick={() => onStage(c, 'rejected', note)} disabled={busy} style={rejectBtn}><XCircle size={13} /> Reject</button>;

  const footer = {
    applied: [reject, primary('Move To Screening', () => onStage(c, 'screening', note), <ChevronRight size={14} />)],
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
      !packetOut && primary('Send Hiring Packet', () => onSendPacket(c), <FileText size={14} />, packetEvents === null)],
    rejected: [primary('Reopen', () => onStage(c, 'applied', note || 'Reopened'), <RotateCcw size={14} />)],
    hired: [c.employeeId && onOpenPerson && primary('Open In People', () => onOpenPerson(c), <ChevronRight size={14} />)],
  }[c.stage] || [];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 60vw, 1100px)', maxHeight: 'min(92dvh, 820px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{candName(c)}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 1 }}>
              {companyName && <b style={{ color: 'var(--ink)' }}>{companyName}</b>}{companyName && (c.roleTitle || c.department || c.source) ? ' · ' : ''}{[c.roleTitle, c.department, c.source].filter(Boolean).join(' · ')}
            </div>
          </div>
          <span style={{ padding: '3px 11px', borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: `hsla(${sm.hue},0.12)`, color: `hsl(${sm.hue})`, flexShrink: 0 }}>{sm.label}</span>
          {onEdit && canEdit && <button className="secondary-btn" onClick={() => onEdit(c)} style={{ fontSize: 12, padding: '4px 11px', flexShrink: 0 }}>Edit</button>}
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '14px 24px 18px' }}>
          <div style={{ background: `hsla(${sm.hue},0.08)`, borderRadius: 10, padding: '9px 12px', fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <ChevronRight size={14} style={{ color: `hsl(${sm.hue})`, flexShrink: 0, marginTop: 1 }} />
            <span><b>Next:</b> {NEXT_STEP[c.stage]}</span>
          </div>

          <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 5, marginTop: 12 }}>
            {c.email ? <span><Mail size={12} style={{ verticalAlign: 'middle', marginRight: 6 }} />{c.email}</span>
              : <span style={{ color: 'hsl(var(--color-orange))' }}><Mail size={12} style={{ verticalAlign: 'middle', marginRight: 6 }} />No email yet{canEdit ? ' - add it with Edit (invites and the hiring packet go there)' : ''}</span>}
            {c.phone && <span><Phone size={12} style={{ verticalAlign: 'middle', marginRight: 6 }} />{c.phone}</span>}
            {c.expectedStart && <span><CalendarDays size={12} style={{ verticalAlign: 'middle', marginRight: 6 }} />Expected start {usDay(c.expectedStart)}</span>}
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <FileText size={12} />
              {c.resumeUrl ? <button onClick={viewResume} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'hsl(var(--color-blue))', fontFamily: 'Inter,sans-serif', padding: 0 }}>View Resume</button>
                : <span>No resume on file</span>}
              <input ref={resumeRef} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} onChange={e => uploadResume(e.target.files?.[0])} />
              {!closed && <button className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} disabled={resumeBusy} onClick={() => resumeRef.current?.click()}>
                {resumeBusy ? 'Uploading...' : c.resumeUrl ? 'Replace' : 'Upload Resume'}</button>}
            </span>
          </div>

          <div style={section}>
            <label style={FL}>{['applied', 'screening'].includes(c.stage) ? 'Screening Notes' : 'Notes'}</label>
            <textarea className="form-input" rows={3} value={notes} onChange={e => setNotes(e.target.value)} disabled={c.stage === 'hired'}
              placeholder="What stood out in the resume or the screening call"
              style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
            {notesDirty && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <button className="secondary-btn" style={{ fontSize: 12 }} onClick={() => setNotes(c.notes || '')}>Discard</button>
              <button className="primary-btn" style={{ fontSize: 12 }} onClick={saveNotes} disabled={notesBusy}>{notesBusy ? 'Saving...' : 'Save Notes'}</button>
            </div>}
          </div>

          {(live.length > 0 || ['interview', 'offer'].includes(c.stage)) && (
            <div style={section}>
              <div style={sectionHead}><Users size={11} /> Interviews</div>
              {rounds === null ? <Spinner size={16} /> : live.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No interview scheduled.</div>
              ) : live.map(r => {
                const [label, tone] = ROUND_STATUS[r.status] || [r.status, 'gray'];
                return (
                  <div key={r.id} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '9px 12px', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <b style={{ fontSize: 13 }}>{formatDateTime(r.at)}</b>
                      <span style={chip(tone)}>{label}</span>
                      {r.status === 'scored' && <span style={{ fontSize: 12, fontWeight: 800, color: 'hsl(var(--color-green))' }}><Trophy size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />{Math.round(r.totalScore)}/100</span>}
                      <span style={{ flex: 1 }} />
                      {r.status === 'scheduled' && !closed && <>
                        <button className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={() => onSchedule(c, r)}>Reschedule</button>
                        <button className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={() => cancelRound(r)}>Cancel</button>
                      </>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                      With {(r.interviewerNames || r.interviewerEmails || []).join(', ') || 'no one set'} · {r.durationMin} minutes
                      {r.templateName ? ` · Questionnaire: ${r.templateName}` : ' · No questionnaire'}
                    </div>
                    <div style={{ marginTop: 6 }}><RecordingLine iv={r} toastErr={toastErr} compact /></div>
                  </div>
                );
              })}
              {upcoming.length === 0 && c.stage === 'interview' && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Nothing coming up - schedule another round, or move them on.</div>}
            </div>
          )}

          {['offer', 'hired'].includes(c.stage) && (
            <HiringPacketStatus candidateId={c.id} refreshKey={refreshKey} onEvents={setPacketEvents} hideSign
              onSignNow={onSignPacket} onChanged={() => onUpdated?.(null)} toastOk={toastOk} toastErr={toastErr} />
          )}
          {c.stage === 'offer' && c.email && onSendForSignature && (
            <div style={{ marginTop: 8 }}>
              <button onClick={() => { onSendForSignature(c); onClose(); }}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, color: 'var(--muted)', textDecoration: 'underline', fontFamily: 'Inter,sans-serif' }}>
                Send a different document for signature
              </button>
            </div>
          )}

          <div style={section}>
            <div style={sectionHead}><History size={11} /> Stage History</div>
            {history === null ? <Spinner size={16} /> : history.map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', fontSize: 12.5, borderBottom: '1px solid var(--line)' }}>
                <span style={{ fontWeight: 700, color: `hsl(${(STAGE_META[h.toStage] || STAGE_META.applied).hue})`, flexShrink: 0 }}>
                  {(STAGE_META[h.toStage] || { label: h.toStage }).label}
                </span>
                <span style={{ color: 'var(--muted)', flex: 1 }}>{h.note}</span>
                <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{formatDate(h.createdAt)}</span>
              </div>
            ))}
          </div>
          {!closed && (
            <div style={section}>
              <label style={FL}>Note For This Move (optional)</label>
              <input className="form-input" style={{ width: '100%' }} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Strong resume, references checked" />
            </div>
          )}
        </div>
        {footer.filter(Boolean).length > 0 && (
          <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', flexShrink: 0 }}>
            {footer.filter(Boolean).map((el, i) => <span key={i} style={{ display: 'contents' }}>{el}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}
