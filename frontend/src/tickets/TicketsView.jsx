// Ticket Module - the support/IT request list.
//
// Split out of the task module (Jul 2026, "Option A"): the ticket files live
// here, but ticket state is still held in TasksContext and the shared UI atoms
// and theme still come from ../tasks - so the task module itself is untouched.
// Ticket statuses get their own color map here (STATUS_META in tasks/theme.js
// is for tasks, not tickets). Inline-styled to match the rest of the app.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Plus, Search, Trash2, CheckCircle2, X, Download, List as ListIcon, Columns3, BarChart3, ChevronDown } from 'lucide-react';
import TicketToken from '../components/icons/TicketToken';
import { api } from '../api';
import { useTasks } from '../tasks/TasksContext';
import { useRole } from '../contexts/RoleContext';
import { takePendingOpen } from '../lib/pendingOpen';
import { peekDraft } from './recordingDraft';
import { NX, FONT, btn, input as inputStyle, PRIORITY_META } from '../tasks/theme';
import { EmptyState, usePeople, useIsMobile } from '../tasks/components';
import { dialog as appDialog } from '../ui/dialog';
import MobileTaskBar from '../tasks/MobileTaskBar';
import { useTableColumns } from '../tasks/tableCols';
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
  TicketMobileFilters, TicketFilterMenu, MoreMenu, SaveViewDialog, TicketColumnsMenu,
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
  // Requests parked on my approval - same reasoning: count the queue, not the view.
  const approvalCount = useMemo(() => {
    const me = (myEmail || '').toLowerCase();
    if (!me) return 0;   // "" must never match "no approver named yet"
    return tickets.filter((t) => t.approvalStatus === 'pending'
      && (t.approverId || '').toLowerCase() === me).length;
  }, [tickets, myEmail]);
  // The IT Admin desk's own queue: gated requests that have landed but not yet
  // been sent to anyone. Without a tab these live only in the bell, and a bell
  // that has been dismissed is not a queue.
  const routeCount = useMemo(() => (itAdmin
    ? tickets.filter((t) => t.approvalStatus === 'pending' && !t.approverId).length
    : 0), [tickets, itAdmin]);
  const [scope, setScope] = useState('all');   // all | mine (requester) | assigned | approve | route
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
  const [view, setView] = useState('list');   // 'list' | 'board' | 'reports'
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  // Which drawer tab to land on - the Latest Comment cell opens straight onto
  // the Conversation (Neil, Oct 1).
  const [openTab, setOpenTab] = useState(null);
  const openTicket = useCallback((id, tab = null) => { setOpenTab(tab); setOpenId(id); }, []);
  // What the open drawer holds unsaved (TicketDrawer keeps it current), and
  // which ticket that is - read by the bell's open-ticket handler below.
  const drawerDirtyRef = useRef(false);
  const openIdRef = useRef(openId);
  useEffect(() => { openIdRef.current = openId; }, [openId]);
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
      setView('reports');
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
    const openTicket = async (e) => {
      const id = e.detail?.ticketId;
      if (!id || id === openIdRef.current) return;
      if (drawerDirtyRef.current && !(await confirmSwitchTicket())) return;
      setOpenTab(null);
      setOpenId(id);
    };
    window.addEventListener('nexus:open-ticket', openTicket);
    // This module is lazy(), so on a first visit the event above has already
    // fired by the time we get here - the bell leaves the id behind for us.
    const pending = takePendingOpen('ticket');
    if (pending) setOpenId(pending);
    return () => window.removeEventListener('nexus:open-ticket', openTicket);
  }, []);

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
  // column set entirely on My Requests (rather than being hidden per-row), so
  // the grid template - and the reorder/resize state - never has to know about it.
  const columnDefs = useMemo(
    () => TICKET_COLUMNS.filter((c) => !(scope === 'mine' && c.key === 'requester'))
      .map((c) => (c.shrink ? { ...c, template: `minmax(${c.shrink}px, ${c.width}fr)` } : c)),
    [scope],
  );
  const { cols, widths, template, startResize, resetWidth, autofitWidth, wrapRef, dragProps, hidden, toggleHidden } = useTableColumns({
    table: 'tickets', cols: columnDefs,
  });
  // Completed tickets (resolved/closed) collapse into their own section below
  // the main list (Pranshu, Sept 8 2026) rather than sitting inline with the
  // work still in flight. Collapsed on EVERY visit (Neil, Oct 13 2026: "make
  // sure the completed section is collapsed by default so it doesn't add to
  // the confusion") - opening it is for this visit only. It used to be a saved
  // preference, so one click left it open on every screen from then on.
  const [completedCollapsed, setCompletedCollapsed] = useState(true);
  const toggleCompleted = () => setCompletedCollapsed((c) => !c);

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

  // Column sort - click a header to sort by it, click again to flip direction.
  const [sort, setSort] = useState({ key: 'created', dir: 'desc' });
  const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  // Saved views - snapshot the current filter set + grouping + view kind.
  const applyTicketView = (v) => {
    const f = v.filters || {};
    setScope(f.scope ?? 'all'); setStatusFilter(f.statusFilter ?? 'all'); setPriorityFilter(f.priorityFilter ?? 'all');
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
    if (f.sort?.key) setSort({ key: f.sort.key, dir: f.sort.dir === 'asc' ? 'asc' : 'desc' });
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
    filters: { scope, statusFilter, priorityFilter, typeFilter, slaFilter, serviceAreaFilter, assigneeFilter, hrDeptFilter, search, sort },
  });
  const removeTicketView = async (v) => {
    if (!(await appDialog.confirm(`Delete the saved view "${v.name}"?`, { title: 'Delete Saved View', confirmText: 'Delete', danger: true }))) return;
    try { await deleteTicketView(v.id); }
    catch (e) { appDialog.alert(`Could not delete the view: ${e?.message || e}`); }
  };

  const visible = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    const me = (myEmail || '').toLowerCase();
    return tickets.filter((t) => {
      if (scope === 'mine' && (t.requesterId || '').toLowerCase() !== me) return false;
      if (scope === 'assigned' && (t.assigneeId || '').toLowerCase() !== me) return false;
      // Approval queue: requests parked on my decision.
      if (scope === 'approve' && !(t.approvalStatus === 'pending'
        && (t.approverId || '').toLowerCase() === me)) return false;
      // Routing queue (IT Admin): gated requests nobody has been asked to sign off yet.
      if (scope === 'route' && !(t.approvalStatus === 'pending' && !t.approverId)) return false;
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
  }, [tickets, scope, myEmail, searchQ, statusFilter, priorityFilter, typeFilter, slaFilter, nameOf, hrDeptFilter, assigneeFilter, serviceAreaFilter, deskFilter]);

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
    // Phones sort by due date from a picker with no "reverse" - undated
    // tickets (still awaiting approval, no SLA) go last either way, so the
    // ones actually due soonest lead. Desktop keeps its header behavior.
    const undatedLast = isMobile && col.key === 'due';
    return [...list].sort((a, b) => {
      const av = col.sort(a, ctx); const bv = col.sort(b, ctx);
      if (undatedLast && (!av || !bv)) return av === bv ? 0 : (!av ? 1 : -1);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, nameOf, companies, isMobile]);

  // Completed (resolved/closed) tickets never sit inline with the ones still in
  // flight - they collapse into their own section at the bottom (see
  // toggleCompleted above). The one exception: someone who has explicitly
  // filtered down to exactly Resolved or Closed asked to SEE those tickets, so
  // hiding them behind a collapsed toggle would bury the very thing they asked
  // for - the partition is skipped and they render as the main (only) list.
  const statusFilterIsClosedOnly = statusFilter === 'resolved' || statusFilter === 'closed';
  // Memoized: unmemoized, both were new arrays every render, which re-ran the
  // sorts below (and re-rendered every row) on any state change at all.
  const [mainVisible, completedVisible] = useMemo(() => (statusFilterIsClosedOnly ? [visible, []]
    : [visible.filter((t) => !CLOSED_STATES.includes(t.status)), visible.filter((t) => CLOSED_STATES.includes(t.status))]),
  [visible, statusFilterIsClosedOnly]);
  const sortedVisible = useMemo(() => sortTickets(mainVisible), [mainVisible, sortTickets]);
  const sortedCompleted = useMemo(() => sortTickets(completedVisible), [completedVisible, sortTickets]);

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
  const toggleBtn = (on) => ({ ...btn('ghost'), padding: '6px 10px', borderRadius: 7, gap: 6, background: on ? NX.surface : 'transparent', color: on ? NX.ink : NX.dim, boxShadow: on ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' });

  // Bulk selection (list view only). Selection is cleared when it no longer matches.
  const toggleSel = useCallback((id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const clearSel = () => setSelected(new Set());
  const selIds = [...selected].filter((id) => visible.some((t) => t.id === id));
  // Select-all - the rows actually on screen: each group's first 200, plus
  // the Completed section only while it is open. It used to take every
  // filtered ticket, so a bulk Delete also hit the collapsed Completed ones
  // nobody could see (Oct 2026 review).
  const allVisibleIds = useMemo(() => [
    ...groups.flatMap((g) => g.rows.slice(0, 200)),
    ...(completedCollapsed ? [] : sortedCompleted.slice(0, 200)),
  ].map((t) => t.id), [groups, completedCollapsed, sortedCompleted]);
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

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', position: 'relative' }}>
      {/* Header - two rows, matching the task module: title + primary action, then
          a bordered tab strip with the toolbar on its right. On phones the tabs,
          filters and New Ticket move into the floating MobileTaskBar. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: isMobile ? '12px 12px 8px' : '18px 24px 12px', flexWrap: 'wrap', background: NX.surface }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ fontSize: isMobile ? 19 : 22, fontWeight: 700 }}>Tickets</span>
          <span style={{ padding: '2px 9px', borderRadius: 12, background: NX.border2, color: NX.dim, fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{visible.length}</span>
        </div>
        {/* Manage sits beside New Ticket rather than in a bar of its own -
            one header line for the module's two top-level actions, the
            everyday one (create) first. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          {/* "Create", not "New Ticket" - the same word the Task module's bar
              button uses, and the page it sits on already says Tickets
              (Sagar, Sept 2 2026). */}
          {!isMobile && (
            <span data-tour="ticket-create">
              <button style={btn('primary')} onClick={() => setCreating(true)}><Plus size={15} /> Create</button>
            </span>
          )}
        </div>
      </div>

      {/* Phones keep a scope strip under the title (the desktop scope pills
          moved into the toolbar row, which doesn't render on mobile). */}
      {isMobile && (
        <div data-tour="ticket-scope" className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, margin: '0 12px 8px', overflowX: 'auto' }}>
          {[['all', 'All'], ['mine', 'Mine'], ['assigned', 'Assigned'],
            ...(routeCount > 0 ? [['route', `To Route (${routeCount})`]] : []),
            ...(approvalCount > 0 ? [['approve', `To Approve (${approvalCount})`]] : [])].map(([k, lab]) => (
            <button key={k} onClick={() => setScope(k)} style={{ ...toggleBtn(scope === k), whiteSpace: 'nowrap' }}>{lab}</button>
          ))}
        </div>
      )}
      {/* Phone search - the same `search` state as the desktop toolbar's box,
          which does not render here. 16px so iOS does not zoom the page on
          focus; the clear button is a full 32px target. type="text" (with
          inputMode="search") rather than type="search", whose native cancel
          button would sit beside our own X on Chrome/Android. */}
      {isMobile && (
        <div style={{ position: 'relative', margin: '0 12px 8px' }}>
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

      {!isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${NX.border}`, padding: '0 24px', flexWrap: 'wrap', background: NX.surface }}>
          {/* Row 2 pairs the two mode controls: scope (WHICH tickets) first,
              then view (HOW they're shown) - row 1 stays title + New Ticket,
              matching My Tasks' header anatomy. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div data-tour="ticket-scope" className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, margin: '8px 0', overflowX: 'auto', flexShrink: 1, minWidth: 0 }}>
              {[['all', 'All'], ['mine', 'My Requests'], ['assigned', 'Assigned to Me'],
                ...(routeCount > 0 ? [['route', `To Route (${routeCount})`]] : []),
                ...(approvalCount > 0 ? [['approve', `To Approve (${approvalCount})`]] : [])].map(([k, lab]) => (
                <button key={k} onClick={() => setScope(k)} style={{ ...toggleBtn(scope === k), whiteSpace: 'nowrap' }}>{lab}</button>
              ))}
            </div>
            <span style={{ width: 1, height: 20, background: NX.border, flexShrink: 0 }} />
            <div data-tour="ticket-views" className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, margin: '8px 0', overflowX: 'auto', flexShrink: 0 }}>
              {TICKET_VIEW_TABS.map((tb) => (
                <button key={tb.key} onClick={() => setView(tb.key)} title={tb.label} style={{
                  ...btn('ghost'), padding: '6px 10px', borderRadius: 7, whiteSpace: 'nowrap',
                  background: view === tb.key ? NX.surface : 'transparent', color: view === tb.key ? NX.ink : NX.dim,
                  boxShadow: view === tb.key ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                }}><tb.icon size={15} /> {tb.label}</button>
              ))}
            </div>
          </div>
          <div data-tour="ticket-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: 210 }}>
              <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tickets…" style={{ ...inputStyle, paddingLeft: 32 }} />
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
            <button
              onClick={() => downloadTicketsCsv([...sortedVisible, ...sortedCompleted], nameOf, companyName, hrDeptName)}
              style={{ ...btn('outline'), padding: '7px 11px', fontSize: 13 }}
              title="Export the currently filtered tickets to CSV"
            >
              <Download size={15} />Export
            </button>
            {privileged && <SuggestPropertyLinksButton style={{ ...btn('outline'), padding: '7px 11px', fontSize: 13 }} />}
            <MoreMenu views={ticketViews} onApply={applyTicketView} onSave={() => setNamingView(true)} onDelete={removeTicketView}
              groupBy={groupBy} setGroupBy={setGroupBy} showGroup={view === 'list'} />
            {view === 'list' && (
              <TicketColumnsMenu columns={columnDefs} hidden={hidden} toggleHidden={toggleHidden} cols={cols} />
            )}
          </div>
        </div>
      )}

      {deskFilter === 'hr' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: NX.ink,
            background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.28)', borderRadius: 999, padding: '4px 6px 4px 11px' }}>
            HR Requests
            <button type="button" aria-label="Show All Tickets" title="Show All Tickets" onClick={() => setDeskFilter('all')}
              style={{ ...btn('ghost'), padding: 2, borderRadius: 999 }}><X size={13} /></button>
          </span>
          <span style={{ fontSize: 12, color: NX.faint }}>Confidential Ask HR requests - only their people and HR see them.</span>
        </div>
      )}

      {/* Status summary tiles (owner's chosen Order-list concept): colored
          header band + count + caption. Every tile is a real filter action.

          Open + Resolved + Closed PARTITION the board - every ticket is in
          exactly one, and the three sum to the total. Unassigned and SLA
          breached are overlays ON Open, so they deliberately double-count.
          Closed was missing, which left finished tickets in no card at all and
          made the numbers look like they did not add up. */}
      {!isMobile && view !== 'reports' && (() => {
        const openCount = tickets.filter((t) => !CLOSED_STATES.includes(t.status)).length;
        const breachedCount = tickets.filter((t) => slaState(t) === 'breached').length;
        const resolvedCount = tickets.filter((t) => t.status === 'resolved').length;
        const closedCount = tickets.filter((t) => t.status === 'closed').length;
        // Live tickets with nobody on them. Closed ones are excluded - a closed
        // ticket having no assignee is not work waiting for someone.
        const unassignedCount = tickets.filter(
          (t) => !t.assigneeId && !CLOSED_STATES.includes(t.status)).length;
        // White cards with a dot (Neil, Oct 14 2026) - the tinted header bands
        // made a row of five different colors. Only Unassigned and SLA
        // Breached color their number, and only when it is above zero; the
        // selected tile takes the Nexus green outline.
        // `urgent` (Neil, Oct 14): with a count, the whole tile turns into a
        // call to act - tinted and bordered in its color, an Action Required
        // line in place of the quiet subtitle - so an unassigned ticket cannot
        // be read past. Empty, it sits as quietly as the others.
        const tile = (label, dot, n, sub, onGo, active, alarm, urgent) => {
          const act = urgent && n > 0;
          const ring = active ? 'var(--wk-brand, #15803d)' : act ? dot : NX.border;
          return (
          <button key={label} onClick={onGo} aria-pressed={active} data-action-required={act ? '' : undefined}
            style={{ textAlign: 'left', border: `1px solid ${ring}`, borderRadius: 12, background: act ? `color-mix(in srgb, ${dot} 12%, ${NX.surface})` : NX.surface, cursor: 'pointer', fontFamily: FONT, padding: '11px 14px 12px', boxShadow: active ? '0 0 0 1px var(--wk-brand, #15803d)' : act ? `0 0 0 1px ${dot}` : 'none', transition: 'transform .15s, box-shadow .15s', display: 'flex', flexDirection: 'column', gap: 4 }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 20px rgba(0,0,0,.08)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = active ? '0 0 0 1px var(--wk-brand, #15803d)' : act ? `0 0 0 1px ${dot}` : 'none'; }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: act ? NX.ink : NX.dim }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />{label}
            </span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 800, color: (alarm || act) && n > 0 ? dot : NX.ink, fontVariantNumeric: 'tabular-nums' }}>{n}</span>
              {act
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: dot }}><AlertTriangle size={12} /> Action Required</span>
                : <span style={{ fontSize: 12, color: NX.faint }}>{sub}</span>}
            </span>
          </button>
          );
        };
        return (
          <div data-tour="ticket-tiles" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, padding: '14px 24px 0', background: NX.canvas }}>
            {/* Every tile counts the WHOLE workspace, so every tile clears the
                scope on the way in - otherwise a card reading 4 opens a list of
                1 because "My Requests" was still selected, and the number looks
                broken. */}
            {/* The Open status color (ticketMeta's TICKET_STATUS_META) - not
                blue, which no status uses any more (Neil, Oct 1). */}
            {/* Unassigned leads the row, in yellow (Pranshu, Oct 6): the major
                item - tickets nobody is working - so it is the first thing
                the desk sees, the whole card tinted, not only its band. */}
            {tile('Unassigned', NX.amber, unassignedCount, 'nobody working them',
              () => { setScope('all'); setSlaFilter('all'); setStatusFilter(statusFilter === 'unassigned' ? 'all' : 'unassigned'); },
              statusFilter === 'unassigned', true, true)}
            {tile('Open', TICKET_STATUS_META.open.color, openCount, 'not yet resolved',
              () => { setScope('all'); setSlaFilter('all'); setStatusFilter(statusFilter === 'open' ? 'all' : 'open'); },
              statusFilter === 'open')}
            {tile('SLA Breached', NX.red, breachedCount, 'past their target',
              () => { setScope('all'); setStatusFilter('all'); setSlaFilter(slaFilter === 'breached' ? 'all' : 'breached'); },
              slaFilter === 'breached', true)}
            {tile('Resolved', TICKET_STATUS_META.resolved.color, resolvedCount, 'awaiting closure',
              () => { setScope('all'); setSlaFilter('all'); setStatusFilter(statusFilter === 'resolved' ? 'all' : 'resolved'); },
              statusFilter === 'resolved')}
            {tile('Closed', TICKET_STATUS_META.closed.color, closedCount, 'done and filed',
              () => { setScope('all'); setSlaFilter('all'); setStatusFilter(statusFilter === 'closed' ? 'all' : 'closed'); },
              statusFilter === 'closed')}
          </div>
        );
      })()}

      {/* Body. Desktop: paddingBottom leaves room under the last row. Phones:
          a small paddingBottom only - the ticket-bar-spacer at the end of the
          body clears the floating MobileTaskBar, so a larger value here would
          stack on top of it. */}
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
          <EmptyState icon={TicketToken} title={tickets.length ? 'No Tickets' : 'No Tickets Yet'}
            hint={tickets.length ? 'No tickets match your filters.' : `Nothing has been submitted so far. ${isMobile ? 'Tap + below' : 'Choose Create'} to report a problem or ask for help.`} />
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
            {/* Resolved/closed tickets collapse into their own section instead of
                sitting inline with the ones still in flight - see toggleCompleted. */}
            {sortedCompleted.length > 0 && (
              <div className="nx-edge-card" style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, overflow: 'hidden' }}>
                <button onClick={toggleCompleted} aria-expanded={!completedCollapsed} style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 16px', background: NX.surface2,
                  border: 'none', borderBottom: completedCollapsed ? 'none' : `1px solid ${NX.border2}`, cursor: 'pointer', fontFamily: FONT, textAlign: 'left',
                }}>
                  <ChevronDown size={15} style={{ color: NX.faint, flexShrink: 0, transform: completedCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s' }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>Completed</span>
                  <span style={{ fontSize: 12, color: NX.faint, fontWeight: 400 }}>{sortedCompleted.length}</span>
                </button>
                {!completedCollapsed && sortedCompleted.slice(0, 200).map((t, idx) => (
                  <TicketRow key={t.id} t={t} nameOf={nameOf} hrDeptName={hrDeptName} companyName={companyName}
                    myEmail={myEmail} privileged={privileged} updateTicket={guardedUpdate} onOpen={openTicket}
                    people={people}
                    checked={selected.has(t.id)} onToggle={toggleSel} band={idx % 2 === 1} mobile />
                ))}
                {!completedCollapsed && sortedCompleted.length > 200 && <div style={{ padding: '8px 16px', fontSize: 12, color: NX.faint }}>+ {sortedCompleted.length - 200} more - filter to narrow down</div>}
              </div>
            )}
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
                    people={people}
                      checked={selected.has(t.id)} onToggle={toggleSel} cols={cols} band={idx % 2 === 1} />
                  ))}
                  {g.rows.length > 200 && <div style={{ padding: '8px 16px', fontSize: 12, color: NX.faint }}>+ {g.rows.length - 200} more - filter to narrow down</div>}
                </div>
              ))}
              {/* Resolved/closed tickets collapse into their own section instead
                  of sitting inline with the ones still in flight (Pranshu, Sept
                  8 2026) - see toggleCompleted above. */}
              {sortedCompleted.length > 0 && (
                <div>
                  <button onClick={toggleCompleted} aria-expanded={!completedCollapsed} style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 16px', background: NX.surface2,
                    border: 'none', borderTop: `1px solid ${NX.border}`, borderBottom: completedCollapsed ? 'none' : `1px solid ${NX.border2}`,
                    cursor: 'pointer', fontFamily: FONT, textAlign: 'left',
                  }}>
                    <ChevronDown size={15} style={{ color: NX.faint, flexShrink: 0, transform: completedCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s' }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>Completed</span>
                    <span style={{ fontSize: 12, color: NX.faint, fontWeight: 400 }}>{sortedCompleted.length}</span>
                  </button>
                  {!completedCollapsed && sortedCompleted.slice(0, 200).map((t, idx) => (
                    <TicketRow key={t.id} t={t} nameOf={nameOf} hrDeptName={hrDeptName} companyName={companyName}
                    myEmail={myEmail} privileged={privileged} updateTicket={guardedUpdate} onOpen={openTicket}
                    people={people}
                      checked={selected.has(t.id)} onToggle={toggleSel} cols={cols} band={idx % 2 === 1} />
                  ))}
                  {!completedCollapsed && sortedCompleted.length > 200 && <div style={{ padding: '8px 16px', fontSize: 12, color: NX.faint }}>+ {sortedCompleted.length - 200} more - filter to narrow down</div>}
                </div>
              )}
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
      {openId && <TicketDrawer key={openId} ticketId={openId} initialTab={openTab} dirtyRef={drawerDirtyRef} onClose={() => { setOpenId(null); setOpenTab(null); }} />}
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
          steps={buildTicketTourSteps({ setScope, setView, isMobile })}
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
