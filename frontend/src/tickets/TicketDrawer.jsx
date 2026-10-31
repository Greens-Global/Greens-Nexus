// TicketDrawer - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, CheckCircle2, ClipboardList, Paperclip, MessageSquare, History, ArrowUp, MousePointer2, Lock, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { useTasks } from '../tasks/TasksContext';
import { useRole } from '../contexts/RoleContext';
import LiveView from '../components/LiveView';
import { richBodyHtml, externalizeInlineImages } from '../tasks/lib';
import RichDescription, { isEmptyDoc } from '../tasks/RichDescription';
import { setOpenTicketId, clearOpenTicketId } from './recordingDraft';
import { NX, FONT, chip, btn, input as inputStyle } from '../tasks/theme';
import TaskDetailDrawer from '../tasks/TaskDetailDrawer';
import { Avatar, PriorityChip, Modal, PersonSelect, usePeople, useIsMobile } from '../tasks/components';
import { dialog as appDialog } from '../ui/dialog';
import {
  fmtDate, TICKET_TYPE_META, TICKET_TYPE_ORDER, TYPE_FIELDS,
  TICKET_RESOLUTION, TICKET_STATUS_META, CLOSED_STATES,
  slaState, fmtDueAt, isBlankFieldValue,
  commentStale, COMMENT_STALE_META, COMMENT_STALE_HOURS,
  label, field, resolutionLabel,
  ticketNo,
  SERVICE_FIELDS, serviceAreaLabel, withDynamicOptions,
  topicQuestionDefs, allTopicQuestionDefs, labelFromKey,
  helpGroupFor,
} from './ticketMeta';
// The help topic's optional "Which one?" level (Neil, Oct 1 2026).
import { HELP_SUBTOPIC_KEY, helpWithLabel } from './ticketMeta';
import {
  TypeFieldInput, SlaBadge, FirstResponseIndicator, TicketStatusChip, TicketSelect, TicketPeopleMultiSelect,
} from './TicketAtoms';
import TicketOpening, { TicketNotFound } from './TicketOpening';
import { PropertySelect } from './PropertySelect';
import { TicketPropertyDetail } from './TicketPropertyFields';
import { TicketMapSpotCard } from './TicketMapSpot';
import { uploadTicketEvidence } from './evidenceUpload';
import { groupTakesProperty } from './propertyMeta';
import { MobileAssignField } from './TicketAssignSheet';
import { useTicketAccess } from './ticketAccess';
import { TicketEquipment } from './TicketEquipment';
import { TicketAiSummary, DrawerSuggestedTopic } from './TicketAi';
import {
  useTicketSites, offeredAtIntake, withHelpSubtopic, listedTopic,
  statusOptions, priorityOptions, typeIntakeOptions,
  serviceAreaOptions,
  attachFailed, hasRichText, useCollaboratorExtras, collaboratorOptions,
  needsResolution, readOnlyFieldValue,
} from './ticketViewShared';
import { HelpTopicField } from './HelpTopicField';
import { ApprovalChip, ApprovalPanel } from './TicketApproval';
import { TicketActionDialog } from './TicketActionDialog';
import { TicketTasks, TicketLinks, SatisfactionCard, CsatWidget } from './TicketDrawerCards';
import { TicketConversation } from './TicketConversation';
import { STOP_VOICE_FIRST } from '../lib/voice';
import { TicketAttachments } from './TicketAttachments';
import { TicketActivity } from './TicketActivity';

// The drawer's Help With field: a pick saves at once, a typed "Other" answer
// saves when the field loses focus - never one save per keystroke (each save
// is an audit row and a requester notification).
//
// `subValue` / `onCommitSub` (optional): the topic's "Which one?" answer
// (typeFields.svc_helpSubtopic), saved the moment it is picked. A picked
// topic commits as onCommit(name, '') - its old sub-option no longer applies.
function DrawerHelpTopic({ value, deptName, onCommit, subValue = '', onCommitSub = null }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const group = helpGroupFor(deptName);
  return (
    <div onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && v.trim()) onCommit(v.trim()); }}>
      <HelpTopicField deptName={deptName} value={v} subValue={subValue}
        onSubChange={onCommitSub ? (s) => { if (s !== subValue) onCommitSub(s); } : null}
        onChange={(n) => {
          setV(n);
          if (listedTopic(group, n)) onCommit(n, '');
        }} />
    </div>
  );
}

// The drawer's frame (Oct 31 2026). As a popup it is the shared Modal; as a
// pane (`inline`, the desk's side pane) it is the same header / scrolling
// body / footer as a plain column that fills whatever the caller gives it -
// no overlay, no Escape layer of its own (the desk owns Escape there), no
// dialog role. `nav` is the Previous / Next pair: in the pane it sits in the
// header beside Close; in the popup, whose header is the Modal's, it leads
// the body so it is in the same corner of the eye.
function DrawerShell({ inline, title, nav, onClose, footer, children }) {
  if (!inline) {
    return (
      <Modal title={title} onClose={onClose} footer={footer}>
        {nav && <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>{nav}</div>}
        {children}
      </Modal>
    );
  }
  return (
    <div data-testid="ticket-drawer" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, background: NX.surface, fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${NX.border2}`, flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        {nav}
        <button type="button" onClick={onClose} style={{ ...btn('ghost'), padding: 6, borderRadius: 8 }} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="nx-scroll" style={{ padding: 20, overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
      {footer && (
        <div style={{ padding: '12px 20px', borderTop: `1px solid ${NX.border2}`, background: NX.surface2, flexShrink: 0,
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{footer}</div>
      )}
    </div>
  );
}

// Exported so the Support page (requester-facing, no module grant needed -
// see views/Support.jsx) can mount this exact drawer directly, the same way
// it already mounts CreateTicketModal for "Submit a Ticket" - rather than
// routing through the Tickets module's own view, which is grant-gated to
// supervisor+ (App.jsx VIEW_MIN_ROLES) and would 403 a plain employee. The
// drawer's own permission model (isRequester/privileged/etc. below) already
// scopes what a non-desk person can see/do, same as it would inside the
// module for someone without the desk grant.
// `startEditing` opens straight into the title/description editor - the
// Support list's pencil (Neil, Sep 30) lands here.
// `inline` (Oct 31 2026): the desk's side pane - see DrawerShell. `onPrev` /
// `onNext`: when either is given (null = nothing to step to) the header shows
// Previous / Next, and the [ and ] keys step while nobody is typing; the
// caller decides the order (the list's) and asks about unsaved edits first.
export function TicketDrawer({ ticketId, onClose, startEditing = false, initialTab = null, dirtyRef = null,
  inline = false, onPrev = undefined, onNext = undefined }) {
  const { tickets, ticketsLoaded, tasks, projects = [], loading: tasksLoading,
    addTicketLink, removeTicketLink, escalateTicket, createTaskFromTicket, myEmail, nameOf, updateTicket, deleteTicket,
    reloadTickets } = useTasks();
  // An approval decision changes status/resolution server-side, so pull the
  // ticket list rather than patching one field locally - the tickets only,
  // not the whole task workspace.
  const onDecided = () => reloadTickets?.();
  const people = usePeople();
  const collabExtras = useCollaboratorExtras();
  const sites = useTicketSites();
  const isMobile = useIsMobile();
  const { myLevel, canAccessModule } = useRole();
  // The desk role the server gives this person (ticket_roles.py) - internal
  // notes and deleting follow it, not the raw module grants.
  const deskAccess = useTicketAccess();
  // initialTab: the list's Latest Comment cell lands on the Conversation.
  const [tab, setTab] = useState(initialTab || 'overview');
  // In the side pane the drawer stays mounted while the SAME ticket's Latest
  // Comment cell is clicked again: the caller changes initialTab, and that
  // must still land on the Conversation (Neil, Oct 1) without a remount that
  // would throw held edits away. Adjusted during render (React's "storing
  // information from previous renders" pattern), not in an effect.
  const [seenInitialTab, setSeenInitialTab] = useState(initialTab);
  if (initialTab !== seenInitialTab) {
    setSeenInitialTab(initialTab);
    if (initialTab) setTab(initialTab);
  }
  // Up here with the other hooks, and NOT next to canRequestControl where it is
  // used, because `if (!t) return null` sits between the two: a hook after that
  // return runs on some renders and not others, which is the one thing React
  // does not allow. The drawer's first render always takes the early path when
  // it is opened from Support (Support.jsx lazy-mounts its own TasksProvider,
  // so the tickets are still being fetched), and the render after the fetch
  // landed then ran one hook more than the render before it - "Rendered more
  // hooks than during the previous render", caught by ViewErrorBoundary as
  // "This section hit a snag". Inside the Tickets module the store is already
  // warm, `t` exists on the first render, and the fault never shows.
  const [requestingControl, setRequestingControl] = useState(false);
  // A linked task opened in place, over the ticket - so working on it does not
  // mean closing the ticket and hunting for the task in the Task module.
  const [openTaskId, setOpenTaskId] = useState(null);
  // A task opened from this ticket closes back onto the ticket's Overview,
  // where its Tasks list is (Sagar, Oct 14 2026).
  const closeTask = () => { setOpenTaskId(null); setTab('overview'); };
  // Title/description editor, and the resolve/confirm/reopen dialog - up
  // here with the other hooks for the same reason as requestingControl.
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(null);   // { subject, description } while editing
  const [dialog, setDialog] = useState(null); // { mode, targetStatus }
  // What the requester had last seen before THIS open - new replies since
  // then get the dot on the Conversation tab and a "New" tag in the thread
  // (Neil, Sep 30: "there's a comment I've added on conversation, but I'm
  // not able to see that there's a new item").
  // Previous / Next by keyboard: [ and ] while no field has the keys and no
  // overlay (a linked task, the Resolve dialog, LiveView) is open on top.
  // Read through a ref so the one listener never goes stale.
  const hasNav = onPrev !== undefined || onNext !== undefined;
  const navRef = useRef({ onPrev, onNext });
  useEffect(() => { navRef.current = { onPrev, onNext }; });
  const navBlocked = !!openTaskId || !!dialog || requestingControl;
  useEffect(() => {
    if (!hasNav || navBlocked) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      // A desk modal over the pane (Create, Save View, bulk Resolve) keeps
      // its keys: in the pane this drawer is not a dialog, so any dialog the
      // key came from is one on top of it.
      if (inline && e.target?.closest?.('[role="dialog"]')) return;
      if (e.key === ']' && navRef.current.onNext) { e.preventDefault(); navRef.current.onNext(); }
      else if (e.key === '[' && navRef.current.onPrev) { e.preventDefault(); navRef.current.onPrev(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasNav, navBlocked, inline]);
  const [seenBefore, setSeenBefore] = useState(undefined);
  const [newReplies, setNewReplies] = useState(0);
  const [companies, setCompanies] = useState([]);
  const [allDepts, setAllDepts] = useState([]);
  // Nothing here saves on its own. Every field edit, and the reply being
  // written on Conversation, is held until Done - then goes out as ONE save,
  // so the requester gets one email and one Teams message for the whole visit
  // instead of one per field (Pranshu, Oct 1: "till the time I click on Done
  // it should not update the ticket, nor post the mail or message").
  const [pending, setPending] = useState({});
  const [reply, setReply] = useState({ body: '', internal: false });
  const [saving, setSaving] = useState(false);
  // A voice note recording under the reply: Done waits for Stop (the clip
  // would be lost with the drawer).
  const [voiceRec, setVoiceRec] = useState(false);
  useEffect(() => {
    api.getTicketCompanies().then(setCompanies).catch(() => setCompanies([]));
    // Every company's departments, not just the viewer's own: a ticket is
    // filed under the REQUESTER's company, and filtering by the viewer's
    // left the Department field blank for anyone looking at a ticket from
    // another company - "the department didn't get selected" on Neil's
    // walkthrough (Sep 30), though it had saved. Filtered to the ticket's
    // company below.
    api.getTicketDepartments().then(setAllDepts).catch(() => setAllDepts([]));
  }, []);
  // Lets a recording started from this drawer's Attachments tab know, on
  // Stop, whether it should bring the app back here - see setOpenTicketId in
  // recordingDraft.js. The functional clear only drops the id if it still
  // names THIS ticket, so switching straight from drawer A to drawer B (B's
  // mount effect can run before A's unmount cleanup) can't have A's cleanup
  // clobber B's id.
  useEffect(() => {
    setOpenTicketId(ticketId);
    return () => clearOpenTicketId(ticketId);
  }, [ticketId]);
  const t = tickets.find((x) => x.id === ticketId);
  // The ticket as it was when this visit started (or at the last save), so
  // Done can tell whether someone else changed a field underneath the edits
  // held here (Oct 2026 review) - see changedUnderneath below.
  const baseRef = useRef(null);
  useEffect(() => { if (t && !baseRef.current) baseRef.current = t; }, [t]);
  // Pasted images already stored by a Done whose save then failed - filed
  // under Attachments by the save that lands (see commit).
  const storedImagesRef = useRef([]);
  // Not in the list that has landed: the list may simply predate the ticket
  // (a bell click on a ticket raised seconds ago - the background refresh is
  // once a minute), so pull the tickets once more before saying it is gone.
  const [refetch, setRefetch] = useState('idle');   // idle | loading | done
  useEffect(() => {
    if (t || !ticketsLoaded || refetch !== 'idle' || !reloadTickets) return;
    setRefetch('loading');
    Promise.resolve(reloadTickets()).catch(() => {}).finally(() => setRefetch('done'));
  }, [t, ticketsLoaded, refetch, reloadTickets]);
  // Tells the screen that opened this drawer whether closing it now would
  // throw edits away (a bell click opening another ticket asks first).
  const dirtyNow = Object.keys(pending).length > 0 || !isEmptyDoc(reply.body);
  useEffect(() => {
    if (!dirtyRef) return undefined;
    dirtyRef.current = dirtyNow;
    return () => { dirtyRef.current = false; };
  }, [dirtyRef, dirtyNow]);
  const meIsRequester = !!t && (t.requesterId || '').toLowerCase() === (myEmail || '').toLowerCase();
  useEffect(() => {
    if (!t || !meIsRequester || seenBefore !== undefined) return;
    const before = t.requesterSeenAt || '';
    setSeenBefore(before);
    api.markTicketSeen(t.id).catch(() => {});
    if (t.requesterUpdateAt && t.requesterUpdateAt > before) {
      api.getTicketComments(t.id).then((rows) => {
        const me = (myEmail || '').toLowerCase();
        setNewReplies((rows || []).filter((c) => (c.authorId || '').toLowerCase() !== me && (c.createdAt || '') > before).length);
      }).catch(() => {});
    }
  }, [t, meIsRequester, seenBefore, myEmail]);
  // Live fields always; a retired one only when this ticket actually holds an
  // answer for it. Rendering retired fields unconditionally would give new
  // tickets permanently empty rows for questions nobody was asked.
  const shownTypeFields = (TYPE_FIELDS[t?.type] || []).filter(
    (f) => !f.retired || !isBlankFieldValue(t?.typeFields?.[f.key]));
  // Service answers follow the same rule, and are shown for the area AND type
  // the ticket was FILED under - the same pair that decided which questions it
  // was asked. Re-classifying an app, or re-typing the ticket, must not hide an
  // answer it already holds: anything with a stored value renders regardless,
  // matched by key across the whole map, so a question that no longer applies
  // still shows what was said the first time.
  const shownSvcFields = (() => {
    const area = t?.serviceArea || '';
    const answered = (f) => !isBlankFieldValue(t?.typeFields?.[f.key]);
    // Only what was answered: new tickets are asked none of these (Oct 1),
    // older ones keep showing what they said.
    const own = topicQuestionDefs(t?.application, area).filter(answered);
    const ownKeys = new Set(own.map((f) => f.key));
    const orphans = [...allTopicQuestionDefs(), ...Object.values(SERVICE_FIELDS).flat()]
      .filter((f) => !ownKeys.has(f.key) && answered(f));
    // An answer whose question an admin has since removed still shows,
    // under a label read off its key.
    const known = new Set([...own, ...orphans].map((f) => f.key));
    const loose = Object.keys(t?.typeFields || {})
      .filter((k) => k.startsWith('svc_') && k !== HELP_SUBTOPIC_KEY && !known.has(k) && !isBlankFieldValue(t.typeFields[k]))
      .map((k) => ({ key: k, label: labelFromKey(k), type: 'text' }));
    const seen = new Set();
    return [...own, ...orphans, ...loose].filter((f) => (seen.has(f.key) ? false : seen.add(f.key)));
  })();
  // Opened from an email link before the ticket list has landed: show the
  // "Opening your ticket" screen rather than nothing (Oct 1 - it read as the
  // link not working). Once the list is in, a ticket that still is not there
  // (deleted, or not yours to see) says so with a way out - it used to render
  // nothing at all, which read as a dead click (Oct 2026 review: a ticket
  // raised on someone's behalf, opened from Support).
  if (!t) {
    const gone = ticketsLoaded && (refetch === 'done' || !reloadTickets);
    if (inline) {
      // The pane has no room for a popup: the same two messages, in place.
      return (
        <div data-testid="ticket-drawer" role={gone ? 'alert' : 'status'} aria-busy={gone ? undefined : 'true'}
          style={{ padding: 24, fontSize: 13.5, color: NX.dim, fontFamily: FONT }}>
          {gone ? 'This ticket is not in your list any more - it may have been deleted, or you may no longer have access to it.' : 'Opening your ticket…'}
        </div>
      );
    }
    return gone ? <TicketNotFound onClose={onClose} /> : <TicketOpening onClose={onClose} />;
  }

  // Before a ticket is "in_progress" (with an assignee), the requester has
  // full edit access and anyone else can triage/self-assign it (working
  // fields only). Once it's in_progress and assigned, it becomes the
  // assignee's to work - everyone else, including the requester, is locked
  // out until it moves to another status. Manager+ is unrestricted throughout.
  // Mirrors _ticket_edit_scope in
  // backend/routers/tickets.py, which enforces the same split server-side (this
  // is UI convenience, not the security boundary - that's the backend check).
  const isRequester = (t.requesterId || '').toLowerCase() === (myEmail || '').toLowerCase();
  const isAssignee = (t.assigneeId || '').toLowerCase() === (myEmail || '').toLowerCase();
  // A confidential Ask HR ticket (Oct 27 2026, ticket_confidential.py) is
  // HR's to work: the server says per ticket whether this viewer is HR for it
  // or its assignee (hrCanWork) - a manager or a desk role is not.
  const confidential = !!t.confidentialDesk;
  const privileged = confidential ? !!t.hrCanWork : (myLevel >= 3 || deskAccess.privileged);   // + Global Admins (server's _ticket_privileged)
  // Request Control: LiveView's `assist` mode (components/LiveView.jsx) -
  // consent-first, NOT the Workforce Analytics roster's disclosed-monitoring
  // model. Nothing is visible until the requester accepts a control prompt
  // shown the instant it's sent, and the whole session closes the moment
  // control ends - never falls back to a passive view (Pranshu, Sep 9: "we
  // should not be able to watch the requester screen"). Visible only to the
  // assignee - the requester's own screen isn't something anyone else
  // working the ticket gets to reach for - and gated at the SAME level the
  // backend requires for an assist request (administrator, or a "full"
  // employee-tracking grant - live_request in routers/timeclock.py), not
  // the looser "viewer grant or supervisor role" that plain watching would
  // use, since an assist request effectively asks for control from the
  // start. LiveView/timeclock.py still independently enforce this
  // server-side, same as every other caller of that component - this only
  // decides whether the button is worth showing.
  const canRequestControl = isAssignee && !!t.requesterId && !isRequester
    && canAccessModule('employee-tracking', 'administrator', 'full');
  // Separate from the in_progress/assignee lock above: the moment a ticket
  // moves off its just-raised "open" status - triaged, worked, resolved,
  // whatever comes next - the person who raised it goes read-only on every
  // Overview field (Pranshu, Sept 8 2026: a requester editing type/priority/
  // department out from under whoever is already acting on it is exactly the
  // confusion this closes off). Conversation and Attachments stay theirs to
  // use regardless - see the tab bodies below, neither reads this flag.
  // Manager+ is never subject to it, same as every other restriction here.
  // Not when they are also the assignee - it is theirs to work (backend parity).
  const requesterLocked = isRequester && !isAssignee && !privileged && t.status !== 'open';
  const locked = t.status === 'in_progress' && !!t.assigneeId;
  const fullAccess = privileged || (!requesterLocked && (locked ? isAssignee : isRequester));
  // The always-open "working fields" (type/status/priority/assignee/department/
  // resolution) - open to anyone pre-lock, restricted to the assignee once locked.
  const canWorking = privileged || (!requesterLocked && (locked ? isAssignee : true));
  // Status is carved out of canWorking for the requester specifically (Pranshu,
  // Sep 10 2026): letting them set it straight from the dropdown - even while
  // pre-lock, when canWorking otherwise hands them the rest of the ticket - let
  // a ticket read "In Progress" or "Resolved" with nobody actually working it,
  // and skipped the Mark Resolved/Reopen flows that capture a resolution or a
  // reason. Their whole workflow once it IS resolved is exactly those two
  // footer buttons (Confirm Resolution / Reopen, both unconditional on role
  // below) - never the raw field. Someone who is ALSO the assignee (or
  // privileged) keeps normal dropdown access; this only takes it away from a
  // requester who isn't.
  const canEditStatus = canWorking && !(isRequester && !privileged && !isAssignee);
  // Just the person who raised it - not working it, not a manager.
  const requesterOnly = isRequester && !privileged && !isAssignee;
  // The person it was raised by and for, who is not working it - whatever
  // their role. They get the requester's own Mark Resolved and are the one
  // asked how satisfied they are (a manager's own ticket included).
  const ownRequester = isRequester && !isAssignee;
  // Company is carved out of fullAccess: the assignee can work everything else
  // about a locked ticket, but never reassign which company it belongs to -
  // that stays with the requester (pre-lock) or a manager. Mirrors the
  // company_id carve-out in _ticket_edit_scope.
  // Never on an HR request: it stays on its company's HR desk.
  const canEditCompany = !confidential && (privileged || (!requesterLocked && !locked && isRequester));
  // Assign To and SLA Due Date are desk decisions, not the requester's to make
  // even in the pre-lock window where fullAccess/canWorking otherwise hand
  // them the rest of the ticket - who works it and by when isn't theirs to
  // pick for themselves (Pranshu, Sept 8 2026). Hidden outright rather than
  // disabled while the ticket is still Open (nothing to show yet, and an
  // editable-looking control they can't use is worse than no control); once
  // it moves past Open, requesterLocked already takes the whole Overview tab
  // read-only, which is exactly where these two belong showing up again.
  const canSeeAssignSla = privileged || !isRequester || t.status !== 'open';
  // Delete stays with whoever raised it or owns the queue - never just the
  // assignee, and not affected by the in_progress lock, but IS affected by
  // the requester lock: once someone else is acting on a ticket, its own
  // requester deleting it out from under them is exactly the kind of change
  // this lock exists to prevent.
  // And only for a desk supervisor - the server's delete route requires one
  // (ticket_roles.can_delete), so offering it to anybody else is a dead button.
  const canDelete = !confidential && deskAccess.canDelete && (privileged || (!requesterLocked && isRequester));
  // Collaborators (Oct 14 2026): whoever may edit the ticket at all - its
  // requester or the desk - may add or remove them, whatever its state. They
  // are not the ticket's content, so neither lock above applies (mirrors
  // _COLLABORATOR_FIELDS in routers/tickets.py).
  const canEditCollaborators = privileged || isRequester || (!confidential && deskAccess.canWorkQueue);
  // Escalate is a distress flare, not a priority bump: it mails the ticket's
  // department head that it needs instant care. The assignee or a manager -
  // whoever is actually working it - can raise it any time it's open,
  // unaffected by requesterLocked (that governs editing the ticket's fields,
  // not asking for help on it) and not just whoever's working the queue.
  // The requester is different: showing them a distress flare while the
  // ticket is still comfortably within its SLA reads as "escalate whenever
  // you feel like it," which is not what the button is for - so it stays
  // hidden for them until the SLA is actually missed (Pranshu, Sep 10 2026).
  // Mirrors the server check in escalate_ticket (backend/routers/tickets.py).
  const slaBreached = slaState(t) === 'breached';
  const canEscalate = !CLOSED_STATES.includes(t.status)
    && ((isRequester && slaBreached) || isAssignee || privileged);
  // Saves at once - kept for the links and tasks below, which are their own
  // records and never mail the requester.
  // This visit's own saves move the base along too, so they never read as
  // "changed by someone else" when Done goes out.
  const patch = (p) => updateTicket(t.id, p)
    .then((r) => {
      if (baseRef.current && r?.id) {
        baseRef.current = { ...baseRef.current, ...Object.fromEntries(Object.keys(p).map((k) => [k, r[k]])), modifiedAt: r.modifiedAt };
      }
      return r;
    })
    .catch((e) => appDialog.alert(`Could not update ticket: ${e.message || e}`));
  // The ticket as it will be once Done is clicked: what is saved, with the
  // held edits on top. Permissions above still read the SAVED ticket - that
  // is what the server checks the save against.
  const v = { ...t, ...pending };
  // Hold an edit for Done. Putting a field back the way it was drops it, so
  // Done with nothing really changed saves (and sends) nothing.
  const stage = (p) => setPending((cur) => {
    const next = { ...cur, ...p };
    for (const k of Object.keys(p)) {
      if (JSON.stringify(next[k] ?? '') === JSON.stringify(t[k] ?? '')) delete next[k];
    }
    return next;
  });
  const hasReply = !isEmptyDoc(reply.body);
  const dirty = Object.keys(pending).length > 0 || hasReply;
  // Done: everything held, plus the reply, in one save. `extra` is a dialog's
  // own change (Confirm / Reopen) that goes out with the rest.
  // Returns false when nothing went out because the person chose not to
  // overwrite someone else's change.
  const commit = async (extra = {}) => {
    if (!Object.keys(pending).length && !hasReply && !Object.keys(extra).length) return true;
    // Someone else saved this ticket while these edits were held, and a field
    // being sent is one they changed: ask before overwriting their change.
    const clashes = changedUnderneath(Object.keys(pending));
    if (clashes.length && !(await appDialog.confirm(
      'This ticket was changed by someone else while you were editing. Save anyway?',
      { title: 'Ticket Changed', confirmText: 'Save Anyway', cancelText: 'Keep Editing' }))) return false;
    // A screenshot pasted into the reply or the description is held inline
    // (a data: URL) while typing. Before it goes out it is stored in the
    // private ticket-evidence bucket and the HTML points at that copy, the
    // way the create form does it - so the ticket, its activity and its
    // emails never carry a megabyte of base64. Each one is also filed under
    // Attachments once the save lands. A failed upload keeps the inline copy
    // - never worse. The stored copy goes straight back into the held edit,
    // so a save that fails and is retried does not upload the same images
    // again.
    const upload = async (f) => {
      const url = await uploadTicketEvidence(f, 'image');
      storedImagesRef.current.push({ name: f.name, size: `${Math.max(1, Math.round(f.size / 1024))} KB`, kind: 'image', url });
      return { url };
    };
    let replyBody = reply.body;
    if (hasReply) {
      replyBody = await externalizeInlineImages(reply.body, upload);
      if (replyBody !== reply.body) setReply((r) => ({ ...r, body: replyBody }));
    }
    let description = pending.description;
    if (description) {
      description = await externalizeInlineImages(description, upload);
      if (description !== pending.description) setPending((p) => ({ ...p, description }));
    }
    const body = { ...pending, ...(description !== undefined ? { description } : {}), ...extra };
    if (hasReply) {
      // A reply being written AND a dialog's own comment (Mark Resolved's
      // "What fixed it?") go out as one reply, the dialog's line last.
      body.comment = extra.comment ? `${replyBody}${extra.comment}` : replyBody;
      body.comment_internal = reply.internal;
    }
    const saved = await updateTicket(t.id, body);
    for (const a of storedImagesRef.current) api.addTicketAttachment(t.id, a).catch(attachFailed(a.name));
    storedImagesRef.current = [];
    baseRef.current = saved && saved.id ? saved : null;
    setPending({});
    setReply({ body: '', internal: false });
    return true;
  };
  // The held fields someone else changed since this visit started (or since
  // its last save). Nothing when the live ticket has not moved on.
  const changedUnderneath = (keys) => {
    const base = baseRef.current;
    if (!base || base === t || (base.modifiedAt || '') === (t.modifiedAt || '')) return [];
    return keys.filter((k) => JSON.stringify(base[k] ?? '') !== JSON.stringify(t[k] ?? ''));
  };
  // The requester's Confirm Resolution is held like any other edit; Done is
  // where it is asked how satisfied they are (Oct 1) - the survey saves the
  // rating with everything else and closes the ticket.
  const confirmingClose = ownRequester && t.status === 'resolved' && pending.status === 'closed';
  const done = async () => {
    if (saving || voiceRec) return;
    if (confirmingClose) { setDialog({ mode: 'confirm', viaDone: true }); return; }
    if (!dirty) { onClose(); return; }
    setSaving(true);
    try {
      if (await commit()) { onClose(); return; }
      setSaving(false);
    } catch (e) { appDialog.alert(`Could not update ticket: ${e.message || e}`); setSaving(false); }
  };
  const closeDrawer = async () => {
    if (dirty && !(await appDialog.confirm('Discard your changes to this ticket? Nothing has been saved or sent yet.',
      { title: 'Discard Changes?', confirmText: 'Discard', cancelText: 'Keep Editing', danger: true }))) return;
    onClose();
  };
  // A move into Resolved/Closed goes through the Resolve dialog (it needs a
  // written resolution); every other status move is held like any other edit.
  // Moving back out of a held Resolved drops the resolution written for it
  // (staging the saved values un-holds them).
  const setStatus = (val) => (needsResolution(t, val) ? setDialog({ mode: 'resolve', targetStatus: val })
    : stage({ status: val, ...(CLOSED_STATES.includes(val) ? {} : { resolution: t.resolution, resolutionNote: t.resolutionNote }) }));
  // Title and description are the requester's while the ticket is still Open
  // (and the desk's always) - the same rule as every other Overview field.
  const canEditText = fullAccess;
  const startEdit = () => { setDraft({ subject: v.subject || '', description: v.description || '' }); setEditing(true); };
  const saveEdit = () => {
    const d = draft || {};
    if (!(d.subject || '').trim()) { appDialog.alert('The title cannot be empty.'); return; }
    stage({ subject: d.subject.trim(), description: d.description || '' });
    setEditing(false); setDraft(null);
  };
  const escalate = async () => {
    if (!(await appDialog.confirm('Escalate this ticket? The department head will get an email that it needs urgent attention.',
      { title: 'Escalate Ticket', confirmText: 'Escalate' }))) return;
    escalateTicket(t.id)
      .then(() => appDialog.alert('Escalated - the department head has been notified.', { title: 'Escalated' }))
      .catch((e) => appDialog.alert(`Could not escalate: ${e.message || e}`));
  };
  // Same "ask a reason" pattern as the approval-reject flow - the Outlook
  // reopened-ticket email includes it, so the assignee/dept lead knows why.
  const reopen = () => setDialog({ mode: 'reopen' });
  // ticket → many tasks: union of the spawned list + the legacy single linkedTaskId
  const taskIds = [...(t.taskIds || []), ...(t.linkedTaskId && !(t.taskIds || []).includes(t.linkedTaskId) ? [t.linkedTaskId] : [])];
  // One server call links both sides (Oct 14 2026) - it used to create the
  // task, then PATCH the ticket, and a failed second save left a task nobody
  // could trace back. The new task opens straight away; closing it comes back
  // here, to the Overview.
  const spawnTask = async () => {
    try {
      const { task } = await createTaskFromTicket(t.id);
      setOpenTaskId(task.id);
    } catch (e) { appDialog.alert(`Could not create task: ${e.message || e}`); }
  };
  const linkTask = (taskId) => { if (taskId && !taskIds.includes(taskId)) patch({ taskIds: [...(t.taskIds || []), taskId] }); };
  const unlinkTask = (taskId) => {
    const p = { taskIds: (t.taskIds || []).filter((id) => id !== taskId) };
    if (t.linkedTaskId === taskId) p.linkedTaskId = '';
    patch(p);
  };
  const overdue = slaBreached && !CLOSED_STATES.includes(t.status);

  const remove = async () => {
    if (!(await appDialog.confirm(`Delete ${ticketNo(t.code) || 'this ticket'}? Its history is kept and a manager can restore it.`,
      { title: 'Delete Ticket', confirmText: 'Delete', danger: true }))) return;
    deleteTicket(t.id).then(onClose).catch((e) => appDialog.alert(`Could not delete ticket: ${e.message || e}`));
  };

  const sel = { ...inputStyle, appearance: 'auto', cursor: 'pointer' };
  const navButton = { ...btn('outline'), padding: '5px 10px', fontSize: 12.5, gap: 4 };
  const nav = hasNav ? (
    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
      <button type="button" style={{ ...navButton, opacity: onPrev ? 1 : 0.5 }} disabled={!onPrev} onClick={() => onPrev?.()}
        title="Previous ticket - press ["><ChevronLeft size={14} /> Previous</button>
      <button type="button" style={{ ...navButton, opacity: onNext ? 1 : 0.5 }} disabled={!onNext} onClick={() => onNext?.()}
        title="Next ticket - press ]">Next <ChevronRight size={14} /></button>
    </div>
  ) : null;
  return (
    <>
    {/* No width override - the Modal default (clamp(520px, 60vw, 980px)) is
        the shared "big form" sizing used across the app; the fixed 620px this
        used to pass read as a cramped tab next to that (Pranshu, Sept 8 2026). */}
    {/* While a linked task is open on top, Escape (which Modal also listens
        for) closes the task first rather than the ticket underneath it. */}
    <DrawerShell inline={inline} nav={nav} title={ticketNo(t.code) || 'Ticket'} onClose={() => (openTaskId ? closeTask() : closeDrawer())} footer={
      <>
        {canDelete && (
          <button style={{ ...btn('outline'), color: NX.red, borderColor: NX.border, marginRight: 'auto' }} onClick={remove}><Trash2 size={14} /> Delete</button>
        )}
        {canEscalate && (
          <button style={{ ...btn('outline'), color: NX.amber }} onClick={escalate} title="Alert the department head this ticket needs instant care"><ArrowUp size={14} /> Escalate</button>
        )}
        {!CLOSED_STATES.includes(t.status) ? (
          // canEditStatus, not canWorking - Mark Resolved is the same "raw
          // status jump" the requester is carved out of above; their only
          // status moves are Confirm Resolution / Reopen below, once there
          // actually is a resolution to confirm or reopen.
          // The one exception (Neil, Oct 1): the requester may mark their own
          // ticket Resolved - "a colleague helped me" - with an optional
          // comment instead of the desk's written resolution.
          (canEditStatus || ownRequester) && !CLOSED_STATES.includes(v.status) && (
            <button style={{ ...btn('outline'), color: NX.green }}
              onClick={() => setDialog({ mode: ownRequester ? 'self_resolve' : 'resolve', targetStatus: 'resolved' })}>
              <CheckCircle2 size={14} /> Mark Resolved
            </button>
          )
        ) : (
          <>
            {/* The requester confirms with a rating; the desk just closes it
                out (the resolution was written when it was resolved). */}
            {t.status === 'resolved' && (
              <button style={{ ...btn(v.status === 'closed' ? 'primary' : 'outline'), ...(v.status === 'closed' ? { background: NX.green, borderColor: NX.green } : { color: NX.green }) }}
                aria-pressed={v.status === 'closed'}
                onClick={() => stage({ status: v.status === 'closed' ? t.status : 'closed' })}
                title={v.status === 'closed' ? 'Click Done to finish - or click again to undo'
                  : 'Close this ticket now instead of waiting for it to auto-close'}>
                <CheckCircle2 size={14} /> {v.status === 'closed' ? 'Resolution Confirmed' : 'Confirm Resolution'}
              </button>
            )}
            {/* Reopen while it is Resolved (Oct 1). A closed ticket is closed
                for the requester - the desk can still reopen one. */}
            {(t.status === 'resolved' || canEditStatus) ? (
              <button style={btn('outline')} onClick={reopen}>Reopen</button>
            ) : (
              <span style={{ fontSize: 12, color: NX.faint }}>Closed - if the problem is back, submit a new ticket.</span>
            )}
          </>
        )}
        {dirty && (
          <span style={{ fontSize: 12, color: NX.amber, fontWeight: 600 }} title="Nothing is saved or sent to the requester until you click Done">
            Unsaved Changes
          </span>
        )}
        {voiceRec && <span role="status" style={{ fontSize: 12, color: NX.red }}>{STOP_VOICE_FIRST}</span>}
        <button style={{ ...btn('primary'), opacity: saving || voiceRec ? 0.6 : 1 }} onClick={done} disabled={saving || voiceRec}
          title={voiceRec ? STOP_VOICE_FIRST : dirty ? 'Save every change and send one update to the requester' : undefined}>
          {saving ? 'Saving…' : 'Done'}
        </button>
      </>
    }>
      <div style={{ marginBottom: 6 }}>
        {editing && canEditText ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input autoFocus value={(draft ?? { subject: v.subject }).subject ?? ''} placeholder="Title"
              onChange={(e) => setDraft((d) => ({ ...(d || { description: v.description || '' }), subject: e.target.value }))}
              style={{ ...inputStyle, fontSize: 15, fontWeight: 700 }} />
            {/* The same rich editor the Create a Ticket form uses (Oct 1) - a
                plain-text description written before then opens as one paragraph. */}
            <RichDescription value={(draft ?? { description: v.description }).description ?? ''} minHeight={90}
              placeholder="Describe the issue"
              onChange={(html) => setDraft((d) => ({ ...(d || { subject: v.subject || '' }), description: html }))} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={btn('outline')} onClick={() => { setEditing(false); setDraft(null); }}>Cancel</button>
              <button style={btn('primary')} onClick={saveEdit} title="Saved with everything else when you click Done">Apply</button>
            </div>
          </div>
        ) : (<>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: NX.ink, flex: 1, minWidth: 0 }}>
              {v.subject}
              {/* Raised by email (ticket_inbound.py) - a quiet note, not a chip. */}
              {t.source === 'email' && (
                <span title="Raised by an email to the support mailbox"
                  style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 500, color: NX.faint, whiteSpace: 'nowrap' }}>
                  Via Email
                </span>
              )}
            </div>
            {canEditText && (
              <button type="button" onClick={startEdit} title="Edit title and description" aria-label="Edit title and description"
                style={{ ...btn('ghost'), padding: 5, color: NX.dim, flexShrink: 0 }}><Pencil size={15} /></button>
            )}
          </div>
          {/* Rich text since Oct 1: richBodyHtml sanitizes it, and wraps an
              older plain-text description in paragraphs so both read alike. */}
          {hasRichText(v.description)
            ? <div className="nx-rich-body" style={{ margin: '6px 0 0', fontSize: 13, color: NX.dim }}
                dangerouslySetInnerHTML={{ __html: richBodyHtml(v.description, nameOf) }} />
            : canEditText && (
              <button type="button" onClick={startEdit} style={{ ...btn('ghost'), padding: '4px 0', marginTop: 4, fontSize: 12.5, color: NX.blue, fontWeight: 600 }}>
                <Plus size={13} /> Add a Description
              </button>
            )}
        </>)}
        {(t.images || []).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {t.images.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noreferrer" title="Open full size" style={{ display: 'block', width: 72, height: 72, borderRadius: 8, overflow: 'hidden', border: `1px solid ${NX.border}` }}>
                <img src={url} alt={`Screenshot ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </a>
            ))}
          </div>
        )}
      </div>

      {confidential && (
        <div role="note" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: NX.ink, background: 'rgba(124,58,237,0.08)',
          border: '1px solid rgba(124,58,237,0.28)', borderRadius: 8, padding: '7px 11px', marginTop: 12 }}>
          <Lock size={14} style={{ color: NX.purple, flexShrink: 0 }} />
          <span><b>Confidential HR Request.</b> Only the person who asked, the people on it and HR can see it.</span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '12px 0 16px' }}>
        <TicketStatusChip status={v.status} />
        <PriorityChip priority={v.priority} />
        <ApprovalChip ticket={t} />
        {t.resolvedAt && <span style={{ fontSize: 12, color: NX.green, display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={13} /> Resolved {fmtDate(t.resolvedAt)}{t.resolution ? ` · ${resolutionLabel(t.resolution)}` : ''}</span>}
      </div>
      {t.resolutionNote && CLOSED_STATES.includes(t.status) && (
        <div style={{ fontSize: 13, color: NX.ink, background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.30)', borderRadius: 8, padding: '8px 11px', margin: '-4px 0 14px', whiteSpace: 'pre-wrap' }}>
          <b>Resolution:</b> {t.resolutionNote}
        </div>
      )}

      {/* Mark an Issue on the Map (Oct 20 2026): where it is, with the photo and Open on Map. */}
      <TicketMapSpotCard ticketId={t.id} propertyId={t.propertyAssetId} onOpenMap={onClose} />

      {/* Approval gate - the decision blocks triage, so it leads the drawer,
          always visible regardless of which tab is open. */}
      <ApprovalPanel ticket={t} myEmail={myEmail} nameOf={nameOf} onDecided={onDecided} />

      {/* AI Summary - desk agents only, hidden when AI is off (TicketAi.jsx). */}
      <TicketAiSummary ticketId={t.id} canWorkQueue={deskAccess.canWorkQueue && !confidential} />

      {/* Overview · Conversation · Attachments · Activity - a real tab strip up
          top so Conversation/Attachments/Activity are one click away instead of
          buried under the whole field list (people kept missing them). */}
      <div style={{ borderTop: `1px solid ${NX.border}`, marginTop: 12, paddingTop: 12 }}>
        {/* Segmented control - same mode-switch grammar as the rest of the module */}
        <div className="scroll-tabs" style={{ display: 'inline-flex', gap: 2, marginBottom: 16, background: NX.border2, borderRadius: 9, padding: 2, maxWidth: '100%', overflowX: 'auto' }}>
          {[['overview', 'Overview', ClipboardList], ['conversation', 'Conversation', MessageSquare], ['attachments', 'Attachments', Paperclip], ['activity', 'Activity', History]].map(([k, lab, Icon]) => (
            <button key={k} onClick={() => { setTab(k); if (k === 'conversation') setNewReplies(0); }} style={{
              ...btn('ghost'), gap: 6, fontSize: 12.5, fontWeight: 600, padding: '6px 10px', borderRadius: 7, whiteSpace: 'nowrap', flexShrink: 0,
              background: tab === k ? NX.surface : 'transparent', color: tab === k ? NX.ink : NX.dim,
              boxShadow: tab === k ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}><Icon size={14} />{lab}
              {k === 'conversation' && newReplies > 0 && (
                <span title={`${newReplies} new repl${newReplies === 1 ? 'y' : 'ies'}`}
                  style={{ minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: NX.red, color: '#fff', fontSize: 10.5, fontWeight: 700, display: 'inline-grid', placeItems: 'center' }}>{newReplies}</span>
              )}
            </button>
          ))}
        </div>

        {tab === 'overview' && (<>
      {(t.csatRating || 0) > 0 && <SatisfactionCard ticket={t} nameOf={nameOf} />}

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
        <div style={field}>
          <label style={label}>Type</label>
          <TicketSelect value={v.type || 'request'} onChange={(val) => stage({ type: val })}
            options={TICKET_TYPE_ORDER.includes(v.type) ? typeIntakeOptions() : [...typeIntakeOptions(), { id: v.type, label: TICKET_TYPE_META[v.type]?.label || v.type }]}
            style={sel} disabled={!canWorking || confidential} />
        </div>
        <div style={field}>
          <label style={label}>Status</label>
          {canEditStatus ? (
            <TicketSelect value={v.status} onChange={setStatus} options={statusOptions()}
              style={sel} />
          ) : (
            <div style={{ fontSize: 13, color: NX.ink, minHeight: 34, display: 'flex', alignItems: 'center' }}>
              {TICKET_STATUS_META[v.status]?.label || v.status}
            </div>
          )}
        </div>
        <div style={field}>
          <label style={label}>Priority</label>
          <TicketSelect value={v.priority} onChange={(val) => stage({ priority: val })} options={priorityOptions()}
            style={sel} disabled={!canWorking} />
        </div>
        <div style={field}>
          <label style={label}>Requester</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 34 }}>
            {t.requesterId ? <><Avatar email={t.requesterId} name={nameOf(t.requesterId)} size={22} /><span style={{ fontSize: 13, color: NX.ink }}>{nameOf(t.requesterId)}</span></> : <span style={{ fontSize: 13, color: NX.faint }}>-</span>}
            {canRequestControl && (
              <button type="button" onClick={() => setRequestingControl(true)}
                title={`Ask ${nameOf(t.requesterId) || 'them'} for permission to view and control their screen - nothing is visible until they accept`}
                style={{ ...btn('outline'), marginLeft: 'auto', padding: '4px 9px', fontSize: 12, gap: 5 }}>
                <MousePointer2 size={13} /> Request Control
              </button>
            )}
          </div>
        </div>
        {canSeeAssignSla && (
          <div style={field}>
            <label style={label}>Assign To</label>
            {/* Locked until the request is approved - the backend refuses it anyway,
                so showing an open picker would only produce a 409 the user can't act on. */}
            {/* Phones get a bottom sheet (TicketAssignSheet) - the anchored
                dropdown and its auto-focused search fought the keyboard. */}
            {isMobile ? (
              <MobileAssignField value={v.assigneeId || ''} people={people} nameOf={nameOf} onChange={(val) => stage({ assigneeId: val || '' })}
                disabled={!canWorking || t.approvalStatus === 'pending'}
                placeholder={t.approvalStatus === 'pending' ? 'Awaiting Approval' : 'Unassigned'} />
            ) : (
              <PersonSelect value={v.assigneeId || null} people={people} onChange={(val) => stage({ assigneeId: val || '' })}
                disabled={!canWorking || t.approvalStatus === 'pending'}
                placeholder={t.approvalStatus === 'pending' ? 'Awaiting approval' : 'Unassigned'} />
            )}
          </div>
        )}
        {t.assignedById && (
          <div style={field}>
            <label style={label}>Assigned By</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 34 }}>
              <Avatar email={t.assignedById} name={nameOf(t.assignedById)} size={22} />
              <span style={{ fontSize: 13, color: NX.ink }}>{nameOf(t.assignedById)}</span>
            </div>
          </div>
        )}
        {/* Collaborators, as on a task (Sagar, Oct 14 2026): the people
            pulled in to help. They are the ticket's watchers - they can open
            it, reply and hear about every change, and each one added gets a
            bell. Saved with the rest on Done. */}
        <div style={{ ...field, gridColumn: '1 / -1' }}>
          <label style={label}>Collaborators</label>
          {canEditCollaborators ? (
            <TicketPeopleMultiSelect value={v.watcherIds || []} onChange={(list) => stage({ watcherIds: list })} {...collabExtras}
              options={collaboratorOptions(people, [t.requesterId, ...(v.watcherIds || [])], t.requesterId)} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minHeight: 34 }}>
              {(v.watcherIds || []).length ? (v.watcherIds || []).map((em) => (
                <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: NX.ink }}>
                  <Avatar email={em} name={nameOf(em)} size={22} />{nameOf(em)}
                </span>
              )) : <span style={{ fontSize: 13, color: NX.faint }}>-</span>}
            </div>
          )}
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>They can open this ticket, reply and get its updates.</div>
        </div>
        <div style={field}>
          <label style={label}>Company</label>
          {canEditCompany ? (
            <TicketSelect value={v.companyId || ''} onChange={(val) => stage({ companyId: val, hrDepartmentId: '' })}
              style={sel} placeholder="Select company" searchPlaceholder="Search companies…"
              options={[['', 'Select company'], ...companies.map((c) => [c.id, c.name])]} />
          ) : (
            <div style={{ fontSize: 13, color: NX.ink, minHeight: 34, display: 'flex', alignItems: 'center' }}>
              {companies.find((c) => c.id === v.companyId)?.name || '-'}
            </div>
          )}
        </div>
        <div style={field}>
          <label style={label}>Department</label>
          <TicketSelect value={v.hrDepartmentId || ''} onChange={(val) => stage({ hrDepartmentId: val })} style={sel}
            disabled={!v.companyId || !canWorking || confidential} searchPlaceholder="Search departments…"
            placeholder={v.companyId ? 'Select department' : 'Select a company first'}
            options={[['', v.companyId ? 'Select department' : 'Select a company first'],
              // Turned off for tickets / deleted globally: not offered, but the
              // one this ticket is already filed under still shows its name.
              ...allDepts.filter((d) => d.companyId === v.companyId
                && (offeredAtIntake(d) || d.id === v.hrDepartmentId)).map((d) => [d.id, d.name]),
              // Filed against a department since removed from the desk list -
              // still show what it was filed under rather than a blank.
              ...(v.hrDepartmentId && allDepts.length && !allDepts.some((d) => d.id === v.hrDepartmentId)
                ? [[v.hrDepartmentId, 'Removed department']] : [])]} />
        </div>
        {/* What the ticket is about. fullAccess, NOT canWorking: `application`
            is not one of the backend's _WORKING_FIELDS, so a triaging third
            party offered this control would get a 403 they cannot act on.
            Re-pointing a mis-filed ticket is the requester's, the assignee's
            or a manager's to do - which is exactly what fullAccess is. */}
        <div style={field}>
          <label style={label}>Help With</label>
          {fullAccess && !confidential ? (
            <DrawerHelpTopic key={`${t.id}:${v.hrDepartmentId || ''}`} value={v.application || ''}
              deptName={allDepts.find((d) => d.id === v.hrDepartmentId)?.name || ''}
              subValue={v.typeFields?.[HELP_SUBTOPIC_KEY] || ''}
              onCommitSub={(sub) => stage({ typeFields: withHelpSubtopic(v.typeFields, sub) })}
              onCommit={(name) => {
                if (name === (v.application || '')) return;
                // A different topic: its old "which one" no longer applies.
                stage(v.typeFields?.[HELP_SUBTOPIC_KEY]
                  ? { application: name, typeFields: withHelpSubtopic(v.typeFields, '') }
                  : { application: name });
              }} />
          ) : (
            <div style={{ fontSize: 13, color: NX.ink, minHeight: 34, display: 'flex', alignItems: 'center' }}>{helpWithLabel(v) || '-'}</div>
          )}
          {/* Suggested Help Topic for a ticket filed without one (TicketAi.jsx); held for Done like any edit. Hidden while a department change is held - its topics are another list. */}
          {fullAccess && !confidential && !('hrDepartmentId' in pending) && (
            <DrawerSuggestedTopic ticketId={t.id} hasTopic={!!(v.application || '').trim()} canWorkQueue={deskAccess.canWorkQueue}
              onApply={(name) => stage({ application: name })} />
          )}
        </div>
        {/* Property Tickets (Neil, 10/05). Same edit rule as Help With: the
            backend leaves property_asset_id out of _WORKING_FIELDS. A
            Resolved/Closed ticket is that property's maintenance record, so
            it moves only after a reopen (the server refuses it too). */}
        {!confidential && (v.propertyAssetId || (fullAccess && groupTakesProperty(helpGroupFor(allDepts.find((d) => d.id === v.hrDepartmentId)?.name || '')))) && (
          <div style={field}>
            <label style={label}>Property</label>
            {fullAccess && !v.propertyLocked ? (<>
              <PropertySelect value={v.propertyAssetId || ''} fallbackName={v.propertyName || ''}
                disabled={['resolved', 'closed'].includes(v.status)}
                onChange={(id) => { if (id !== (v.propertyAssetId || '')) stage({ propertyAssetId: id }); }} />
              {['resolved', 'closed'].includes(v.status) && v.propertyAssetId && (
                <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>Part of this property's maintenance history - reopen the ticket to change it.</div>
              )}
            </>) : (<>
              <div style={{ fontSize: 13, color: NX.ink, minHeight: 34, display: 'flex', alignItems: 'center' }}>{v.propertyName || '-'}</div>
              {v.propertyLocked && (
                <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 2 }}>Raised from this property in Asset Management - it can't be changed.</div>
              )}
            </>)}
          </div>
        )}
        {/* Unit + View Property (Ops review, Oct 20) - TicketPropertyFields.jsx. */}
        {!confidential && <TicketPropertyDetail v={v} canEdit={fullAccess} stage={stage} style={sel} />}
        {/* Derived from the application by the server, and re-derived whenever
            it changes. A manager can still override it here for an app the
            directory has mapped wrongly - correcting the mapping itself is a
            job for the External Links screen. */}
        <div style={field}>
          <label style={label}>Service Area</label>
          {fullAccess && !confidential ? (
            <TicketSelect value={v.serviceArea || ''} onChange={(val) => stage({ serviceArea: val })} style={sel}
              placeholder="Not Set" options={[['', 'Not Set'], ...serviceAreaOptions()]} />
          ) : (
            <div style={{ fontSize: 13, color: NX.ink, minHeight: 34, display: 'flex', alignItems: 'center' }}>{serviceAreaLabel(v.serviceArea) || '-'}</div>
          )}
        </div>
        {/* NOT gated on canSeeAssignSla (Pranshu, Sep 17 2026: "I want SLA due
            date for all type of tickets") - that gate exists to keep Assign
            To a desk decision, not the requester's to make or see while a
            ticket is still Open, but the due date itself is informational
            for everyone regardless of who's viewing or what state it's in. */}
        <div style={field}>
          <label style={label}>SLA Due Date</label>
          {/* Read-only always (Pranshu, Sep 17 2026) - it follows Priority
              automatically (ticket_sla.recompute in update_ticket), and a
              manual DateField editor here let it drift out of step with the
              priority it's supposed to track. Change Priority to move it.
              A moment, not a day (Honest SLA, Oct 2026): date and time, and
              Paused while the ticket waits on the requester. */}
          <div data-testid="ticket-sla-due" style={{ fontSize: 13, color: overdue ? NX.red : NX.ink, fontWeight: overdue ? 700 : 400, minHeight: 34, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {fmtDueAt(t)}
            {slaState(t) === 'paused' && <SlaBadge t={t} />}
          </div>
          <FirstResponseIndicator t={t} />
          {/* "Needs a comment" - a signal separate from the due date above:
              nobody has said anything in longer than this priority's
              check-in cadence, whether or not the due date has passed. */}
          {commentStale(t) && (
            <div title={`No comment in over ${COMMENT_STALE_HOURS[t.priority] ?? 24}h`}
              style={{ ...chip(COMMENT_STALE_META.color, COMMENT_STALE_META.tint), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, padding: '2px 8px', marginTop: 6 }}>
              <COMMENT_STALE_META.Icon size={12} />{COMMENT_STALE_META.label}
            </div>
          )}
        </div>
        {CLOSED_STATES.includes(v.status) && (
          <div style={field}>
            <label style={label}>Resolution</label>
            <TicketSelect value={v.resolution || ''} onChange={(val) => stage({ resolution: val })} style={sel}
              disabled={!canWorking} placeholder="Select One"
              options={[['', 'Select One'], ...TICKET_RESOLUTION.map((r) => [r.key, r.label])]} />
          </div>
        )}
      </div>

      {shownTypeFields.length > 0 && (
        <div style={field}>
          <label style={label}>{TICKET_TYPE_META[t.type]?.label} Details</label>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            {shownTypeFields.map((f) => (
              <div key={f.key} style={{ gridColumn: (f.full || f.type === 'textarea' || f.type === 'checklist') ? '1 / -1' : 'auto' }}>
                <div style={{ ...label, fontSize: 11 }}>{f.label}</div>
                {fullAccess ? (
                  <TypeFieldInput field={f} value={v.typeFields?.[f.key]} onChange={(val) => stage({ typeFields: { ...(v.typeFields || {}), [f.key]: val } })} people={people} projects={projects} />
                ) : (
                  <div style={{ fontSize: 13, color: NX.ink, whiteSpace: f.type === 'textarea' ? 'pre-wrap' : 'normal' }}>{readOnlyFieldValue(f, v.typeFields?.[f.key], nameOf)}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {shownSvcFields.length > 0 && (
        <div style={field}>
          <label style={label}>{serviceAreaLabel(t.serviceArea) || 'Help Topic'} Details</label>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            {withDynamicOptions(shownSvcFields, { sites }).map((f) => (
              <div key={f.key} style={{ gridColumn: (f.full || f.type === 'textarea') ? '1 / -1' : 'auto' }}>
                <div style={{ ...label, fontSize: 11 }}>{f.label}</div>
                {fullAccess ? (
                  <TypeFieldInput field={f} value={v.typeFields?.[f.key]} onChange={(val) => stage({ typeFields: { ...(v.typeFields || {}), [f.key]: val } })} people={people} projects={projects} />
                ) : (
                  <div style={{ fontSize: 13, color: NX.ink }}>{readOnlyFieldValue(f, v.typeFields?.[f.key], nameOf)}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tasks, linked tickets and equipment would carry an HR request to
          people outside HR - an HR ticket has none (the server refuses them). */}
      {!confidential && (<>
      <div style={field}>
        <label style={label}>Tasks</label>
        <TicketTasks taskIds={taskIds} tasks={tasks} tasksLoading={tasksLoading} onOpen={setOpenTaskId} onSpawn={spawnTask} onLink={linkTask} onUnlink={unlinkTask} readOnly={!fullAccess} />
      </div>

      <div style={field}>
        <label style={label}>Linked Tickets</label>
        <TicketLinks ticket={t} tickets={tickets} onAdd={(target, type) => addTicketLink(t.id, target, type).catch((e) => appDialog.alert(`Could not link the ticket: ${e.message || e}`))}
          onRemove={(target) => removeTicketLink(t.id, target).catch((e) => appDialog.alert(`Could not remove the link: ${e.message || e}`))} readOnly={!fullAccess} />
      </div>

      <div style={field}>
        <label style={label}>Equipment</label>
        <TicketEquipment ticketId={t.id} />
      </div>
      </>)}

      {CLOSED_STATES.includes(t.status) && !(t.csatRating > 0) && (
        <div style={field}>
          <label style={label}>Satisfaction</label>
          <CsatWidget ticket={v} canRate={!t.requesterId || t.requesterId === myEmail} onRate={(rating) => stage({ csatRating: rating })}
            onComment={(comment) => stage({ csatComment: comment })} />
        </div>
      )}

        </>)}
        {tab === 'conversation' && (
          <TicketConversation ticketId={t.id} ticketType={t.type} nameOf={nameOf} newSince={meIsRequester ? seenBefore : undefined}
            reply={reply} onReplyChange={setReply} onDone={done} onVoiceRecordingChange={setVoiceRec}
            // The public-reply / internal-note switch is the desk's. The person
            // who raised the ticket just replies (Neil, Sep 30: "they should
            // not see public reply versus an internal note").
            canInternal={confidential ? (!!t.hrCanWork && !isRequester) : ((privileged || isAssignee || !isRequester) && deskAccess.canReadInternal)}
            canDelete={deskAccess.canDelete && !confidential}
            // Saved Replies are the desk's (Oct 2026) - never the requester view.
            savedReplies={deskAccess.canWorkQueue && (privileged || isAssignee || !isRequester)}
            ticket={t} myEmail={myEmail} />
        )}
        {tab === 'attachments' && <TicketAttachments ticketId={t.id} ticketType={t.type} canDelete={deskAccess.canDelete && !confidential} />}
        {tab === 'activity' && <TicketActivity ticketId={t.id} nameOf={nameOf} companies={companies} allDepts={allDepts} />}
      </div>
    </DrawerShell>
    {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} onBackToTicket={closeTask} zIndex={4100} />}
    {dialog && (
      <TicketActionDialog mode={dialog.mode} targetStatus={dialog.targetStatus} ticket={v}
        // Resolving is a status change like any other - held for Done. Confirm
        // and Reopen are the requester's own finishing moves, so they save
        // (with anything else held) right away.
        // Self-resolve is the requester's own finishing move too.
        // The satisfaction survey raised by Done closes the drawer once saved.
        onSubmit={(p) => (dialog.mode === 'resolve' ? stage(p)
          : dialog.viaDone ? commit(p).then((ok) => { if (ok) onClose(); return ok; }) : commit(p))} onClose={() => setDialog(null)} />
    )}
    {requestingControl && (
      <LiveView assist email={t.requesterId} name={nameOf(t.requesterId) || t.requesterId} onClose={() => setRequestingControl(false)} />
    )}
    </>
  );
}
