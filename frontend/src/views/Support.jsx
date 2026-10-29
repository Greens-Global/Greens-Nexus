// Help Center (Neil, Oct 13 2026; was Support) - the end-user face of the
// Ticket module, plus everything for learning: Documentation (the
// Implementation Guide is a section of it) and the Knowledge Base & Training.
// The view id and its routing stay 'support'; the address reads /help-center.
//
// This page used to be a mock: four cards whose "Open" buttons did nothing, and
// two invented tickets (SUP-204, SUP-198) that looked exactly like real ones.
// The whole point of a support page is that someone in trouble can raise a
// ticket and then see what happened to it, and neither worked.
//
// Deliberately NOT the Tickets module. That screen is the agent queue - every
// ticket in the company, with assignment, priority triage and status controls.
// This is the requester's view: raise one, then watch yours. The list comes from
// /task-tickets?mine=true, scoped server-side, so an employee's browser never
// receives anyone else's ticket.
import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Ticket is the Ticket module's own icon (Sidebar, TicketsView) - the card
// that opens its create form should wear it, not a generic document.
import {
  Ticket, ArrowUpRight, Search,
  ArrowUp, ArrowDown, ArrowUpDown, ChevronLeft, ChevronRight, LifeBuoy, BookOpen,
  Pencil, CheckCircle2, RotateCcw, CircleHelp, GraduationCap,
} from 'lucide-react';
import { HELP_OPEN_EVENT } from '../support/HelpMenu';
import { api } from '../api';
import { ticketNoShort, normalizeCode, TICKET_STATUS_META, TICKET_STATUS_ORDER } from '../tickets/ticketMeta';
import { formatDate, formatTime } from '../lib/datetime';
import { NX, FONT } from '../tasks/theme';
import { useRole } from '../contexts/RoleContext';
import { Avatar, usePeople } from '../tasks/components';
import { useTableColumns, useTableValue, ColResizer } from '../tasks/tableCols';
import { takePendingOpen } from '../lib/pendingOpen';
import GuidedTour from '../components/GuidedTour';
import ModuleTabs from '../components/ModuleTabs';
import { SkeletonBlocks, ModalLoading, LoadingState } from '../components/AsyncState';
import { buildSupportTourSteps } from './supportTourSteps';
import { LatestCommentPreview } from '../tickets/LatestComment';
import { StatusLabel } from '../components/StatusLabel';
import { registerTour } from '../lib/tours';
import { useActionCounts, tabCount } from '../lib/useActionCounts';
import { confirmSwitchTicket } from '../tickets/drawerGuard';

// Documentation tab (Sep 24): the written guide to every module. Lazy so its
// content and drawn screenshots only load when someone opens the tab. The
// Implementation Guide is one of its sections since Oct 13 2026 (Neil:
// "technically it is all of documentation") - /support/implementation opens
// Documentation on it.
const SupportDocs = lazy(() => import('../support/SupportDocs'));

// 'help' is the page as it always was; 'documentation' is the module guide.
// URL: /help-center or /help-center/documentation.
// One tab in the header (Pranshu, 10/07): Documentation opens from its card,
// not the top bar, so the page's own tab is just Help Center, and clicking it
// always comes back to the cards.
const SUPPORT_TABS = [
  { key: 'help', label: 'Help Center', Icon: LifeBuoy },
];

// Tour id this page reports to the server (routers/user_tours.py) - same
// pattern as the Task and Ticket modules' own TASK_TOUR_ID/TICKET_TOUR_ID.
const SUPPORT_TOUR_ID = 'support';

// Report a Bug used to be its own tile here (a Tasks-module modal). Neil, Oct 1
// 2026: folded into Submit a Ticket - a bug is just the Bug Report type there,
// so there is one form to learn and one set of routing rules behind it.

// The Ticket module's OWN create form, mounted here instead of navigating to
// that module. A second form would be a second set of fields to keep in step
// with routing, SLA and per-type questions - and the first thing to drift.
// It reads createTicket from TasksProvider, which lives on the Tasks view, so
// the provider comes along just for the modal (same trick QuickActionModals
// uses for CreateTaskModal). Lazy so the tickets chunk only loads on click.
const TicketComposer = lazy(async () => {
  const [{ TasksProvider }, { CreateTicketModal }] = await Promise.all([
    import('../tasks/TasksContext'),
    import('../tickets/TicketsView'),
  ]);
  return {
    default: ({ onClose, onBatch }) => (
      <TasksProvider><CreateTicketModal onClose={onClose} onBatch={onBatch} /></TasksProvider>
    ),
  };
});

// The Ticket module's OWN detail drawer, mounted here instead of routing to
// that module - same trick as TicketComposer above. That module's own view is
// grant-gated to supervisor+ (App.jsx VIEW_MIN_ROLES: tickets is the agent
// queue), so a plain employee following a nexus:navigate('tickets') there
// would hit an Access Restricted wall instead of their own ticket. The
// drawer's own permission model already scopes what a non-desk person sees
// (isRequester/privileged checks inside TicketDrawer), and /task-tickets is
// auto-scoped server-side to "my tickets" for anyone without the desk grant -
// so mounting it directly here shows exactly what the Ticket module would,
// without needing the module's own access grant.
// Batch Create (Neil, Oct 13 2026; was the Property Walkthrough tile, 10/05) -
// the second tab of Submit a Ticket, only for people who may run one (the
// desk, the Asset Management team, admins; /ticket-properties says).
// Needs no TasksProvider: it saves through api directly.
const WalkthroughComposer = lazy(() => import('../tickets/PropertyWalkthrough'));
const TicketDetail = lazy(async () => {
  const [{ TasksProvider }, { TicketDrawer }] = await Promise.all([
    import('../tasks/TasksContext'),
    import('../tickets/TicketsView'),
  ]);
  return {
    default: ({ ticketId, onClose, startEditing, initialTab, dirtyRef }) => (
      <TasksProvider><TicketDrawer ticketId={ticketId} onClose={onClose} startEditing={startEditing} initialTab={initialTab} dirtyRef={dirtyRef} /></TasksProvider>
    ),
  };
});

// Confirm (with a star rating) / Reopen, straight from the list - the same
// dialog the drawer uses, lazy for the same reason as everything above.
const ActionDialog = lazy(async () => {
  const { TicketActionDialog } = await import('../tickets/TicketsView');
  return { default: TicketActionDialog };
});
// The dialog speaks the store's camelCase; this page saves through api
// directly, which takes the backend's field names.
const toTicketBody = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [
  ({ csatRating: 'csat_rating', csatComment: 'csat_comment', resolutionNote: 'resolution_note' })[k] || k, v]));

const go = (view, sub) => window.dispatchEvent(
  new CustomEvent('nexus:navigate', { detail: sub ? { view, sub } : { view } }));

// The same soft status label the Ticket module's own list uses (Neil, Oct 14
// 2026 - the solid color blocks were retired everywhere), so this table reads
// as the same UI, not a lookalike.
function StatusCell({ status }) {
  const m = TICKET_STATUS_META[status] || { label: status, color: '#64748b' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: '0 10px', minWidth: 0, overflow: 'hidden' }}>
      <StatusLabel label={m.label} color={m.color} />
    </div>
  );
}

// Ten rows the Ticket module's own list would sort exactly this way for -
// State by its workflow order, everything else by value.
//
// Neil, 10/08: the table fills the card's width (Title and Latest Comment are
// the elastic columns - `template` - until someone drags them, when they
// become a saved pixel width like any other), "#" instead of "Ticket No" so
// the number stops eating room, and every row is two lines tall: the date
// cells stack date over time, Title and the comment wrap onto a second line.
const SUPPORT_TABLE_COLUMNS = [
  { key: 'ticket', label: '#', width: 64, minWidth: 56, sort: (t) => normalizeCode(t.code) },
  { key: 'title', label: 'Title', width: 320, minWidth: 160, template: 'minmax(200px,1.3fr)', sort: (t) => (t.subject || '').toLowerCase() },
  { key: 'status', label: 'Status', width: 150, minWidth: 90, sort: (t) => TICKET_STATUS_ORDER.indexOf(t.status) },
  { key: 'assignedTo', label: 'Assigned To', width: 150, minWidth: 90, sort: (t, ctx) => (ctx.nameOf(t.assigneeId) || '').toLowerCase() },
  { key: 'created', label: 'Created', width: 112, minWidth: 96, sort: (t) => t.createdAt || '' },
  // Neil, Sep 30: "when was the last update" - any change or reply.
  { key: 'updated', label: 'Last Updated', width: 112, minWidth: 96, sort: (t) => lastUpdated(t) },
  // The newest public reply (Neil, Oct 1) - click it to land on the
  // conversation. The server never sends an internal note here. Runs to the
  // card's right edge and wraps so it can actually be read (Neil, 10/08).
  { key: 'latestComment', label: 'Latest Comment', width: 320, minWidth: 180, template: 'minmax(240px,2fr)', sort: (t) => t.latestComment?.createdAt || '' },
];

// The table fits the card instead of scrolling sideways (Neil, Oct 12 2026:
// no horizontal scrollbar on a laptop, a desktop or an iPad). Three column
// sets, picked from the CARD's measured width - not the window's, since the
// sidebar and the page gutters take a different share on every screen:
//   full     every column, the person's saved widths and the resize handles
//   compact  Created goes (Last Updated stays - it is the one people read),
//            Title / Assigned To / Latest Comment share the room elastically
//   narrow   #, Title, Status, Last Updated; the latest comment and the row's
//            actions move UNDER the title, so nothing is lost, just stacked
//   phone    #, Title, Status - Last Updated joins the comment under the
//            title (Oct 17: four fixed columns left the title ~4px on a phone)
// Below the full tier a saved pixel width is ignored: a column dragged wide
// on a desktop must not bring the scrollbar back on the laptop.
//
// Neil, 10/28/2026 ("a random small horizontal scrollbar"): a tier is picked
// only when its columns' real floors - plus the left gutter and the Actions
// column - fit the card, so there is nothing to scroll and no scroll box at
// all. Fixed breakpoints used to let the full tier start ~90px before it fit.
const TABLE_TIER_NARROW_MIN = 560;
const SUPPORT_TABLE = 'support-open-tickets';
const pick = (keys, patch = {}) => SUPPORT_TABLE_COLUMNS.filter((c) => keys.includes(c.key)).map((c) => ({ ...c, ...(patch[c.key] || {}) }));
const TIER_COLUMNS = {
  full: SUPPORT_TABLE_COLUMNS,
  compact: pick(['ticket', 'title', 'status', 'assignedTo', 'updated', 'latestComment'], {
    title: { template: 'minmax(150px,1.3fr)' }, status: { width: 120 }, assignedTo: { template: 'minmax(96px,0.7fr)' },
    latestComment: { template: 'minmax(170px,1.6fr)' },
  }),
  narrow: pick(['ticket', 'title', 'status', 'updated'], {
    ticket: { width: 54 }, title: { template: 'minmax(0,1fr)' }, status: { width: 100 }, updated: { width: 96 },
  }),
  phone: pick(['ticket', 'title', 'status'], {
    ticket: { width: 44 }, title: { template: 'minmax(0,1fr)' }, status: { width: 116 },
  }),
};
// The grid template a column set draws with - a saved width (never under the
// column's own floor, as useTableColumns does) or its default.
const templateOf = (cols, saved = {}) => cols.map((c) => {
  const w = saved[c.key] && Math.max(saved[c.key], c.minWidth || 0);
  return w ? `${w}px` : c.template || `${c.width}px`;
}).join(' ');
// The least width a template can take: each px track, each minmax's minimum.
const floorOf = (tpl) => [...tpl.matchAll(/minmax\(([^,]+),[^)]*\)|(\d+(?:\.\d+)?)px/g)]
  .reduce((sum, m) => sum + (parseFloat(m[1] ?? m[2]) || 0), 0);
// { tier, saved }: `saved` false = the full tier on its default widths,
// because the widths this person dragged no longer fit this card (a column
// dragged past the edge snaps back instead of scrolling).
function pickTier(w, saved, extra) {
  if (!w) return { tier: 'full', saved: true };
  if (floorOf(templateOf(TIER_COLUMNS.full, saved)) + extra <= w) return { tier: 'full', saved: true };
  if (floorOf(templateOf(TIER_COLUMNS.full)) + extra <= w) return { tier: 'full', saved: false };
  if (floorOf(templateOf(TIER_COLUMNS.compact)) + extra <= w) return { tier: 'compact', saved: false };
  return { tier: w >= TABLE_TIER_NARROW_MIN ? 'narrow' : 'phone', saved: false };
}
// The Actions column (Neil, 10/28/2026: Confirm / Reopen "hang outside the
// table") - inside the table, at the width its widest buttons need, so every
// row's buttons line up under one header.
const ACTIONS_W_PAIR = 196;     // Confirm + Reopen
const ACTIONS_W_ONE = 150;      // Mark Resolved

// The card's inner (content-box) width, live - the tier above follows it as
// the window, the sidebar or the device changes. Width only: a height change
// (rows paging in) must not re-pick columns.
//
// A CALLBACK ref, not a ref object read in an effect: the card is unmounted
// while Documentation or the Implementation Guide is showing, and a mount-time
// effect keyed on a ref object never sees the card that comes back (it stayed
// at width 0 - the full table, scrollbar included - after a deep link to
// Documentation, and watched a detached node after Documentation -> Back).
// React calls this with every new card and runs the cleanup for the old one.
// It also measures once on the spot: ref callbacks run in the commit, before
// the browser paints, so the first frame is already the right tier instead of
// the full table flashing in until the observer's first report.
const contentWidth = (el) => {
  const cs = window.getComputedStyle(el);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  return Math.max(0, Math.round(el.clientWidth - pad));
};
function useCardWidth() {
  const [w, setW] = useState(0);
  const ref = useCallback((el) => {
    if (!el) return undefined;
    setW(contentWidth(el));
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect?.width || 0);
      setW((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [w, ref];
}

// Date over time, the two-line cell Created and Last Updated use (Neil, 10/08).
function DateTimeStack({ value, strong }) {
  if (!value) return <span style={{ color: NX.faint }}>-</span>;
  return (
    <div style={{ lineHeight: 1.3 }}>
      <div style={{ fontSize: 12.5, color: strong ? NX.ink : NX.dim, fontWeight: strong ? 700 : 500 }}>{formatDate(value)}</div>
      <div style={{ fontSize: 11.5, color: NX.faint }}>{formatTime(value)}</div>
    </div>
  );
}

// The later of the ticket's own modified time and a reply by the team - so a
// comment moves it even on a ticket saved before comments stamped modified_at.
function lastUpdated(t) {
  const a = t.modifiedAt || t.createdAt || '';
  const b = t.requesterUpdateAt || '';
  return b > a ? b : a;
}
// Changed by someone else since the requester last opened it.
const isUnread = (t) => !!t.requesterUpdateAt && t.requesterUpdateAt > (t.requesterSeenAt || '');
// The left gutter: the unread dot and the edit pencil sit in it, OUTSIDE the
// table, so they never push a column around (Neil, 10/08).
const GUTTER_W = 46;
// Two lines of content per row (Neil, 10/08).
const ROW_MIN_H = 54;
const cellBase = { display: 'flex', alignItems: 'center', minHeight: ROW_MIN_H, padding: '6px 10px', boxSizing: 'border-box', minWidth: 0 };
const rowBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px', fontSize: 12, fontWeight: 600,
  border: `1px solid ${NX.border}`, borderRadius: 7, background: NX.surface, color: NX.ink, cursor: 'pointer',
  fontFamily: FONT, whiteSpace: 'nowrap',
};
const SUPPORT_PAGE_SIZE = 10;

export default function Support({ activeSub, onSubChange }) {
  const { can = () => false, isExternal = false } = useRole() || {};
  const counts = useActionCounts();
  const canImplement = !isExternal && can('administrator');
  const onGuide = activeSub === 'implementation' && canImplement;
  const tab = activeSub === 'documentation' || onGuide ? 'documentation' : 'help';
  const setTab = (key) => onSubChange?.(key === 'help' ? null : key);
  const [submitting, setSubmitting] = useState(false);
  const [walking, setWalking] = useState(false);
  const [canWalk, setCanWalk] = useState(false);
  useEffect(() => {
    let live = true;
    api.getTicketProperties().then((r) => { if (live) setCanWalk(!!r?.canWalkthrough); }).catch(() => {});
    return () => { live = false; };
  }, []);
  // { id, edit } - `edit` opens the drawer straight into its editor (the pencil).
  // `n` numbers each open, and keys the drawer: clicking the same row again
  // (after a drawer that could not show the ticket) mounts a fresh one
  // rather than leaving the old one where it was.
  const [viewing, setViewingState] = useState(null);
  const openSeq = useRef(0);
  const setViewing = useCallback((v) => {
    if (!v) { setViewingState(null); return; }
    openSeq.current += 1;
    setViewingState({ ...v, n: openSeq.current });
  }, []);
  const setViewingTicketId = useCallback((id) => setViewing(id ? { id } : null), [setViewing]);
  // Whether the open drawer holds unsaved edits (TicketDrawer keeps it
  // current) - a bell click opening another ticket asks before dropping them.
  const drawerDirtyRef = useRef(false);
  const viewingIdRef = useRef(null);
  useEffect(() => { viewingIdRef.current = viewing?.id || null; }, [viewing]);
  const [listTab, setListTab] = useState('open');   // 'open' | 'following' | 'closed'
  const [action, setAction] = useState(null);       // { mode: 'confirm' | 'reopen' | 'self_resolve' | 'resolve', ticket }
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  // Ticket module list conventions, reused here: click a header to sort by it
  // (default desc so the newest work leads), ten rows per page rather than
  // one long unbroken list.
  const [sort, setSort] = useState({ key: 'created', dir: 'desc' });
  const [page, setPage] = useState(1);
  const { myEmail } = useRole();
  const people = usePeople();
  const nameOf = useCallback((email) => {
    const e = (email || '').toLowerCase();
    return people.find((p) => p.email === e)?.name || '';
  }, [people]);
  // Same drag-to-resize kit the Ticket module's own list and the Task List
  // use (tasks/tableCols.jsx) - a person's column widths here follow them the
  // same way, saved to their profile under their own table key.
  const [cardW, cardRef] = useCardWidth();

  // Closed tickets are not what "Open Tickets" means, but a requester whose
  // ticket was just resolved should still see that it was - so resolved stays
  // (with Confirm / Reopen beside it) until it is closed out. Closed ones have
  // their own tab.
  // A ticket raised FOR someone else (Oct 1: the form's Requester field) is
  // listed for whoever filed it too, but confirming, rating, reopening and
  // editing stay with the person it is for - the server enforces the same.
  const mineToAct = (t) => (t.requesterId || '').toLowerCase() === (myEmail || '').toLowerCase();
  // Three lists (Neil, Oct 12 2026). Open Tickets is only what is FOR me; a
  // ticket I raised for someone else, or was added to as a watcher, is
  // something I follow, not something I own - it sits under Tickets I'm
  // Following (the server's ?mine=true sends all three kinds). Closed holds
  // both, so the history is in one place and Following stays current work.
  const open = (tickets || []).filter((t) => t.status !== 'closed' && mineToAct(t));
  const following = (tickets || []).filter((t) => t.status !== 'closed' && !mineToAct(t));
  const closed = (tickets || []).filter((t) => t.status === 'closed');
  const listed = listTab === 'closed' ? closed : listTab === 'following' ? following : open;
  // Every ticket the person it is FOR can see has an action: Mark Resolved
  // while it is still in flight (Neil, Oct 1), Confirm / Reopen once resolved.
  // A closed ticket has none: Reopen is only while it is Resolved (Oct 1).
  // Sized from the whole tab, not the page, so paging never moves a column.
  const actionsWidth = (rows) => {
    const act = rows.filter((t) => mineToAct(t) && t.status !== 'closed');
    return !act.length ? 0 : act.some((t) => t.status === 'resolved') ? ACTIONS_W_PAIR : ACTIONS_W_ONE;
  };
  const actionsW = actionsWidth(listed);
  // The tier budgets for the roomiest tab, so switching tabs never swaps the
  // column set (Closed Tickets just gives its elastic columns the room).
  const all = tickets || [];
  const anyGutter = all.some((t) => mineToAct(t) && (t.status === 'open' || isUnread(t)));
  const savedWidths = useTableValue(SUPPORT_TABLE, 'widths', null);
  const { tier, saved: useSaved } = pickTier(cardW, savedWidths || {}, (anyGutter ? GUTTER_W : 0) + actionsWidth(all));
  // Narrow and phone stack the comment and actions under the title.
  const stacked = tier === 'narrow' || tier === 'phone';
  const actionsCol = !stacked && actionsW ? `${actionsW}px` : '';
  const { cols, widths, template, startResize, resetWidth, autofitWidth, wrapRef } =
    useTableColumns({ table: SUPPORT_TABLE, cols: TIER_COLUMNS[tier], trailing: actionsCol });
  // Saved widths and the resize handles are a full-tier thing (see TIER_COLUMNS).
  const gridTemplate = useSaved ? template : [templateOf(cols), actionsCol].filter(Boolean).join(' ');
  const colKeys = useMemo(() => new Set(cols.map((c) => c.key)), [cols]);

  // Deep-link support - a ticket-update email or notification points here
  // (not the gated Tickets module, which a plain requester can't open) via
  // "?ticket=<id>" (backend/ticket_mail_templates.py's _ticket_url). Open
  // that ticket once on mount, then strip the param so a later refresh
  // doesn't reopen it. Same pattern TicketsView.jsx uses for its own copy of
  // this link, for the agent side.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tid = params.get('ticket');
    if (!tid) return;
    setViewingTicketId(tid);
    params.delete('ticket');
    const rest = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
  }, [setViewingTicketId]);

  // The in-app equivalent: the notification bell's "View ticket" navigates
  // here (instead of the gated Tickets module, for a recipient without desk
  // access) and then fires this - a mount-time query param alone can't reach
  // a Support page that's already mounted.
  useEffect(() => {
    const openTicket = async (e) => {
      // The sender also left a note for a page still loading; this page is
      // here and heard it, so the note goes - left behind it reopened the
      // ticket on the next visit, even after Cancel at the prompt below.
      takePendingOpen('ticket');
      const id = e.detail?.ticketId;
      if (!id || id === viewingIdRef.current) return;
      if (drawerDirtyRef.current && !(await confirmSwitchTicket())) return;
      setViewingTicketId(id);
    };
    window.addEventListener('nexus:open-ticket', openTicket);
    // Support isn't lazy(), but the view it's switched into might not be
    // mounted yet the instant the bell dispatches nexus:navigate - the same
    // gap TicketsView's copy of this handles by draining the note left behind.
    const pending = takePendingOpen('ticket');
    if (pending) setViewingTicketId(pending);
    return () => window.removeEventListener('nexus:open-ticket', openTicket);
  }, [setViewingTicketId]);

  // Guided tour - same pattern as the Task and Ticket modules' own (see
  // views/Tasks.jsx / tickets/TicketsView.jsx): runs itself once per person on
  // first visit, then again from the profile menu's "Tour" row (TopHeader,
  // gated on activeView === 'support'), which fires this same event. "Seen"
  // is server-side, per person - see routers/user_tours.py.
  const [tour, setTour] = useState(false);
  const onSubChangeRef = useRef(onSubChange);
  useEffect(() => { onSubChangeRef.current = onSubChange; });
  useEffect(() => {
    if (!myEmail) return;
    let cancelled = false;
    api.getToursSeen()
      .then(({ seen }) => { if (!cancelled && !seen?.[SUPPORT_TOUR_ID]) setTour(true); })
      .catch(() => { /* can't confirm "seen" - skip the auto-tour rather than risk nagging on every flaky load */ });
    return () => { cancelled = true; };
  }, [myEmail]);
  const closeTour = () => {
    setTour(false);
    api.markTourSeen(SUPPORT_TOUR_ID).catch(() => {});
  };
  useEffect(() => {
    // The tour spotlights Help Center cards, so it always runs on that tab.
    const openTour = () => { onSubChangeRef.current?.(null); setTour(true); };
    window.addEventListener('nexus:support-tour', openTour);
    const unTour = registerTour('support', 'Help Center', openTour);   // the Help panel's Take the Tour (lib/tours.js)
    return () => { window.removeEventListener('nexus:support-tour', openTour); unTour(); };
  }, []);

  // Only the newest request lands: a reload from closing the drawer and one
  // from a dialog's submit can come back out of order. A failed load keeps
  // whatever was last shown (or none) - never an empty list that reads as
  // "nothing open" - and says so, with Retry.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    api.getMyTickets()
      .then((rows) => { if (seq === loadSeq.current) { setTickets(rows || []); setError(''); } })
      .catch((e) => { if (seq === loadSeq.current) setError(e.message || 'Could not load your tickets.'); });
  }, []);

  useEffect(load, [load]);
  // A ticket created anywhere (the Help panel, Batch Create, the Tickets module).
  useEffect(() => {
    window.addEventListener('nexus:tickets-changed', load);
    return () => window.removeEventListener('nexus:tickets-changed', load);
  }, [load]);
  useEffect(() => setPage(1), [search]);

  // Neil, Oct 13 2026: "anything to do with support or learning is right
  // here". The Contact Directory moved to Team > Contact, the Property
  // Walkthrough became Submit a Ticket's Batch Create tab, and the
  // Implementation Guide is a section of Documentation.
  const OPTIONS = [
    { icon: Ticket, title: 'Submit a Ticket', desc: canWalk
      ? 'Report an issue or a bug, or request help from any department - one ticket or a whole batch.'
      : 'Report an issue or a bug, or request help from any department.',
      onOpen: () => setSubmitting(true), tour: 'support-submit-ticket' },
    // The help panel the header's "?" opens: search, ask a question, What's
    // New, help for this page (support/HelpMenu.jsx listens for the event).
    // Not "Help Center" any more - that is this page now (Neil, Oct 13 2026).
    { icon: CircleHelp, title: 'Assistant', desc: 'Search for help, ask a question, or see what is new in Nexus.',
      onOpen: () => window.dispatchEvent(new CustomEvent(HELP_OPEN_EVENT)) },
    // Privacy Policy and Terms & Conditions moved to Legal in the profile menu
    // (Neil, 10/06: "this has nothing to do with Support").
    { icon: BookOpen, title: 'Documentation', desc: canImplement
      ? 'How every Nexus module works, step by step - and the Implementation Guide for setting Nexus up.'
      : 'How every Nexus module works, step by step.',
      onOpen: () => setTab('documentation'), tour: 'support-documentation' },
    // The Knowledge Base left the left menu for here (Neil, Oct 13 2026:
    // "people aren't going to use SOPs unless they're having an issue").
    { icon: GraduationCap, title: 'Knowledge Base & Training', desc: 'SOPs, how-to articles and your assigned courses.',
      onOpen: () => go('sop'), waiting: tabCount(counts, 'support', 'kb') },
  ];

  // Mark Resolved: the requester's own optional-comment version - unless they
  // also work the ticket, who resolve it the desk's way (with a written
  // resolution). A manager's own ticket is theirs as a requester.
  const resolveMode = (t) => ((t.assigneeId || '').toLowerCase() === (myEmail || '').toLowerCase()
    ? 'resolve' : 'self_resolve');
  // Ticket number OR title - the two things someone actually remembers about
  // their own ticket. Matched against both the raw and normalized code so
  // "9", "000009" and "#000009" all find the same row.
  const q = search.trim().toLowerCase();
  const visible = !q ? listed : listed.filter((t) => {
    const code = ticketNoShort(t.code) || '';
    return code.toLowerCase().includes(q) || normalizeCode(t.code).includes(q)
      || (t.subject || '').toLowerCase().includes(q);
  });
  // The saved sort applies while its column is on screen. On a laptop or an
  // iPad the Created column is gone, so the default "newest first" would be
  // an order no header owns; the list sorts by Last Updated instead - the
  // date column that is always there - and its header shows it.
  const effSort = colKeys.has(sort.key) ? sort : { key: 'updated', dir: 'desc' };
  const sortCol = SUPPORT_TABLE_COLUMNS.find((c) => c.key === effSort.key);
  const sortCtx = { nameOf };
  const sorted = sortCol ? [...visible].sort((a, b) => {
    const av = sortCol.sort(a, sortCtx); const bv = sortCol.sort(b, sortCtx);
    const dir = effSort.dir === 'asc' ? 1 : -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  }) : visible;
  const pageCount = Math.max(1, Math.ceil(sorted.length / SUPPORT_PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const paged = sorted.slice((pageSafe - 1) * SUPPORT_PAGE_SIZE, pageSafe * SUPPORT_PAGE_SIZE);
  // The left gutter only exists while a row on this page has an unread dot or
  // an edit pencil to put in it, so the table otherwise starts flush left
  // under the tabs (Neil, Oct 19: "Open Tickets is not left justified").
  const needsGutter = paged.some((t) => mineToAct(t) && (t.status === 'open' || isUnread(t)));
  const gutterW = !needsGutter ? 0 : tier === 'phone' ? 24 : tier === 'narrow' ? 34 : GUTTER_W;
  // From what is SHOWN: clicking the header that reads as sorted flips it,
  // even when that sort was the fallback above rather than the saved one.
  const onSort = (key) => {
    setSort(effSort.key === key ? { key, dir: effSort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
    setPage(1);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <ModuleTabs tabs={SUPPORT_TABS} active="help" onChange={setTab} />

      {/* Documentation has its own back arrow in its toolbar (Oct 15 2026). */}
      {tab !== 'help' && tab !== 'documentation' && (
        <button type="button" onClick={() => setTab('help')}
          style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px 6px 8px', borderRadius: 8,
            border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginBottom: -8 }}>
          <ChevronLeft size={15} /> Back to Help Center
        </button>
      )}

      {tab === 'documentation' ? (
        <Suspense fallback={<SkeletonBlocks count={4} height={120} />}>
          <SupportDocs canImplement={canImplement} startOnGuide={onGuide} onBack={() => setTab('help')} />
        </Suspense>
      ) : (<>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Help Center</h2>
          <p>Get help across Nexus</p>
        </div>
      </div>

      <div className="support-grid" data-tour="support-options">
        {OPTIONS.map((o) => (
          // The whole tile is the button - anything less than a full-tile hit
          // area was just a smaller target that looked the same (Sagar, Sept 2
          // 2026). The "Open" label is gone (Neil, Sep 30: it "makes it seem
          // like you would have to click the open area"): a corner arrow and a
          // faint tint on hover (style.css) say the whole tile opens instead.
          <button key={o.title} type="button" className="support-card" data-tour={o.tour} onClick={o.onOpen}>
            <ArrowUpRight size={16} className="support-card-arrow" aria-hidden="true" />
            <div className="support-icon"><o.icon size={20} /></div>
            <div className="support-card-title">{o.title}
              {/* Sign-offs and training waiting on me (Oct 18). */}
              {o.waiting > 0 && <span className="hdr-tab-badge" style={{ marginLeft: 8 }} aria-label={`${o.waiting} waiting`}>{o.waiting}</span>}
            </div>
            <p className="support-card-desc">{o.desc}</p>
          </button>
        ))}
      </div>

      <div className="dash-card" data-tour="support-open-tickets" data-tier={tier} ref={cardRef}>
        {/* Flush left on every tab, empty or loading too, so the tabs never
            jump sideways (Neil, Oct 14) and sit left-justified (Neil, Oct 19). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          {/* Open and Closed (Neil, Sep 30: "now I don't have any history of
              the ticket that I had... I should be able to go through and
              reopen if the same issue happened again"). */}
          <div className="scroll-tabs" role="tablist" style={{ display: 'inline-flex', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, maxWidth: '100%', minWidth: 0 }}>
            {/* "Open Tickets" / "Closed Tickets" - no "My" (Neil, Oct 1): the
                page is already only yours. */}
            {[['open', 'Open Tickets', open.length], ['following', "Tickets I'm Following", following.length], ['closed', 'Closed Tickets', closed.length]].map(([k, lab, n]) => (
              <button key={k} type="button" role="tab" aria-selected={listTab === k} onClick={() => { setListTab(k); setPage(1); }}
                style={{
                  border: 'none', cursor: 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 700, padding: '6px 12px', borderRadius: 7,
                  background: listTab === k ? NX.surface : 'transparent', color: listTab === k ? NX.ink : NX.dim,
                  boxShadow: listTab === k ? '0 1px 2px rgba(0,0,0,0.08)' : 'none', whiteSpace: 'nowrap',
                }}>
                {lab}{tickets !== null && <span style={{ color: NX.faint, fontWeight: 600, marginLeft: 6 }}>{n}</span>}
                {/* A ticket waiting on my answer, or a reply I have not read (Oct 18). */}
                {k === 'open' && tabCount(counts, 'support', 'open') > 0 && <span className="nav-dot-inline" role="img" aria-label="Waiting on you" />}
              </button>
            ))}
          </div>
          {tickets !== null && listed.length > 0 && (
            <div style={{ position: 'relative', marginLeft: 'auto', flex: '0 1 220px', minWidth: 160, maxWidth: '100%' }}>
              <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
              <input type="text" className="form-input" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search ticket # or title…" style={{ width: '100%', paddingLeft: 28, fontSize: 13 }} />
            </div>
          )}
        </div>

        {error && (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', color: 'hsl(var(--color-red))', fontSize: 13, marginBottom: 10 }}>
            {error}
            <button type="button" className="secondary-btn" onClick={load} style={{ fontSize: 12, padding: '4px 10px' }}>
              <RotateCcw size={13} /> Retry
            </button>
          </div>
        )}

        {tickets === null && error ? null : tickets === null ? (
          <LoadingState compact label="Loading your tickets…" />
        ) : listed.length === 0 ? (
          // An empty state, not an empty table: a header row with nothing under
          // it reads as broken rather than as "nothing open".
          <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--muted)' }}>
            <Ticket size={26} style={{ opacity: 0.4, marginBottom: 10 }} />
            <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
              {listTab === 'open' ? 'Nothing open right now' : listTab === 'following' ? 'Not following any tickets' : 'No closed tickets yet'}
            </div>
            <p style={{ fontSize: '0.85rem', margin: '0 0 14px' }}>
              {listTab === 'open' ? 'Anything you submit shows up here with its status.'
                : listTab === 'following' ? 'A ticket you raise for someone else, or are added to, shows up here until it is closed.'
                : 'Tickets you confirm as resolved move here.'}
            </p>
            {listTab === 'open' && (
              <button className="primary-btn" onClick={() => setSubmitting(true)}>
                <Ticket size={15} /> Submit a Ticket
              </button>
            )}
          </div>
        ) : visible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--muted)', fontSize: 13 }}>
            No {listTab === 'following' ? 'followed' : listTab} tickets match "{search.trim()}".
          </div>
        ) : (
          <>
            {/* Same grid-list DNA as the Ticket module's own table (TicketsView
                TicketListHeader/TicketRow) - uppercase sortable headers, a
                solid status fill, one border per row, drag-to-resize handles.
                The unread dot and the edit pencil sit in a gutter OUTSIDE the
                table on the left (Neil, Sep 30), so they never push a column
                around; the row's actions are the table's own last column
                (Neil, 10/28/2026), or sit under the title when it stacks. */}
            {/* No scroll box (Neil, 10/28/2026): the tier only puts columns
                on screen that fit the card (pickTier). `clip`, not `auto`,
                so the last header's resize handle - it pokes 6px past the
                table's edge - can never turn into a scrollbar again. */}
            <div style={{ overflowX: 'clip' }}>
              <div style={{ display: 'grid', gridTemplateColumns: `${gutterW}px minmax(0,1fr)`, alignItems: 'stretch', fontFamily: FONT }}>
                <div />
                <div ref={wrapRef} style={{ '--nx-grid': gridTemplate, display: 'grid', gridTemplateColumns: 'var(--nx-grid)', minWidth: 0, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: '10px 10px 0 0' }}>
                  {cols.map((col, i) => {
                    const active = effSort.key === col.key;
                    const SortIcon = active ? (effSort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                    const lastCol = i === cols.length - 1 && !actionsCol;
                    return (
                      <div key={col.key} onClick={() => onSort(col.key)} title={`Sort by ${col.label}`}
                        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, minHeight: 34, padding: '0 10px', cursor: 'pointer', userSelect: 'none', borderRight: lastCol ? 'none' : `1px solid ${NX.border2}`, boxSizing: 'border-box', minWidth: 0 }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 700, color: NX.ink, textTransform: 'uppercase', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{col.label}</span>
                        <SortIcon size={11} style={{ flexShrink: 0, opacity: active ? 1 : 0.4 }} />
                        {tier === 'full' && <ColResizer onMouseDown={startResize(col.key, widths[col.key] ?? col.width)} onReset={() => resetWidth(col.key)} onAutofit={() => autofitWidth(col.key)} />}
                      </div>
                    );
                  })}
                  {actionsCol && (
                    <div style={{ display: 'flex', alignItems: 'center', minHeight: 34, padding: '0 10px', boxSizing: 'border-box', fontSize: 11, fontWeight: 700, color: NX.ink, textTransform: 'uppercase', letterSpacing: '0.04em', userSelect: 'none' }}>
                      Actions
                    </div>
                  )}
                </div>
                {paged.map((t, idx) => {
                  const last = idx === paged.length - 1;
                  const forOther = !mineToAct(t);
                  // The unread dot reads the REQUESTER's seen stamp, so it
                  // only means something on a ticket that is for me.
                  const unread = !forOther && isUnread(t);
                  const editable = t.status === 'open' && !forOther;
                  const actions = !forOther && t.status !== 'closed' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: stacked ? 'wrap' : 'nowrap' }}>
                      {t.status !== 'resolved' && (
                        <button type="button" onClick={(e) => { e.stopPropagation(); setAction({ mode: resolveMode(t), ticket: t }); }}
                          style={{ ...rowBtn, color: NX.green, borderColor: 'rgba(22,163,74,0.45)' }}>
                          <CheckCircle2 size={13} /> Mark Resolved
                        </button>
                      )}
                      {t.status === 'resolved' && (<>
                        <button type="button" onClick={(e) => { e.stopPropagation(); setAction({ mode: 'confirm', ticket: t }); }}
                          style={{ ...rowBtn, color: NX.green, borderColor: 'rgba(22,163,74,0.45)' }}>
                          <CheckCircle2 size={13} /> Confirm
                        </button>
                        <button type="button" onClick={(e) => { e.stopPropagation(); setAction({ mode: 'reopen', ticket: t }); }} style={rowBtn}>
                          <RotateCcw size={13} /> Reopen
                        </button>
                      </>)}
                    </div>
                  );
                  return (
                    <Fragment key={t.id}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, paddingRight: 6 }}>
                        {unread && (
                          <span title="Updated since you last opened it" aria-label="New update"
                            style={{ width: 8, height: 8, borderRadius: '50%', background: NX.blue, flexShrink: 0 }} />
                        )}
                        {editable && (
                          <button type="button" title="Edit ticket" aria-label={`Edit ${ticketNoShort(t.code) || 'ticket'}`}
                            onClick={() => setViewing({ id: t.id, edit: true })}
                            style={{ border: 'none', background: 'none', cursor: 'pointer', color: NX.dim, padding: 3, display: 'grid', placeItems: 'center', borderRadius: 6 }}>
                            <Pencil size={14} />
                          </button>
                        )}
                      </div>
                      {/* The whole row opens the ticket's real detail drawer
                          (Ticket module). role="button" + cursor:pointer since
                          a grid row isn't natively interactive. */}
                      <div role="button" tabIndex={0} aria-label={`Open ticket ${ticketNoShort(t.code) || ''} ${t.subject || ''}`.replace(/\s+/g, ' ').trim()} className={mineToAct(t) && !['resolved', 'closed'].includes(t.status) && (t.status === 'waiting_user' || isUnread(t)) ? 'nx-row-hover nx-needs-you--row' : 'nx-row-hover'} onClick={() => setViewing({ id: t.id })}
                        onKeyDown={(e) => {
                          // Only the row's OWN keys: Enter on a button inside
                          // it (Mark Resolved, Confirm, Reopen, the latest
                          // comment) belongs to that button.
                          if (e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewing({ id: t.id }); }
                        }}
                        style={{
                          display: 'grid', gridTemplateColumns: 'var(--nx-grid)', '--nx-grid': gridTemplate,
                          background: idx % 2 ? NX.zebra : NX.surface, cursor: 'pointer',
                          borderLeft: `1px solid ${NX.border}`, borderRight: `1px solid ${NX.border}`,
                          borderBottom: `1px solid ${last ? NX.border : NX.border2}`,
                          borderRadius: last ? '0 0 10px 10px' : 0,
                        }}>
                        <div style={{ ...cellBase, fontWeight: 700, fontSize: 13, color: NX.ink, borderRight: `1px solid ${NX.border2}` }}>
                          {ticketNoShort(t.code) || '-'}
                        </div>
                        <div style={{ ...cellBase, fontSize: 13, color: NX.ink, fontWeight: unread ? 700 : 400, overflow: 'hidden', borderRight: `1px solid ${NX.border2}` }}>
                          <div style={{ minWidth: 0 }}>
                            {/* Up to two lines, then an ellipsis - a title that
                                needs more than that is read in the drawer. */}
                            <span className="nx-clamp-2" style={{ lineHeight: 1.35, overflowWrap: 'anywhere' }}>{t.subject}</span>
                            {forOther && (
                              <div title={(t.createdById || '').toLowerCase() === (myEmail || '').toLowerCase() ? 'You raised this on their behalf' : 'You are following this ticket'}
                                style={{ fontSize: 11.5, fontWeight: 600, color: NX.dim, marginTop: 2 }}>
                                For {nameOf(t.requesterId) || t.requesterId}
                              </div>
                            )}
                            {stacked && (
                              /* Narrow: the comment and the actions live here
                                 instead of in columns of their own. */
                              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                                {tier === 'phone' && lastUpdated(t) && (
                                  <span style={{ fontSize: 11.5, color: NX.faint, fontWeight: unread ? 700 : 500 }}>
                                    Updated {formatDate(lastUpdated(t))}, {formatTime(lastUpdated(t))}
                                  </span>
                                )}
                                {t.latestComment && (
                                  <LatestCommentPreview comment={t.latestComment} nameOf={nameOf} stacked
                                    onOpen={() => setViewing({ id: t.id, tab: 'conversation' })} />
                                )}
                                {actions}
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={{ minHeight: ROW_MIN_H, minWidth: 0, borderRight: tier === 'phone' ? 'none' : `1px solid ${NX.border2}` }}>
                          <StatusCell status={t.status} />
                        </div>
                        {colKeys.has('assignedTo') && (
                          <div style={{ ...cellBase, gap: 6, fontSize: 13, color: NX.dim, overflow: 'hidden', borderRight: `1px solid ${NX.border2}` }}>
                            {t.assigneeId
                              ? <><Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={22} /><span className="nx-clamp-2" style={{ lineHeight: 1.3, overflowWrap: 'anywhere' }}>{nameOf(t.assigneeId) || t.assigneeId}</span></>
                              : <span style={{ color: NX.faint }}>Unassigned</span>}
                          </div>
                        )}
                        {colKeys.has('created') && (
                          <div style={{ ...cellBase, borderRight: `1px solid ${NX.border2}` }}>
                            <DateTimeStack value={t.createdAt} />
                          </div>
                        )}
                        {colKeys.has('updated') && (
                          <div style={{ ...cellBase, borderRight: colKeys.has('latestComment') ? `1px solid ${NX.border2}` : 'none' }}>
                            <DateTimeStack value={lastUpdated(t)} strong={unread} />
                          </div>
                        )}
                        {colKeys.has('latestComment') && (
                          <div style={{ ...cellBase, overflow: 'hidden', borderRight: actionsCol ? `1px solid ${NX.border2}` : 'none' }}>
                            <LatestCommentPreview comment={t.latestComment} nameOf={nameOf} stacked
                              onOpen={() => setViewing({ id: t.id, tab: 'conversation' })} />
                          </div>
                        )}
                        {/* The Actions column - empty on a row with nothing to
                            do (a ticket that is someone else's). */}
                        {actionsCol && <div style={cellBase}>{actions}</div>}
                      </div>
                    </Fragment>
                  );
                })}
              </div>
            </div>

            {sorted.length > SUPPORT_PAGE_SIZE && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 10, fontFamily: FONT }}>
                <span style={{ fontSize: 12, color: NX.dim }}>
                  {(pageSafe - 1) * SUPPORT_PAGE_SIZE + 1}-{Math.min(pageSafe * SUPPORT_PAGE_SIZE, sorted.length)} of {sorted.length}
                </span>
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pageSafe <= 1}
                  style={{ display: 'flex', alignItems: 'center', border: `1px solid ${NX.border}`, borderRadius: 7, background: NX.surface, padding: '5px 8px', cursor: pageSafe <= 1 ? 'default' : 'pointer', opacity: pageSafe <= 1 ? 0.4 : 1 }}>
                  <ChevronLeft size={14} />
                </button>
                <span style={{ fontSize: 12, color: NX.ink, fontWeight: 600 }}>Page {pageSafe} of {pageCount}</span>
                <button type="button" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={pageSafe >= pageCount}
                  style={{ display: 'flex', alignItems: 'center', border: `1px solid ${NX.border}`, borderRadius: 7, background: NX.surface, padding: '5px 8px', cursor: pageSafe >= pageCount ? 'default' : 'pointer', opacity: pageSafe >= pageCount ? 0.4 : 1 }}>
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
      </>)}

      {submitting && (
        <Suspense fallback={<ModalLoading />}>
          {/* CreateTicketModal calls onClose after a successful create too, so
              reloading here covers both "submitted" and "cancelled". */}
          <TicketComposer onClose={() => { setSubmitting(false); load(); }}
            onBatch={canWalk ? () => { setSubmitting(false); setWalking(true); } : undefined} />
        </Suspense>
      )}

      {walking && (
        <Suspense fallback={<ModalLoading />}>
          <WalkthroughComposer onClose={() => { setWalking(false); load(); }}
            onSingle={() => { setWalking(false); setSubmitting(true); }} />
        </Suspense>
      )}

      {viewing && (
        <Suspense fallback={<ModalLoading />}>
          {/* Reload on close too - the drawer can change the ticket (within
              the requester's own edit access) and marks it seen, and the
              table above should reflect both without a manual refresh. */}
          <TicketDetail key={viewing.n} ticketId={viewing.id} startEditing={!!viewing.edit} initialTab={viewing.tab || null}
            dirtyRef={drawerDirtyRef} onClose={() => { setViewing(null); load(); }} />
        </Suspense>
      )}

      {action && (
        <Suspense fallback={<ModalLoading />}>
          <ActionDialog mode={action.mode} ticket={action.ticket}
            onSubmit={(p) => api.updateTaskTicket(action.ticket.id, toTicketBody(p)).then(load)}
            onClose={() => setAction(null)} />
        </Suspense>
      )}

      {tour && tab === 'help' && <GuidedTour steps={buildSupportTourSteps()} onClose={closeTour} />}
    </div>
  );
}
