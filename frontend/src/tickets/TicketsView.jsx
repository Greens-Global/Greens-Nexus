// Ticket Module - the support/IT request list.
//
// Split out of the task module (Jul 2026, "Option A"): the ticket files live
// here, but ticket state is still held in TasksContext and the shared UI atoms
// and theme still come from ../tasks - so the task module itself is untouched.
// Ticket statuses get their own color map here (STATUS_META in tasks/theme.js
// is for tasks, not tickets). Inline-styled to match the rest of the app.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Plus, Pencil, Search, Trash2, CheckCircle2, ClipboardList, Paperclip, X, Download, MessageSquare, Zap, History, List as ListIcon, Columns3, BarChart3, ArrowUp, ChevronDown, Lock, MousePointer2 } from 'lucide-react';
import TicketToken from '../components/icons/TicketToken';
import { api } from '../api';
import { useTasks } from '../tasks/TasksContext';
import { useRole } from '../contexts/RoleContext';
import LiveView from '../components/LiveView';
import { richBodyHtml, externalizeInlineImages } from '../tasks/lib';
import RichDescription, { isEmptyDoc } from '../tasks/RichDescription';
import { takePendingOpen } from '../lib/pendingOpen';
import { formatDateTime } from '../lib/datetime';
import { peekDraft, setOpenTicketId, clearOpenTicketId } from './recordingDraft';
import { NX, FONT, chip, btn, input as inputStyle, PRIORITY_META } from '../tasks/theme';
import TaskDetailDrawer from '../tasks/TaskDetailDrawer';
import { Avatar, PriorityChip, EmptyState, Modal, PersonSelect, usePeople, useIsMobile } from '../tasks/components';
import { dialog as appDialog } from '../ui/dialog';
import MobileTaskBar from '../tasks/MobileTaskBar';
import { useTableColumns } from '../tasks/tableCols';
import {
  fmtDate, TICKET_TYPE_META, TICKET_TYPE_ORDER, TYPE_FIELDS,
  TICKET_RESOLUTION, TICKET_STATUS_META, TICKET_STATUS_ORDER, CLOSED_STATES,
  slaState, fmtDueAt, isBlankFieldValue,
  commentStale, COMMENT_STALE_META, COMMENT_STALE_HOURS,
  label, field, resolutionLabel,
  ticketNo, ticketNoShort, normalizeCode,
  SERVICE_FIELDS, serviceAreaLabel, withDynamicOptions,
  topicQuestionDefs, allTopicQuestionDefs, labelFromKey,
  helpGroupFor,
} from './ticketMeta';
// The help topic's optional "Which one?" level (Neil, Oct 1 2026).
import { HELP_SUBTOPIC_KEY, HELP_SUBTOPIC_LABEL, helpWithLabel } from './ticketMeta';
import { useTicketConfig } from './ticketConfig';
import {
  TypeFieldInput, TicketTypeIcon, SlaBadge, FirstResponseIndicator, TicketStatusChip, TicketSelect, TicketPeopleMultiSelect,
} from './TicketAtoms';
import { SkeletonBlocks } from '../components/AsyncState';
import GuidedTour from '../components/GuidedTour';
import { buildTicketTourSteps } from './ticketTourSteps';
import TicketOpening, { TicketNotFound } from './TicketOpening';
import { confirmSwitchTicket } from './drawerGuard';
import { PropertySelect } from './PropertySelect';
import { TicketPropertyDetail, SuggestPropertyLinksButton } from './TicketPropertyFields';
import { uploadTicketEvidence } from './evidenceUpload';
import { groupTakesProperty } from './propertyMeta';
import { MobileAssignField } from './TicketAssignSheet';
import { useTicketAccess } from './ticketAccess';
import { registerTour } from '../lib/tours';
import TicketReports from './TicketReports';
import { TicketEquipment } from './TicketEquipment';
import { TicketAiSummary, DrawerSuggestedTopic } from './TicketAi';
import {
  TICKET_COLUMNS, useTicketSites, offeredAtIntake, withHelpSubtopic, listedTopic,
  statusOptions, priorityOptions, typeIntakeOptions,
  serviceAreaOptions, ticketRights,
  attachFailed, hasRichText, useCollaboratorExtras, collaboratorOptions,
  needsResolution, readOnlyFieldValue,
} from './ticketViewShared';
import { HelpTopicField } from './HelpTopicField';
import { downloadTicketsCsv } from './ticketExport';
import {
  TicketMobileFilters, TicketFilterMenu, MoreMenu, SaveViewDialog, TicketColumnsMenu,
} from './TicketFilters';
import { ApprovalChip, ApprovalPanel } from './TicketApproval';
import { TicketListHeader, TicketRow } from './TicketList';
import { TicketActionDialog } from './TicketActionDialog';
import { CreateTicketModal } from './CreateTicketModal';
import { TicketTasks, TicketLinks, SatisfactionCard, CsatWidget } from './TicketDrawerCards';
import { TicketConversation } from './TicketConversation';
import { TicketAttachments } from './TicketAttachments';

// Re-exported: tests and other modules import these from TicketsView.
export { TicketActionDialog, CreateTicketModal };

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
    setSearch(f.search ?? '');
    if (f.sort?.key) setSort({ key: f.sort.key, dir: f.sort.dir === 'asc' ? 'asc' : 'desc' });
    if (v.group) setGroupBy(v.group);
    if (v.view) setView(v.view);
  };
  // The phone filter sheet's Clear All - every filter back to 'all'. Scope,
  // search, sort and grouping are not filters and stay as they are.
  const clearFilters = () => {
    setStatusFilter('all'); setPriorityFilter('all'); setTypeFilter('all'); setSlaFilter('all');
    setHrDeptFilter('all'); setServiceAreaFilter('all'); setAssigneeFilter('all');
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
  }, [tickets, scope, myEmail, searchQ, statusFilter, priorityFilter, typeFilter, slaFilter, nameOf, hrDeptFilter, assigneeFilter, serviceAreaFilter]);

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
  // The row's Mark Resolved: `mode` is 'self_resolve' for the requester (an
  // optional "What fixed it?") or 'resolve' for the desk (a written resolution).
  const requestResolve = useCallback((tk, mode = 'resolve') => setResolveReq({ ids: [tk.id], status: 'resolved', mode }), []);
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
                    onResolve={requestResolve} people={people}
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
                    onResolve={requestResolve} people={people}
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
                    onResolve={requestResolve} people={people}
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
                    onResolve={requestResolve} people={people}
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
export function TicketDrawer({ ticketId, onClose, startEditing = false, initialTab = null, dirtyRef = null }) {
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
    return ticketsLoaded && (refetch === 'done' || !reloadTickets)
      ? <TicketNotFound onClose={onClose} /> : <TicketOpening onClose={onClose} />;
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
  const privileged = myLevel >= 3 || deskAccess.privileged;   // + Global Admins (server's _ticket_privileged)
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
  const canEditCompany = privileged || (!requesterLocked && !locked && isRequester);
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
  const canDelete = deskAccess.canDelete && (privileged || (!requesterLocked && isRequester));
  // Collaborators (Oct 14 2026): whoever may edit the ticket at all - its
  // requester or the desk - may add or remove them, whatever its state. They
  // are not the ticket's content, so neither lock above applies (mirrors
  // _COLLABORATOR_FIELDS in routers/tickets.py).
  const canEditCollaborators = privileged || isRequester || deskAccess.canWorkQueue;
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
    if (saving) return;
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
  return (
    <>
    {/* No width override - the Modal default (clamp(520px, 60vw, 980px)) is
        the shared "big form" sizing used across the app; the fixed 620px this
        used to pass read as a cramped tab next to that (Pranshu, Sept 8 2026). */}
    {/* While a linked task is open on top, Escape (which Modal also listens
        for) closes the task first rather than the ticket underneath it. */}
    <Modal title={ticketNo(t.code) || 'Ticket'} onClose={() => (openTaskId ? closeTask() : closeDrawer())} footer={
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
        <button style={{ ...btn('primary'), opacity: saving ? 0.6 : 1 }} onClick={done} disabled={saving}
          title={dirty ? 'Save every change and send one update to the requester' : undefined}>
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

      {/* Approval gate - the decision blocks triage, so it leads the drawer,
          always visible regardless of which tab is open. */}
      <ApprovalPanel ticket={t} myEmail={myEmail} nameOf={nameOf} onDecided={onDecided} />

      {/* AI Summary - desk agents only, hidden when AI is off (TicketAi.jsx). */}
      <TicketAiSummary ticketId={t.id} canWorkQueue={deskAccess.canWorkQueue} />

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
            style={sel} disabled={!canWorking} />
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
            disabled={!v.companyId || !canWorking} searchPlaceholder="Search departments…"
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
          {fullAccess ? (
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
          {fullAccess && !('hrDepartmentId' in pending) && (
            <DrawerSuggestedTopic ticketId={t.id} hasTopic={!!(v.application || '').trim()} canWorkQueue={deskAccess.canWorkQueue}
              onApply={(name) => stage({ application: name })} />
          )}
        </div>
        {/* Property Tickets (Neil, 10/05). Same edit rule as Help With: the
            backend leaves property_asset_id out of _WORKING_FIELDS. A
            Resolved/Closed ticket is that property's maintenance record, so
            it moves only after a reopen (the server refuses it too). */}
        {(v.propertyAssetId || (fullAccess && groupTakesProperty(helpGroupFor(allDepts.find((d) => d.id === v.hrDepartmentId)?.name || '')))) && (
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
        <TicketPropertyDetail v={v} canEdit={fullAccess} stage={stage} style={sel} />
        {/* Derived from the application by the server, and re-derived whenever
            it changes. A manager can still override it here for an app the
            directory has mapped wrongly - correcting the mapping itself is a
            job for the External Links screen. */}
        <div style={field}>
          <label style={label}>Service Area</label>
          {fullAccess ? (
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
            reply={reply} onReplyChange={setReply} onDone={done}
            // The public-reply / internal-note switch is the desk's. The person
            // who raised the ticket just replies (Neil, Sep 30: "they should
            // not see public reply versus an internal note").
            canInternal={(privileged || isAssignee || !isRequester) && deskAccess.canReadInternal}
            canDelete={deskAccess.canDelete}
            // Saved Replies are the desk's (Oct 2026) - never the requester view.
            savedReplies={deskAccess.canWorkQueue && (privileged || isAssignee || !isRequester)}
            ticket={t} myEmail={myEmail} />
        )}
        {tab === 'attachments' && <TicketAttachments ticketId={t.id} ticketType={t.type} canDelete={deskAccess.canDelete} />}
        {tab === 'activity' && <TicketActivity ticketId={t.id} nameOf={nameOf} companies={companies} allDepts={allDepts} />}
      </div>
    </Modal>
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

// The field key from a "created" snapshot's typeFields (see _ticket_snapshot
// in backend/routers/tickets.py) back to its question definition, so the
// snapshot can use the SAME label the Overview tab shows for that field
// today - checked against the type's own fields first, then every service
// question (an app/type re-pick since then can leave a key that no longer
// belongs to either, but the snapshot must still show what was asked at the
// time), falling back to the raw key if nothing matches at all.
function auditFieldDef(type, key) {
  return (TYPE_FIELDS[type] || []).find((f) => f.key === key)
    || allTopicQuestionDefs().find((f) => f.key === key)
    || Object.values(SERVICE_FIELDS).flat().find((f) => f.key === key)
    || (key === HELP_SUBTOPIC_KEY ? { key, label: HELP_SUBTOPIC_LABEL, type: 'text' } : null)
    || { key, label: key.startsWith('svc_') ? labelFromKey(key) : key, type: 'text' };
}

// The original submission, exactly as raised - see _ticket_snapshot on the
// backend. A permanent, un-editable audit copy: if a requester's mistake in
// any of these gets corrected later, this card is the proof of what the
// ticket originally said (Pranshu, Sept 8 2026).
function CreatedSnapshotCard({ snapshot, nameOf, companies, allDepts }) {
  const rows = [
    ['Type', TICKET_TYPE_META[snapshot.type]?.label || snapshot.type || '-'],
    ['Priority', PRIORITY_META[snapshot.priority]?.label || snapshot.priority || '-'],
    ['Help With', snapshot.application || '-'],
    ['Service Area', serviceAreaLabel(snapshot.serviceArea) || '-'],
    ['Department', allDepts.find((d) => d.id === snapshot.hrDepartmentId)?.name || '-'],
    ['Company', companies.find((c) => c.id === snapshot.companyId)?.name || '-'],
  ];
  const tfKeys = Object.keys(snapshot.typeFields || {});
  return (
    <div style={{ border: `1px dashed ${NX.border}`, borderRadius: 10, padding: 12, background: NX.surface2 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: NX.dim, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ClipboardList size={13} /> Original request (unedited)
      </div>
      <div style={{ marginBottom: snapshot.description ? 8 : 4 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: NX.faint, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Title</div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: NX.ink }}>{snapshot.subject || '-'}</div>
      </div>
      {hasRichText(snapshot.description) && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: NX.faint, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Description</div>
          <div className="nx-rich-body" style={{ fontSize: 13, color: NX.dim }}
            dangerouslySetInnerHTML={{ __html: richBodyHtml(snapshot.description, nameOf) }} />
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', fontSize: 12.5 }}>
        {rows.map(([k, v]) => (
          <div key={k}><span style={{ color: NX.faint }}>{k}: </span><span style={{ color: NX.ink }}>{v}</span></div>
        ))}
        {tfKeys.map((k) => {
          const f = auditFieldDef(snapshot.type, k);
          return (
            <div key={k}><span style={{ color: NX.faint }}>{f.label}: </span><span style={{ color: NX.ink }}>{readOnlyFieldValue(f, snapshot.typeFields[k], nameOf)}</span></div>
          );
        })}
      </div>
    </div>
  );
}

// ── Activity log ─────────────────────────────────────────────────────────────
// Server-side already drops the notification/auto-close "system" bookkeeping
// (ticket_notify.py) before this ever sees it - what's left is exactly the
// "who changed what, when" trail the ticket asks for: status/priority/
// assignee moves, field corrections (subject/description/department/
// application/service area/resolution/type-specific answers), comments,
// attachments and approvals, each with a real actor and timestamp. The
// "created" entry is the one exception - rendered as the original-submission
// audit card above, not a one-line "created this ticket".
function TicketActivity({ ticketId, nameOf, companies = [], allDepts = [] }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.getTicketActivity(ticketId).then(setRows).catch(() => setRows([])); }, [ticketId]);
  if (rows === null) return <div style={{ padding: '6px 0' }}><SkeletonBlocks count={4} height={44} /></div>;
  if (rows.length === 0) return <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>No activity yet.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((a) => {
        // A row logged before this snapshot existed just has the old plain
        // "created this ticket" text - shown as a normal line rather than a
        // broken card when it isn't valid JSON.
        let snapshot = null;
        if (a.type === 'created') {
          try { snapshot = JSON.parse(a.detail); } catch { /* pre-existing plain-text row */ }
        }
        // Same fallback for "commented" rows logged before the preview
        // existed - those are still the old plain "commented" / "added an
        // internal note" string and render as-is.
        let comment = null;
        if (a.type === 'commented') {
          try { comment = JSON.parse(a.detail); } catch { /* pre-existing plain-text row */ }
        }
        // A deleted comment is logged as JSON too ({internal, text, ...}) -
        // never with the comment's words; show its `text` and the Internal chip.
        let removed = null;
        if (a.type === 'comment_deleted') {
          try { removed = JSON.parse(a.detail); } catch { /* plain-text row */ }
        }
        // Default assignee (Oct 2026): written by Nexus, not by a person, so
        // the line is the sentence itself - "Assigned to Sam Patel
        // automatically (help topic: Printer or Scanner)".
        if (a.type === 'auto_assigned' || a.type === 'auto_assign_gap') {
          const gap = a.type === 'auto_assign_gap';
          return (
            <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <span aria-hidden style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0,
                background: gap ? 'rgba(245,158,11,0.16)' : NX.surface2, color: gap ? NX.amber : NX.dim }}>
                {gap ? <AlertTriangle size={12} /> : <Zap size={12} />}
              </span>
              <span style={{ color: gap ? NX.amber : NX.dim, fontWeight: gap ? 600 : 400 }}>{a.detail}</span>
              <span style={{ color: NX.faint, marginLeft: 'auto', fontSize: 11, whiteSpace: 'nowrap' }}>{formatDateTime(a.at)}</span>
            </div>
          );
        }
        return (
          <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <Avatar email={a.actorId} name={nameOf(a.actorId)} size={22} />
              <span style={{ color: NX.ink, fontWeight: 600 }}>{nameOf(a.actorId) || a.actorId || 'Someone'}</span>
              <span style={{ color: NX.dim }}>
                {snapshot ? 'created this ticket' : comment ? (comment.internal ? 'added an internal note' : 'commented') : removed ? (removed.text || 'deleted a comment') : a.detail}
              </span>
              {(comment?.internal || removed?.internal) && <span style={{ ...chip(NX.amber, 'rgba(245,158,11,0.16)'), display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '1px 7px' }}><Lock size={10} /> Internal</span>}
              <span style={{ color: NX.faint, marginLeft: 'auto', fontSize: 11, whiteSpace: 'nowrap' }}>{formatDateTime(a.at)}</span>
            </div>
            {snapshot && <CreatedSnapshotCard snapshot={snapshot} nameOf={nameOf} companies={companies} allDepts={allDepts} />}
            {comment && (
              <div style={{
                marginLeft: 30, fontSize: 13, color: NX.ink, whiteSpace: 'pre-wrap', padding: '6px 10px', borderRadius: 8,
                background: comment.internal ? 'rgba(245,158,11,0.08)' : NX.surface2,
                border: `1px solid ${comment.internal ? 'rgba(245,158,11,0.3)' : NX.border2}`,
              }}>{comment.preview}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Kanban board - columns by status, drag a card to change its status ────────
// `mobile` (from TicketsView): HTML5 drag-and-drop does not exist on touch
// screens, so on a phone the cards are not draggable and each carries a Move To
// picker instead - routed through the same onMove (TicketsView's guardedUpdate)
// a drop uses, so moving to Resolved/Closed still asks for the resolution.
// Columns narrow to leave the next one peeking in and snap as they scroll.
// `canMove(t)`: the drawer's status gate (ticketRights.canEditStatus) - a card
// someone may not move is neither draggable nor offered a Move To picker.
function TicketBoard({ tickets, nameOf, onOpen, onMove, mobile = false, canMove = () => true }) {
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  return (
    <div data-testid="ticket-board" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 8,
      ...(mobile ? { scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain' } : null) }}>
      {TICKET_STATUS_ORDER.map((s) => {
        const m = TICKET_STATUS_META[s];
        const col = tickets.filter((t) => t.status === s);
        return (
          <div key={s}
            onDragOver={(e) => { e.preventDefault(); setOver(s); }}
            onDragLeave={() => setOver((o) => (o === s ? null : o))}
            onDrop={() => {
              const dragged = dragId && tickets.find((x) => x.id === dragId);
              if (dragged && dragged.status !== s) onMove(dragId, s);
              setDragId(null); setOver(null);
            }}
            style={{ width: mobile ? 'min(260px, 82vw)' : 260, flexShrink: 0, background: over === s ? `${m.color}12` : NX.surface2, border: `1px solid ${over === s ? m.color : NX.border}`, borderRadius: 12, padding: 8, display: 'flex', flexDirection: 'column', gap: 8,
              ...(mobile ? { scrollSnapAlign: 'start', boxSizing: 'border-box' } : null) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color }} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: NX.ink }}>{m.label}</span>
              <span style={{ fontSize: 12, color: NX.faint, marginLeft: 'auto' }}>{col.length}</span>
            </div>
            {col.slice(0, 100).map((t) => {
              const movable = canMove(t);
              const drag = !mobile && movable;
              return (
              <div key={t.id} draggable={drag} onDragStart={drag ? () => setDragId(t.id) : undefined} onDragEnd={drag ? () => setDragId(null) : undefined} onClick={() => onOpen(t.id)}
                title={!mobile && !movable ? 'You cannot change this ticket\'s status' : undefined}
                style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, padding: 10, cursor: drag ? 'grab' : 'pointer', opacity: dragId === t.id ? 0.5 : 1, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <TicketTypeIcon type={t.type} size={14} />
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: NX.faint }}>{ticketNoShort(t.code)}</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: NX.ink }}>{t.subject}</div>
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <PriorityChip priority={t.priority} />
                    <SlaBadge t={t} compact />
                  </span>
                  {t.assigneeId && <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={20} />}
                </div>
                {mobile && movable && (
                  // A native select: the phone's own picker, which no column or
                  // scroller can clip. Clicks stop here so they never open the card.
                  <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim, whiteSpace: 'nowrap' }}>Move To</span>
                    <select value={t.status} aria-label={`Move ${ticketNoShort(t.code) || 'ticket'} To`}
                      onChange={(e) => { const next = e.target.value; if (next && next !== t.status) onMove(t.id, next); }}
                      style={{ ...inputStyle, flex: 1, minWidth: 0, width: 'auto', fontSize: 16, padding: '6px 8px', minHeight: 36, cursor: 'pointer', appearance: 'auto' }}>
                      {TICKET_STATUS_ORDER.map((st) => <option key={st} value={st}>{TICKET_STATUS_META[st].label}</option>)}
                    </select>
                  </div>
                )}
              </div>
              );
            })}
            {col.length > 100 && <div style={{ fontSize: 11.5, color: NX.faint, textAlign: 'center', padding: '6px 0' }}>+ {col.length - 100} more - filter to narrow down</div>}
            {col.length === 0 && <div style={{ fontSize: 11.5, color: NX.faint, textAlign: 'center', padding: '10px 0' }}>No tickets</div>}
          </div>
        );
      })}
    </div>
  );
}
