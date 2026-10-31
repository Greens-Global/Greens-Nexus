// Ticket Module - the support/IT request list.
//
// Split out of the task module (Jul 2026, "Option A"): the ticket files live
// here, but ticket state is still held in TasksContext and the shared UI atoms
// and theme still come from ../tasks - so the task module itself is untouched.
// Ticket statuses get their own color map here (STATUS_META in tasks/theme.js
// is for tasks, not tickets). Inline-styled to match the rest of the app.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, Trash2, CheckCircle2, X, List as ListIcon, Columns3, BarChart3 } from 'lucide-react';
import TicketToken from '../components/icons/TicketToken';
import { api } from '../api';
import { useTasks } from '../tasks/TasksContext';
import { useRole } from '../contexts/RoleContext';
import { takePendingOpen } from '../lib/pendingOpen';
import { peekDraft } from './recordingDraft';
import { NX, FONT, btn, input as inputStyle, PRIORITY_META } from '../tasks/theme';
import { EmptyState, usePeople, useIsMobile, useEscapeLayer } from '../tasks/components';
import { dialog as appDialog } from '../ui/dialog';
import MobileTaskBar from '../tasks/MobileTaskBar';
import { useTableColumns, useTableValue } from '../tasks/tableCols';
import { useListKeys } from './useListKeys';
import {
  TICKET_TYPE_META,
  TICKET_STATUS_META, CLOSED_STATES,
  slaState,
  ticketNoShort, normalizeCode,
  serviceAreaLabel,
} from './ticketMeta';
// The help topic's optional "Which one?" level (Neil, Oct 1 2026).
import { helpWithLabel } from './ticketMeta';
import { useTicketConfig } from './ticketConfig';
import { TicketSelect } from './TicketAtoms';
import GuidedTour from '../components/GuidedTour';
import { buildTicketTourSteps } from './ticketTourSteps';
import { confirmSwitchTicket } from './drawerGuard';
import { SuggestPropertyLinksButton } from './TicketPropertyFields';
import ModuleTabs from '../components/ModuleTabs';
import {
  QUEUES, DEFAULT_QUEUE, queueMatches, queueCounts, queueDefaultSort, queueFromLegacyScope, queueFromFilterEvent,
} from './queues';
import { useTicketAccess } from './ticketAccess';
import { registerTour } from '../lib/tours';
import TicketReports from './TicketReports';
import {
  TICKET_COLUMNS,
  statusOptions, priorityOptions,
  ticketRights,
  needsResolution,
} from './ticketViewShared';
import { downloadTicketsCsv } from './ticketExport';
import {
  TicketMobileFilters, TicketFilterMenu, MoreMenu, SaveViewDialog,
} from './TicketFilters';
import { TicketListHeader, TicketRow } from './TicketList';
import { TicketActionDialog } from './TicketActionDialog';
import { CreateTicketModal } from './CreateTicketModal';
import { TicketDrawer } from './TicketDrawer';
import { TicketBoard } from './TicketBoard';

// Re-exported: tests and other modules import these from TicketsView.
export { TicketActionDialog, CreateTicketModal, TicketDrawer };

// Tour id this module reports to the server (routers/user_tours.py) - see
// the Task module's identical TASK_TOUR_ID in views/Tasks.jsx.
const TICKET_TOUR_ID = 'ticket';

// Views offered by the mobile bar's view sheet (desktop uses the inline switcher).
const TICKET_VIEW_TABS = [
  { key: 'list', label: 'List', icon: ListIcon },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
];

// The desk's two layouts (Neil, 10/31/2026), kept per person in the profile
// with the list's column arrangement: 'modal' opens a row as the popup;
// 'pane' opens it beside the list, which drops to the columns that still
// matter at half width. Desktop and the List view only - phones, the Board
// and Reports never see the pane.
const LAYOUTS = ['modal', 'pane'];
const PANE_COLS = ['checkbox', 'type', 'title', 'state', 'clock'];
// Tabs whose count is a tally, not work waiting on you - no pill.
const UNCOUNTED = new Set(['done', 'open', 'raised']);

// What an empty queue says - not "no tickets match your filters", which is
// for a filter someone set. Title Case titles, sentence-case hints.
const QUEUE_EMPTY = {
  needs_reply: { title: 'All Caught Up', hint: 'Nothing is waiting on a reply from the desk.' },
  unassigned: { title: 'Everything Has an Owner', hint: 'Every live ticket is assigned to someone.' },
  mine: { title: 'Nothing Assigned to You', hint: 'Tickets assigned to you will show up here.' },
  due_soon: { title: 'Nothing Due Soon', hint: 'Nothing is overdue or about to be.' },
  waiting: { title: 'Nothing Parked', hint: 'No ticket is waiting on a user, a vendor or a hold.' },
  open: { title: 'No Open Tickets', hint: 'Everything has been resolved or closed.' },
  done: { title: 'Nothing Finished Yet', hint: 'Resolved and closed tickets land here.' },
  route: { title: 'Nothing to Route', hint: 'No gated request is waiting for an approver.' },
  approve: { title: 'Nothing to Approve', hint: 'No request is parked on your decision.' },
  raised: { title: 'No Tickets Raised', hint: 'Tickets you raise will show up here.' },
};

export default function TicketsView() {
  // Applies any admin-saved SLA-hours / intake-field overrides (Sep 2026,
  // ticketConfig.js) on top of ticketMeta.js's compiled-in defaults, and
  // re-renders once they land - see that file for why a mutate-in-place +
  // event pattern instead of turning these constants into fetched state.
  useTicketConfig();
  const { tickets, ticketViews = [], createTicketView, deleteTicketView,
    myEmail, nameOf, updateTicket, deleteTicket } = useTasks();
  const people = usePeople();
  // For the list's own inline State/Priority dropdown (TicketRow) - mirrors
  // the drawer's canWorking gate exactly, see inlineCanWorking below.
  const { myLevel } = useRole();
  // Desk membership comes from the server, not from holding administrator: the
  // roster is configured in Manage, and an agent need not be an admin at all.
  // Admins stay true so a mis-configured desk can always be fixed. Optimistic
  // false while it loads - the queues appear a beat later rather than flashing
  // for someone who should not see them. The backend re-checks every action.
  const [itAdmin, setItAdmin] = useState(false);
  // Bulk Delete is a supervisor's (ticket_roles.can_delete on the server).
  const { canDelete: canBulkDelete, privileged: deskPrivileged } = useTicketAccess();
  // Manager+ or a Global Admin (server's _ticket_privileged).
  const privileged = myLevel >= 3 || deskPrivileged;
  useEffect(() => {
    let alive = true;
    // onDesk, not canAct: the queues are shown to the people whose work they
    // are. An administrator who was not picked in Manage can still act on a
    // ticket, but "To Route" is not their inbox - and they are not notified
    // about those tickets either, so showing them the queue would contradict
    // their own bell.
    api.getMyTicketAccess()
      .then((r) => { if (alive) setItAdmin(!!r?.onDesk); })
      .catch(() => { if (alive) setItAdmin(false); });
    return () => { alive = false; };
  }, []);
  const isMobile = useIsMobile();
  // HR departments carry the triage lead/backup; used for the department
  // filter. Loaded here rather than in context - tickets are the only
  // consumer today.
  const [hrDepts, setHrDepts] = useState([]);
  useEffect(() => { api.getTicketDepartments().then(setHrDepts).catch(() => setHrDepts([])); }, []);
  // Companies - same lookup pattern as hrDepts, for the Company column/export.
  const [companies, setCompanies] = useState([]);
  useEffect(() => { api.getTicketCompanies().then(setCompanies).catch(() => setCompanies([])); }, []);
  const companyName = useCallback((id) => companies.find((c) => c.id === id)?.name || '', [companies]);
  const hrDeptName = useCallback((id) => hrDepts.find((d) => d.id === id)?.name || '', [hrDepts]);
  // The desk's work queues (Neil, 10/31/2026, tickets/queues.js): the tabs in
  // the bar, each a filter preset counted over the WHOLE workspace, so a tab's
  // number is what the desk owes rather than what the filters happen to show.
  // `queue` replaced the old scope (All / My Requests / Assigned to Me) and the
  // five summary tiles that sat above the list. To Route (the desk's unrouted
  // approvals) and To Approve (parked on me) only show with something in them.
  // The context's clock ticks once a minute, so a ticket that crosses into
  // its at-risk window while the desk sits on the page is counted in Due
  // Soon without a refetch (a reload recounts against the last tick).
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClockNow(Date.now()), 60 * 1000);
    return () => clearInterval(id);
  }, []);
  const qctx = useMemo(() => ({ me: (myEmail || '').toLowerCase(), onDesk: itAdmin, now: clockNow }), [myEmail, itAdmin, clockNow]);
  const counts = useMemo(() => queueCounts(tickets, qctx), [tickets, qctx]);
  const [queue, setQueue] = useState(DEFAULT_QUEUE);
  // The saved view whose tab is lit, while the list shows it.
  const [activeSaved, setActiveSaved] = useState(null);
  // Column sort - click a header to sort by it, click again to flip direction.
  // A queue opens in its own order (urgency for Needs Reply and Due Soon, else
  // Updated, newest first); a header click overrides it until the next queue.
  const [sort, setSort] = useState(() => queueDefaultSort(DEFAULT_QUEUE));
  const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const pickQueue = useCallback((key) => { setQueue(key); setActiveSaved(null); setSort(queueDefaultSort(key)); }, []);
  const [search, setSearch] = useState('');
  // The list filters on a debounced copy (~200ms) so a long queue is not
  // re-filtered and re-rendered on every keystroke. Clearing applies at once.
  const [searchQ, setSearchQ] = useState('');
  useEffect(() => {
    if (!search) { setSearchQ(''); return undefined; }
    const id = setTimeout(() => setSearchQ(search), 200);
    return () => clearTimeout(id);
  }, [search]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [hrDeptFilter, setHrDeptFilter] = useState('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState('all');
  const [slaFilter, setSlaFilter] = useState('all');   // all | breached | at_risk | ok
  // The HR desk (Oct 27 2026): 'hr' = only the confidential Ask HR tickets -
  // what HR's old Ask HR queue in People links to (setPendingOpen
  // 'ticket-desk', or the nexus:ticket-desk event when already here).
  const [deskFilter, setDeskFilter] = useState('all');
  useEffect(() => {
    const pendingDesk = takePendingOpen('ticket-desk');
    if (pendingDesk) setDeskFilter(pendingDesk);
    const onDesk = (e) => setDeskFilter(e.detail?.desk || 'all');
    window.addEventListener('nexus:ticket-desk', onDesk);
    return () => window.removeEventListener('nexus:ticket-desk', onDesk);
  }, []);
  const [groupBy, setGroupBy] = useState('none');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  // Which drawer tab to land on - the Latest Comment cell opens straight onto
  // the Conversation (Neil, Oct 1).
  const [openTab, setOpenTab] = useState(null);
  // What the open drawer holds unsaved (TicketDrawer keeps it current), and
  // which ticket that is - read by the bell's open-ticket handler below.
  const drawerDirtyRef = useRef(false);
  const openIdRef = useRef(openId);
  useEffect(() => { openIdRef.current = openId; }, [openId]);
  // Every way of opening a ticket over one already open - a row click in the
  // pane, ↑ ↓, Previous / Next, the bell - asks first when the open one holds
  // unsaved edits (the drawer remounts and would throw them away).
  // One question at a time: while the confirm is up, a second switch (a held
  // arrow key, a double click) is refused rather than stacking dialogs.
  const switchingRef = useRef(false);
  const switchTo = useCallback(async (id, tab = null) => {
    if (!id) return false;
    if (id === openIdRef.current) { if (tab) setOpenTab(tab); return true; }
    if (openIdRef.current && drawerDirtyRef.current) {
      if (switchingRef.current) return false;
      switchingRef.current = true;
      const ok = await confirmSwitchTicket().finally(() => { switchingRef.current = false; });
      if (!ok) return false;
    }
    setOpenTab(tab); setOpenId(id);
    return true;
  }, []);
  const openTicket = useCallback((id, tab = null) => { switchTo(id, tab); }, [switchTo]);
  const closeTicket = useCallback(() => { setOpenId(null); setOpenTab(null); }, []);
  // Leaving the open ticket behind (the pane switched off, Board / Reports
  // chosen with a ticket in the pane) asks the same question first, then
  // CLOSES the ticket - it never re-materializes as a popup over the next
  // screen.
  const leaveOpenTicket = useCallback(async () => {
    if (!openIdRef.current) return true;
    if (drawerDirtyRef.current) {
      if (switchingRef.current) return false;
      switchingRef.current = true;
      const ok = await confirmSwitchTicket().finally(() => { switchingRef.current = false; });
      if (!ok) return false;
    }
    closeTicket();
    return true;
  }, [closeTicket]);
  const [layoutPref, setLayoutPref] = useTableValue('tickets-v3', 'layout', 'modal');
  const layout = LAYOUTS.includes(layoutPref) ? layoutPref : 'modal';
  const [view, setViewState] = useState('list');   // 'list' | 'board' | 'reports'
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  // Only a ticket parked in the PANE is at stake here: the popup drawer
  // stays where it is across a view change, as it always has.
  const inPane = useCallback(() => !isMobile && viewRef.current === 'list' && layout === 'pane' && !!openIdRef.current, [isMobile, layout]);
  const setView = useCallback((next) => {
    if (next === viewRef.current) return;
    if (next !== 'list' && inPane()) { leaveOpenTicket().then((ok) => { if (ok) setViewState(next); }); return; }
    setViewState(next);
  }, [inPane, leaveOpenTicket]);
  const setLayout = useCallback((next) => {
    if (next === layout) return;
    if (inPane()) { leaveOpenTicket().then((ok) => { if (ok) setLayoutPref(next); }); return; }
    setLayoutPref(next);
  }, [layout, inPane, leaveOpenTicket, setLayoutPref]);
  const [selected, setSelected] = useState(() => new Set());
  // Phones have no row checkboxes, so a selection made on desktop must not
  // survive a rotate into the phone layout - the bulk pill would float over a
  // list with nothing ticked and no way to untick it. Adjusted during render
  // (React's "storing information from previous renders" pattern) so the pill
  // never paints even for one frame.
  const [selLayoutMobile, setSelLayoutMobile] = useState(isMobile);
  if (selLayoutMobile !== isMobile) {
    setSelLayoutMobile(isMobile);
    if (isMobile && selected.size) setSelected(new Set());
  }

  // A screen recording that ended while the user was on ANOTHER view navigates
  // the app back here (recordingDraft.finishRecording) - reopen the create
  // form so it can seed itself from the stashed draft, clip included.
  useEffect(() => { if (peekDraft()?.resume) setCreating(true); }, []);

  // Deep-link support - the Outlook notification emails link to
  // "?ticket=<id>" (see backend/ticket_mail_templates.py's _ticket_url). Open
  // that ticket once on mount, then strip the param so a later refresh
  // doesn't reopen it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // The Weekly Ticket Report email links to ?view=reports.
    if (params.get('view') === 'reports') {
      setViewState('reports');   // mount time: no ticket is open yet, nothing to ask
      params.delete('view');
      const left = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (left ? `?${left}` : ''));
    }
    const tid = params.get('ticket');
    if (!tid) return;
    setOpenId(tid);
    params.delete('ticket');
    const rest = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
  }, []);

  // The in-app equivalent of that ?ticket= link: the notification bell's "View
  // ticket" navigates here and then fires this, because a mount-time query
  // param cannot reach a module that is already mounted (clicking a second
  // notification while sitting on this screen). Same shape as the Task
  // module's `nexus:open-task` - see views/Tasks.jsx.
  // A ticket opened over one with held edits asks first - switching used to
  // throw the unsaved edits away without a word (the drawer remounts).
  useEffect(() => {
    const openTicket = (e) => { switchTo(e.detail?.ticketId); };
    window.addEventListener('nexus:open-ticket', openTicket);
    // This module is lazy(), so on a first visit the event above has already
    // fired by the time we get here - the bell leaves the id behind for us.
    const pending = takePendingOpen('ticket');
    if (pending) setOpenId(pending);
    return () => window.removeEventListener('nexus:open-ticket', openTicket);
  }, [switchTo]);

  // A list to land on (Oct 26 2026): the Tickets to Assign notice and the
  // dashboard's My Open Tickets tile open the desk on the Unassigned or the
  // Mine queue. Live event for a mounted screen, pending note for a first
  // visit (lib/openTarget.js).
  useEffect(() => {
    const apply = (f) => {
      const q = queueFromFilterEvent(f);
      if (q) { pickQueue(q); setSlaFilter('all'); setStatusFilter('all'); }
    };
    const onFilter = (e) => apply(e.detail?.filter);
    window.addEventListener('nexus:ticket-filter', onFilter);
    const pending = takePendingOpen('ticketFilter');
    if (pending) apply(pending);
    return () => window.removeEventListener('nexus:ticket-filter', onFilter);
  }, [pickQueue]);

  // Guided tour - same pattern as the Task module's (views/Tasks.jsx): runs
  // itself once per person on first visit, then only from the profile menu's
  // "Tour" row (TopHeader, gated on activeView === 'tickets'), which fires
  // this same nexus:tickets-tour event. "Seen" is server-side, per person -
  // see routers/user_tours.py.
  const [tour, setTour] = useState(false);
  useEffect(() => {
    if (!myEmail) return;
    let cancelled = false;
    api.getToursSeen()
      .then(({ seen }) => { if (!cancelled && !seen?.[TICKET_TOUR_ID]) setTour(true); })
      .catch(() => { /* can't confirm "seen" - skip the auto-tour rather than risk nagging on every flaky load */ });
    return () => { cancelled = true; };
  }, [myEmail]);
  const closeTour = () => {
    setTour(false);
    // Written on close, not on finish - see the Task module's identical comment.
    api.markTourSeen(TICKET_TOUR_ID).catch(() => {});
  };
  useEffect(() => {
    const openTour = () => setTour(true);
    window.addEventListener('nexus:tickets-tour', openTour);
    const unTour = registerTour('tickets', 'Tickets', openTour);   // the Help panel's Take the Tour (lib/tours.js)
    return () => { window.removeEventListener('nexus:tickets-tour', openTour); unTour(); };
  }, []);

  // Column order/widths - the same drag-to-reorder/resize kit the Task List
  // uses (tasks/tableCols.jsx), persisted to the user's profile under
  // table:"tickets" rather than a one-off localStorage key, so an arrangement
  // follows them to another device. Requester drops out of the underlying
  // column set entirely on Raised by Me (rather than being hidden per-row), so
  // the grid template - and the reorder/resize state - never has to know about it.
  // Company ships hidden while every loaded ticket is one company (desk
  // re-cut, 10/31/2026) - it shows by itself once there are two, and is one
  // click away in Columns either way.
  const oneCompany = useMemo(() => new Set(tickets.map((t) => t.companyId || '')).size <= 1, [tickets]);
  const columnDefs = useMemo(
    () => TICKET_COLUMNS.filter((c) => !(queue === 'raised' && c.key === 'requester'))
      .map((c) => (c.key === 'company' ? { ...c, defaultHidden: oneCompany } : c))
      .map((c) => (c.shrink ? { ...c, template: `minmax(${c.shrink}px, ${c.width}fr)` } : c)),
    [queue, oneCompany],
  );
  // 'tickets-v3' (10/31/2026): the title went elastic and Status / Priority
  // narrowed; saved widths win over defaults, so the key bumps once to
  // retire everyone's old arrangement ('tickets' was the first key).
  const fullTable = useTableColumns({ table: 'tickets-v3', cols: columnDefs });
  const { hidden, toggleHidden } = fullTable;
  // The pane's own arrangement: the columns that still read at half width,
  // kept apart from the full list's so widening one never squeezes the other.
  const pane = !isMobile && view === 'list' && layout === 'pane';
  const paneDefs = useMemo(() => columnDefs.filter((c) => PANE_COLS.includes(c.key)), [columnDefs]);
  const paneTable = useTableColumns({ table: 'tickets-v3-pane', cols: paneDefs });
  const { cols, widths, template, startResize, resetWidth, autofitWidth, wrapRef, dragProps } = pane ? paneTable : fullTable;
  // Finished tickets (resolved / closed) used to collapse into a Completed
  // section under the list (Pranshu, Sept 8 2026; collapsed on every visit,
  // Neil, Oct 13 2026). The Done queue is that section now (10/31/2026): the
  // same intent - finished work out of the way, one click to see it.

  // Assignee filter options - every distinct current assignee across the
  // tickets already on screen, not a separate directory fetch: this only
  // ever needs to offer people something is ACTUALLY assigned to right now,
  // and deriving it from the data in hand keeps it correct with zero extra
  // calls (same spirit as hrDepts being its own fetch only because
  // departments genuinely aren't on the ticket rows).
  const assigneeOptions = useMemo(() => {
    const byEmail = new Map();
    for (const t of tickets) {
      const email = (t.assigneeId || '').toLowerCase();
      if (email && !byEmail.has(email)) byEmail.set(email, nameOf(t.assigneeId) || t.assigneeId);
    }
    return [...byEmail.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tickets, nameOf]);

  // Saved views - snapshot the current filter set + grouping + view kind.
  const applyTicketView = (v) => {
    const f = v.filters || {};
    // A view saved before the queues existed carried the old scope (10/31/2026).
    pickQueue(f.queue ?? queueFromLegacyScope(f.scope));
    setActiveSaved(v.id);
    setStatusFilter(f.statusFilter ?? 'all'); setPriorityFilter(f.priorityFilter ?? 'all');
    setTypeFilter(f.typeFilter ?? 'all'); setSlaFilter(f.slaFilter ?? 'all');
    // ?? 'all', not a no-op: a view saved before service areas existed must
    // still CLEAR the filter, or applying it silently keeps whatever narrowing
    // was on screen and shows a different list than the one it names.
    setServiceAreaFilter(f.serviceAreaFilter ?? 'all');
    setAssigneeFilter(f.assigneeFilter ?? 'all');
    // Department was never saved, so a view applied while a department was
    // picked kept it and showed a different list than the one it names.
    setHrDeptFilter(f.hrDeptFilter ?? 'all');
    setDeskFilter('all');
    setSearch(f.search ?? '');
    // A view saved before the Next Clock column sorted by 'due' - that column is 'clock' now.
    if (f.sort?.key) setSort({ key: f.sort.key === 'due' ? 'clock' : f.sort.key, dir: f.sort.dir === 'asc' ? 'asc' : 'desc' });
    if (v.group) setGroupBy(v.group);
    if (v.view) setView(v.view);
  };
  // The phone filter sheet's Clear All - every filter back to 'all'. Scope,
  // search, sort and grouping are not filters and stay as they are.
  const clearFilters = () => {
    setStatusFilter('all'); setPriorityFilter('all'); setTypeFilter('all'); setSlaFilter('all');
    setHrDeptFilter('all'); setServiceAreaFilter('all'); setAssigneeFilter('all'); setDeskFilter('all');
  };
  // Save View names the view in its own small dialog (SaveViewDialog) - it
  // used to be window.prompt.
  const [namingView, setNamingView] = useState(false);
  const saveTicketView = (name) => createTicketView({
    name, view, group: groupBy,
    filters: { queue, statusFilter, priorityFilter, typeFilter, slaFilter, serviceAreaFilter, assigneeFilter, hrDeptFilter, search, sort },
  });
  const removeTicketView = async (v) => {
    if (!(await appDialog.confirm(`Delete the saved view "${v.name}"?`, { title: 'Delete Saved View', confirmText: 'Delete', danger: true }))) return;
    try { await deleteTicketView(v.id); }
    catch (e) { appDialog.alert(`Could not delete the view: ${e?.message || e}`); }
  };

  const visible = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    // Inside All Open, a filter set to Resolved or Closed means "show me
    // those" - the one time a finished ticket shows outside Done.
    const closedOnly = statusFilter === 'resolved' || statusFilter === 'closed';
    return tickets.filter((t) => {
      if (!queueMatches(queue, t, qctx) && !(queue === 'open' && closedOnly && CLOSED_STATES.includes(t.status))) return false;
      if (hrDeptFilter !== 'all' && (t.hrDepartmentId || '') !== hrDeptFilter) return false;
      if (deskFilter !== 'all' && (t.confidentialDesk || '') !== deskFilter) return false;
      if (assigneeFilter !== 'all' && (t.assigneeId || '').toLowerCase() !== assigneeFilter) return false;
      // 'open' is a bucket, not a status: any state that is not resolved/closed.
      // Without it the Open tile had nothing to select, so it cleared the
      // filters instead - showing closed tickets under a count that excluded them.
      if (statusFilter === 'open' && CLOSED_STATES.includes(t.status)) return false;
      if (statusFilter === 'unassigned' && (t.assigneeId || CLOSED_STATES.includes(t.status))) return false;
      if (!['all', 'open', 'unassigned'].includes(statusFilter) && t.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (typeFilter !== 'all' && (t.type || 'request') !== typeFilter) return false;
      if (serviceAreaFilter !== 'all' && (t.serviceArea || '') !== serviceAreaFilter) return false;
      if (slaFilter !== 'all' && slaState(t) !== slaFilter) return false;
      if (q) {
        // Application is searchable too - "egnyte" is how someone looks for the
        // ticket they raised, and it is rarely the word they put in the title.
        const hay = `${t.code} ${normalizeCode(t.code)} ${ticketNoShort(t.code)} ${t.subject} ${t.description} ${helpWithLabel(t)} ${nameOf(t.requesterId) || ''} ${nameOf(t.assigneeId) || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tickets, queue, qctx, searchQ, statusFilter, priorityFilter, typeFilter, slaFilter, nameOf, hrDeptFilter, assigneeFilter, serviceAreaFilter, deskFilter]);

  // Reports (server-side, TicketReports.jsx) take the list's filters that the
  // report endpoint understands; status, SLA, scope and search are list-only.
  // The list's '' ("No Department" / "Not Set") travels as 'none'.
  const reportFilters = useMemo(() => {
    const v = (x) => (x === 'all' ? '' : x);
    const blank = (x) => (x === '' ? 'none' : v(x));
    return { priority: v(priorityFilter), type: v(typeFilter), department: blank(hrDeptFilter),
      assignee: v(assigneeFilter), service_area: blank(serviceAreaFilter) };
  }, [priorityFilter, typeFilter, hrDeptFilter, assigneeFilter, serviceAreaFilter]);
  const reportFilterLabels = useMemo(() => [
    priorityFilter !== 'all' && `Priority: ${PRIORITY_META[priorityFilter]?.label || priorityFilter}`,
    typeFilter !== 'all' && `Type: ${TICKET_TYPE_META[typeFilter]?.label || typeFilter}`,
    hrDeptFilter !== 'all' && `Department: ${hrDeptFilter === '' ? 'No Department' : (hrDeptName(hrDeptFilter) || hrDeptFilter)}`,
    assigneeFilter !== 'all' && `Assignee: ${nameOf(assigneeFilter) || assigneeFilter}`,
    serviceAreaFilter !== 'all' && `Service Area: ${serviceAreaFilter === '' ? 'Not Set' : (serviceAreaLabel(serviceAreaFilter) || serviceAreaFilter)}`,
  ].filter(Boolean), [priorityFilter, typeFilter, hrDeptFilter, assigneeFilter, serviceAreaFilter, hrDeptName, nameOf]);

  // List-view sort - applied before grouping so it holds within each bucket too.
  const sortTickets = useCallback((list) => {
    const col = TICKET_COLUMNS.find((c) => c.key === sort.key);
    if (!col?.sort) return list;
    const ctx = { nameOf, companyName };
    const dir = sort.dir === 'asc' ? 1 : -1;
    // Next Clock sorts on the deadline itself (nextClock.at): paused after
    // every live clock, no clock last - on phones and desktop alike.
    return [...list].sort((a, b) => {
      const av = col.sort(a, ctx); const bv = col.sort(b, ctx);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, nameOf, companies]);

  const sortedVisible = useMemo(() => sortTickets(visible), [visible, sortTickets]);

  // Grouped sections for the list view.
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: '', rows: sortedVisible }];
    const buckets = new Map();
    const keyOf = (t) => (groupBy === 'status' ? t.status
      : groupBy === 'priority' ? t.priority
      : groupBy === 'type' ? (t.type || 'request')
      : groupBy === 'serviceArea' ? (t.serviceArea || '')
      : groupBy === 'assignee' ? (t.assigneeId || '')
      : 'all');
    const labelOf = (k) => (groupBy === 'status' ? (TICKET_STATUS_META[k]?.label || k)
      : groupBy === 'priority' ? (PRIORITY_META[k]?.label || k)
      : groupBy === 'type' ? (TICKET_TYPE_META[k]?.label || k)
      // Tickets raised before service areas existed carry none - "Not set" is
      // the same wording the filter uses for them.
      : groupBy === 'serviceArea' ? (k ? serviceAreaLabel(k) || k : 'Not Set')
      : groupBy === 'assignee' ? (k ? nameOf(k) || k : 'Unassigned')
      : '');
    for (const t of sortedVisible) { const k = keyOf(t); if (!buckets.has(k)) buckets.set(k, { key: k || '-', label: labelOf(k), rows: [] }); buckets.get(k).rows.push(t); }
    return [...buckets.values()];
  }, [sortedVisible, groupBy, nameOf]);

  // Compact controls for the floating bulk-action pill - smaller than the
  // standard form idiom so a handful of them fit in one tight row.
  const compactSelStyle = { ...inputStyle, width: 'auto', cursor: 'pointer', appearance: 'auto', color: NX.ink, fontSize: 12.5, padding: '5px 8px', borderRadius: 8 };
  const compactBtnStyle = { ...btn('ghost'), color: NX.surface, background: 'color-mix(in srgb, var(--nx-surface) 14%, transparent)', fontSize: 12.5, padding: '5px 9px', gap: 5 };

  // Bulk selection (list view only). Selection is cleared when it no longer matches.
  const toggleSel = useCallback((id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const clearSel = () => setSelected(new Set());
  const selIds = [...selected].filter((id) => visible.some((t) => t.id === id));
  // Select-all - the rows actually on screen: each group's first 200. It used
  // to take every filtered ticket, so a bulk Delete also hit rows nobody
  // could see (Oct 2026 review).
  const allVisibleIds = useMemo(() => groups.flatMap((g) => g.rows.slice(0, 200)).map((t) => t.id), [groups]);
  // Keyboard flow (Neil, 10/31/2026): ↑ ↓ move a highlight through the rows
  // on screen, Enter opens. In the pane the arrows open as they move (the
  // conversation stays in view); as a popup the list goes quiet while a
  // ticket is open, so the keys never reach a list hidden behind it.
  const keysOn = !isMobile && view === 'list' && (pane || !openId);
  const onMove = useCallback((id) => switchTo(id), [switchTo]);
  const { focusId } = useListKeys({ ids: allVisibleIds, enabled: keysOn, onOpen: openTicket, openId, onMove: pane ? onMove : null });
  // Previous / Next in the open ticket's header, in the list's order.
  const openIdx = openId ? allVisibleIds.indexOf(openId) : -1;
  const prevId = openIdx > 0 ? allVisibleIds[openIdx - 1] : null;
  const nextId = openIdx >= 0 && openIdx < allVisibleIds.length - 1 ? allVisibleIds[openIdx + 1] : null;
  const onPrev = useMemo(() => (prevId ? () => switchTo(prevId) : null), [prevId, switchTo]);
  const onNext = useMemo(() => (nextId ? () => switchTo(nextId) : null), [nextId, switchTo]);
  // The pane has no overlay of its own, so Escape is the desk's: it clears
  // the pane (asking first when the ticket holds edits). A dialog open on
  // top (Resolve, a linked task) is a layer above this one and wins.
  useEscapeLayer(() => {
    if (drawerDirtyRef.current) { confirmSwitchTicket().then((ok) => { if (ok) closeTicket(); }); return; }
    closeTicket();
  }, pane && !!openId);
  const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => selected.has(id));
  const someSelected = !allSelected && allVisibleIds.some((id) => selected.has(id));
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(allVisibleIds));
  // Resolving needs a written resolution now (Neil, Sep 30), so every quick
  // path into Resolved/Closed - the row's status cell, a board drag, the bulk
  // bar - opens the Resolve dialog instead of saving straight away.
  const [resolveReq, setResolveReq] = useState(null);   // { ids, status, mode? }
  // Read through a ref so the callback stays stable for the memoized rows.
  const ticketsRef = useRef(tickets);
  useEffect(() => { ticketsRef.current = tickets; }, [tickets]);
  const guardedUpdate = useCallback((id, patch) => {
    const tk = ticketsRef.current.find((x) => x.id === id);
    if (patch?.status && needsResolution(tk, patch.status)) {
      setResolveReq({ ids: [id], status: patch.status });
      return Promise.resolve(tk);
    }
    return updateTicket(id, patch);
  }, [updateTicket]);
  // Every bulk action runs each ticket on its own and reports what did not
  // go through ("2 of 5 could not be updated: <reason>"); the ones that
  // failed stay selected so they can be retried. It used to swallow every
  // error and clear the selection as if all had worked.
  const runBulk = async (ids, fn, verb) => {
    const results = await Promise.allSettled(ids.map((id) => fn(id)));
    const failed = ids.filter((_, i) => results[i].status === 'rejected');
    setSelected(new Set(failed));
    if (failed.length) reportBulkFailure(results, ids.length, verb);
  };
  const bulkPatch = async (patch) => {
    if (patch?.status && selIds.some((id) => needsResolution(tickets.find((x) => x.id === id), patch.status))) {
      setResolveReq({ ids: selIds, status: patch.status });
      return;
    }
    await runBulk(selIds, (id) => updateTicket(id, patch), 'updated');
  };
  const bulkDelete = async () => {
    const ids = selIds;
    if (!(await appDialog.confirm(`Delete ${ids.length} ticket${ids.length === 1 ? '' : 's'}? Their history is kept and a manager can restore them.`,
      { title: ids.length === 1 ? 'Delete Ticket' : 'Delete Tickets', confirmText: 'Delete', danger: true }))) return;
    await runBulk(ids, (id) => deleteTicket(id), 'deleted');
  };
  // A board drop / the phone's Move To: same Resolve gate, and a failure
  // says so instead of the card silently snapping back.
  const moveOnBoard = useCallback((id, status) => guardedUpdate(id, { status })
    .catch((e) => appDialog.alert(`Could not move the ticket: ${e?.message || e}`)), [guardedUpdate]);

  // The bar's tabs: the queues this person has (To Route only on the desk,
  // and the two approval queues only with something in them), then their
  // saved views, then "+ View" (desktop - saving is a desktop job).
  // Order (Neil, 10/31/2026): the built-in queues through Done, To Route and
  // To Approve when they have something, the person's saved views, Raised by
  // Me, then "+ View". A count pill means something waiting on you, so Done,
  // All Open and Raised by Me carry none.
  const queueTabs = useMemo(() => {
    const shown = QUEUES.filter((q) => !(q.onlyDesk && !itAdmin) && !(q.hideWhenEmpty && !counts[q.key]));
    const tab = (q) => ({ key: q.key, label: q.label, badge: UNCOUNTED.has(q.key) ? 0 : counts[q.key], tone: q.tone });
    return [
      ...shown.filter((q) => q.key !== 'raised').map(tab),
      ...ticketViews.map((v) => ({ key: `view:${v.id}`, label: v.name })),
      ...shown.filter((q) => q.key === 'raised').map(tab),
      ...(isMobile ? [] : [{ key: '__save', label: '+ View' }]),
    ];
  }, [counts, itAdmin, ticketViews, isMobile]);
  const activeTab = activeSaved && ticketViews.some((v) => v.id === activeSaved) ? `view:${activeSaved}` : queue;
  const onTab = (key) => {
    if (key === '__save') { setNamingView(true); return; }
    if (key.startsWith('view:')) {
      const v = ticketViews.find((x) => `view:${x.id}` === key);
      if (v) applyTicketView(v);
      return;
    }
    pickQueue(key);
  };
  // What an empty list says: the queue's own words, unless a filter or a
  // search narrowed it - or nothing has been raised at all.
  const narrowed = !!searchQ || [statusFilter, priorityFilter, typeFilter, slaFilter, hrDeptFilter, serviceAreaFilter, assigneeFilter, deskFilter].some((v) => v !== 'all');
  const emptyWords = !tickets.length
    ? { title: 'No Tickets Yet', hint: `Nothing has been submitted so far. ${isMobile ? 'Tap + below' : 'Choose Create'} to report a problem or ask for help.` }
    : narrowed ? { title: 'No Tickets', hint: 'No tickets match your filters.' }
      : (QUEUE_EMPTY[queue] || { title: 'No Tickets', hint: 'Nothing here right now.' });

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', position: 'relative' }}>
      {/* One bar, the Tasks anatomy (Neil, 10/31/2026): the work queues on the
          left - each a filter preset counted over the whole workspace - and
          Create on the right. The title row and the five summary tiles that
          sat above the list are gone; their counts live on the tabs. To Route
          and To Approve appear only with something in them, a saved view is a
          tab too, and "+ View" saves the current filters as one. Phones get
          the same strip (swipeable), with Create in the floating bar. */}
      <div className="nx-primary-bar" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: isMobile ? '0 8px' : '0 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, flexShrink: 0 }}>
        <div data-tour="ticket-scope" style={{ flex: 1, minWidth: 0 }}>
          <ModuleTabs inline tabs={queueTabs} active={activeTab} onChange={onTab} />
        </div>
        {!isMobile && (
          <span data-tour="ticket-create" style={{ flexShrink: 0, padding: '6px 0' }}>
            {/* "Create", not "New Ticket" - the same word the Task module's bar
                button uses, and the page it sits on already says Tickets
                (Sagar, Sept 2 2026). */}
            <button style={btn('primary')} onClick={() => setCreating(true)}><Plus size={15} /> Create</button>
          </span>
        )}
      </div>

      {/* Phone search - the same `search` state as the desktop toolbar's box,
          which does not render here. 16px so iOS does not zoom the page on
          focus; the clear button is a full 32px target. type="text" (with
          inputMode="search") rather than type="search", whose native cancel
          button would sit beside our own X on Chrome/Android. */}
      {isMobile && (
        <div style={{ position: 'relative', margin: '8px 12px' }}>
          <Search size={16} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: NX.faint, pointerEvents: 'none' }} />
          <input type="text" inputMode="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tickets…"
            aria-label="Search tickets" enterKeyHint="search"
            style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', fontSize: 16, padding: '9px 40px 9px 34px', WebkitAppearance: 'none', appearance: 'none' }} />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search"
              style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: NX.faint, cursor: 'pointer', padding: 0 }}>
              <X size={16} />
            </button>
          )}
        </div>
      )}

      {/* The toolbar - the same shape on List, Board and Reports: how the
          tickets are shown on the left; search, Filters and the one overflow
          menu (grouping, columns, saved views, export, the property clean-up)
          on the right. It never changes rows between views. */}
      {!isMobile && (
        <div data-tour="ticket-toolbar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${NX.border}`, padding: '6px 16px', flexWrap: 'wrap', background: NX.surface }}>
          <div data-tour="ticket-views" className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, overflowX: 'auto', flexShrink: 0 }}>
            {TICKET_VIEW_TABS.map((tb) => (
              <button key={tb.key} onClick={() => setView(tb.key)} title={tb.label} style={{
                ...btn('ghost'), padding: '6px 10px', borderRadius: 7, whiteSpace: 'nowrap',
                background: view === tb.key ? NX.surface : 'transparent', color: view === tb.key ? NX.ink : NX.dim,
                boxShadow: view === tb.key ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
              }}><tb.icon size={15} /> {tb.label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: 210 }}>
              <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tickets…" aria-label="Search tickets" style={{ ...inputStyle, paddingLeft: 32 }} />
            </div>
            <TicketFilterMenu
              statusFilter={statusFilter} setStatusFilter={setStatusFilter}
              priorityFilter={priorityFilter} setPriorityFilter={setPriorityFilter}
              typeFilter={typeFilter} setTypeFilter={setTypeFilter}
              slaFilter={slaFilter} setSlaFilter={setSlaFilter}
              hrDeptFilter={hrDeptFilter} setHrDeptFilter={setHrDeptFilter} hrDepts={hrDepts}
              serviceAreaFilter={serviceAreaFilter} setServiceAreaFilter={setServiceAreaFilter}
              assigneeFilter={assigneeFilter} setAssigneeFilter={setAssigneeFilter} assigneeOptions={assigneeOptions}
            />
            <MoreMenu views={ticketViews} onApply={applyTicketView} onSave={() => setNamingView(true)} onDelete={removeTicketView}
              groupBy={groupBy} setGroupBy={setGroupBy} showGroup={view === 'list'}
              onExport={() => downloadTicketsCsv(sortedVisible, nameOf, companyName, hrDeptName)}
              columns={columnDefs} hidden={hidden} toggleHidden={toggleHidden} cols={fullTable.cols} showColumns={view === 'list' && !pane}
              layout={view === 'list' ? layout : undefined} setLayout={setLayout}
              suggestLinks={privileged ? (style) => <SuggestPropertyLinksButton style={style} /> : null} />
          </div>
        </div>
      )}

      {deskFilter === 'hr' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 16px 0', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: NX.ink,
            background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.28)', borderRadius: 999, padding: '4px 6px 4px 11px' }}>
            HR Requests
            <button type="button" aria-label="Show All Tickets" title="Show All Tickets" onClick={() => setDeskFilter('all')}
              style={{ ...btn('ghost'), padding: 2, borderRadius: 999 }}><X size={13} /></button>
          </span>
          <span style={{ fontSize: 12, color: NX.faint }}>Confidential Ask HR requests - only their people and HR see them.</span>
        </div>
      )}

      {/* Body. Desktop: paddingBottom leaves room under the last row. Phones:
          a small paddingBottom only - the ticket-bar-spacer at the end of the
          body clears the floating MobileTaskBar, so a larger value here would
          stack on top of it. */}
      {/* With the pane on, the body is two columns: the list's scroller and
          the open ticket beside it (never under it). Each scrolls on its own. */}
      <div style={{ flex: 1, minHeight: 0, display: pane ? 'grid' : 'flex', flexDirection: 'column', gridTemplateColumns: pane ? 'minmax(0, 1fr) minmax(420px, 45%)' : undefined, background: NX.canvas }}>
      <div data-tour="ticket-body" className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas,
        // Longhands only: React warns when a shorthand and its longhand
        // both change on one re-render (rotating the phone, List <-> Board).
        paddingTop: view === 'board' ? 12 : 16, paddingLeft: view === 'board' ? 12 : 16, paddingRight: view === 'board' ? 12 : 16, paddingBottom: isMobile ? 8 : 76 }}>
        {view === 'reports' ? (
          <TicketReports listFilters={reportFilters} filterLabels={reportFilterLabels} companies={companies} />
        ) : view === 'board' ? (
          <TicketBoard tickets={visible} nameOf={nameOf} onOpen={setOpenId} onMove={moveOnBoard} mobile={isMobile}
            canMove={(t) => ticketRights(t, myEmail, privileged).canEditStatus} />
        ) : visible.length === 0 ? (
          <EmptyState icon={TicketToken} title={emptyWords.title} hint={emptyWords.hint} />
        ) : isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {groups.map((g) => (
              <div key={g.key} className="nx-edge-card" style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, overflow: 'hidden' }}>
                {groupBy !== 'none' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: NX.surface2, borderBottom: `1px solid ${NX.border2}`, fontSize: 13, fontWeight: 700 }}>
                    {g.label} <span style={{ color: NX.faint, fontWeight: 400 }}>{g.rows.length}</span>
                  </div>
                )}
                {g.rows.slice(0, 200).map((t, idx) => (
                  <TicketRow key={t.id} t={t} nameOf={nameOf} hrDeptName={hrDeptName} companyName={companyName}
                    myEmail={myEmail} privileged={privileged} updateTicket={guardedUpdate} onOpen={openTicket}
                    people={people}
                    checked={selected.has(t.id)} onToggle={toggleSel} band={idx % 2 === 1} mobile />
                ))}
                {g.rows.length > 200 && <div style={{ padding: '8px 16px', fontSize: 12, color: NX.faint }}>+ {g.rows.length - 200} more - filter to narrow down</div>}
              </div>
            ))}
          </div>
        ) : (
          // Desktop - copies the task module's RichListView structure exactly:
          // one bordered/rounded shell, wrapped in .nx-list-scroll (the same class
          // Tasks uses) so a wide/resized table scrolls horizontally as a single
          // block - header and rows are plain sibling content, not separately
          // scrolled regions, so there's no way for them to drift out of sync.
          // wrapRef + the --nx-grid custom property are useTableColumns' - every
          // header/row inside reads the SAME template, so a resize or a
          // drag-reorder repaints the whole grid with zero React re-renders.
          <div className="nx-list-scroll" style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface }}>
            {/* width (not just minWidth): every column here is a fixed px
                size, none elastic, so a plain block div - which stretches to
                fill its parent by default - kept painting the row/header
                background past the last real column on any screen wider than
                the columns' sum, reading as a stray blank column (Pranshu,
                Sep 17 2026: "however much column I'm adding, the table
                should show that much column only"). fit-content pins this
                div's actual width to its grid content, so there's nothing
                left over to paint; still never shrinks below it either, so
                a narrow screen scrolls horizontally exactly as before. */}
            {/* Elastic columns (Oct 6) fill the width; the table scrolls only
                below every column's floor (min-content). Once EVERY data
                column carries a dragged px width, fit-content again, so there
                is no blank strip past the last column. */}
            <div ref={wrapRef} style={cols.every((c) => c.fixed || widths[c.key])
              ? { width: 'fit-content', minWidth: 'fit-content', '--nx-grid': template }
              : { width: '100%', minWidth: 'min-content', '--nx-grid': template }}>
              <TicketListHeader cols={cols} widths={widths} startResize={startResize} resetWidth={resetWidth} autofitWidth={autofitWidth}
                dragProps={dragProps} sort={sort} onSort={onSort} allSelected={allSelected} someSelected={someSelected} onToggleSelectAll={toggleSelectAll} />
              {groups.map((g) => (
                <div key={g.key}>
                  {groupBy !== 'none' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: NX.surface2, borderBottom: `1px solid ${NX.border2}`, fontSize: 13, fontWeight: 700 }}>
                      {g.label} <span style={{ color: NX.faint, fontWeight: 400 }}>{g.rows.length}</span>
                    </div>
                  )}
                  {/* band = odd row inside its group - the zebra tint the task
                      lists use, which is what lets the eye follow a row out to
                      the Created Date column on a wide screen. */}
                  {g.rows.slice(0, 200).map((t, idx) => (
                    <TicketRow key={t.id} t={t} nameOf={nameOf} hrDeptName={hrDeptName} companyName={companyName}
                    myEmail={myEmail} privileged={privileged} updateTicket={guardedUpdate} onOpen={openTicket}
                    people={people} focused={focusId === t.id}
                      checked={selected.has(t.id)} onToggle={toggleSel} cols={cols} band={idx % 2 === 1} />
                  ))}
                  {g.rows.length > 200 && <div style={{ padding: '8px 16px', fontSize: 12, color: NX.faint }}>+ {g.rows.length - 200} more - filter to narrow down</div>}
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Phones: room to scroll the last card clear of the floating
            MobileTaskBar (52px tall). A spacer rather than paddingBottom, so it
            works whether or not .nx-gutter's phone rule (style.css) overrides
            this body's bottom padding. Where .main-content reserves 64px + the
            safe-area inset at the bottom, the bar sits 18px above that and
            overlaps the body by 70px; where it does not (no module nav), the
            bar sits 16px + the inset above the screen edge, 68px + the inset
            of overlap. 96px + the inset clears both with 26-28px to spare. */}
        {isMobile && <div aria-hidden="true" data-testid="ticket-bar-spacer" style={{ height: 'calc(96px + env(safe-area-inset-bottom))', flexShrink: 0 }} />}
      </div>
      {pane && (
        <div data-testid="ticket-pane" role="region" aria-label="Open Ticket" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${NX.border}`, background: NX.surface }}>
          {openId ? (
            <TicketDrawer key={openId} inline ticketId={openId} initialTab={openTab} dirtyRef={drawerDirtyRef}
              onPrev={onPrev} onNext={onNext} onClose={closeTicket} />
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <EmptyState icon={TicketToken} title="Pick a Ticket" hint="Click a row, or press ↓ to start at the top of the list. ↑ ↓ step through it, Escape clears the pane." />
            </div>
          )}
        </div>
      )}
      </div>

      {!isMobile && view === 'list' && selIds.length > 0 && (
        // Floating pill, centered at the bottom of the panel - doesn't push the
        // list's layout (position:absolute against the panel's position:relative
        // above) and stays compact instead of stretching edge to edge.
        <div style={{
          position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, flexWrap: 'wrap',
          maxWidth: 'calc(100% - 32px)', padding: '7px 10px', borderRadius: 12,
          background: NX.ink, color: NX.surface, boxShadow: '0 10px 28px rgba(0,0,0,0.28)',   // inverse of the page in either theme - #fff text vanished on dark mode's light pill
        }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', padding: '0 2px' }}>{selIds.length} selected</span>
          <TicketSelect command placeholder="Set status…" options={statusOptions()} style={compactSelStyle}
            onChange={(v) => bulkPatch({ status: v })} />
          <TicketSelect command placeholder="Set priority…" options={priorityOptions()} style={compactSelStyle}
            onChange={(v) => bulkPatch({ priority: v })} />
          <TicketSelect command placeholder="Assign to…" searchPlaceholder="Search people…"
            options={[['', 'Unassign'], ...people.map((p) => [p.email, p.name || p.email])]}
            style={{ ...compactSelStyle, maxWidth: 140 }} onChange={(v) => bulkPatch({ assigneeId: v })} />
          <button style={compactBtnStyle} onClick={() => bulkPatch({ status: 'resolved' })}><CheckCircle2 size={13} /> Resolve</button>
          {canBulkDelete && <button style={compactBtnStyle} onClick={bulkDelete}><Trash2 size={13} /> Delete</button>}
          <button style={{ ...compactBtnStyle, background: 'transparent', padding: 6 }} onClick={clearSel} title="Clear selection"><X size={14} /></button>
        </div>
      )}

      {isMobile && (
        <MobileTaskBar
          views={TICKET_VIEW_TABS} view={view} setView={setView}
          onCreate={() => setCreating(true)}
          hasModuleNav={false} createLabel="Create Ticket"
          filterSheet={(onClose) => (
            <TicketMobileFilters
              onClose={onClose}
              statusFilter={statusFilter} setStatusFilter={setStatusFilter}
              priorityFilter={priorityFilter} setPriorityFilter={setPriorityFilter}
              typeFilter={typeFilter} setTypeFilter={setTypeFilter}
              slaFilter={slaFilter} setSlaFilter={setSlaFilter}
              hrDeptFilter={hrDeptFilter} setHrDeptFilter={setHrDeptFilter} hrDepts={hrDepts}
              serviceAreaFilter={serviceAreaFilter} setServiceAreaFilter={setServiceAreaFilter}
              assigneeFilter={assigneeFilter} setAssigneeFilter={setAssigneeFilter} assigneeOptions={assigneeOptions}
              groupBy={groupBy} setGroupBy={setGroupBy} showGroup={view === 'list'}
              showSort={view === 'list'} sort={sort} setSort={setSort} onClearAll={clearFilters}
            />
          )}
        />
      )}

      {creating && <CreateTicketModal onClose={() => setCreating(false)} />}
      {namingView && <SaveViewDialog onSave={saveTicketView} onClose={() => setNamingView(false)} />}
      {openId && !pane && (
        <TicketDrawer key={openId} ticketId={openId} initialTab={openTab} dirtyRef={drawerDirtyRef}
          onPrev={onPrev} onNext={onNext} onClose={closeTicket} />
      )}
      {resolveReq && (
        <TicketActionDialog mode={resolveReq.mode || 'resolve'} targetStatus={resolveReq.status}
          ticket={resolveReq.ids.length === 1 ? tickets.find((x) => x.id === resolveReq.ids[0]) : null}
          onSubmit={async (p) => {
            // Bulk: one resolution for all of them, each still refused
            // server-side on its own if something is wrong with it.
            const ids = resolveReq.ids;
            const results = await Promise.allSettled(ids.map((id) => updateTicket(id, p)));
            const failed = ids.filter((_, i) => results[i].status === 'rejected');
            if (ids.length === 1) {
              if (failed.length) throw new Error(results[0].reason?.message || 'Could not resolve.');
              return;
            }
            // Bulk: the ones that failed stay selected, and the dialog closes
            // with a count of what did not go through.
            setSelected(new Set(failed));
            if (failed.length) reportBulkFailure(results, ids.length, 'resolved');
          }}
          onClose={() => setResolveReq(null)} />
      )}
      {tour && (
        <GuidedTour
          steps={buildTicketTourSteps({ setQueue: pickQueue, setView, isMobile })}
          onClose={closeTour} />
      )}
    </div>
  );
}

// "2 of 5 could not be updated: <first reason>" after a bulk action. Exported
// for its test.
export function bulkFailureMessage(results, total, verb) {
  const failed = results.filter((r) => r.status === 'rejected');
  if (!failed.length) return '';
  const reason = failed[0].reason?.message || (typeof failed[0].reason === 'string' ? failed[0].reason : '');
  return `${failed.length} of ${total} ticket${total === 1 ? '' : 's'} could not be ${verb}${reason ? `: ${reason}` : '.'}`
    + (failed.length < total ? ' The rest went through; the ones that failed are still selected.' : '');
}
function reportBulkFailure(results, total, verb) {
  const msg = bulkFailureMessage(results, total, verb);
  if (msg) appDialog.alert(msg, { title: 'Some Tickets Not Changed' });
}
