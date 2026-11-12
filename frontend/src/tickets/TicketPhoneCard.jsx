// The ticket on a phone (Neil, 11/03/2026: "This mobile version sucks and
// needs to be consolidated. Rethink this entire mobile card"). The same
// TicketDrawer - its permissions, its held edits, its one save - drawn for a
// thumb instead of a desk: TicketDrawer works everything out and hands it
// here; this file only decides where each piece sits. Never on a desktop (the
// desk's sheet and side pane are TicketDrawer's own layout, unchanged) and
// still inside the shared Modal, which is the full-screen sheet on a phone.
//
// Top to bottom:
//   header   Ticket #45 · 3 of 12, Previous / Next, Close (a swipe steps too)
//   title    tap to edit (whoever may edit it)
//   chips    Status · Priority · Type · Next Clock - ONE line, each tap opens a
//            small bottom-sheet picker (the SLA chip a read-out); nothing is
//            shown twice further down
//   people   Requester and Assignee rows, Teams Message / Call on each
//   tabs     Conversation (first) · Details · Files · Activity
//   footer   the reply box pinned above the keyboard (Conversation), then ONE
//            primary action chosen by state and role and a More sheet for the
//            rest - Delete is a hold there, never beside the primary
import { useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, X, ChevronDown, Check, Clock, Pencil, Plus, Send, Camera, Lock, MessageSquare,
  MessageSquareText, MoreHorizontal, CheckCircle2, RotateCcw, ArrowUp, MousePointer2, CircleCheckBig,
} from 'lucide-react';
import { NX, FONT, btn, PRIORITY_META } from '../tasks/theme';
import { Modal, Avatar, UnassignedAvatar, PriorityChip, usePeople } from '../tasks/components';
import { BottomSheet } from '../tasks/MobileTaskBar';
import RichDescription, { isEmptyDoc } from '../tasks/RichDescription';
import { richBodyHtml } from '../tasks/lib';
import PersonActions from '../components/PersonActions';
import { PriorityMark } from '../components/StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { prefersReducedMotion } from '../lib/reducedMotion';
import { formatDateTime } from '../lib/datetime';
import { STOP_VOICE_FIRST } from '../lib/voice';
import {
  TICKET_STATUS_META, TICKET_TYPE_META, CLOSED_STATES, NO_RECORDING_TYPES,
  nextClock, NEXT_CLOCK_META, fmtDueAt, slaState, commentStale, COMMENT_STALE_META, COMMENT_STALE_HOURS,
  ticketNo, fmtDate, resolutionLabel,
} from './ticketMeta';
import { TicketStatusChip, TicketTypeIcon, SlaBadge, FirstResponseIndicator } from './TicketAtoms';
import { TicketAssignSheet } from './TicketAssignSheet';
import { ApprovalChip } from './TicketApproval';
import { useReplyAttach } from './TicketConversation';
import { RecordUploadButtons } from './TicketEvidence';
import SavedReplyPicker from './SavedReplyPicker';
import TicketJobAction, { useTicketJobState, jobActionShown } from './TicketJobAction';
import { returnToTicketAfterRecording } from './ticketViewShared';

const TABS = [['conversation', 'Conversation'], ['overview', 'Details'], ['attachments', 'Files'], ['activity', 'Activity']];
const SWIPE_PX = 72;         // a horizontal drag this long steps to the next / previous ticket
// A drag that starts on any of these is theirs (selecting text, scrolling a
// wide table, a picker), never a step.
const NO_SWIPE = 'input, textarea, select, [contenteditable="true"], .nx-rich, .nx-rich-body, table, pre, .scroll-tabs, [data-no-swipe]';
// Text being selected (a long-press drag) is never a step either.
const selecting = () => { try { const sel = window.getSelection?.(); return !!sel && !sel.isCollapsed; } catch { return false; } };

// One row of a picker sheet: 48px tall, the mark of the current value on the right.
const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 48, padding: '8px 10px',
  border: 'none', borderRadius: 10, background: 'transparent', cursor: 'pointer', fontFamily: FONT,
  fontSize: 15, color: NX.ink, textAlign: 'left',
};

function PickSheet({ title, options, value, onPick, onClose }) {
  return (
    <BottomSheet title={title} onClose={onClose}>
      <div role="group" aria-label={title}>
        {options.map((o) => (
          <button key={o.id} type="button" aria-pressed={o.id === value} className="nx-menu-row"
            style={{ ...rowStyle, background: o.id === value ? NX.hover : 'transparent' }}
            onClick={() => { onClose(); if (o.id !== value) onPick(o.id); }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{o.render || o.label}</span>
              {o.desc && <span style={{ display: 'block', fontSize: 13, color: NX.faint, marginTop: 2, lineHeight: 1.35 }}>{o.desc}</span>}
            </span>
            {o.id === value && <Check size={17} style={{ color: NX.blue, flexShrink: 0 }} />}
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}

// A chip on the meta line: a button (36px tall, a press that gives) only for
// someone who may change it, otherwise just the label. No chevrons - four of
// them would not leave the line room for its four chips on a 390px phone.
function MetaChip({ label, onTap, children, testId }) {
  if (!onTap) return <span data-testid={testId} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 36 }}>{children}</span>;
  return (
    <button type="button" data-testid={testId} aria-label={label} onClick={onTap} aria-haspopup="dialog" className="nx-press"
      style={{ display: 'inline-flex', alignItems: 'center', minHeight: 36, padding: 0, margin: 0,
        border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT, borderRadius: 999 }}>
      {children}
    </button>
  );
}

// The SLA chip's read-out: which clock bites next, the due moment, and the
// separate "Needs a Comment" signal. Nothing here is editable - the SLA
// follows Priority (ticket_sla.recompute).
function SlaSheet({ t, onClose }) {
  const clock = nextClock(t);
  const overdue = clock.state === 'overdue';
  const line = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '10px 2px', borderBottom: `1px solid ${NX.border2}`, fontSize: 14 };
  return (
    <BottomSheet title="SLA" onClose={onClose}>
      {clock.kind !== 'none' && (
        <div style={line}>
          <span style={{ color: NX.dim }}>Next Clock</span>
          <span style={{ textAlign: 'right', color: overdue ? NX.red : NX.ink, fontWeight: overdue ? 700 : 600 }}>
            {clock.label}<span style={{ display: 'block', fontSize: 13, fontWeight: 400, color: NX.faint }}>{clock.title}</span>
          </span>
        </div>
      )}
      <div style={line}>
        <span style={{ color: NX.dim }}>SLA Due Date</span>
        <span data-testid="ticket-sla-due" style={{ textAlign: 'right', color: NX.ink, display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {fmtDueAt(t)}{slaState(t) === 'paused' && <SlaBadge t={t} />}
        </span>
      </div>
      <div style={{ padding: '10px 2px 2px' }}><FirstResponseIndicator t={t} /></div>
      {commentStale(t) && (
        <div style={{ padding: '6px 2px 0', fontSize: 13, color: NX.dim, display: 'flex', alignItems: 'center', gap: 6 }}>
          <COMMENT_STALE_META.Icon size={14} />{COMMENT_STALE_META.label} - no comment in over {COMMENT_STALE_HOURS[t.priority] ?? 24}h.
        </div>
      )}
    </BottomSheet>
  );
}

// One person on the card: the role on the left, the name, Teams on the right.
// `onPick` makes the name a button (Assignee, for whoever may reassign).
function PersonRow({ role, email, name, placeholder, onPick, actions, extra }) {
  const body = (
    <>
      {email ? <Avatar email={email} name={name} size={26} card={false} /> : <UnassignedAvatar size={26} />}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 15, color: email ? NX.ink : NX.faint, fontWeight: email ? 600 : 500 }}>
        {email ? name : placeholder}
      </span>
      {onPick && <ChevronDown size={15} aria-hidden="true" style={{ color: NX.faint, flexShrink: 0 }} />}
    </>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 48 }}>
      <span style={{ width: 74, flexShrink: 0, fontSize: 13, color: NX.dim }}>{role}</span>
      {onPick ? (
        <button type="button" onClick={onPick} aria-label={email ? `${role}: ${name} - change` : `${role}: ${placeholder} - choose`}
          style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 6px', margin: '0 -6px',
            border: 'none', borderRadius: 10, background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left' }}>
          {body}
        </button>
      ) : (
        <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>{body}</span>
      )}
      {extra}
      {actions}
    </div>
  );
}

// The reply box pinned to the foot of the card. The reply is still the
// drawer's held reply (one save with every other change); Send is that save,
// without closing the ticket, so the reply shows up in the thread.
function PhoneComposer({ ticket, reply, onReplyChange, onSend, sending, canInternal, savedReplies, myEmail, nameOf,
  voiceRec, onVoiceRecordingChange, onFocusChange }) {
  const people = usePeople();
  const { attaching, attach } = useReplyAttach(ticket.id, onReplyChange);
  const [tray, setTray] = useState(false);
  const [pickingReply, setPickingReply] = useState(false);
  const photoRef = useRef(null);
  const { body, internal } = reply;
  const empty = isEmptyDoc(body);
  const setInternal = (i) => onReplyChange((r) => ({ ...r, internal: i }));
  const insertSaved = (html) => onReplyChange((r) => ({ ...r, body: isEmptyDoc(r.body) ? html : `${r.body || ''}${html}` }));
  const canSend = !empty && !sending && !voiceRec;
  const pill = (on, isInt) => ({
    ...btn('ghost'), padding: '0 10px', height: 30, fontSize: 13, borderRadius: 999, gap: 5,
    background: on ? (isInt ? 'rgba(245,158,11,0.16)' : 'rgba(37,99,235,0.12)') : 'transparent',
    color: on ? (isInt ? NX.amber : NX.blue) : NX.dim, fontWeight: on ? 700 : 600,
  });
  return (
    // "Composing" = the text box has the keyboard. Only the box counts: a
    // tap on + or a mode pill must not hide the action bar mid-tap (the
    // footer would shift under the finger and the tap would land elsewhere).
    <div data-testid="ticket-phone-composer" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
      onFocus={(e) => { if (e.target.isContentEditable) onFocusChange(true); }}
      onBlur={(e) => { if (e.target.isContentEditable && !e.currentTarget.contains(e.relatedTarget)) onFocusChange(false); }}>
      {(canInternal || savedReplies) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {canInternal && [['Reply', false], ['Internal Note', true]].map(([lab, isInt]) => (
            <button key={lab} type="button" aria-pressed={internal === isInt} onPointerDown={(e) => e.preventDefault()} onClick={() => setInternal(isInt)} style={pill(internal === isInt, isInt)}>
              {isInt ? <Lock size={12} /> : <MessageSquare size={12} />}{lab}
            </button>
          ))}
          {savedReplies && (
            <button type="button" onClick={() => setPickingReply(true)} style={{ ...btn('ghost'), marginLeft: 'auto', padding: '0 8px', height: 30, fontSize: 13, gap: 5 }}>
              <MessageSquareText size={13} /> Saved Replies
            </button>
          )}
        </div>
      )}
      {tray && (
        <div data-testid="ticket-phone-tray" style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', padding: '2px 0' }}>
          <button type="button" onClick={() => photoRef.current?.click()} disabled={attaching}
            style={{ ...btn('ghost'), fontSize: 13, fontWeight: 600, color: NX.ink, padding: '5px 8px', gap: 6 }}>
            <Camera size={14} /> Take Photo
          </button>
          <input ref={photoRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
            onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; fs.forEach(attach); }} />
          <RecordUploadButtons quiet disabled={attaching} showRecord={!NO_RECORDING_TYPES.includes(ticket.type)}
            onFile={attach} onRecordingChange={returnToTicketAfterRecording(ticket.id)} onVoiceRecordingChange={onVoiceRecordingChange} />
          <span style={{ flexBasis: '100%', fontSize: 12, color: NX.faint, padding: '0 8px' }}>
            {attaching ? 'Adding it to Attachments…' : 'Saved to Attachments and linked in your reply - or press Ctrl+V to paste a screenshot into the reply.'}
          </span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
        <button type="button" aria-label={tray ? 'Hide Attach Options' : 'Attach a Photo or File'} aria-expanded={tray}
          disabled={tray && voiceRec} onPointerDown={(e) => e.preventDefault()} onClick={() => setTray((o) => !o)}
          style={{ ...btn('ghost'), width: 40, height: 40, padding: 0, justifyContent: 'center', borderRadius: 20, color: NX.dim, flexShrink: 0,
            background: tray ? NX.hover : 'transparent', transform: tray ? 'rotate(45deg)' : 'none', transition: 'transform .18s ease-out, background .13s' }}>
          <Plus size={20} />
        </button>
        <div style={{ flex: 1, minWidth: 0, ...(internal ? { borderRadius: 12, padding: 2, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)' } : null) }}>
          <RichDescription value={body} onChange={(b) => onReplyChange((r) => ({ ...r, body: b }))} onSubmit={onSend}
            mentionPeople={people} minHeight={40} compact={132}
            placeholder={internal ? 'Internal note - agents only…' : canInternal ? 'Reply to the requester…' : 'Write a reply…'} />
        </div>
        {/* pointerdown keeps the box focused, so tapping Send does not drop
            the keyboard (and the action bar) before the reply goes. */}
        <button type="button" aria-label={internal ? 'Add Note' : 'Send Reply'} disabled={!canSend}
          onPointerDown={(e) => e.preventDefault()} onClick={onSend}
          style={{ ...btn('primary'), width: 40, height: 40, padding: 0, justifyContent: 'center', borderRadius: 20, flexShrink: 0,
            opacity: canSend ? 1 : 0.4, cursor: canSend ? 'pointer' : 'default' }}>
          <Send size={17} />
        </button>
      </div>
      {voiceRec && <span role="status" style={{ fontSize: 12, color: NX.red, padding: '0 4px' }}>{STOP_VOICE_FIRST}</span>}
      {pickingReply && (
        <SavedReplyPicker ticket={ticket} agentEmail={myEmail} nameOf={nameOf}
          onInsert={insertSaved} onClose={() => setPickingReply(false)} />
      )}
    </div>
  );
}

// The description, as the first message of the thread - what was asked comes
// before the answers.
function DescriptionMessage({ t, v, nameOf, canEditText, onEdit }) {
  const who = t.requesterId ? (nameOf(t.requesterId) || t.requesterId) : 'Requester';
  const has = !isEmptyDoc(v.description);
  return (
    <div data-testid="ticket-phone-description" style={{ display: 'flex', gap: 8 }}>
      <Avatar email={t.requesterId} name={who} size={26} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{who}</span>
          {t.createdAt && <span style={{ fontSize: 11, color: NX.faint }}>Opened {formatDateTime(t.createdAt)}</span>}
        </div>
        {has ? (
          <div className="nx-rich-body" style={{ fontSize: 14, color: NX.dim, marginTop: 2 }}
            dangerouslySetInnerHTML={{ __html: richBodyHtml(v.description, nameOf) }} />
        ) : canEditText ? (
          <button type="button" onClick={onEdit} style={{ ...btn('ghost'), padding: '6px 0', marginTop: 2, fontSize: 13, color: NX.blue, fontWeight: 600 }}>
            <Plus size={13} /> Add a Description
          </button>
        ) : (
          <div style={{ fontSize: 13, color: NX.faint, marginTop: 2 }}>No description.</div>
        )}
        {(t.images || []).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {t.images.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noreferrer" title="Open full size" style={{ display: 'block', width: 72, height: 72, borderRadius: 8, overflow: 'hidden', border: `1px solid ${NX.border}` }}>
                <img src={url} alt={`Screenshot ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Which ONE action leads the footer, by the ticket's state and the viewer's
// role. Everything else the drawer offers goes to More. Exported for tests.
//   held edits            Save Changes (a held reply alone is the reply box's Send)
//   live ticket           Mark Resolved (the desk's resolve, or the requester's own)
//   Resolved, requester   Confirm Resolution (the rating survey, then Closed)
//   Resolved / Closed     Reopen (the desk; the requester while it is Resolved)
//   anything else         Done
export function phonePrimary({ t, v, pendingCount, hasReply, onConversation, canEditStatus, ownRequester }) {
  if (pendingCount > 0 || (hasReply && !onConversation)) return pendingCount > 0 ? 'save' : 'send';
  const closedNow = CLOSED_STATES.includes(t.status);
  if (!closedNow && (canEditStatus || ownRequester) && !CLOSED_STATES.includes(v.status)) return 'resolve';
  if (t.status === 'resolved' && ownRequester) return 'confirm';
  if (closedNow && (t.status === 'resolved' || canEditStatus)) return 'reopen';
  return 'done';
}

export default function TicketPhoneCard(p) {
  const {
    t, v, nameOf, myEmail, personById, people, hasNav, onPrev, onNext, navPosition, onRequestClose,
    titleBlock, editing, canEditText, startEdit, confidential, overviewBody, conversationProps, attachmentsBody, activityBody,
    approvalPanel, aiSummary, tab, setTab, newReplies, clearNewReplies,
    canWorking, canEditStatus, canSeeAssignSla, ownRequester, canEscalate, canDelete, canRequestControl,
    stage, setStatus, statusOpts, priorityOpts, typeOpts,
    pending, reply, setReply, hasReply, saving, voiceRec, setVoiceRec, send, done,
    openResolve, openConfirm, reopen, escalate, requestControl, removeTicket,
  } = p;
  const [picker, setPicker] = useState(null);   // 'status' | 'priority' | 'type' | 'sla' | 'assign' | 'more'
  const [composing, setComposing] = useState(false);
  const jobState = useTicketJobState(confidential ? null : t.id);
  // The swipe: the body follows the finger a little (not under reduced
  // motion), and a long enough sideways drag steps to the next ticket.
  const swipe = useRef(null);
  const [drag, setDrag] = useState(0);
  const reduced = prefersReducedMotion();
  const onTouchStart = (e) => {
    if (!hasNav || e.touches.length !== 1 || e.target.closest?.(NO_SWIPE) || selecting()) { swipe.current = null; return; }
    const { clientX: x, clientY: y } = e.touches[0];
    swipe.current = { x, y, dx: 0, sideways: null };
  };
  const onTouchMove = (e) => {
    const s = swipe.current;
    if (!s) return;
    const dx = e.touches[0].clientX - s.x;
    const dy = e.touches[0].clientY - s.y;
    if (s.sideways === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) s.sideways = Math.abs(dx) > Math.abs(dy) * 1.5;
    if (!s.sideways) return;
    s.dx = dx;
    // Nothing to step to on that side: the drag gives, but only a little.
    const can = dx < 0 ? !!onNext : !!onPrev;
    if (!reduced) setDrag(dx * (can ? 0.35 : 0.12));
  };
  const onTouchEnd = () => {
    const s = swipe.current;
    swipe.current = null;
    setDrag(0);
    if (!s?.sideways || selecting()) return;
    if (s.dx <= -SWIPE_PX && onNext) onNext();
    else if (s.dx >= SWIPE_PX && onPrev) onPrev();
  };

  const clock = nextClock(t);
  const overdue = clock.state === 'overdue';
  const clockM = clock.state === 'paused' ? NEXT_CLOCK_META.paused : null;
  const closedNow = CLOSED_STATES.includes(t.status);
  const pendingCount = Object.keys(pending).length;
  const onConversation = tab === 'conversation';
  const primaryKey = phonePrimary({ t, v, pendingCount, hasReply, onConversation, canEditStatus, ownRequester });
  const canResolve = !closedNow && (canEditStatus || ownRequester) && !CLOSED_STATES.includes(v.status);
  const canReopen = closedNow && (t.status === 'resolved' || canEditStatus);
  const canAssign = canWorking && t.approvalStatus !== 'pending';
  const typeEditable = canWorking && !confidential;
  const showJob = !confidential && jobActionShown(jobState);

  const PRIMARY = {
    save: { label: 'Save Changes', icon: Check, run: send, title: 'Save every change and send one update to the requester' },
    send: { label: reply.internal ? 'Add Note' : 'Send Reply', icon: Send, run: send },
    resolve: { label: 'Mark Resolved', icon: CheckCircle2, run: openResolve },
    confirm: { label: 'Confirm Resolution', icon: CircleCheckBig, run: openConfirm },
    reopen: { label: 'Reopen', icon: RotateCcw, run: reopen },
    done: { label: 'Done', icon: null, run: done },
  };
  const primary = PRIMARY[primaryKey];

  // More: everything the footer used to carry, less the primary.
  const closeSheet = () => setPicker(null);
  const moreRows = [];
  if (canResolve && primaryKey !== 'resolve') moreRows.push({ key: 'resolve', label: 'Mark Resolved', icon: CheckCircle2, run: openResolve });
  if (t.status === 'resolved' && primaryKey !== 'confirm') {
    // The desk closes it out (held for Save); the requester rates it.
    const staged = v.status === 'closed';
    moreRows.push(ownRequester
      ? { key: 'confirm', label: 'Confirm Resolution', icon: CircleCheckBig, run: openConfirm }
      : { key: 'confirm', label: staged ? 'Undo Confirm Resolution' : 'Confirm Resolution', icon: CircleCheckBig,
        run: () => stage({ status: staged ? t.status : 'closed' }) });
  }
  if (canReopen && primaryKey !== 'reopen') moreRows.push({ key: 'reopen', label: 'Reopen', icon: RotateCcw, run: reopen });
  if (canEscalate) moreRows.push({ key: 'escalate', label: 'Escalate', icon: ArrowUp, run: escalate, hint: 'Email the department head that it needs urgent care' });
  if (canRequestControl) moreRows.push({ key: 'control', label: 'Request Control', icon: MousePointer2, run: requestControl, hint: `Ask ${nameOf(t.requesterId) || 'them'} to share their screen - nothing shows until they accept` });
  if (canEditText && !editing) moreRows.push({ key: 'edit', label: 'Edit Title and Description', icon: Pencil, run: startEdit });
  const hasMore = moreRows.length > 0 || showJob || canDelete;

  const sheetRow = { ...rowStyle, fontWeight: 600 };
  const assigneeName = v.assigneeId ? (nameOf(v.assigneeId) || v.assigneeId) : '';
  const personActions = (email) => email && (
    <PersonActions email={email} name={nameOf(email)} known={personById.has((email || '').toLowerCase())}
      external={!!personById.get((email || '').toLowerCase())?.external} myEmail={myEmail} size="md" />
  );

  const header = (titleId, requestClose) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 4px 4px 16px', minHeight: 52, borderBottom: `1px solid ${NX.border2}`, flexShrink: 0 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <span id={titleId} style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>{ticketNo(t.code) || 'Ticket'}</span>
        {hasNav && navPosition && navPosition.total > 1 && (
          <span data-testid="ticket-phone-position" style={{ fontSize: 13, color: NX.faint, fontVariantNumeric: 'tabular-nums' }}>
            {navPosition.index} of {navPosition.total}
          </span>
        )}
      </div>
      {hasNav && (onPrev || onNext) && (<>
        <button type="button" aria-label="Previous Ticket" disabled={!onPrev} onClick={() => onPrev?.()}
          style={{ ...btn('ghost'), width: 44, height: 44, padding: 0, justifyContent: 'center', borderRadius: 22, color: NX.ink, opacity: onPrev ? 1 : 0.3 }}>
          <ChevronLeft size={22} />
        </button>
        <button type="button" aria-label="Next Ticket" disabled={!onNext} onClick={() => onNext?.()}
          style={{ ...btn('ghost'), width: 44, height: 44, padding: 0, justifyContent: 'center', borderRadius: 22, color: NX.ink, opacity: onNext ? 1 : 0.3 }}>
          <ChevronRight size={22} />
        </button>
        <span aria-hidden="true" style={{ width: 1, height: 22, background: NX.border, margin: '0 2px' }} />
      </>)}
      <button type="button" aria-label="Close" onClick={requestClose}
        style={{ ...btn('ghost'), width: 44, height: 44, padding: 0, justifyContent: 'center', borderRadius: 22, color: NX.ink }}>
        <X size={21} />
      </button>
    </div>
  );

  const footer = (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {onConversation && (
        <PhoneComposer ticket={t} reply={reply} onReplyChange={setReply} onSend={send} sending={saving}
          canInternal={conversationProps.canInternal} savedReplies={conversationProps.savedReplies} myEmail={myEmail} nameOf={nameOf}
          voiceRec={voiceRec} onVoiceRecordingChange={setVoiceRec} onFocusChange={setComposing} />
      )}
      {/* While the reply box has the keyboard the action bar steps aside -
          the reply's own Send is the action then. */}
      {!(onConversation && composing) && (
        <div data-testid="ticket-phone-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {closedNow && !canReopen && (
            <span style={{ flex: 1, fontSize: 13, color: NX.faint, lineHeight: 1.35 }}>Closed - if the problem is back, submit a new ticket.</span>
          )}
          {hasMore && (
            <button type="button" onClick={() => setPicker('more')} aria-haspopup="dialog" className="nx-press"
              style={{ ...btn('outline'), height: 44, padding: '0 14px', borderRadius: 12, fontSize: 14, gap: 6, flexShrink: 0 }}>
              <MoreHorizontal size={18} /> More
            </button>
          )}
          <button type="button" onClick={primary.run} disabled={saving || (voiceRec && (primaryKey === 'save' || primaryKey === 'send'))}
            data-primary={primaryKey} title={primary.title} className="nx-press"
            style={{ ...btn('primary'), height: 44, borderRadius: 12, fontSize: 15, justifyContent: 'center', gap: 7,
              flex: closedNow && !canReopen ? '0 0 auto' : 1, opacity: saving ? 0.6 : 1 }}>
            {primary.icon && <primary.icon size={17} />}
            {saving && (primaryKey === 'save' || primaryKey === 'send') ? 'Saving…' : primary.label}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <Modal title={ticketNo(t.code) || 'Ticket'} onClose={onRequestClose} header={header} footer={footer}
        bodyStyle={{ padding: '12px 16px 16px' }}
        footerStyle={{ padding: composing ? '8px 12px' : '8px 12px calc(8px + env(safe-area-inset-bottom))', display: 'block' }}>
        <div data-testid="ticket-drawer" data-layout="phone" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}
          style={{ display: 'flex', flexDirection: 'column', flex: '1 0 auto',
            transform: drag ? `translateX(${drag}px)` : undefined, transition: drag ? 'none' : (reduced ? undefined : 'transform .2s ease-out') }}>
          {/* Title: tap to edit for whoever may. */}
          {editing ? titleBlock : (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              {canEditText ? (
                <button type="button" onClick={startEdit} aria-label="Edit title and description"
                  style={{ flex: 1, minWidth: 0, display: 'block', padding: '2px 0', margin: 0, border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', fontFamily: FONT }}>
                  <span style={{ fontSize: 18, fontWeight: 700, color: NX.ink, lineHeight: 1.3, letterSpacing: '-0.01em' }}>{v.subject}</span>
                  <Pencil size={13} aria-hidden="true" style={{ color: NX.faint, marginLeft: 6, verticalAlign: '-1px' }} />
                </button>
              ) : (
                <div style={{ flex: 1, minWidth: 0, fontSize: 18, fontWeight: 700, color: NX.ink, lineHeight: 1.3, letterSpacing: '-0.01em', padding: '2px 0' }}>{v.subject}</div>
              )}
            </div>
          )}
          {t.source === 'email' && <div style={{ fontSize: 12, color: NX.faint, marginTop: 2 }}>Via Email</div>}

          {/* The one meta line. */}
          <div data-testid="ticket-phone-chips" style={{ display: 'flex', alignItems: 'center', columnGap: 12, rowGap: 0, flexWrap: 'wrap', margin: '8px 0 2px' }}>
            <MetaChip testId="chip-status" label={`Status: ${TICKET_STATUS_META[v.status]?.label || v.status} - change`} onTap={canEditStatus ? () => setPicker('status') : null}>
              <TicketStatusChip status={v.status} />
            </MetaChip>
            <MetaChip testId="chip-priority" label={`Priority: ${PRIORITY_META[v.priority]?.label || v.priority} - change`} onTap={canWorking ? () => setPicker('priority') : null}>
              <PriorityChip priority={v.priority} />
            </MetaChip>
            <MetaChip testId="chip-type" label={`Type: ${TICKET_TYPE_META[v.type]?.label || v.type} - change`} onTap={typeEditable ? () => setPicker('type') : null}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, fontWeight: 600, color: NX.dim }}>
                <TicketTypeIcon type={v.type || 'request'} size={13} />{TICKET_TYPE_META[v.type]?.label || v.type || 'Request'}
              </span>
            </MetaChip>
            {clock.kind !== 'none' && (
              <MetaChip testId="chip-sla" label={`SLA: ${clock.label} - details`} onTap={() => setPicker('sla')}>
                <span title={clock.title} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 13, fontWeight: overdue ? 700 : 600,
                  color: overdue ? NX.red : clockM ? clockM.color : NX.dim }}>
                  <Clock size={12} />{clock.label}
                </span>
              </MetaChip>
            )}
            <ApprovalChip ticket={t} />
            {t.resolvedAt && (
              <span style={{ fontSize: 13, color: NX.dim, display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 36 }}>
                <CheckCircle2 size={13} style={{ color: NX.green }} /> Resolved {fmtDate(t.resolvedAt)}{t.resolution ? ` · ${resolutionLabel(t.resolution)}` : ''}
              </span>
            )}
          </div>

          {confidential && (
            <div role="note" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: NX.ink, background: 'rgba(124,58,237,0.08)',
              border: '1px solid rgba(124,58,237,0.28)', borderRadius: 8, padding: '7px 11px', marginTop: 6 }}>
              <Lock size={14} style={{ color: NX.purple, flexShrink: 0 }} />
              <span><b>Confidential HR Request.</b> Only the person who asked, the people on it and HR can see it.</span>
            </div>
          )}
          {t.resolutionNote && closedNow && (
            <div style={{ fontSize: 13, color: NX.ink, background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.30)', borderRadius: 10, padding: '8px 11px', marginTop: 6, whiteSpace: 'pre-wrap' }}>
              <b>Resolution:</b> {t.resolutionNote}
            </div>
          )}

          {/* People: two rows. */}
          <div data-testid="ticket-phone-people" style={{ marginTop: 6, borderTop: `1px solid ${NX.border2}`, borderBottom: `1px solid ${NX.border2}`, padding: '2px 0' }}>
            <PersonRow role="Requester" email={t.requesterId} name={nameOf(t.requesterId) || t.requesterId} placeholder="-"
              actions={personActions(t.requesterId)} />
            {canSeeAssignSla && (
              <PersonRow role="Assignee" email={v.assigneeId} name={assigneeName}
                placeholder={t.approvalStatus === 'pending' ? 'Awaiting Approval' : 'Unassigned'}
                onPick={canAssign ? () => setPicker('assign') : null} actions={personActions(v.assigneeId)} />
            )}
          </div>

          {approvalPanel}
          {aiSummary}

          {/* Conversation first; the rest one tap away - no strip to scroll. */}
          {/* Sticky, so a long thread can still switch to Details. */}
          <div data-no-swipe="" style={{ position: 'sticky', top: -12, zIndex: 2, background: NX.surface, margin: '6px -16px 6px', padding: '6px 16px' }}>
          <div role="group" aria-label="Ticket Sections"
            style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 11, background: NX.border2 }}>
            {TABS.map(([k, lab]) => (
              <button key={k} type="button" aria-pressed={tab === k}
                onClick={() => { setTab(k); if (k === 'conversation') clearNewReplies(); }}
                style={{ flex: '1 1 auto', minWidth: 0, height: 36, padding: '0 6px', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: FONT,
                  fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                  background: tab === k ? NX.surface : 'transparent', color: tab === k ? NX.ink : NX.dim,
                  boxShadow: tab === k ? '0 1px 2px rgba(0,0,0,0.10)' : 'none' }}>
                {lab}
                {k === 'conversation' && newReplies > 0 && (
                  <span aria-label={`${newReplies} new`} style={{ minWidth: 17, height: 17, padding: '0 5px', borderRadius: 9, background: NX.blue, color: '#fff', fontSize: 11, fontWeight: 700, display: 'inline-grid', placeItems: 'center' }}>{newReplies}</span>
                )}
              </button>
            ))}
          </div>
          </div>

          <div style={{ flex: 1, paddingTop: 4 }}>
            {tab === 'conversation' && conversationProps.render({
              lead: <DescriptionMessage t={t} v={v} nameOf={nameOf} canEditText={canEditText} onEdit={startEdit} />,
            })}
            {tab === 'overview' && overviewBody}
            {tab === 'attachments' && attachmentsBody}
            {tab === 'activity' && activityBody}
          </div>
        </div>
      </Modal>

      {picker === 'status' && (
        <PickSheet title="Status" value={v.status} onClose={closeSheet} onPick={setStatus}
          options={statusOpts.map(([id, label]) => ({ id, label, render: <TicketStatusChip status={id} /> }))} />
      )}
      {picker === 'priority' && (
        <PickSheet title="Priority" value={v.priority} onClose={closeSheet} onPick={(val) => stage({ priority: val })}
          options={priorityOpts.map(([id, label]) => ({ id, label, render: <><PriorityMark priority={id} size={16} />{label}</> }))} />
      )}
      {picker === 'type' && (
        <PickSheet title="Type" value={v.type || 'request'} onClose={closeSheet} onPick={(val) => stage({ type: val })}
          options={typeOpts.map((o) => ({ id: o.id, label: o.label, desc: o.desc, render: <><TicketTypeIcon type={o.id} size={15} />{o.label}</> }))} />
      )}
      {picker === 'sla' && <SlaSheet t={t} onClose={closeSheet} />}
      {picker === 'assign' && (
        <TicketAssignSheet value={v.assigneeId || ''} people={people} onPick={(email) => stage({ assigneeId: email || '' })} onClose={closeSheet} />
      )}
      {picker === 'more' && (
        <BottomSheet title="More Actions" onClose={closeSheet}>
          <div data-testid="ticket-phone-more" style={{ display: 'flex', flexDirection: 'column' }}>
            {moreRows.map((r) => (
              <button key={r.key} type="button" data-more={r.key} className="nx-menu-row" style={sheetRow}
                onClick={() => { closeSheet(); r.run(); }}>
                <r.icon size={18} style={{ color: NX.dim, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {r.label}
                  {r.hint && <span style={{ display: 'block', fontSize: 13, fontWeight: 400, color: NX.faint, marginTop: 1 }}>{r.hint}</span>}
                </span>
              </button>
            ))}
            {showJob && (
              <div data-more="job">
                <TicketJobAction ticketId={t.id} state={jobState} onOpen={() => { closeSheet(); onRequestClose(); }}
                  style={{ ...sheetRow, gap: 12 }} iconSize={18} />
              </div>
            )}
            {canDelete && (
              <div data-more="delete" style={{ display: 'grid', borderTop: `1px solid ${NX.border2}`, marginTop: 8, paddingTop: 14 }}>
                <HoldButton label="Delete Ticket" doneLabel="Deleted" holdMs={HOLD_RECORD_MS} style={{ width: '100%', minHeight: 44, justifyContent: 'center' }}
                  fallbackMessage={`Delete ${ticketNo(t.code) || 'this ticket'}? Its history is kept and a manager can restore it.`}
                  onConfirm={removeTicket} onDone={closeSheet} />
                <div style={{ fontSize: 12, color: NX.faint, textAlign: 'center', marginTop: 8 }}>Its history is kept and a manager can restore it.</div>
              </div>
            )}
          </div>
        </BottomSheet>
      )}
    </>
  );
}
