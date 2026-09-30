// Support - the end-user face of the Ticket module.
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
import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
// Ticket is the Ticket module's own icon (Sidebar, TicketsView) - the card
// that opens its create form should wear it, not a generic document.
import {
  Ticket, Users, ArrowUpRight, Shield, FileSignature, Bug, Search,
  ArrowUp, ArrowDown, ArrowUpDown, ChevronLeft, ChevronRight, LifeBuoy, BookOpen,
  Pencil, CheckCircle2, RotateCcw,
} from 'lucide-react';
import { api } from '../api';
import { ticketNoShort, normalizeCode, TICKET_STATUS_META, TICKET_STATUS_ORDER } from '../tickets/ticketMeta';
import { formatDateTime } from '../lib/datetime';
import { NX, FONT } from '../tasks/theme';
import { useRole } from '../contexts/RoleContext';
import { Avatar, usePeople } from '../tasks/components';
import { useTableColumns, ColResizer } from '../tasks/tableCols';
import { takePendingOpen } from '../lib/pendingOpen';
import GuidedTour from '../components/GuidedTour';
import ModuleTabs from '../components/ModuleTabs';
import { SkeletonBlocks, ModalLoading, LoadingState } from '../components/AsyncState';
import { buildSupportTourSteps } from './supportTourSteps';

// Documentation tab (Sep 24): the written guide to every module. Lazy so its
// content and drawn screenshots only load when someone opens the tab.
const SupportDocs = lazy(() => import('../support/SupportDocs'));

// 'help' is the page as it always was; 'documentation' is the module guide.
// URL: /support (help) or /support/documentation.
const SUPPORT_TABS = [
  { key: 'help', label: 'Help Center', Icon: LifeBuoy },
  { key: 'documentation', label: 'Documentation', Icon: BookOpen },
];

// Tour id this page reports to the server (routers/user_tours.py) - same
// pattern as the Task and Ticket modules' own TASK_TOUR_ID/TICKET_TOUR_ID.
const SUPPORT_TOUR_ID = 'support';

// Report a Bug used to float as its own button, hovering bottom-right over
// every Tasks/Tickets screen. Folded into Support (Pranshu, Sep 3) since it's
// a help action like everything else on this page, not a persistent overlay.
// Same trick as TicketComposer below: mount the Tasks module's own modal
// (it needs TasksProvider for createTicket) instead of building a second form.
const BugComposer = lazy(async () => {
  const [{ TasksProvider }, { ReportBugModal }] = await Promise.all([
    import('../tasks/TasksContext'),
    import('../tasks/ReportBug'),
  ]);
  return {
    default: ({ onClose }) => (
      <TasksProvider><ReportBugModal onClose={onClose} /></TasksProvider>
    ),
  };
});

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
    default: ({ onClose }) => (
      <TasksProvider><CreateTicketModal onClose={onClose} /></TasksProvider>
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
const TicketDetail = lazy(async () => {
  const [{ TasksProvider }, { TicketDrawer }] = await Promise.all([
    import('../tasks/TasksContext'),
    import('../tickets/TicketsView'),
  ]);
  return {
    default: ({ ticketId, onClose, startEditing }) => (
      <TasksProvider><TicketDrawer ticketId={ticketId} onClose={onClose} startEditing={startEditing} /></TasksProvider>
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

// Same solid, edge-to-edge status cell the Ticket module's own list uses
// (TicketsView's SolidCellPair) - filled with the status color rather than a
// small outlined pill, so this table reads as the same UI, not a lookalike.
function StatusCell({ status }) {
  const m = TICKET_STATUS_META[status] || { label: status, color: NX.dim };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
      padding: '0 10px', background: m.color, color: '#fff', fontSize: 12, fontWeight: 700,
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: FONT,
    }}>{m.label}</div>
  );
}

// Ten rows the Ticket module's own list would sort exactly this way for -
// State by its workflow order, everything else by value.
const SUPPORT_TABLE_COLUMNS = [
  { key: 'ticket', label: 'Ticket No', width: 110, sort: (t) => ticketNoShort(t.code) || '' },
  { key: 'title', label: 'Title', width: 320, sort: (t) => (t.subject || '').toLowerCase() },
  { key: 'status', label: 'Status', width: 140, sort: (t) => TICKET_STATUS_ORDER.indexOf(t.status) },
  { key: 'assignedTo', label: 'Assigned To', width: 160, sort: (t, ctx) => (ctx.nameOf(t.assigneeId) || '').toLowerCase() },
  { key: 'created', label: 'Created Date', width: 150, sort: (t) => t.createdAt || '' },
  // Neil, Sep 30: "when was the last update" - any change or reply.
  { key: 'updated', label: 'Last Updated', width: 150, sort: (t) => lastUpdated(t) },
];

// The later of the ticket's own modified time and a reply by the team - so a
// comment moves it even on a ticket saved before comments stamped modified_at.
function lastUpdated(t) {
  const a = t.modifiedAt || t.createdAt || '';
  const b = t.requesterUpdateAt || '';
  return b > a ? b : a;
}
// Changed by someone else since the requester last opened it.
const isUnread = (t) => !!t.requesterUpdateAt && t.requesterUpdateAt > (t.requesterSeenAt || '');
const GUTTER_W = 46;
const rowBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px', fontSize: 12, fontWeight: 600,
  border: `1px solid ${NX.border}`, borderRadius: 7, background: NX.surface, color: NX.ink, cursor: 'pointer',
  fontFamily: FONT, whiteSpace: 'nowrap',
};
const SUPPORT_PAGE_SIZE = 10;

export default function Support({ activeSub, onSubChange }) {
  const tab = activeSub === 'documentation' ? 'documentation' : 'help';
  const setTab = (key) => onSubChange?.(key === 'help' ? null : key);
  const [submitting, setSubmitting] = useState(false);
  const [reportingBug, setReportingBug] = useState(false);
  // { id, edit } - `edit` opens the drawer straight into its editor (the pencil).
  const [viewing, setViewing] = useState(null);
  const setViewingTicketId = useCallback((id) => setViewing(id ? { id } : null), []);
  const [listTab, setListTab] = useState('open');   // 'open' | 'closed'
  const [action, setAction] = useState(null);       // { mode: 'confirm' | 'reopen', ticket }
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
  const { cols, widths, template, startResize, resetWidth, autofitWidth, wrapRef } =
    useTableColumns({ table: 'support-open-tickets', cols: SUPPORT_TABLE_COLUMNS });

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
    const openTicket = (e) => { const id = e.detail?.ticketId; if (id) setViewingTicketId(id); };
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
    return () => window.removeEventListener('nexus:support-tour', openTour);
  }, []);

  const load = useCallback(() => {
    api.getMyTickets()
      .then((rows) => setTickets(rows || []))
      .catch((e) => { setTickets([]); setError(e.message || 'Could not load your tickets.'); });
  }, []);

  useEffect(load, [load]);
  useEffect(() => setPage(1), [search]);

  const OPTIONS = [
    { icon: Ticket, title: 'Submit a Ticket', desc: 'Report an issue or request help from any department.',
      onOpen: () => setSubmitting(true), tour: 'support-submit-ticket' },
    { icon: Bug, title: 'Report a Bug', desc: 'Flag something broken in Nexus, with screenshots if you have them.',
      onOpen: () => setReportingBug(true), tour: 'support-report-bug' },
    { icon: Users, title: 'Contact Directory', desc: 'Find the right person across your organization.',
      onOpen: () => go('people') },
    // Folded in from their own left-nav entries (Aug 31) to shrink the nav -
    // both still resolve as ordinary views (App.jsx), just opened from here.
    { icon: Shield, title: 'Privacy Policy', desc: 'What Nexus collects, why, and who can see it.',
      onOpen: () => go('privacy-policy') },
    { icon: FileSignature, title: 'Terms & Conditions', desc: 'The terms that govern your use of Nexus.',
      onOpen: () => go('terms-conditions') },
    { icon: BookOpen, title: 'Documentation', desc: 'How every Nexus module works, step by step.',
      onOpen: () => setTab('documentation'), tour: 'support-documentation' },
  ];

  // Closed tickets are not what "My Open Tickets" means, but a requester whose
  // ticket was just resolved should still see that it was - so resolved stays
  // (with Confirm / Reopen beside it) until it is closed out. Closed ones have
  // their own tab.
  const open = (tickets || []).filter((t) => t.status !== 'closed');
  const closed = (tickets || []).filter((t) => t.status === 'closed');
  const listed = listTab === 'closed' ? closed : open;
  const hasActions = listed.some((t) => t.status === 'resolved' || t.status === 'closed');
  // Ticket number OR title - the two things someone actually remembers about
  // their own ticket. Matched against both the raw and normalized code so
  // "9", "000009" and "#000009" all find the same row.
  const q = search.trim().toLowerCase();
  const visible = !q ? listed : listed.filter((t) => {
    const code = ticketNoShort(t.code) || '';
    return code.toLowerCase().includes(q) || normalizeCode(t.code).includes(q)
      || (t.subject || '').toLowerCase().includes(q);
  });
  const sortCol = SUPPORT_TABLE_COLUMNS.find((c) => c.key === sort.key);
  const sortCtx = { nameOf };
  const sorted = sortCol ? [...visible].sort((a, b) => {
    const av = sortCol.sort(a, sortCtx); const bv = sortCol.sort(b, sortCtx);
    const dir = sort.dir === 'asc' ? 1 : -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  }) : visible;
  const pageCount = Math.max(1, Math.ceil(sorted.length / SUPPORT_PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const paged = sorted.slice((pageSafe - 1) * SUPPORT_PAGE_SIZE, pageSafe * SUPPORT_PAGE_SIZE);
  const onSort = (key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
    setPage(1);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <ModuleTabs tabs={SUPPORT_TABS} active={tab} onChange={setTab} />

      {tab === 'documentation' ? (
        <Suspense fallback={<SkeletonBlocks count={4} height={120} />}>
          <SupportDocs />
        </Suspense>
      ) : (<>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Support</h2>
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
            <div className="support-card-title">{o.title}</div>
            <p className="support-card-desc">{o.desc}</p>
          </button>
        ))}
      </div>

      <div className="dash-card" data-tour="support-open-tickets">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          {/* Open and Closed (Neil, Sep 30: "now I don't have any history of
              the ticket that I had... I should be able to go through and
              reopen if the same issue happened again"). */}
          <div className="scroll-tabs" role="tablist" style={{ display: 'inline-flex', gap: 2, background: NX.border2, borderRadius: 9, padding: 2 }}>
            {[['open', 'My Open Tickets', open.length], ['closed', 'My Closed Tickets', closed.length]].map(([k, lab, n]) => (
              <button key={k} type="button" role="tab" aria-selected={listTab === k} onClick={() => { setListTab(k); setPage(1); }}
                style={{
                  border: 'none', cursor: 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 700, padding: '6px 12px', borderRadius: 7,
                  background: listTab === k ? NX.surface : 'transparent', color: listTab === k ? NX.ink : NX.dim,
                  boxShadow: listTab === k ? '0 1px 2px rgba(0,0,0,0.08)' : 'none', whiteSpace: 'nowrap',
                }}>
                {lab}{tickets !== null && <span style={{ color: NX.faint, fontWeight: 600, marginLeft: 6 }}>{n}</span>}
              </button>
            ))}
          </div>
          {tickets !== null && listed.length > 0 && (
            <div style={{ position: 'relative', marginLeft: 'auto', width: 220, maxWidth: '100%' }}>
              <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
              <input type="text" className="form-input" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search ticket # or title…" style={{ width: '100%', paddingLeft: 28, fontSize: 13 }} />
            </div>
          )}
        </div>

        {error && <div style={{ color: 'hsl(var(--color-red))', fontSize: 13, marginBottom: 10 }}>{error}</div>}

        {tickets === null ? (
          <LoadingState compact label="Loading your tickets…" />
        ) : listed.length === 0 ? (
          // An empty state, not an empty table: a header row with nothing under
          // it reads as broken rather than as "nothing open".
          <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--muted)' }}>
            <Ticket size={26} style={{ opacity: 0.4, marginBottom: 10 }} />
            <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
              {listTab === 'open' ? 'Nothing open right now' : 'No closed tickets yet'}
            </div>
            <p style={{ fontSize: '0.85rem', margin: '0 0 14px' }}>
              {listTab === 'open' ? 'Anything you submit shows up here with its status.' : 'Tickets you confirm as resolved move here, and you can reopen them.'}
            </p>
            {listTab === 'open' && (
              <button className="primary-btn" onClick={() => setSubmitting(true)}>
                <Ticket size={15} /> Submit a Ticket
              </button>
            )}
          </div>
        ) : visible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--muted)', fontSize: 13 }}>
            No {listTab} tickets match "{search.trim()}".
          </div>
        ) : (
          <>
            {/* Same grid-list DNA as the Ticket module's own table (TicketsView
                TicketListHeader/TicketRow) - uppercase sortable headers, a
                solid status fill, one border per row, drag-to-resize handles.
                Two gutters sit OUTSIDE the table (Neil, Sep 30): on the left
                the unread dot and the edit pencil, on the right the Confirm /
                Reopen actions - so each is in the same place on every row and
                never pushes a column around. */}
            <div style={{ overflowX: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: `${GUTTER_W}px max-content ${hasActions ? 'max-content' : '0px'}`, alignItems: 'stretch', fontFamily: FONT, minWidth: 'fit-content' }}>
                <div />
                <div ref={wrapRef} style={{ '--nx-grid': template, display: 'grid', gridTemplateColumns: 'var(--nx-grid)', background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: '10px 10px 0 0' }}>
                  {cols.map((col) => {
                    const active = sort.key === col.key;
                    const SortIcon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                    return (
                      <div key={col.key} onClick={() => onSort(col.key)} title={`Sort by ${col.label}`}
                        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, minHeight: 34, padding: '0 10px', cursor: 'pointer', userSelect: 'none', borderRight: `1px solid ${NX.border2}`, boxSizing: 'border-box' }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 700, color: NX.ink, textTransform: 'uppercase', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{col.label}</span>
                        <SortIcon size={11} style={{ flexShrink: 0, opacity: active ? 1 : 0.4 }} />
                        <ColResizer onMouseDown={startResize(col.key, widths[col.key] ?? col.width)} onReset={() => resetWidth(col.key)} onAutofit={() => autofitWidth(col.key)} />
                      </div>
                    );
                  })}
                </div>
                <div />
                {paged.map((t, idx) => {
                  const last = idx === paged.length - 1;
                  const unread = isUnread(t);
                  const editable = t.status === 'open';
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
                      <div role="button" tabIndex={0} onClick={() => setViewing({ id: t.id })}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewing({ id: t.id }); } }}
                        style={{
                          display: 'grid', gridTemplateColumns: 'var(--nx-grid)', '--nx-grid': template,
                          background: idx % 2 ? NX.zebra : NX.surface, cursor: 'pointer',
                          borderLeft: `1px solid ${NX.border}`, borderRight: `1px solid ${NX.border}`,
                          borderBottom: `1px solid ${last ? NX.border : NX.border2}`,
                          borderRadius: last ? '0 0 10px 10px' : 0,
                        }}>
                        <div style={{ display: 'flex', alignItems: 'center', minHeight: 40, padding: '0 10px', fontWeight: 700, fontSize: 13, color: NX.ink, borderRight: `1px solid ${NX.border2}` }}>
                          {ticketNoShort(t.code) || '-'}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', minHeight: 40, padding: '0 10px', fontSize: 13, color: NX.ink, fontWeight: unread ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRight: `1px solid ${NX.border2}` }}>
                          {t.subject}
                        </div>
                        <div style={{ minHeight: 40, borderRight: `1px solid ${NX.border2}` }}>
                          <StatusCell status={t.status} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 40, padding: '0 10px', fontSize: 13, color: NX.dim, overflow: 'hidden', borderRight: `1px solid ${NX.border2}` }}>
                          {t.assigneeId
                            ? <><Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={20} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(t.assigneeId) || t.assigneeId}</span></>
                            : <span style={{ color: NX.faint }}>Unassigned</span>}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', minHeight: 40, padding: '0 10px', fontSize: 12, color: NX.dim, borderRight: `1px solid ${NX.border2}` }}>
                          {formatDateTime(t.createdAt)}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', minHeight: 40, padding: '0 10px', fontSize: 12, color: unread ? NX.ink : NX.dim, fontWeight: unread ? 700 : 400 }}>
                          {formatDateTime(lastUpdated(t))}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: hasActions ? 10 : 0 }}>
                        {t.status === 'resolved' && (<>
                          <button type="button" onClick={() => setAction({ mode: 'confirm', ticket: t })}
                            style={{ ...rowBtn, color: NX.green, borderColor: 'rgba(22,163,74,0.45)' }}>
                            <CheckCircle2 size={13} /> Confirm
                          </button>
                          <button type="button" onClick={() => setAction({ mode: 'reopen', ticket: t })} style={rowBtn}>
                            <RotateCcw size={13} /> Reopen
                          </button>
                        </>)}
                        {t.status === 'closed' && (
                          <button type="button" onClick={() => setAction({ mode: 'reopen', ticket: t })} style={rowBtn}>
                            <RotateCcw size={13} /> Reopen
                          </button>
                        )}
                      </div>
                    </Fragment>
                  );
                })}
              </div>
            </div>

            {sorted.length > SUPPORT_PAGE_SIZE && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 10, fontFamily: FONT }}>
                <span style={{ fontSize: 12, color: NX.dim }}>
                  {(pageSafe - 1) * SUPPORT_PAGE_SIZE + 1}–{Math.min(pageSafe * SUPPORT_PAGE_SIZE, sorted.length)} of {sorted.length}
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
          <TicketComposer onClose={() => { setSubmitting(false); load(); }} />
        </Suspense>
      )}

      {reportingBug && (
        <Suspense fallback={<ModalLoading />}>
          <BugComposer onClose={() => setReportingBug(false)} />
        </Suspense>
      )}

      {viewing && (
        <Suspense fallback={<ModalLoading />}>
          {/* Reload on close too - the drawer can change the ticket (within
              the requester's own edit access) and marks it seen, and the
              table above should reflect both without a manual refresh. */}
          <TicketDetail ticketId={viewing.id} startEditing={!!viewing.edit} onClose={() => { setViewing(null); load(); }} />
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
