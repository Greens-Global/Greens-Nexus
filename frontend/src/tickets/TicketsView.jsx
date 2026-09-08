// Ticket Module - the support/IT request list.
//
// Split out of the task module (Jul 2026, "Option A"): the ticket files live
// here, but ticket state is still held in TasksContext and the shared UI atoms
// and theme still come from ../tasks - so the task module itself is untouched.
// Ticket statuses get their own color map here (STATUS_META in tasks/theme.js
// is for tasks, not tickets). Inline-styled to match the rest of the app.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, Link2, Trash2, CheckCircle2, Clock, ClipboardList, Paperclip, Send, X, Download, MessageSquare, History, List as ListIcon, Columns3, BarChart3, ShieldAlert, ArrowUp, ArrowDown, ArrowUpDown, ChevronDown, Star, Lock, Bookmark, SlidersHorizontal, Image as ImageIcon, ScanText, Camera, ImagePlus, Video, Upload as UploadIcon, Mic, CircleDot, Loader2, Play, MousePointer2, Check } from 'lucide-react';
import TicketToken from '../components/icons/TicketToken';
import { api } from '../api';
import { useTasks } from '../tasks/TasksContext';
import { useRole } from '../contexts/RoleContext';
import LiveView from '../components/LiveView';
import { filesFromPaste, richBodyHtml } from '../tasks/lib';
import RichDescription, { isEmptyDoc } from '../tasks/RichDescription';
import { takePendingOpen, setPendingOpen } from '../lib/pendingOpen';
import { supabase } from '../lib/supabase';
import { formatDateTime } from '../lib/datetime';
import { startScreenRecording, primeReturnCue } from '../lib/screenRecorder';
import {
  stashDraft, appendDraftFile, takeDraft, peekDraft, setDraftUiMounted, finishRecording,
  setOpenTicketId, clearOpenTicketId, isTicketDrawerOpen,
} from './recordingDraft';
import { NX, FONT, chip, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER } from '../tasks/theme';
import { Avatar, PriorityChip, EmptyState, Modal, PersonSelect, usePeople, DateField, useIsMobile, useClickOutside, SearchSelect, UnassignedAvatar, SelectMenu } from '../tasks/components';
import MobileTaskBar, { BottomSheet } from '../tasks/MobileTaskBar';
import { Card, LightBar, Donut } from '../tasks/views/charts';
import { useTableColumns, useTableSetting, ColResizer } from '../tasks/tableCols';
import {
  fmtDate, today, requiredHint, TICKET_TYPE_META, TICKET_TYPE_ORDER, TYPE_FIELDS, NO_RECORDING_TYPES,
  TICKET_RESOLUTION, LINK_TYPES, TICKET_STATUS_META, TICKET_STATUS_ORDER, CLOSED_STATES,
  SLA_TARGET_HOURS, SLA_META, slaState, slaDueFromPriority, isBlankFieldValue, toEmailList,
  commentStale, COMMENT_STALE_META, COMMENT_STALE_HOURS,
  label, field, resolutionLabel, linkTypeLabel, APPROVAL_META, intakeFields,
  ticketNo, ticketNoShort, normalizeCode,
  SERVICE_AREAS, SERVICE_FIELDS, serviceAreaLabel, serviceFields, serviceFieldApplies, withDynamicOptions,
} from './ticketMeta';
import {
  TypeFieldInput, TicketTypeIcon, SlaBadge, TicketStatusChip, TicketSelect,
} from './TicketAtoms';
import { SkeletonBlocks } from '../components/AsyncState';

// Views offered by the mobile bar's view sheet (desktop uses the inline switcher).
const TICKET_VIEW_TABS = [
  { key: 'list', label: 'List', icon: ListIcon },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
];

// Desktop list-view column layout - the single source of truth for widths,
// labels and sort keys, shared by the header (labels + drag handles + sort
// arrows) and every row. `sort` pulls the comparable value off a ticket; `ctx`
// ({ nameOf, companyName }) is threaded in from TicketsView for the
// lookup-backed columns. Order/widths themselves are no longer state on this
// component - useTableColumns (tasks/tableCols.jsx, the same drag-to-reorder/
// resize kit the Task List uses) owns them, persisted to the user's profile
// under table:"tickets" so an arrangement follows them between devices.
// checkbox/type/resolved are `fixed`: structure, not data - they never move.
const TICKET_COLUMNS = [
  { key: 'checkbox', label: '', width: 34, fixed: true },
  { key: 'type', label: '', width: 34, fixed: true },
  { key: 'title', label: 'Title', width: 260, sort: (t) => (t.subject || '').toLowerCase() },
  { key: 'company', label: 'Company', width: 130, sort: (t, ctx) => (ctx.companyName(t.companyId) || '').toLowerCase() },
  // State and Priority each carry a second chip when a ticket needs it
  // (Awaiting approval / SLA breached), so they're sized for the pair - at 150
  // the pair ran past the column and painted over the one after it.
  { key: 'state', label: 'State', width: 180, sort: (t) => TICKET_STATUS_ORDER.indexOf(t.status) },
  { key: 'priority', label: 'Priority', width: 180, sort: (t) => PRIORITY_ORDER.indexOf(t.priority) },
  { key: 'due', label: 'Due Date', width: 110, sort: (t) => t.slaDueOn || '' },
  { key: 'requester', label: 'Requester', width: 150, sort: (t, ctx) => (ctx.nameOf(t.requesterId) || '').toLowerCase() },
  { key: 'assignee', label: 'Assigned To', width: 150, sort: (t, ctx) => (ctx.nameOf(t.assigneeId) || '').toLowerCase() },
  { key: 'created', label: 'Created Date', width: 110, sort: (t) => t.createdAt || '' },
  { key: 'resolved', label: '', width: 24, fixed: true },
];
// ── Applications ─────────────────────────────────────────────────────────────
// The app a ticket is about comes from the External Links directory - the
// rebuilt start.greensglobal.com, which already knows which departments use
// which app and (since this change) which service area each one belongs to.
// Read live: a hardcoded copy would go stale the first time someone adds a
// link in Manage, with nothing to signal that it had.
const OTHER_APP = 'Other / not listed';

function useTicketApps() {
  const [apps, setApps] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getExternalLinks()
      .then((rows) => { if (alive) setApps(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) setApps([]); });
    return () => { alive = false; };
  }, []);
  return apps;
}

// Work-site names for the Facility / Site service questions.
function useTicketSites() {
  const [sites, setSites] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getTicketSites()
      .then((rows) => { if (alive) setSites(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) setSites([]); });
    return () => { alive = false; };
  }, []);
  return sites;
}

// The service area an app belongs to, for the client-side preview of what the
// server will derive on save. "" for no app; an app the directory doesn't know
// (including "Other / not listed") is General - mirrors service_area_for in
// backend/routers/tickets.py.
function areaForApp(apps, application) {
  const name = (application || '').trim();
  if (!name) return '';
  const row = apps.find((a) => (a.name || '').toLowerCase() === name.toLowerCase());
  if (!row) return 'general';
  return row.service_area || 'general';
}

// Searchable app picker, grouped by whether the department that was picked in
// step 1 actually uses the app.
//
// Grouped, never filtered. A hard department filter is a dead end - the app you
// need not being on your department's list would leave you unable to file the
// ticket you came to file - and the two department lists are not even the same
// namespace: External Links carries free-text department strings, a ticket
// routes on an HrDepartment id. So they are matched by name, the matches float
// to the top under their own caption, and everything else stays reachable
// below. No name match just means no grouping, not an empty list.
function ApplicationSelect({ apps, value, onChange, deptName, invalid }) {
  const options = useMemo(() => {
    const dept = (deptName || '').trim().toLowerCase();
    const named = apps.map((a) => a.name).filter(Boolean);
    const uses = (a) => dept && (a.departments || []).some((d) => String(d).trim().toLowerCase() === dept);
    const mine = dept ? apps.filter(uses).map((a) => a.name).filter(Boolean) : [];
    const mineSet = new Set(mine);
    const rest = named.filter((n) => !mineSet.has(n));
    const byName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });
    const opt = (n) => ({ id: n, label: n });
    return [
      ...(mine.length ? [{ id: '__hdr_mine', label: `Used by ${deptName}`, header: true },
        ...mine.slice().sort(byName).map(opt)] : []),
      ...(rest.length ? [...(mine.length ? [{ id: '__hdr_all', label: 'All applications', header: true }] : []),
        ...rest.slice().sort(byName).map(opt)] : []),
      { id: '__hdr_other', label: 'Not on the list', header: true },
      opt(OTHER_APP),
    ];
  }, [apps, deptName]);
  return (
    <SearchSelect
      value={value || ''} options={options} onPick={onChange}
      placeholder="Select application" searchPlaceholder="Search applications…"
      emptyText="No applications in the directory yet."
      buttonStyle={{ ...inputStyle, width: '100%', cursor: 'pointer', justifyContent: 'space-between',
        ...(invalid ? { borderColor: NX.red } : null) }} />
  );
}

// List-view grouping. Carries its own labels rather than title-casing the key,
// which only worked while every dimension happened to be one word.
const GROUP_BY_OPTIONS = [
  { key: 'none', label: 'None' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'type', label: 'Type' },
  { key: 'serviceArea', label: 'Service Area' },
  { key: 'assignee', label: 'Assignee' },
];

// -v2: saved widths win over the defaults, so widening State/Priority above
// would have left everyone who had ever loaded the list on the old, too-narrow
// numbers. Bumping the key retires them once.
// Option lists for the kit dropdowns, in one place - the filter sheet, the
// filter menu, the create wizard and the drawer each used to carry their own
// hand-written <option> list of the same choices.
const statusOptions = () => TICKET_STATUS_ORDER.map((s) => [s, TICKET_STATUS_META[s].label]);
const priorityOptions = () => PRIORITY_ORDER.map((p) => [p, PRIORITY_META[p].label]);
const typeOptions = () => TICKET_TYPE_ORDER.map((ty) => [ty, TICKET_TYPE_META[ty].label]);
const slaFilterOptions = [['all', 'Any SLA'], ['breached', 'SLA breached'], ['at_risk', 'Due soon'], ['ok', 'On track']];
// Open/Unassigned are buckets, not statuses - they must be listed or the
// control renders blank when a summary tile selects one.
const statusFilterOptions = () => [['all', 'All statuses'], ['open', 'Open (not resolved)'],
  ['unassigned', 'Unassigned'], ...statusOptions()];
const serviceAreaOptions = () => SERVICE_AREAS.map((a) => [a.key, a.label]);
const groupByOptions = () => GROUP_BY_OPTIONS.map((g) => [g.key, g.label]);

// Export - same client-side CSV pattern as the task module's own report export
// (tasks/ManageView.jsx downloadCSV): a BOM'd CSV blob opens cleanly in Excel,
// no server round-trip or xlsx binary needed.
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadTicketsCsv(rows, nameOf, companyName, hrDeptName) {
  const headers = ['Code', 'Title', 'Type', 'Application', 'Service Area', 'Company', 'Department', 'State', 'Priority', 'Due Date', 'Requester', 'Assigned To', 'Created Date', 'Resolved At', 'Description'];
  const body = rows.map((t) => [
    ticketNoShort(t.code) || '', t.subject || '', TICKET_TYPE_META[t.type]?.label || t.type || '',
    t.application || '', serviceAreaLabel(t.serviceArea) || '',
    companyName(t.companyId) || '', hrDeptName(t.hrDepartmentId) || '',
    TICKET_STATUS_META[t.status]?.label || t.status || '', PRIORITY_META[t.priority]?.label || t.priority || '',
    t.slaDueOn ? fmtDate(t.slaDueOn) : '', t.requesterId ? (nameOf(t.requesterId) || t.requesterId) : '',
    t.assigneeId ? (nameOf(t.assigneeId) || t.assigneeId) : '', t.createdAt ? fmtDate(t.createdAt) : '',
    t.resolvedAt ? fmtDate(t.resolvedAt) : '', t.description || '',
  ]);
  const lines = [headers, ...body].map((r) => r.map(csvEscape).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tickets-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Every filter the desktop toolbar shows, stacked into the mobile bar's sheet.
// Changes apply immediately - the sheet is a view onto the same state, so there
// is nothing to "save" and no way to lose a selection by dismissing it.
function TicketMobileFilters({
  onClose, statusFilter, setStatusFilter, priorityFilter, setPriorityFilter,
  typeFilter, setTypeFilter, slaFilter, setSlaFilter, hrDeptFilter, setHrDeptFilter, hrDepts,
  serviceAreaFilter, setServiceAreaFilter,
  groupBy, setGroupBy, showGroup,
}) {
  const row = { width: '100%', fontSize: 15, padding: '10px 12px' };
  const wrap = { marginBottom: 14 };
  const lab = { ...label, fontSize: 12.5 };
  // MobileTaskBar renders filterSheet(...) raw - the caller supplies the sheet
  // chrome (same contract as the task module's MobileFilters).
  return (
    <BottomSheet title="Filter & Group" onClose={onClose}>
      <div style={wrap}>
        <label style={lab}>Status</label>
        <TicketSelect value={statusFilter} onChange={setStatusFilter} options={statusFilterOptions()} style={row} />
      </div>
      <div style={wrap}>
        <label style={lab}>Priority</label>
        <TicketSelect value={priorityFilter} onChange={setPriorityFilter} style={row}
          options={[['all', 'All priorities'], ...priorityOptions()]} />
      </div>
      <div style={wrap}>
        <label style={lab}>Type</label>
        <TicketSelect value={typeFilter} onChange={setTypeFilter} style={row}
          options={[['all', 'All types'], ...typeOptions()]} />
      </div>
      <div style={wrap}>
        <label style={lab}>SLA</label>
        <TicketSelect value={slaFilter} onChange={setSlaFilter} options={slaFilterOptions} style={row} />
      </div>
      {hrDepts.length > 0 && (
        <div style={wrap}>
          <label style={lab}>Department</label>
          <TicketSelect value={hrDeptFilter} onChange={setHrDeptFilter} style={row} searchPlaceholder="Search departments…"
            options={[['all', 'All departments'], ['', 'No department'], ...hrDepts.map((d) => [d.id, d.name])]} />
        </div>
      )}
      <div style={wrap}>
        <label style={lab}>Service Area</label>
        <TicketSelect value={serviceAreaFilter} onChange={setServiceAreaFilter} style={row}
          options={[['all', 'All service areas'], ['', 'Not set'], ...serviceAreaOptions()]} />
      </div>
      {showGroup && (
        <div style={wrap}>
          <label style={lab}>Group by</label>
          <TicketSelect value={groupBy} onChange={setGroupBy} options={groupByOptions()} style={row} />
        </div>
      )}
      <button onClick={onClose} style={{ ...btn('primary'), width: '100%', justifyContent: 'center', padding: '11px 0', fontSize: 15 }}>Done</button>
    </BottomSheet>
  );
}

// Desktop filter popover. The five selects used to sit inline in the toolbar,
// which is what made the header two crowded rows; behind one button they match
// the task module's Filters control. Shows a count so a narrowed list is never
// mistaken for an empty one.
function TicketFilterMenu({
  statusFilter, setStatusFilter, priorityFilter, setPriorityFilter, typeFilter, setTypeFilter,
  slaFilter, setSlaFilter, hrDeptFilter, setHrDeptFilter, hrDepts,
  serviceAreaFilter, setServiceAreaFilter,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const active = [statusFilter, priorityFilter, typeFilter, slaFilter, hrDeptFilter, serviceAreaFilter].filter((v) => v !== 'all').length;
  const rowStyle = { width: '100%' };
  const wrap = { marginBottom: 10 };
  const lab = { ...label, fontSize: 12 };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} title="Filters" style={{ ...btn('outline'), borderColor: active ? NX.blue : NX.border, color: active ? NX.blue : NX.ink }}>
        <SlidersHorizontal size={15} /> Filters{active ? ` (${active})` : ''}
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, width: 260, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 50, padding: 12 }}>
          <div style={wrap}>
            <label style={lab}>Status</label>
            <TicketSelect value={statusFilter} onChange={setStatusFilter} options={statusFilterOptions()} style={rowStyle} />
          </div>
          <div style={wrap}>
            <label style={lab}>Priority</label>
            <TicketSelect value={priorityFilter} onChange={setPriorityFilter} style={rowStyle}
              options={[['all', 'All priorities'], ...priorityOptions()]} />
          </div>
          <div style={wrap}>
            <label style={lab}>Type</label>
            <TicketSelect value={typeFilter} onChange={setTypeFilter} style={rowStyle}
              options={[['all', 'All types'], ...typeOptions()]} />
          </div>
          <div style={wrap}>
            <label style={lab}>SLA</label>
            <TicketSelect value={slaFilter} onChange={setSlaFilter} options={slaFilterOptions} style={rowStyle} />
          </div>
          {hrDepts.length > 0 && (
            <div style={wrap}>
              <label style={lab}>Department</label>
              <TicketSelect value={hrDeptFilter} onChange={setHrDeptFilter} style={rowStyle} searchPlaceholder="Search departments…"
                options={[['all', 'All departments'], ['', 'No department'], ...hrDepts.map((d) => [d.id, d.name])]} />
            </div>
          )}
          <div style={wrap}>
            <label style={lab}>Service Area</label>
            <TicketSelect value={serviceAreaFilter} onChange={setServiceAreaFilter} style={rowStyle}
              options={[['all', 'All service areas'], ['', 'Not set'], ...serviceAreaOptions()]} />
          </div>
          {active > 0 && (
            <button onClick={() => { setStatusFilter('all'); setPriorityFilter('all'); setTypeFilter('all'); setSlaFilter('all'); setHrDeptFilter('all'); setServiceAreaFilter('all'); }}
              style={{ ...btn('ghost'), width: '100%', justifyContent: 'center', color: NX.red, fontSize: 12.5 }}>Clear filters</button>
          )}
        </div>
      )}
    </div>
  );
}

// One overflow menu for every occasional control - saved views, group-by,
// export - so the toolbar stays search + Filters + More (owner call, Jul 28).
function MoreMenu({ views, onApply, onSave, onDelete, groupBy, setGroupBy, showGroup }) {
  const [open, setOpen] = useState(false);
  const item = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', fontSize: 13, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT, color: NX.ink, textAlign: 'left' };
  const sectionLabel = { padding: '8px 12px 4px', fontSize: 12, fontWeight: 600, color: NX.dim };
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={{ ...btn('outline'), padding: '7px 11px', fontSize: 13 }} title="Views, grouping and export">
        <Bookmark size={15} />More
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 41, minWidth: 240, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', overflow: 'hidden', fontFamily: FONT }}>
            {showGroup && (
              <>
                <div style={sectionLabel}>Group by</div>
                <div style={{ padding: '0 12px 10px' }}>
                  <TicketSelect value={groupBy} onChange={setGroupBy} options={groupByOptions()} style={{ width: '100%' }} />
                </div>
                <div style={{ borderTop: `1px solid ${NX.border2}` }} />
              </>
            )}
            <div style={sectionLabel}>Saved views</div>
            {views.length === 0 && <div style={{ padding: '0 12px 8px', fontSize: 12.5, color: NX.faint }}>No saved views yet.</div>}
            {views.map((v) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center' }}>
                <button onClick={() => { onApply(v); setOpen(false); }} style={{ ...item, flex: 1, minWidth: 0 }}>
                  <Bookmark size={13} style={{ color: NX.faint, flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
                </button>
                <button onClick={() => onDelete(v.id)} title="Delete view" style={{ ...btn('ghost'), padding: 6, color: NX.faint }}><X size={13} /></button>
              </div>
            ))}
            <button onClick={() => { onSave(); setOpen(false); }} style={{ ...item, color: NX.blue, fontWeight: 600 }}><Plus size={14} />Save current view…</button>
          </div>
        </>
      )}
    </div>
  );
}

// Show/hide which non-fixed columns render in the desktop List table. `cols`
// is the hook's already-filtered/ordered list (what's on screen right now),
// used only to count how many data columns are currently visible - hiding
// the last one would leave the table with nothing but the checkbox/type/
// resolved gutters, so that one stays checked and disabled.
function TicketColumnsMenu({ columns, hidden, toggleHidden, cols }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const hideable = columns.filter((c) => !c.fixed);
  const visibleCount = cols.filter((c) => !c.fixed).length;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} title="Customize columns" style={btn('outline')}>
        <Columns3 size={15} /> Customize
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, width: 220, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 50, padding: 8 }}>
          <div style={{ padding: '4px 6px 8px', fontSize: 12, fontWeight: 600, color: NX.dim }}>Show columns</div>
          {hideable.map((c) => {
            const checked = !hidden.includes(c.key);
            const lastOne = checked && visibleCount <= 1;
            return (
              <label key={c.key} style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 6px',
                borderRadius: 6, cursor: lastOne ? 'default' : 'pointer', fontSize: 13, color: NX.ink,
              }}>
                <input type="checkbox" checked={checked} disabled={lastOne}
                  onChange={() => toggleHidden(c.key)} />
                {c.label}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function TicketsView({ manageAction = null }) {
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
  useEffect(() => {
    let alive = true;
    // onDesk, not canAct: the queues are shown to the people whose work they
    // are. An administrator who was not picked in Manage can still act on a
    // ticket, but "To Assign" is not their inbox - and they are not notified
    // about those tickets either, so showing them the queue would contradict
    // their own bell.
    api.getMyTicketAccess()
      .then((r) => { if (alive) setItAdmin(!!r?.onDesk); })
      .catch(() => { if (alive) setItAdmin(false); });
    return () => { alive = false; };
  }, []);
  const isMobile = useIsMobile();
  // HR departments carry the triage lead/backup; used for the Triage scope and the
  // department filter. Loaded here rather than in context - tickets are the only
  // consumer today.
  const [hrDepts, setHrDepts] = useState([]);
  useEffect(() => { api.getTicketDepartments().then(setHrDepts).catch(() => setHrDepts([])); }, []);
  // Companies - same lookup pattern as hrDepts, for the Company column/export.
  const [companies, setCompanies] = useState([]);
  useEffect(() => { api.getTicketCompanies().then(setCompanies).catch(() => setCompanies([])); }, []);
  const companyName = (id) => companies.find((c) => c.id === id)?.name || '';
  const hrDeptName = (id) => hrDepts.find((d) => d.id === id)?.name || '';
  // Badge on the Triage tab - counts the whole queue, not the filtered view, so it
  // doesn't shrink as you narrow other filters. The queue belongs to the IT Admin
  // desk, irrespective of department: it used to be scoped to the departments you
  // lead, which put a ticket in front of whoever it was ABOUT rather than whoever
  // resolves it. Requests still awaiting approval are excluded - they can't be
  // assigned yet and live in To Route.
  const triageCount = useMemo(() => (itAdmin
    ? tickets.filter((t) => !t.assigneeId && t.approvalStatus !== 'pending'
        && !CLOSED_STATES.includes(t.status)).length
    : 0), [tickets, itAdmin]);
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
  const [scope, setScope] = useState('all');   // all | mine (requester) | assigned | triage | approve | route
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [hrDeptFilter, setHrDeptFilter] = useState('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState('all');
  const [slaFilter, setSlaFilter] = useState('all');   // all | breached | at_risk | ok
  const [groupBy, setGroupBy] = useState('none');
  const [view, setView] = useState('list');   // 'list' | 'board' | 'reports'
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

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
  useEffect(() => {
    const openTicket = (e) => { const id = e.detail?.ticketId; if (id) setOpenId(id); };
    window.addEventListener('nexus:open-ticket', openTicket);
    // This module is lazy(), so on a first visit the event above has already
    // fired by the time we get here - the bell leaves the id behind for us.
    const pending = takePendingOpen('ticket');
    if (pending) setOpenId(pending);
    return () => window.removeEventListener('nexus:open-ticket', openTicket);
  }, []);

  // Column order/widths - the same drag-to-reorder/resize kit the Task List
  // uses (tasks/tableCols.jsx), persisted to the user's profile under
  // table:"tickets" rather than a one-off localStorage key, so an arrangement
  // follows them to another device. Requester drops out of the underlying
  // column set entirely on My Requests (rather than being hidden per-row), so
  // the grid template - and the reorder/resize state - never has to know about it.
  const columnDefs = useMemo(
    () => TICKET_COLUMNS.filter((c) => !(scope === 'mine' && c.key === 'requester')),
    [scope],
  );
  const { cols, widths, template, startResize, resetWidth, autofitWidth, wrapRef, dragProps, hidden, toggleHidden } = useTableColumns({
    table: 'tickets', cols: columnDefs,
  });
  // Completed tickets (resolved/closed) collapse into their own section below
  // the main list by default (Pranshu, Sept 8 2026) rather than sitting inline
  // with the work still in flight. Same per-table settings document as the
  // column arrangement, so it also follows the person between devices.
  const [collapsedList, setCollapsedList] = useTableSetting('tickets', 'collapsed', ['completed']);
  const completedCollapsed = collapsedList.includes('completed');
  const toggleCompleted = () => setCollapsedList(
    completedCollapsed ? collapsedList.filter((k) => k !== 'completed') : [...collapsedList, 'completed'],
  );

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
    setSearch(f.search ?? '');
    if (v.group) setGroupBy(v.group);
    if (v.view) setView(v.view);
  };
  const saveTicketView = () => {
    const name = window.prompt('Name this view');
    if (!name || !name.trim()) return;
    createTicketView({
      name: name.trim(), view, group: groupBy,
      filters: { scope, statusFilter, priorityFilter, typeFilter, slaFilter, serviceAreaFilter, search },
    }).catch((e) => alert(`Could not save view: ${e.message || e}`));
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const me = (myEmail || '').toLowerCase();
    return tickets.filter((t) => {
      if (scope === 'mine' && (t.requesterId || '').toLowerCase() !== me) return false;
      if (scope === 'assigned' && (t.assigneeId || '').toLowerCase() !== me) return false;
      // Triage queue: everything unassigned and approved - the work the IT Admin
      // desk is notified about and expected to hand out.
      if (scope === 'triage' && ((t.assigneeId || '') || t.approvalStatus === 'pending'
        || CLOSED_STATES.includes(t.status))) return false;
      // Approval queue: requests parked on my decision.
      if (scope === 'approve' && !(t.approvalStatus === 'pending'
        && (t.approverId || '').toLowerCase() === me)) return false;
      // Routing queue (IT Admin): gated requests nobody has been asked to sign off yet.
      if (scope === 'route' && !(t.approvalStatus === 'pending' && !t.approverId)) return false;
      if (hrDeptFilter !== 'all' && (t.hrDepartmentId || '') !== hrDeptFilter) return false;
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
        const hay = `${t.code} ${normalizeCode(t.code)} ${ticketNoShort(t.code)} ${t.subject} ${t.description} ${t.application || ''} ${nameOf(t.requesterId) || ''} ${nameOf(t.assigneeId) || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tickets, scope, myEmail, search, statusFilter, priorityFilter, typeFilter, slaFilter, nameOf, hrDeptFilter, serviceAreaFilter, approvalCount]);

  // List-view sort - applied before grouping so it holds within each bucket too.
  const sortTickets = useCallback((list) => {
    const col = TICKET_COLUMNS.find((c) => c.key === sort.key);
    if (!col?.sort) return list;
    const ctx = { nameOf, companyName };
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = col.sort(a, ctx); const bv = col.sort(b, ctx);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, nameOf, companies]);

  // Completed (resolved/closed) tickets never sit inline with the ones still in
  // flight - they collapse into their own section at the bottom (see
  // toggleCompleted above). The one exception: someone who has explicitly
  // filtered down to exactly Resolved or Closed asked to SEE those tickets, so
  // hiding them behind a collapsed toggle would bury the very thing they asked
  // for - the partition is skipped and they render as the main (only) list.
  const statusFilterIsClosedOnly = statusFilter === 'resolved' || statusFilter === 'closed';
  const mainVisible = statusFilterIsClosedOnly ? visible : visible.filter((t) => !CLOSED_STATES.includes(t.status));
  const completedVisible = statusFilterIsClosedOnly ? [] : visible.filter((t) => CLOSED_STATES.includes(t.status));
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
      : groupBy === 'serviceArea' ? (k ? serviceAreaLabel(k) || k : 'Not set')
      : groupBy === 'assignee' ? (k ? nameOf(k) || k : 'Unassigned')
      : '');
    for (const t of sortedVisible) { const k = keyOf(t); if (!buckets.has(k)) buckets.set(k, { key: k || '-', label: labelOf(k), rows: [] }); buckets.get(k).rows.push(t); }
    return [...buckets.values()];
  }, [sortedVisible, groupBy, nameOf]);

  // Compact controls for the floating bulk-action pill - smaller than the
  // standard form idiom so a handful of them fit in one tight row.
  const compactSelStyle = { ...inputStyle, width: 'auto', cursor: 'pointer', appearance: 'auto', color: NX.ink, fontSize: 12.5, padding: '5px 8px', borderRadius: 8 };
  const compactBtnStyle = { ...btn('ghost'), color: '#fff', background: 'rgba(255,255,255,0.14)', fontSize: 12.5, padding: '5px 9px', gap: 5 };
  const toggleBtn = (on) => ({ ...btn('ghost'), padding: '6px 10px', borderRadius: 7, gap: 6, background: on ? NX.surface : 'transparent', color: on ? NX.ink : NX.dim, boxShadow: on ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' });

  // Bulk selection (list view only). Selection is cleared when it no longer matches.
  const toggleSel = (id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  const selIds = [...selected].filter((id) => visible.some((t) => t.id === id));
  // Select-all - scoped to the currently filtered/sorted queue, not the whole table.
  const allVisibleIds = visible.map((t) => t.id);
  const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => selected.has(id));
  const someSelected = !allSelected && allVisibleIds.some((id) => selected.has(id));
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(allVisibleIds));
  const bulkPatch = async (patch) => { await Promise.all(selIds.map((id) => updateTicket(id, patch).catch(() => {}))); clearSel(); };
  const bulkDelete = async () => {
    if (!window.confirm(`Delete ${selIds.length} ticket${selIds.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    await Promise.all(selIds.map((id) => deleteTicket(id).catch(() => {}))); clearSel();
  };

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
            <button style={btn('primary')} onClick={() => setCreating(true)}><Plus size={15} /> Create</button>
          )}
          {manageAction}
        </div>
      </div>

      {/* Phones keep a scope strip under the title (the desktop scope pills
          moved into the toolbar row, which doesn't render on mobile). */}
      {isMobile && (
        <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, margin: '0 12px 8px', overflowX: 'auto' }}>
          {[['all', 'All'], ['mine', 'Mine'], ['assigned', 'Assigned'],
            ...(routeCount > 0 ? [['route', `To Route (${routeCount})`]] : []),
            ...(itAdmin ? [['triage', `To Assign${triageCount ? ` (${triageCount})` : ''}`]] : []),
            ...(approvalCount > 0 ? [['approve', `To Approve (${approvalCount})`]] : [])].map(([k, lab]) => (
            <button key={k} onClick={() => setScope(k)} style={{ ...toggleBtn(scope === k), whiteSpace: 'nowrap' }}>{lab}</button>
          ))}
        </div>
      )}

      {!isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${NX.border}`, padding: '0 24px', flexWrap: 'wrap', background: NX.surface }}>
          {/* Row 2 pairs the two mode controls: scope (WHICH tickets) first,
              then view (HOW they're shown) - row 1 stays title + New Ticket,
              matching My Tasks' header anatomy. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, margin: '8px 0', overflowX: 'auto', flexShrink: 1, minWidth: 0 }}>
              {[['all', 'All'], ['mine', 'My Requests'], ['assigned', 'Assigned to Me'],
                ...(routeCount > 0 ? [['route', `To Route (${routeCount})`]] : []),
                ...(itAdmin ? [['triage', `To Assign${triageCount ? ` (${triageCount})` : ''}`]] : []),
                ...(approvalCount > 0 ? [['approve', `To Approve (${approvalCount})`]] : [])].map(([k, lab]) => (
                <button key={k} onClick={() => setScope(k)} style={{ ...toggleBtn(scope === k), whiteSpace: 'nowrap' }}>{lab}</button>
              ))}
            </div>
            <span style={{ width: 1, height: 20, background: NX.border, flexShrink: 0 }} />
            <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, margin: '8px 0', overflowX: 'auto', flexShrink: 0 }}>
              {TICKET_VIEW_TABS.map((tb) => (
                <button key={tb.key} onClick={() => setView(tb.key)} title={tb.label} style={{
                  ...btn('ghost'), padding: '6px 10px', borderRadius: 7, whiteSpace: 'nowrap',
                  background: view === tb.key ? NX.surface : 'transparent', color: view === tb.key ? NX.ink : NX.dim,
                  boxShadow: view === tb.key ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                }}><tb.icon size={15} /> {tb.label}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', flexWrap: 'wrap' }}>
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
            />
            <button
              onClick={() => downloadTicketsCsv([...sortedVisible, ...sortedCompleted], nameOf, companyName, hrDeptName)}
              style={{ ...btn('outline'), padding: '7px 11px', fontSize: 13 }}
              title="Export the currently filtered tickets to CSV"
            >
              <Download size={15} />Export
            </button>
            <MoreMenu views={ticketViews} onApply={applyTicketView} onSave={saveTicketView} onDelete={(id) => deleteTicketView(id).catch(() => {})}
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
        const tile = (label, bandBg, bandFg, n, sub, onGo, active) => (
          <button key={label} onClick={onGo}
            style={{ textAlign: 'left', border: `1px solid ${active ? bandFg : NX.border}`, borderRadius: 14, overflow: 'hidden', background: NX.surface, cursor: 'pointer', fontFamily: FONT, padding: 0, boxShadow: active ? `0 0 0 1px ${bandFg}` : 'none', transition: 'transform .15s, box-shadow .15s' }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 20px rgba(0,0,0,.08)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = active ? `0 0 0 1px ${bandFg}` : 'none'; }}>
            <span style={{ display: 'block', padding: '6px 14px', background: bandBg, color: bandFg, fontSize: 12.5, fontWeight: 700 }}>{label}</span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '10px 14px 12px' }}>
              <span style={{ fontSize: 24, fontWeight: 800, color: NX.ink, fontVariantNumeric: 'tabular-nums' }}>{n}</span>
              <span style={{ fontSize: 12, color: NX.faint }}>{sub}</span>
            </span>
          </button>
        );
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, padding: '14px 24px 0', background: NX.canvas }}>
            {/* Every tile counts the WHOLE workspace, so every tile clears the
                scope on the way in - otherwise a card reading 4 opens a list of
                1 because "My Requests" was still selected, and the number looks
                broken. (To assign is itself a scope, so it sets one instead.) */}
            {tile('Open', 'rgba(9,152,195,0.14)', '#0998c3', openCount, 'not yet resolved',
              () => { setScope('all'); setSlaFilter('all'); setStatusFilter(statusFilter === 'open' ? 'all' : 'open'); },
              statusFilter === 'open')}
            {/* Red once there's actually a backlog - purple read as "just an
                info card" and nobody's eye caught it climbing (Pranshu, Sept
                8 2026). Same red the SLA-breached tile uses, so red already
                means one thing across this row: something needs a person. */}
            {tile('Unassigned', unassignedCount > 0 ? 'rgba(220,38,38,0.12)' : 'rgba(124,58,237,0.14)',
              unassignedCount > 0 ? NX.red : '#7c3aed', unassignedCount, 'nobody working them',
              () => { setScope('all'); setSlaFilter('all'); setStatusFilter(statusFilter === 'unassigned' ? 'all' : 'unassigned'); },
              statusFilter === 'unassigned')}
            {itAdmin && tile('To assign', 'rgba(217,119,6,0.15)', NX.amber, triageCount, 'waiting for triage',
              () => setScope('triage'), scope === 'triage')}
            {tile('SLA breached', 'rgba(220,38,38,0.12)', NX.red, breachedCount, 'past their target',
              () => { setScope('all'); setStatusFilter('all'); setSlaFilter(slaFilter === 'breached' ? 'all' : 'breached'); },
              slaFilter === 'breached')}
            {tile('Resolved', 'rgba(22,163,74,0.14)', NX.green, resolvedCount, 'awaiting closure',
              () => { setScope('all'); setSlaFilter('all'); setStatusFilter(statusFilter === 'resolved' ? 'all' : 'resolved'); },
              statusFilter === 'resolved')}
            {tile('Closed', 'rgba(100,116,139,0.16)', '#475569', closedCount, 'done and filed',
              () => { setScope('all'); setSlaFilter('all'); setStatusFilter(statusFilter === 'closed' ? 'all' : 'closed'); },
              statusFilter === 'closed')}
          </div>
        );
      })()}

      {/* Body. paddingBottom clears the floating mobile bar (matches My Tasks). */}
      <div className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, padding: view === 'board' ? 12 : 16, paddingBottom: isMobile ? 88 : 76 }}>
        {view === 'reports' ? (
          <TicketReports tickets={visible} nameOf={nameOf} hrDeptName={hrDeptName} />
        ) : view === 'board' ? (
          <TicketBoard tickets={visible} nameOf={nameOf} onOpen={setOpenId} onMove={(id, status) => updateTicket(id, { status }).catch(() => {})} />
        ) : visible.length === 0 ? (
          <EmptyState icon={TicketToken} title="No Tickets" hint={tickets.length ? 'No tickets match your filters.' : 'Raise a ticket to get started.'} />
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
                    myEmail={myEmail} myLevel={myLevel} updateTicket={updateTicket} onOpen={() => setOpenId(t.id)}
                    checked={selected.has(t.id)} onToggle={() => toggleSel(t.id)} band={idx % 2 === 1} />
                ))}
                {g.rows.length > 200 && <div style={{ padding: '8px 16px', fontSize: 12, color: NX.faint }}>+ {g.rows.length - 200} more - filter to narrow down</div>}
              </div>
            ))}
            {/* Resolved/closed tickets collapse into their own section instead of
                sitting inline with the ones still in flight - see toggleCompleted. */}
            {sortedCompleted.length > 0 && (
              <div className="nx-edge-card" style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, overflow: 'hidden' }}>
                <button onClick={toggleCompleted} style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 16px', background: NX.surface2,
                  border: 'none', borderBottom: completedCollapsed ? 'none' : `1px solid ${NX.border2}`, cursor: 'pointer', fontFamily: FONT, textAlign: 'left',
                }}>
                  <ChevronDown size={15} style={{ color: NX.faint, flexShrink: 0, transform: completedCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s' }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>Completed</span>
                  <span style={{ fontSize: 12, color: NX.faint, fontWeight: 400 }}>{sortedCompleted.length}</span>
                </button>
                {!completedCollapsed && sortedCompleted.slice(0, 200).map((t, idx) => (
                  <TicketRow key={t.id} t={t} nameOf={nameOf} hrDeptName={hrDeptName} companyName={companyName}
                    myEmail={myEmail} myLevel={myLevel} updateTicket={updateTicket} onOpen={() => setOpenId(t.id)}
                    checked={selected.has(t.id)} onToggle={() => toggleSel(t.id)} band={idx % 2 === 1} />
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
            <div ref={wrapRef} style={{ minWidth: 'fit-content', '--nx-grid': template }}>
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
                    myEmail={myEmail} myLevel={myLevel} updateTicket={updateTicket} onOpen={() => setOpenId(t.id)}
                      checked={selected.has(t.id)} onToggle={() => toggleSel(t.id)} cols={cols} band={idx % 2 === 1} />
                  ))}
                  {g.rows.length > 200 && <div style={{ padding: '8px 16px', fontSize: 12, color: NX.faint }}>+ {g.rows.length - 200} more - filter to narrow down</div>}
                </div>
              ))}
              {/* Resolved/closed tickets collapse into their own section instead
                  of sitting inline with the ones still in flight (Pranshu, Sept
                  8 2026) - see toggleCompleted/collapsedList above. */}
              {sortedCompleted.length > 0 && (
                <div>
                  <button onClick={toggleCompleted} style={{
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
                    myEmail={myEmail} myLevel={myLevel} updateTicket={updateTicket} onOpen={() => setOpenId(t.id)}
                      checked={selected.has(t.id)} onToggle={() => toggleSel(t.id)} cols={cols} band={idx % 2 === 1} />
                  ))}
                  {!completedCollapsed && sortedCompleted.length > 200 && <div style={{ padding: '8px 16px', fontSize: 12, color: NX.faint }}>+ {sortedCompleted.length - 200} more - filter to narrow down</div>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {view === 'list' && selIds.length > 0 && (
        // Floating pill, centered at the bottom of the panel - doesn't push the
        // list's layout (position:absolute against the panel's position:relative
        // above) and stays compact instead of stretching edge to edge.
        <div style={{
          position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, flexWrap: 'wrap',
          maxWidth: 'calc(100% - 32px)', padding: '7px 10px', borderRadius: 12,
          background: NX.ink, color: '#fff', boxShadow: '0 10px 28px rgba(0,0,0,0.28)',
        }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', padding: '0 2px' }}>{selIds.length} selected</span>
          <TicketSelect command placeholder="Set status…" options={statusOptions()} style={compactSelStyle}
            onChange={(v) => bulkPatch({ status: v })} />
          <TicketSelect command placeholder="Set priority…" options={priorityOptions()} style={compactSelStyle}
            onChange={(v) => bulkPatch({ priority: v })} />
          <TicketSelect command placeholder="Assign to…" searchPlaceholder="Search people…"
            options={[['', 'Unassign'], ...people.map((p) => [p.email, p.name || p.email])]}
            style={{ ...compactSelStyle, maxWidth: 140 }} onChange={(v) => bulkPatch({ assigneeId: v })} />
          <button style={compactBtnStyle} onClick={() => bulkPatch({ status: 'resolved', resolution: 'fixed' })}><CheckCircle2 size={13} /> Resolve</button>
          <button style={compactBtnStyle} onClick={bulkDelete}><Trash2 size={13} /> Delete</button>
          <button style={{ ...compactBtnStyle, background: 'transparent', padding: 6 }} onClick={clearSel} title="Clear selection"><X size={14} /></button>
        </div>
      )}

      {isMobile && (
        <MobileTaskBar
          views={TICKET_VIEW_TABS} view={view} setView={setView}
          onCreate={() => setCreating(true)}
          filterSheet={(onClose) => (
            <TicketMobileFilters
              onClose={onClose}
              statusFilter={statusFilter} setStatusFilter={setStatusFilter}
              priorityFilter={priorityFilter} setPriorityFilter={setPriorityFilter}
              typeFilter={typeFilter} setTypeFilter={setTypeFilter}
              slaFilter={slaFilter} setSlaFilter={setSlaFilter}
              hrDeptFilter={hrDeptFilter} setHrDeptFilter={setHrDeptFilter} hrDepts={hrDepts}
              serviceAreaFilter={serviceAreaFilter} setServiceAreaFilter={setServiceAreaFilter}
              groupBy={groupBy} setGroupBy={setGroupBy} showGroup={view === 'list'}
            />
          )}
        />
      )}

      {creating && <CreateTicketModal onClose={() => setCreating(false)} />}
      {openId && <TicketDrawer ticketId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// Column header for the desktop list view - driven by TICKET_COLUMNS/cols so
// widths, labels and sort keys stay in one place. Each movable cell is
// click-to-sort, drag-to-reorder (useTableColumns' dragProps) and carries a
// resize handle on its trailing edge; checkbox/type/resolved are `fixed` and
// render a blank (or the select-all checkbox) header cell instead. Renders as
// a CSS grid using the shared --nx-grid template, so it lines up with every
// row without either one tracking the other's widths directly - the same
// contract the task list's rich-list grid uses (tasks/views/richlist.jsx).
const TICKET_ROW_H = 44;    // tall enough for the two-line title cell

function TicketListHeader({ cols, widths, startResize, resetWidth, autofitWidth, dragProps, sort, onSort, allSelected, someSelected, onToggleSelectAll }) {
  // Checkbox "indeterminate" (some but not all selected) isn't settable via a
  // JSX prop - it's a DOM-only flag, so it's applied imperatively via a ref.
  const selectAllRef = useRef(null);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = !!someSelected; }, [someSelected]);
  const headCell = { position: 'relative', display: 'flex', alignItems: 'center', minHeight: 34, padding: '0 10px', borderRight: `1px solid ${NX.border2}`, boxSizing: 'border-box' };
  return (
    // Sticky, not just top-of-list - scrolling a long queue used to lose the
    // column labels entirely (Pranshu, Sep 9 2026). Anchored to .viewport
    // (the app shell's own scroll container - .nx-list-scroll below only
    // affects horizontal overflow), with an opaque background so rows
    // scrolling underneath don't show through.
    <div style={{ position: 'sticky', top: 0, zIndex: 3, display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'stretch', padding: '9px 0', background: NX.surface2, borderBottom: `1px solid ${NX.border}` }}>
      {cols.map((col) => {
        if (col.key === 'checkbox') {
          return (
            <div key="checkbox" style={{ ...headCell, justifyContent: 'center' }}>
              <input ref={selectAllRef} type="checkbox" checked={!!allSelected} onChange={onToggleSelectAll}
                title={allSelected ? 'Deselect all' : 'Select all'} style={{ cursor: 'pointer', width: 15, height: 15, margin: 0, accentColor: NX.blue }} />
            </div>
          );
        }
        // type/resolved are fixed, label-less structure columns - a blank cell
        // keeps the grid template in step without offering anything to drag/sort.
        if (col.fixed) return <div key={col.key} style={headCell} />;
        const drag = dragProps(col.key, true);
        const active = sort.key === col.key;
        const SortIcon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
        return (
          <div key={col.key} {...drag} onClick={() => onSort(col.key)} title={`Sort by ${col.label}`}
            style={{
              ...headCell, cursor: 'pointer', userSelect: 'none',
              // The column being dragged fades; the one it would land on shows
              // the insertion edge, so a drop reads as "it goes there" before
              // the mouse is released - same cue the Task List's drag uses.
              opacity: drag['data-dragging'] ? 0.4 : 1,
              boxShadow: drag['data-dropping'] ? `inset 2px 0 0 ${NX.blue}` : 'none',
            }}>
            <span style={{
              flex: 1, minWidth: 0, fontFamily: FONT, fontSize: 11, fontWeight: 700, color: NX.ink,
              textTransform: 'uppercase', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{col.label}</span>
            <SortIcon size={11} style={{ flexShrink: 0, marginLeft: 4, opacity: active ? 1 : 0.4 }} />
            <ColResizer onMouseDown={startResize(col.key, widths[col.key] ?? col.width)} onReset={() => resetWidth(col.key)} onAutofit={() => autofitWidth(col.key)} />
          </div>
        );
      })}
    </div>
  );
}

// Click-to-edit State/Priority directly from the list, no drawer (Pranshu,
// Sep 2026 - clicking the pill offers a dropdown right there). Shows
// `children` (the row's existing SolidCellPair/chip) unchanged at rest; when
// `editable`, a click opens a small anchored option list and picking one
// fires `onChange` immediately. Gated by the SAME canWorking the drawer
// enforces for these exact fields (see TicketRow below) - this is UI
// convenience only, the backend's _ticket_edit_scope is the real boundary
// regardless, same as everywhere else in this file.
function InlineTicketSelect({ value, options, onChange, editable, meta, children }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef(null);
  if (!editable) return children;
  const pick = (id) => {
    setOpen(false);
    if (id === value || busy) return;
    setBusy(true);
    onChange(id).catch((e) => alert(`Could not update: ${e.message || e}`)).finally(() => setBusy(false));
  };
  return (
    <div ref={anchorRef} onClick={(e) => { e.stopPropagation(); if (!busy) setOpen((o) => !o); }}
      style={{ width: '100%', height: '100%', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.65 : 1 }}>
      {children}
      {open && (
        // Portaled to document.body (SelectMenu, position:fixed off the anchor's
        // own rect) rather than absolutely positioned inside this cell - the
        // State/Priority cells are `overflow:hidden` (SolidCellPair needs that to
        // clip its solid fill to the cell edge), which silently clipped an
        // in-place dropdown to invisible: it existed in the DOM, computed
        // visible/display:block, and still never painted (Pranshu, Sep 9 2026 -
        // reported as "clicking State/Priority does nothing").
        <SelectMenu anchorRef={anchorRef} onClose={() => setOpen(false)} minWidth={170}>
          {options.map(([id, optLabel]) => {
            const m = meta[id] || {};
            const selected = id === value;
            return (
              <div key={id} onClick={(e) => { e.stopPropagation(); pick(id); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', fontSize: 12.5, borderRadius: 6, cursor: 'pointer', color: NX.ink, background: selected ? NX.hover : 'transparent' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = selected ? NX.hover : 'transparent'; }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color || NX.dim, flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{optLabel}</span>
                {selected && <Check size={13} style={{ color: NX.blue, flexShrink: 0 }} />}
              </div>
            );
          })}
        </SelectMenu>
      )}
    </div>
  );
}

// Solid, edge-to-edge colored cell fill - matches the task rich-list's
// monday-style Priority/Status columns (tasks/views/richlist.jsx PillSelect
// `solid`) instead of a floating pastel chip. The primary segment grows to
// fill whatever width the secondary badge (approval / SLA) doesn't need, so
// the block always covers the cell edge-to-edge regardless of label length.
function SolidCellPair({ primaryLabel, primaryColor, secondaryLabel, secondaryColor, SecondaryIcon }) {
  const seg = (color) => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, height: '100%',
    padding: '0 10px', background: color, color: '#fff', fontSize: 12, fontWeight: 700,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: FONT,
  });
  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div style={{ ...seg(primaryColor), flex: 1, minWidth: 0 }}>{primaryLabel}</div>
      {secondaryLabel && (
        <div style={{ ...seg(secondaryColor), flexShrink: 0, fontSize: 11 }}>
          {SecondaryIcon && <SecondaryIcon size={11} />}{secondaryLabel}
        </div>
      )}
    </div>
  );
}

function TicketRow({ t, nameOf, hrDeptName, companyName, myEmail, myLevel, updateTicket, onOpen, checked, onToggle, cols, band = false }) {
  const isMobile = useIsMobile();
  // Resting background: selection wins, then the zebra band (same NX.zebra /
  // NX.hover pair the task list rows use). Selected tint matches the task
  // list's row-select highlight exactly, rather than a plain surface swap.
  const rowBg = checked ? 'rgba(37,99,235,0.10)' : band ? NX.zebra : NX.surface;
  // Every cell shares this base (minHeight/padding/border) - the same cellPad
  // contract the task rich-list rows use, so the two grids read identically.
  const cell = { minWidth: 0, minHeight: TICKET_ROW_H, display: 'flex', alignItems: 'center', padding: '0 12px', borderRight: `1px solid ${NX.border2}`, boxSizing: 'border-box' };
  // Flush - no padding, stretched to the row's full height - so the solid
  // State/Priority fills sit truly edge-to-edge inside their cell.
  const flushCell = { minWidth: 0, minHeight: TICKET_ROW_H, display: 'flex', padding: 0, borderRight: `1px solid ${NX.border2}`, boxSizing: 'border-box' };
  const overdue = t.slaDueOn && t.slaDueOn < today() && !CLOSED_STATES.includes(t.status);
  const sla = slaState(t);
  const slaM = (sla === 'breached' || sla === 'at_risk') ? SLA_META[sla] : null;
  const approvalM = t.approvalStatus === 'pending' ? APPROVAL_META.pending : null;
  const staleM = commentStale(t) ? COMMENT_STALE_META : null;
  // The HR department is what routed this ticket, so it belongs on the row.
  const hrDept = t.hrDepartmentId ? hrDeptName(t.hrDepartmentId) : '';

  // Same canWorking the drawer enforces for type/status/priority/assignee/
  // department/resolution - never let the list's inline dropdown drift from
  // it (see TicketDrawer below and InlineTicketSelect above).
  const myEmailLower = (myEmail || '').toLowerCase();
  const rowIsRequester = (t.requesterId || '').toLowerCase() === myEmailLower;
  const rowIsAssignee = (t.assigneeId || '').toLowerCase() === myEmailLower;
  const rowPrivileged = myLevel >= 3;
  const rowRequesterLocked = rowIsRequester && !rowPrivileged && t.status !== 'open';
  const rowLocked = t.status === 'in_progress' && !!t.assigneeId;
  const canWorking = rowPrivileged || (!rowRequesterLocked && (rowLocked ? rowIsAssignee : true));

  // Phones: two stacked lines instead of eight columns. Subject leads; the chips
  // and the assignee wrap underneath. Requester, the separate SLA date column and
  // the bulk-select checkbox are dropped - all reachable by opening the ticket,
  // and bulk edit is a desktop job.
  if (isMobile) {
    return (
      <div onClick={onOpen} style={{
        display: 'flex', flexDirection: 'column', gap: 6, padding: '11px 12px',
        borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer', background: rowBg,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <TicketTypeIcon type={t.type} size={15} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: NX.ink, lineHeight: 1.35 }}>
              {t.subject}
              {t.linkedTaskId && <Link2 size={13} style={{ color: NX.faint, marginLeft: 6, verticalAlign: 'middle' }} />}
            </div>
            <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 2 }}>
              {ticketNoShort(t.code) || '-'}{hrDept ? ` · ${hrDept}` : ''}
            </div>
          </div>
          {t.resolvedAt && <CheckCircle2 size={16} style={{ color: NX.green, flexShrink: 0 }} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <TicketStatusChip status={t.status} />
          {t.approvalStatus === 'pending' && <ApprovalChip ticket={t} />}
          <PriorityChip priority={t.priority} />
          <SlaBadge t={t} compact />
          {staleM && (
            <span title={`No comment in over ${COMMENT_STALE_HOURS[t.priority] ?? 24}h - past this priority's check-in window`}
              style={{ ...chip(staleM.color, staleM.tint), display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '1px 7px' }}>
              <staleM.Icon size={11} />
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            {t.assigneeId
              ? <><Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={20} />
                  <span style={{ fontSize: 12, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{nameOf(t.assigneeId)}</span></>
              : <UnassignedAvatar size={20} />}
          </span>
        </div>
      </div>
    );
  }

  const stateM = TICKET_STATUS_META[t.status] || { label: t.status, color: NX.dim };
  const priM = PRIORITY_META[t.priority] || { label: t.priority, color: NX.dim };

  // Cells are keyed and rendered in `cols`' order (useTableColumns' saved
  // arrangement) rather than a fixed sequence, the same reason
  // tasks/views/richlist.jsx's TaskRow does it - once columns can be
  // dragged, a row that renders them in source order puts every value under
  // the wrong heading the moment someone reorders the header.
  const cells = {
    checkbox: (
      <div style={{ ...cell, justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={!!checked} onChange={onToggle}
          title="Select" style={{ cursor: 'pointer', width: 15, height: 15, margin: 0, accentColor: NX.blue }} />
      </div>
    ),
    type: (
      <div style={{ ...cell, justifyContent: 'center' }}>
        <TicketTypeIcon type={t.type} size={16} />
      </div>
    ),
    title: (
      <div style={{ ...cell, overflow: 'hidden', textAlign: 'left' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.subject}
            {t.linkedTaskId && <Link2 size={13} style={{ color: NX.faint, marginLeft: 6, verticalAlign: 'middle' }} />}
          </div>
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 1 }}>
            {ticketNoShort(t.code) || '-'}{hrDept ? ` · ${hrDept}` : ''}
          </div>
        </div>
      </div>
    ),
    company: (
      <div style={{ ...cell, justifyContent: 'flex-start', overflow: 'hidden' }} title={companyName(t.companyId) || ''}>
        <span style={{ fontSize: 12.5, color: NX.dim, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{companyName(t.companyId) || '-'}</span>
      </div>
    ),
    // Solid, edge-to-edge fill - matches the task rich-list's Priority/Status
    // columns exactly, with the approval/SLA badge as a second solid segment
    // rather than a floating chip. Wrapped in InlineTicketSelect so clicking
    // it offers a dropdown to change the value right there - no drawer.
    state: (
      <div style={{ ...flushCell, overflow: 'hidden' }} title={approvalM ? `${stateM.label} · awaiting approval` : stateM.label}>
        <InlineTicketSelect value={t.status} options={statusOptions()} meta={TICKET_STATUS_META} editable={canWorking}
          onChange={(v) => updateTicket(t.id, { status: v })}>
          <SolidCellPair primaryLabel={stateM.label} primaryColor={stateM.color}
            secondaryLabel={approvalM?.label} secondaryColor={approvalM?.color} />
        </InlineTicketSelect>
      </div>
    ),
    // staleM wins the one secondary slot over slaM when both apply - the Due
    // Date column (below) still shows the SLA breach in red regardless, so
    // it's never fully hidden, and "needs a comment" is the more actionable
    // of the two right now.
    priority: (
      <div style={{ ...flushCell, overflow: 'hidden' }}
        title={staleM ? `${priM.label} · ${staleM.label}` : slaM ? `${priM.label} · ${slaM.label}` : priM.label}>
        <InlineTicketSelect value={t.priority} options={priorityOptions()} meta={PRIORITY_META} editable={canWorking}
          onChange={(v) => updateTicket(t.id, { priority: v })}>
          <SolidCellPair primaryLabel={priM.label} primaryColor={priM.color}
            secondaryLabel={staleM?.label || slaM?.label} secondaryColor={staleM?.color || slaM?.color}
            SecondaryIcon={staleM?.Icon || slaM?.Icon} />
        </InlineTicketSelect>
      </div>
    ),
    due: (
      <div style={{ ...cell, justifyContent: 'flex-start', gap: 5, overflow: 'hidden' }}>
        <Clock size={12} style={{ color: overdue ? NX.red : NX.faint, flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: overdue ? NX.red : NX.dim, fontWeight: overdue ? 700 : 400, textAlign: 'left' }}>{t.slaDueOn ? fmtDate(t.slaDueOn) : '-'}</span>
      </div>
    ),
    requester: (
      <div style={{ ...cell, justifyContent: 'flex-start', gap: 6, overflow: 'hidden' }} title={`Requester: ${nameOf(t.requesterId) || 'Unknown'}`}>
        {t.requesterId ? <Avatar email={t.requesterId} name={nameOf(t.requesterId)} size={22} /> : <span style={{ width: 22, flexShrink: 0 }} />}
        <span style={{ fontSize: 12.5, color: NX.dim, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.requesterId ? nameOf(t.requesterId) : '-'}</span>
      </div>
    ),
    assignee: (
      <div style={{ ...cell, justifyContent: 'flex-start', gap: 6, overflow: 'hidden' }} title={`Assignee: ${t.assigneeId ? nameOf(t.assigneeId) : 'Unassigned'}`}>
        {/* Unassigned is the dashed avatar alone - the word said no more than
            the empty space it filled, and the icon keeps the column reading as
            a column of faces. The cell's title still spells it out on hover. */}
        {t.assigneeId ? <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={22} /> : <UnassignedAvatar size={22} />}
        {t.assigneeId && <span style={{ fontSize: 12.5, color: NX.dim, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(t.assigneeId)}</span>}
      </div>
    ),
    created: (
      <div style={{ ...cell, justifyContent: 'flex-start', overflow: 'hidden' }} title={t.createdAt ? `Created ${fmtDate(t.createdAt)}` : ''}>
        <span style={{ fontSize: 12, color: NX.dim, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.createdAt ? fmtDate(t.createdAt) : '-'}</span>
      </div>
    ),
    resolved: (
      <div style={{ ...cell, justifyContent: 'center', borderRight: 'none' }}>
        {t.resolvedAt && <CheckCircle2 size={16} style={{ color: NX.green }} title={`Resolved ${fmtDate(t.resolvedAt)}`} />}
      </div>
    ),
  };

  return (
    <div onClick={onOpen} style={{
      display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'stretch',
      borderBottom: `1px solid ${NX.border}`, cursor: 'pointer', background: rowBg,
    }}
      onMouseEnter={(e) => { if (!checked) e.currentTarget.style.background = NX.hover; }}
      onMouseLeave={(e) => { if (!checked) e.currentTarget.style.background = rowBg; }}>
      {cols.map((c) => <Fragment key={c.key}>{cells[c.key]}</Fragment>)}
    </div>
  );
}

// Real Supabase Storage upload for ticket evidence (screenshots, documents,
// screen recordings) - works for any file size, unlike the old inline-data-URL
// scheme it replaced (which silently dropped anything over 2MB; recordings
// always would have). Bucket must exist on the Supabase project - public,
// same as Testing's qa-evidence - create `ticket-evidence` there.
async function uploadTicketEvidence(file, prefix = 'file') {
  if (!supabase) throw new Error('Storage not configured');
  const ext = (file.name.split('.').pop() || 'dat').toLowerCase();
  const path = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { data, error } = await supabase.storage.from('ticket-evidence')
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false, cacheControl: '31536000' });
  if (error || !data) throw new Error(error?.message || 'Upload failed');
  return supabase.storage.from('ticket-evidence').getPublicUrl(data.path).data.publicUrl;
}

function attachmentKindOf(f) {
  if (f.type.startsWith('image/')) return 'image';
  if (f.type.startsWith('video/')) return 'video';
  return 'doc';
}

// Posts one file to a ticket - the ticket must already exist (attachments are
// keyed by ticket id). A failed storage upload still records the attachment
// by name (returns false) so the attempt isn't silently lost - the caller
// decides whether/how to surface that.
async function uploadTicketFile(ticketId, f) {
  const size = `${Math.max(1, Math.round(f.size / 1024))} KB`;
  const kind = attachmentKindOf(f);
  let url = '';
  let ok = true;
  try { url = await uploadTicketEvidence(f, kind); } catch { ok = false; }
  await api.addTicketAttachment(ticketId, { name: f.name, size, kind, url }).catch(() => {});
  return ok;
}

// Shared Record + Upload control - a screen recording (optionally with mic
// narration) or a plain file picker. `onFile(file)` gets a plain File each
// time (recordings become File objects too); the caller decides whether to
// queue it locally (pre-creation) or upload it immediately (post-creation).
function RecordUploadButtons({ onFile, disabled, showRecord = true, onRecordingChange }) {
  const fileRef = useRef(null);
  const [menu, setMenu] = useState(false);
  const [recording, setRecording] = useState(false);
  const setRec = (v) => { setRecording(v); onRecordingChange?.(v); };
  // The submenu used to close itself via a position:fixed full-viewport
  // backdrop div. That div sits above everything else in the modal
  // (including the scrollable body), so any wheel/touch scroll while the
  // menu was open hit the backdrop instead of the scroll container and did
  // nothing - the modal looked frozen until the menu was dismissed.
  // useClickOutside (the same pattern every other dropdown in this file
  // uses - TicketFilterMenu, MoreMenu) closes on an outside click without
  // ever intercepting scroll.
  const menuWrapRef = useRef(null);
  useClickOutside(menuWrapRef, () => setMenu(false), menu);

  const record = async (voice) => {
    setMenu(false);
    try {
      const started = await startScreenRecording({ voice }, (blob) => {
        // File FIRST, recording-state second: onRecordingChange(false) may
        // trigger the navigate-back-and-resume flow (recordingDraft.js), and
        // the clip must already be in the draft when the form reopens.
        // null = cancelled or genuinely empty; both end quietly. The old
        // "came out empty - try again" alert fired on every Cancel too, which
        // read as a failure when the user had simply changed their mind.
        if (blob) onFile(new File([blob], `ticket-recording-${Date.now()}.webm`, { type: 'video/webm' }));
        setRec(false);
      });
      if (started) setRec(true);
    } catch (e) {
      setRec(false);
      // NotAllowedError covers both "dismissed the picker" and "denied
      // permission" in Chrome - quiet in both cases, same as Testing's
      // startBugRecording. Anything else (unsupported browser, NotFoundError,
      // etc.) is worth telling the requester about.
      if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') {
        alert(e?.message || 'Could not start screen recording.');
      }
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {showRecord && (
        <div ref={menuWrapRef} style={{ position: 'relative' }}>
          {/* Record is the featured action here - a screen recording tells us
              more about a broken workflow than a paragraph of description
              ever will, so it's styled to be noticed, not just discoverable. */}
          {/* Asks for notification permission HERE - a dedicated click, well
              before the getDisplayMedia screen/window/tab picker shows up -
              rather than right before that picker, where the two browser
              prompts landing back-to-back meant the permission one (easy to
              mistake for spam next to the picker everyone expects) was very
              likely getting reflexively dismissed. That's the "come back"
              cue this button promises. */}
          <button type="button" disabled={disabled || recording} onClick={() => { primeReturnCue(); setMenu((m) => !m); }}
            style={{
              ...btn('primary'), background: NX.red, borderColor: NX.red,
              padding: '11px 18px', fontSize: 14, fontWeight: 700, borderRadius: 10,
              boxShadow: recording ? 'none' : '0 2px 8px rgba(220,38,38,0.28)',
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}>
            {recording ? <Loader2 size={17} style={{ animation: 'spin 1s linear infinite' }} /> : <CircleDot size={17} />}
            {recording ? 'Recording…' : 'Record screen'}
          </button>
          {menu && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 20, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,.18)', padding: 4, width: 210 }}>
              <button type="button" onClick={() => record(false)} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8, fontSize: 12 }}>
                <Video size={14} /> Screen recording
              </button>
              <button type="button" onClick={() => record(true)} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8, fontSize: 12 }}>
                <Mic size={14} /> Screen + narration
              </button>
            </div>
          )}
        </div>
      )}
      <button type="button" disabled={disabled} onClick={() => fileRef.current?.click()}
        style={{ ...btn('outline'), fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <UploadIcon size={13} /> Upload
      </button>
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
        onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ''; files.forEach(onFile); }} />
    </div>
  );
}

// Pending-attachment chip for the create-ticket form (local File, not yet uploaded).
function PendingFileChip({ file, onRemove }) {
  const isVideo = file.type.startsWith('video/');
  const isImage = file.type.startsWith('image/');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 9px 3px 8px', fontSize: 12 }}>
      {isVideo ? <Video size={13} style={{ color: NX.dim }} /> : isImage ? <ImageIcon size={13} style={{ color: NX.dim }} /> : <Paperclip size={13} style={{ color: NX.dim }} />}
      <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
      <button type="button" onClick={onRemove} title="Remove" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={12} /></button>
    </span>
  );
}

// ── Create ───────────────────────────────────────────────────────────────────
export function CreateTicketModal({ onClose }) {
  const { createTicket, projects = [], myEmail } = useTasks();
  const people = usePeople();
  const isMobile = useIsMobile();
  const [companies, setCompanies] = useState([]);
  const [allDepts, setAllDepts] = useState([]);
  useEffect(() => {
    api.getTicketCompanies().then(setCompanies).catch(() => setCompanies([]));
    api.getMyTicketDepartments().then(setAllDepts).catch(() => setAllDepts([]));
  }, []);
  // A draft stashed during a screen recording (recordingDraft.js) seeds the
  // form when it reopens - possibly after the user navigated to another view
  // and back. Consumed exactly once per mount via the ref guard.
  const seedRef = useRef(undefined);
  if (seedRef.current === undefined) seedRef.current = takeDraft() || null;
  const seed = seedRef.current;
  const [form, setForm] = useState(seed?.form || {
    // Opens on the first type offered, read from the order rather than named
    // here, so the two can never drift into a default that isn't in the list.
    subject: '', description: '', type: TICKET_TYPE_ORDER[0], priority: 'medium', status: 'open',
    requesterId: myEmail || null, hrDepartmentId: '', application: '',
  });
  const [tf, setTf] = useState(seed?.tf || {});   // per-type field values (keyed by field key)
  const [step, setStep] = useState(seed ? 2 : 1);        // 1 = routing (company/dept/type), 2 = details
  const [showErrors, setShowErrors] = useState(false);   // only nag after a failed submit
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setTfVal = (k, v) => setTf((p) => ({ ...p, [k]: v }));
  // intakeFields, not TYPE_FIELDS: retired fields stay in the definitions so
  // tickets that already captured one still render it, but nobody is asked
  // for them again.
  const typeFieldDefs = useMemo(() => intakeFields(form.type), [form.type]);
  // The application directory and the work-site list the service questions use.
  const apps = useTicketApps();
  const sites = useTicketSites();
  // Derived, not asked. The server derives it again on save from the same
  // mapping - this copy only lets step 2 say which questions it is about to ask
  // and why, so the requester is never made to classify their own problem.
  const serviceArea = useMemo(() => areaForApp(apps, form.application), [apps, form.application]);
  // Driven by BOTH the application's service area and the ticket type: "which
  // facility?" is the right question for a camera that has stopped working and
  // noise on a request to reword a report. See SERVICE_FIELDS' `types`.
  const svcFieldDefs = useMemo(
    () => withDynamicOptions(serviceFields(serviceArea, form.type), { sites }),
    [serviceArea, form.type, sites]);
  // Already scoped server-side to the requester's own company
  // (/ticket-departments?mine=true), so there is nothing to filter here - and
  // nothing that could offer a department belonging to another company.
  const deptOptions = allDepts;
  // The chosen department's NAME - what the app list groups on, since External
  // Links stores department strings rather than HrDepartment ids.
  const deptName = deptOptions.find((d) => d.id === form.hrDepartmentId)?.name || '';

  // ── Step 1 validation ──
  // Department is only demanded when the chosen company actually has departments -
  // requiring a choice with nothing to choose from would be an inescapable form.
  // Application is demanded on the same terms: only once the directory has
  // actually loaded. Requiring it while the list is still in flight (or after
  // the lookup failed) would be the same inescapable form.
  const missingStep1 = useMemo(() => {
    const out = new Set();
    if (deptOptions.length > 0 && !form.hrDepartmentId) out.add('hrDepartmentId');
    if (apps.length > 0 && !form.application) out.add('application');
    return out;
  }, [form.hrDepartmentId, deptOptions, apps, form.application]);

  // ── Step 2 validation ──
  // Recomputed each render, so red marks clear as soon as a field is filled. Only
  // the CURRENT type's fields are checked - leftovers from a previously selected
  // type are never submitted.
  const missing = useMemo(() => {
    const out = new Set();
    if (!form.subject.trim()) out.add('subject');
    for (const f of [...typeFieldDefs, ...svcFieldDefs]) {
      if (f.req && isBlankFieldValue(tf[f.key])) out.add(f.key);
    }
    return out;
  }, [form.subject, typeFieldDefs, svcFieldDefs, tf]);

  const goNext = () => {
    if (missingStep1.size) { setShowErrors(true); return; }
    setShowErrors(false);   // step 2 starts clean
    setStep(2);
  };

  // ── Mobile capture shortcuts (mirrors CreateTaskModal) ──
  // Photo / attach / scan sit in the footer so they're one tap away on a phone.
  // Files are held locally and uploaded once the ticket exists - the attachment
  // API is keyed by ticket id, so there is nothing to attach to until then.
  const camRef = useRef(null);
  const libRef = useRef(null);
  const attachRef = useRef(null);
  const scanRef = useRef(null);
  const [attachments, setAttachments] = useState(seed?.attachments || []);
  const [photoMenu, setPhotoMenu] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  // While a screen recording runs, the whole modal steps aside (see the early
  // return before `shell`): the backdrop at z-4000 both buried the recorder's
  // Stop pill and closed-and-discarded the form on any outside click. Hiding
  // the RENDER while this component stays mounted keeps every field intact.
  const [recActive, setRecActive] = useState(false);
  // Tell the draft stash whether this form is alive: on Stop it either lets
  // the mounted form reappear, or (form unmounted - the user navigated away
  // to reproduce the issue) routes the app back here to resume from the stash.
  useEffect(() => { setDraftUiMounted(true); return () => setDraftUiMounted(false); }, []);
  const onRecChange = (v) => {
    setRecActive(v);
    if (v) stashDraft({ form, tf, attachments });
    else finishRecording();
  };
  const onFiles = (e) => {
    const list = Array.from(e.target.files || []); e.target.value = '';
    if (list.length) setAttachments((prev) => [...prev, ...list]);
  };
  // ABC scanner → OCR the photo server-side and append the text to the Title.
  const onScan = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setOcrBusy(true);
    try {
      const { text } = await api.ocrImage(f);
      if (text && text.trim()) set('subject', (form.subject ? `${form.subject} ` : '') + text.trim().replace(/\s+/g, ' '));
      else alert('No text found in the image.');
    } catch { alert("Couldn't extract text from the image."); }
    finally { setOcrBusy(false); }
  };

  const submit = async () => {
    if (busy) return;
    if (missing.size) { setShowErrors(true); return; }
    setBusy(true);
    try {
      // Persist the current type's fields AND the current service area's,
      // dropping blanks. Both live on the same typeFields JSON - the `svc_`
      // prefix is what keeps the two sets from colliding. Leftovers from a
      // type or an app the user moved away from are never submitted, because
      // only the CURRENT definitions are walked.
      const typeFields = {};
      for (const f of [...typeFieldDefs, ...svcFieldDefs]) {
        if (!isBlankFieldValue(tf[f.key])) typeFields[f.key] = tf[f.key];
      }
      const created = await createTicket({
        subject: form.subject.trim(), description: form.description, type: form.type, priority: form.priority, status: form.status,
        // Requester defaults to the current user; SLA due date is derived from
        // priority; the service area is derived server-side from application.
        requesterId: form.requesterId || '', hrDepartmentId: form.hrDepartmentId || '',
        application: form.application || '',
        slaDueOn: slaDueFromPriority(form.priority),
        typeFields,
      });
      // Attachments can only be posted once the ticket has an id. A storage
      // failure here must not lose the ticket that was just created - the
      // ticket still saves, and any failed file gets one combined warning
      // (not one alert per file) rather than being silently dropped.
      if (created?.id && attachments.length) {
        const results = await Promise.all(attachments.map((f) => uploadTicketFile(created.id, f)));
        const failed = attachments.filter((_, i) => !results[i]);
        if (failed.length) {
          alert(`Ticket created, but ${failed.length} attachment${failed.length > 1 ? 's' : ''} couldn't be stored (${failed.map((f) => f.name).join(', ')}) - they won't be playable/downloadable.`);
        }
      }
      onClose();
    } catch (e) { alert(`Could not create ticket: ${e.message || e}`); setBusy(false); }
  };

  const sel = { ...inputStyle, appearance: 'auto', cursor: 'pointer' };

  // Recording in progress: get out of the way. The form (and its portal
  // backdrop) disappears so the person can reproduce the issue and reach the
  // recorder's Stop pill; this component stays mounted, so on stop the form
  // returns exactly as they left it, with the clip attached. The chip is a
  // pointer-events-free hint - the recorder pill owns Stop/Cancel.
  if (recActive) {
    return (
      <div style={{ position: 'fixed', left: 18, bottom: 18, zIndex: 5990, pointerEvents: 'none',
        background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, padding: '10px 14px',
        boxShadow: '0 8px 30px rgba(0,0,0,.18)', fontSize: 12.5, color: NX.dim, maxWidth: 300, fontFamily: FONT }}>
        Recording for your ticket - the form reopens with everything intact when you press Stop.
      </div>
    );
  }

  // Phones get the Asana-style bottom sheet (same chrome as quick-create task);
  // desktop keeps the centred modal. A plain function, not a component - defining
  // a component inline would remount the whole form on every render and drop focus.
  // `extras` is the icon row, which sits on its own line above the actions.
  const shell = (title, { onBack, footer, extras, children }) => (isMobile ? (
    <BottomSheet title={title} onClose={onClose} onBack={onBack}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
      {/* Pinned to the bottom of the sheet's scroll area: the ticket form is long,
          and Create Ticket must not scroll out of reach. Negative margins + padding
          let the bar span the sheet's full width over BottomSheet's 16px padding. */}
      <div style={{
        position: 'sticky', bottom: -16, zIndex: 2, background: NX.surface,
        borderTop: `1px solid ${NX.border2}`, marginTop: 14,
        marginLeft: -16, marginRight: -16, marginBottom: -16,
        padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {extras}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{footer}</div>
      </div>
    </BottomSheet>
  ) : (
    <Modal title={title} onClose={onClose} footer={footer}>{children}</Modal>
  ));

  // ── Step 1: who the ticket is for and what kind it is. Everything downstream
  // (which intake fields to ask) depends on Type, so it's settled up front. ──
  if (step === 1) {
    return shell(isMobile ? 'New Ticket' : 'New Ticket · Step 1 of 2', {
      footer: (
        <>
          {showErrors && missingStep1.size > 0 && (
            <span style={{ fontSize: 12.5, color: NX.red, marginRight: 'auto', fontWeight: 600 }}>
              {missingStep1.size > 1 ? 'Fill in the required fields to continue'
                : missingStep1.has('application') ? 'Select an application to continue'
                : 'Select a department to continue'}
            </span>
          )}
          <button style={{ ...btn('outline'), marginLeft: 'auto' }} onClick={onClose}>Cancel</button>
          <button style={btn('primary')} onClick={goNext}>Next</button>
        </>
      ),
      children: (<>
        <div style={{ fontSize: 12.5, color: NX.dim, marginBottom: 14 }}>
          Where does this ticket belong, and what kind is it? The next step asks for details specific to the type you pick.
        </div>
        {/* No Company picker. A requester works for exactly one, the server
            knows which (tickets.company_for), and asking was a question with a
            single right answer they could still get wrong. The departments
            offered below are already that company's. */}
        <div style={field}>
          <label style={label}>Department {deptOptions.length > 0 && <span style={{ color: NX.red }}>*</span>}</label>
          <TicketSelect value={form.hrDepartmentId} onChange={(v) => set('hrDepartmentId', v)}
            placeholder={deptOptions.length ? 'Select department' : 'No departments to choose from'}
            searchPlaceholder="Search departments…" emptyText="No departments to choose from."
            invalid={showErrors && missingStep1.has('hrDepartmentId')} style={sel}
            options={[['', deptOptions.length ? 'Select department' : 'No departments to choose from'],
              ...deptOptions.map((d) => [d.id, d.name])]} />
          {showErrors && missingStep1.has('hrDepartmentId') && <div style={requiredHint}>Required</div>}
          {deptOptions.length === 0 && (
            <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
              No departments set up for your company - you can continue without one.
            </div>
          )}
        </div>
        {/* Which app this is about. Picked from the External Links directory,
            so it is the same value everywhere rather than a typed string, and
            it is what decides the service area (and therefore which service
            questions step 2 asks). Changing it clears any service answers that
            belonged to the previous app's area - keeping them would submit an
            answer to a question this ticket was never asked. */}
        <div style={field}>
          <label style={label}>Application {apps.length > 0 && <span style={{ color: NX.red }}>*</span>}</label>
          <ApplicationSelect apps={apps} value={form.application} deptName={deptName}
            invalid={showErrors && missingStep1.has('application')}
            onChange={(name) => {
              set('application', name);
              // Only when the AREA changes: swapping one storage app for
              // another asks the same questions, and throwing away the
              // facility they already picked would be gratuitous. Moving from
              // storage to email genuinely leaves stale answers behind.
              if (areaForApp(apps, name) !== serviceArea) {
                setTf((prev) => Object.fromEntries(
                  Object.entries(prev).filter(([k]) => !k.startsWith('svc_'))));
              }
            }} />
          {showErrors && missingStep1.has('application') && <div style={requiredHint}>Required</div>}
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
            {apps.length === 0 ? 'No applications in the directory yet - you can continue without one.'
              : serviceArea ? `Goes to ${serviceAreaLabel(serviceArea)}.`
              : deptName ? `${deptName}'s apps are listed first. Search to find any other.`
              : 'Search by name, or pick "Other / not listed".'}
          </div>
        </div>
        <div style={field}>
          <label style={label}>Type <span style={{ color: NX.red }}>*</span></label>
          <TicketSelect value={form.type} options={typeOptions()} style={sel} onChange={(v) => {
            set('type', v);
            // Clear the outgoing type's own fields, but KEEP the service
            // answers. A different type may ask fewer of them (see
            // SERVICE_FIELDS' `types`) - one that no longer applies is simply
            // not rendered and never submitted, because both the form and the
            // save walk the current definitions. Holding the value means
            // switching type and back does not cost the answer.
            setTf((prev) => Object.fromEntries(
              Object.entries(prev).filter(([k]) => k.startsWith('svc_'))));
          }} />
          {/* Six types only work if the difference is spelled out. The hint is
              the plain-English "is this me?" for whichever one is selected. */}
          {TICKET_TYPE_META[form.type]?.hint && (
            <div style={{ fontSize: 12, color: NX.dim, marginTop: 5 }}>{TICKET_TYPE_META[form.type].hint}</div>
          )}
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
            {typeFieldDefs.length + svcFieldDefs.length} extra question{typeFieldDefs.length + svcFieldDefs.length === 1 ? '' : 's'} on the next step.
          </div>
        </div>
      </>),
    });
  }

  // ── Step 2: the ticket itself, shaped by the type chosen in step 1. ──
  return shell(isMobile ? 'New Ticket' : 'New Ticket · Step 2 of 2', {
    onBack: isMobile ? () => { setStep(1); setShowErrors(false); } : undefined,
    // Phone only - same trio as Create a Task, so raising a ticket from a phone
    // can capture a photo of the problem without leaving the form.
    extras: (<>
      {isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 'auto', position: 'relative' }}>
          <button type="button" title="Add photo" aria-label="Add photo" onClick={() => setPhotoMenu((v) => !v)}
            style={{ ...btn('ghost'), padding: 7, color: NX.dim }}><ImageIcon size={20} /></button>
          <button type="button" title="Attach file" aria-label="Attach file" onClick={() => attachRef.current?.click()}
            style={{ ...btn('ghost'), padding: 7, color: NX.dim }}><Paperclip size={20} /></button>
          <button type="button" title="Scan text" aria-label="Scan text" disabled={ocrBusy} onClick={() => scanRef.current?.click()}
            style={{ ...btn('ghost'), padding: 7, color: NX.dim, opacity: ocrBusy ? 0.5 : 1 }}><ScanText size={20} /></button>
          {ocrBusy && <span style={{ fontSize: 12, color: NX.faint }}>Scanning…</span>}
          {attachments.length > 0 && <span style={{ fontSize: 12, color: NX.faint, marginLeft: 2 }}>{attachments.length}</span>}
          {photoMenu && (
            /* Opens upward - the footer is pinned to the bottom of the modal. */
            <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 10px 28px rgba(0,0,0,0.18)', zIndex: 10, padding: 4, minWidth: 180 }}>
              <button type="button" onClick={() => { setPhotoMenu(false); camRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><Camera size={16} /> Take photo</button>
              <button type="button" onClick={() => { setPhotoMenu(false); libRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><ImagePlus size={16} /> Choose from device</button>
            </div>
          )}
          {/* capture="environment" opens the rear camera on a phone. */}
          <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onFiles} />
          <input ref={libRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFiles} />
          <input ref={attachRef} type="file" multiple style={{ display: 'none' }} onChange={onFiles} />
          <input ref={scanRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onScan} />
        </div>
      )}
    </>),
    footer: (
      <>
        {showErrors && missing.size > 0 && (
          <span style={{ fontSize: 12.5, color: NX.red, fontWeight: 600 }}>
            {missing.size} required field{missing.size > 1 ? 's' : ''} still empty
          </span>
        )}
        <button style={{ ...btn('outline'), marginLeft: 'auto' }} onClick={() => { setStep(1); setShowErrors(false); }}>Back</button>
        <button style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create Ticket'}</button>
      </>
    ),
    children: (<>
      {/* Recap of step 1 - the choices shaping this form stay visible and editable. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', marginBottom: 14, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 8 }}>
        <TicketTypeIcon type={form.type} size={14} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: NX.ink }}>{TICKET_TYPE_META[form.type].label}</span>
        <span style={{ fontSize: 12.5, color: NX.dim }}>
          {deptName || 'No department'}
        </span>
        {form.application && (
          <span style={{ fontSize: 12.5, color: NX.dim, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: NX.faint }}>·</span>
            <span style={{ color: NX.ink, fontWeight: 600 }}>{form.application}</span>
            {/* Derived, shown, not asked - so it is visible and correctable
                (by going Back and re-picking) without being a second dropdown
                that means almost the same thing as the one above it. */}
            {serviceArea && <span style={chip(NX.dim, NX.border2)}>{serviceAreaLabel(serviceArea)}</span>}
          </span>
        )}
        <button type="button" onClick={() => { setStep(1); setShowErrors(false); }}
          style={{ ...btn('ghost'), marginLeft: 'auto', padding: '2px 6px', fontSize: 12, color: NX.blue, fontWeight: 600 }}>Change</button>
      </div>

      <div style={field}>
        <label style={label}>Priority</label>
        <TicketSelect value={form.priority} onChange={(v) => set('priority', v)} options={priorityOptions()} style={sel} />
      </div>
      <div style={field}>
        <label style={label}>Title <span style={{ color: NX.red }}>*</span></label>
        <input autoFocus value={form.subject} onChange={(e) => set('subject', e.target.value)} placeholder="What is the issue?"
          style={{ ...inputStyle, ...(showErrors && missing.has('subject') ? { borderColor: NX.red } : null) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
        {showErrors && missing.has('subject') && <div style={requiredHint}>Required</div>}
      </div>
      <div style={field}>
        <label style={label}>Description</label>
        <textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} placeholder="Add detail…" style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
      </div>

      {/* Type-specific details - the point of the ticket, so it's prominent. */}
      {typeFieldDefs.length > 0 && (
        <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, padding: 14, background: NX.surface2, marginTop: 2 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: NX.dim, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            <TicketTypeIcon type={form.type} size={14} /> {TICKET_TYPE_META[form.type].label} Details
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            {typeFieldDefs.map((f) => (
              <div key={f.key} style={{ ...field, marginBottom: 0, gridColumn: (f.full || f.type === 'textarea' || f.type === 'checklist') ? '1 / -1' : 'auto' }}>
                <label style={label}>{f.label}{f.req && <span style={{ color: NX.red }}> *</span>}</label>
                <TypeFieldInput field={f} value={tf[f.key]} onChange={(v) => setTfVal(f.key, v)} people={people} projects={projects}
                  invalid={showErrors && missing.has(f.key)} />
                {showErrors && missing.has(f.key) && <div style={requiredHint}>Required</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Application-specific details. Driven by the service area the chosen
          app maps to, so the requester answers questions about the thing they
          already named rather than picking a second category first. Most areas
          ask nothing at all and this block simply doesn't appear. */}
      {svcFieldDefs.length > 0 && (
        <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, padding: 14, background: NX.surface2, marginTop: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: NX.dim, marginBottom: 10 }}>
            {serviceAreaLabel(serviceArea)} Details
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            {svcFieldDefs.map((f) => (
              <div key={f.key} style={{ ...field, marginBottom: 0, gridColumn: (f.full || f.type === 'textarea') ? '1 / -1' : 'auto' }}>
                <label style={label}>{f.label}{f.req && <span style={{ color: NX.red }}> *</span>}</label>
                <TypeFieldInput field={f} value={tf[f.key]} onChange={(v) => setTfVal(f.key, v)} people={people} projects={projects}
                  invalid={showErrors && missing.has(f.key)} />
                {showErrors && missing.has(f.key) && <div style={requiredHint}>Required</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={field}>
        <label style={label}>Attachments</label>
        {/* Framed as a benefit to the requester (faster triage), not an
            instruction - "please record" reads as a chore; this reads as
            useful. Only shown when recording is actually offered for this
            ticket type (NO_RECORDING_TYPES hides the Record button itself). */}
        {!NO_RECORDING_TYPES.includes(form.type) && (
          <div style={{ fontSize: 12.5, color: NX.faint, marginBottom: 8, lineHeight: 1.4 }}>
            A quick screen recording shows us exactly what's happening - usually faster than typing it out.
          </div>
        )}
        <RecordUploadButtons showRecord={!NO_RECORDING_TYPES.includes(form.type)}
          onFile={(f) => { appendDraftFile(f); setAttachments((prev) => [...prev, f]); }}
          onRecordingChange={onRecChange} />
        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {attachments.map((f, i) => (
              <PendingFileChip key={`${f.name}-${i}`} file={f} onRemove={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))} />
            ))}
          </div>
        )}
      </div>
    </>),
  });
}

// ── Edit drawer (modal) ───────────────────────────────────────────────────────
// Plain-text rendering of a type-field or custom-field value, for actors who
// can see it but (per the drawer's field gating below) can't edit it.
function readOnlyFieldValue(f, value, nameOf) {
  if (f.type === 'person') return value ? (nameOf(value) || value) : '-';
  if (f.type === 'multiperson') {
    const ids = toEmailList(value);
    return ids.length ? ids.map((e) => nameOf(e) || e).join(', ') : '-';
  }
  if (f.type === 'checklist') {
    const items = Array.isArray(value) ? value : [];
    return items.length ? items.map((it) => `${it.done ? '✓' : '○'} ${it.label}`).join('  ·  ') : '-';
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (value === '' || value == null) return '-';
  if (f.type === 'date') return fmtDate(value);
  return String(value);
}

// Exported so the Support page (requester-facing, no module grant needed -
// see views/Support.jsx) can mount this exact drawer directly, the same way
// it already mounts CreateTicketModal for "Submit a Ticket" - rather than
// routing through the Tickets module's own view, which is grant-gated to
// supervisor+ (App.jsx VIEW_MIN_ROLES) and would 403 a plain employee. The
// drawer's own permission model (isRequester/privileged/etc. below) already
// scopes what a non-desk person can see/do, same as it would inside the
// module for someone without the desk grant.
export function TicketDrawer({ ticketId, onClose }) {
  const { tickets, tasks, projects = [],
    addTicketLink, removeTicketLink, escalateTicket, createTask, myEmail, nameOf, updateTicket, deleteTicket,
    refresh } = useTasks();
  // An approval decision changes status/resolution server-side, so pull the whole
  // list rather than patching one field locally.
  const onDecided = () => refresh?.();
  const people = usePeople();
  const apps = useTicketApps();
  const sites = useTicketSites();
  const isMobile = useIsMobile();
  const { myLevel, canAccessModule } = useRole();
  const [tab, setTab] = useState('overview');
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
  const [companies, setCompanies] = useState([]);
  const [allDepts, setAllDepts] = useState([]);
  useEffect(() => {
    api.getTicketCompanies().then(setCompanies).catch(() => setCompanies([]));
    api.getMyTicketDepartments().then(setAllDepts).catch(() => setAllDepts([]));
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
    const own = (SERVICE_FIELDS[area] || []).filter(
      (f) => (!f.retired && serviceFieldApplies(f, t?.type)) || answered(f));
    const ownKeys = new Set(own.map((f) => f.key));
    const orphans = Object.values(SERVICE_FIELDS).flat()
      .filter((f) => !ownKeys.has(f.key) && answered(f));
    const seen = new Set();
    return [...own, ...orphans].filter((f) => (seen.has(f.key) ? false : seen.add(f.key)));
  })();
  if (!t) return null;

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
  const privileged = myLevel >= 3;
  // Request Control: the same consent-first remote screen control Workforce
  // Analytics already has (components/LiveView.jsx) - reused as-is, not
  // reimplemented, so a support agent can jump straight from "I'm assigned
  // this ticket" to "let me see what they're seeing" without leaving the
  // ticket. Visible only to the assignee - the requester's own screen isn't
  // something anyone else working the ticket gets to reach for - and only to
  // someone who could already open Workforce Analytics at all (mirrors that
  // module's own Sidebar.jsx gate); LiveView/timeclock.py still independently
  // enforce who may actually watch or take control server-side, same as
  // every other caller of that component - this only decides whether the
  // button is worth showing.
  const canRequestControl = isAssignee && !!t.requesterId && !isRequester
    && canAccessModule('employee-tracking', 'supervisor');
  // Separate from the in_progress/assignee lock above: the moment a ticket
  // moves off its just-raised "open" status - triaged, worked, resolved,
  // whatever comes next - the person who raised it goes read-only on every
  // Overview field (Pranshu, Sept 8 2026: a requester editing type/priority/
  // department out from under whoever is already acting on it is exactly the
  // confusion this closes off). Conversation and Attachments stay theirs to
  // use regardless - see the tab bodies below, neither reads this flag.
  // Manager+ is never subject to it, same as every other restriction here.
  const requesterLocked = isRequester && !privileged && t.status !== 'open';
  const locked = t.status === 'in_progress' && !!t.assigneeId;
  const fullAccess = privileged || (!requesterLocked && (locked ? isAssignee : isRequester));
  // The always-open "working fields" (type/status/priority/assignee/department/
  // resolution) - open to anyone pre-lock, restricted to the assignee once locked.
  const canWorking = privileged || (!requesterLocked && (locked ? isAssignee : true));
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
  const canDelete = privileged || (!requesterLocked && isRequester);
  // Escalate is a distress flare, not a priority bump: it mails the ticket's
  // department head that it needs instant care. The requester or the current
  // assignee - the two people actually living the ticket - can raise it,
  // unaffected by requesterLocked (that governs editing the ticket's fields,
  // not asking for help on it) and not just whoever's working the queue.
  // Mirrors the server check in escalate_ticket (backend/routers/tickets.py).
  const canEscalate = (isRequester || isAssignee || privileged) && !CLOSED_STATES.includes(t.status);
  const patch = (p) => updateTicket(t.id, p).catch((e) => alert(`Could not update ticket: ${e.message || e}`));
  const escalate = () => {
    if (!window.confirm('Escalate this ticket? The department head will get an email that it needs urgent attention.')) return;
    escalateTicket(t.id)
      .then(() => alert('Escalated - the department head has been notified.'))
      .catch((e) => alert(`Could not escalate: ${e.message || e}`));
  };
  // Same "ask a reason" pattern as the approval-reject flow - the Outlook
  // reopened-ticket email includes it, so the assignee/dept lead knows why.
  const reopen = () => {
    const reason = window.prompt('Why are you reopening this ticket?');
    if (reason === null) return;
    patch({ status: 'reopened', reopen_reason: reason.trim() });
  };
  // ticket → many tasks: union of the spawned list + the legacy single linkedTaskId
  const taskIds = [...(t.taskIds || []), ...(t.linkedTaskId && !(t.taskIds || []).includes(t.linkedTaskId) ? [t.linkedTaskId] : [])];
  const spawnTask = async () => {
    try {
      const task = await createTask({ title: t.subject, description: t.description || '', assigneeId: t.assigneeId || '', priority: t.priority || 'medium' });
      await patch({ taskIds: [...(t.taskIds || []), task.id] });
    } catch (e) { alert(`Could not create task: ${e.message || e}`); }
  };
  const linkTask = (taskId) => { if (taskId && !taskIds.includes(taskId)) patch({ taskIds: [...(t.taskIds || []), taskId] }); };
  const unlinkTask = (taskId) => {
    const p = { taskIds: (t.taskIds || []).filter((id) => id !== taskId) };
    if (t.linkedTaskId === taskId) p.linkedTaskId = '';
    patch(p);
  };
  const overdue = t.slaDueOn && t.slaDueOn < today() && !CLOSED_STATES.includes(t.status);

  const remove = () => {
    if (!window.confirm(`Delete ${ticketNo(t.code) || 'this ticket'}? This cannot be undone.`)) return;
    deleteTicket(t.id).then(onClose).catch((e) => alert(`Could not delete ticket: ${e.message || e}`));
  };

  const sel = { ...inputStyle, appearance: 'auto', cursor: 'pointer' };
  return (
    <>
    {/* No width override - the Modal default (clamp(520px, 60vw, 980px)) is
        the shared "big form" sizing used across the app; the fixed 620px this
        used to pass read as a cramped tab next to that (Pranshu, Sept 8 2026). */}
    <Modal title={ticketNo(t.code) || 'Ticket'} onClose={onClose} footer={
      <>
        {canDelete && (
          <button style={{ ...btn('outline'), color: NX.red, borderColor: NX.border, marginRight: 'auto' }} onClick={remove}><Trash2 size={14} /> Delete</button>
        )}
        {canEscalate && (
          <button style={{ ...btn('outline'), color: NX.amber }} onClick={escalate} title="Alert the department head this ticket needs instant care"><ArrowUp size={14} /> Escalate</button>
        )}
        {!CLOSED_STATES.includes(t.status) ? (
          canWorking && (
            <button style={{ ...btn('outline'), color: NX.green }} onClick={() => patch({ status: 'resolved', resolution: t.resolution || 'fixed' })}><CheckCircle2 size={14} /> Mark Resolved</button>
          )
        ) : (
          <>
            {t.status === 'resolved' && (
              <button style={{ ...btn('outline'), color: NX.green }} onClick={() => patch({ status: 'closed' })}
                title="Close this ticket now instead of waiting for it to auto-close"><CheckCircle2 size={14} /> Confirm Resolution</button>
            )}
            <button style={btn('outline')} onClick={reopen}>Reopen</button>
          </>
        )}
        <button style={btn('primary')} onClick={onClose}>Done</button>
      </>
    }>
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: NX.ink }}>{t.subject}</div>
        {t.description && <p style={{ margin: '6px 0 0', fontSize: 13, color: NX.dim, whiteSpace: 'pre-wrap' }}>{t.description}</p>}
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
        <TicketStatusChip status={t.status} />
        <PriorityChip priority={t.priority} />
        <ApprovalChip ticket={t} />
        {t.resolvedAt && <span style={{ fontSize: 12, color: NX.green, display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={13} /> Resolved {fmtDate(t.resolvedAt)}{t.resolution ? ` · ${resolutionLabel(t.resolution)}` : ''}</span>}
      </div>

      {/* Approval gate - the decision blocks triage, so it leads the drawer,
          always visible regardless of which tab is open. */}
      <ApprovalPanel ticket={t} myEmail={myEmail} nameOf={nameOf} onDecided={onDecided} />

      {/* Overview · Conversation · Attachments · Activity - a real tab strip up
          top so Conversation/Attachments/Activity are one click away instead of
          buried under the whole field list (people kept missing them). */}
      <div style={{ borderTop: `1px solid ${NX.border}`, marginTop: 12, paddingTop: 12 }}>
        {/* Segmented control - same mode-switch grammar as the rest of the module */}
        <div style={{ display: 'inline-flex', gap: 2, marginBottom: 16, background: NX.border2, borderRadius: 9, padding: 2, flexWrap: 'wrap' }}>
          {[['overview', 'Overview', ClipboardList], ['conversation', 'Conversation', MessageSquare], ['attachments', 'Attachments', Paperclip], ['activity', 'Activity', History]].map(([k, lab, Icon]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              ...btn('ghost'), gap: 6, fontSize: 12.5, fontWeight: 600, padding: '6px 10px', borderRadius: 7,
              background: tab === k ? NX.surface : 'transparent', color: tab === k ? NX.ink : NX.dim,
              boxShadow: tab === k ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}><Icon size={14} />{lab}</button>
          ))}
        </div>

        {tab === 'overview' && (<>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
        <div style={field}>
          <label style={label}>Type</label>
          <TicketSelect value={t.type || 'request'} onChange={(v) => patch({ type: v })} options={typeOptions()}
            style={sel} disabled={!canWorking} />
        </div>
        <div style={field}>
          <label style={label}>Status</label>
          <TicketSelect value={t.status} onChange={(v) => patch({ status: v })} options={statusOptions()}
            style={sel} disabled={!canWorking} />
        </div>
        <div style={field}>
          <label style={label}>Priority</label>
          <TicketSelect value={t.priority} onChange={(v) => patch({ priority: v })} options={priorityOptions()}
            style={sel} disabled={!canWorking} />
        </div>
        <div style={field}>
          <label style={label}>Requester</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 34 }}>
            {t.requesterId ? <><Avatar email={t.requesterId} name={nameOf(t.requesterId)} size={22} /><span style={{ fontSize: 13, color: NX.ink }}>{nameOf(t.requesterId)}</span></> : <span style={{ fontSize: 13, color: NX.faint }}>-</span>}
            {canRequestControl && (
              <button type="button" onClick={() => setRequestingControl(true)}
                title={`Watch ${nameOf(t.requesterId) || 'their'} screen live, then ask to take control - same consent-first flow as Workforce Analytics`}
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
            <PersonSelect value={t.assigneeId || null} people={people} onChange={(v) => patch({ assigneeId: v || '' })}
              disabled={!canWorking || t.approvalStatus === 'pending'}
              placeholder={t.approvalStatus === 'pending' ? 'Awaiting approval' : 'Unassigned'} />
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
        <div style={field}>
          <label style={label}>Company</label>
          {canEditCompany ? (
            <TicketSelect value={t.companyId || ''} onChange={(v) => patch({ companyId: v, hrDepartmentId: '' })}
              style={sel} placeholder="Select company" searchPlaceholder="Search companies…"
              options={[['', 'Select company'], ...companies.map((c) => [c.id, c.name])]} />
          ) : (
            <div style={{ fontSize: 13, color: NX.ink, minHeight: 34, display: 'flex', alignItems: 'center' }}>
              {companies.find((c) => c.id === t.companyId)?.name || '-'}
            </div>
          )}
        </div>
        <div style={field}>
          <label style={label}>Department</label>
          <TicketSelect value={t.hrDepartmentId || ''} onChange={(v) => patch({ hrDepartmentId: v })} style={sel}
            disabled={!t.companyId || !canWorking} searchPlaceholder="Search departments…"
            placeholder={t.companyId ? 'Select department' : 'Select a company first'}
            options={[['', t.companyId ? 'Select department' : 'Select a company first'],
              ...allDepts.filter((d) => d.companyId === t.companyId).map((d) => [d.id, d.name])]} />
        </div>
        {/* What the ticket is about. fullAccess, NOT canWorking: `application`
            is not one of the backend's _WORKING_FIELDS, so a triaging third
            party offered this control would get a 403 they cannot act on.
            Re-pointing a mis-filed ticket is the requester's, the assignee's
            or a manager's to do - which is exactly what fullAccess is. */}
        <div style={field}>
          <label style={label}>Application</label>
          {fullAccess ? (
            <ApplicationSelect apps={apps} value={t.application || ''}
              deptName={allDepts.find((d) => d.id === t.hrDepartmentId)?.name || ''}
              onChange={(name) => patch({ application: name })} />
          ) : (
            <div style={{ fontSize: 13, color: NX.ink, minHeight: 34, display: 'flex', alignItems: 'center' }}>{t.application || '-'}</div>
          )}
        </div>
        {/* Derived from the application by the server, and re-derived whenever
            it changes. A manager can still override it here for an app the
            directory has mapped wrongly - correcting the mapping itself is a
            job for the External Links screen. */}
        <div style={field}>
          <label style={label}>Service Area</label>
          {fullAccess ? (
            <TicketSelect value={t.serviceArea || ''} onChange={(v) => patch({ serviceArea: v })} style={sel}
              placeholder="Not set" options={[['', 'Not set'], ...serviceAreaOptions()]} />
          ) : (
            <div style={{ fontSize: 13, color: NX.ink, minHeight: 34, display: 'flex', alignItems: 'center' }}>{serviceAreaLabel(t.serviceArea) || '-'}</div>
          )}
        </div>
        {canSeeAssignSla && (
          <div style={field}>
            <label style={label}>SLA Due Date</label>
            {fullAccess ? (
              <DateField value={t.slaDueOn || ''} onChange={(v) => patch({ slaDueOn: v || '' })} color={overdue ? NX.red : undefined}
                style={{ ...inputStyle, ...(overdue ? { fontWeight: 700 } : {}) }} />
            ) : (
              <div style={{ fontSize: 13, color: overdue ? NX.red : NX.ink, fontWeight: overdue ? 700 : 400, minHeight: 34, display: 'flex', alignItems: 'center' }}>
                {t.slaDueOn ? fmtDate(t.slaDueOn) : '-'}
              </div>
            )}
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
        )}
        {CLOSED_STATES.includes(t.status) && (
          <div style={field}>
            <label style={label}>Resolution</label>
            <TicketSelect value={t.resolution || ''} onChange={(v) => patch({ resolution: v })} style={sel}
              disabled={!canWorking} placeholder="- pick -"
              options={[['', '- pick -'], ...TICKET_RESOLUTION.map((r) => [r.key, r.label])]} />
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
                  <TypeFieldInput field={f} value={t.typeFields?.[f.key]} onChange={(v) => patch({ typeFields: { ...(t.typeFields || {}), [f.key]: v } })} people={people} projects={projects} />
                ) : (
                  <div style={{ fontSize: 13, color: NX.ink, whiteSpace: f.type === 'textarea' ? 'pre-wrap' : 'normal' }}>{readOnlyFieldValue(f, t.typeFields?.[f.key], nameOf)}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {shownSvcFields.length > 0 && (
        <div style={field}>
          <label style={label}>{serviceAreaLabel(t.serviceArea) || 'Application'} Details</label>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            {withDynamicOptions(shownSvcFields, { sites }).map((f) => (
              <div key={f.key} style={{ gridColumn: (f.full || f.type === 'textarea') ? '1 / -1' : 'auto' }}>
                <div style={{ ...label, fontSize: 11 }}>{f.label}</div>
                {fullAccess ? (
                  <TypeFieldInput field={f} value={t.typeFields?.[f.key]} onChange={(v) => patch({ typeFields: { ...(t.typeFields || {}), [f.key]: v } })} people={people} projects={projects} />
                ) : (
                  <div style={{ fontSize: 13, color: NX.ink }}>{readOnlyFieldValue(f, t.typeFields?.[f.key], nameOf)}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={field}>
        <label style={label}>Tasks</label>
        <TicketTasks taskIds={taskIds} tasks={tasks} onSpawn={spawnTask} onLink={linkTask} onUnlink={unlinkTask} readOnly={!fullAccess} />
      </div>

      <div style={field}>
        <label style={label}>Linked Tickets</label>
        <TicketLinks ticket={t} tickets={tickets} onAdd={(target, type) => addTicketLink(t.id, target, type).catch((e) => alert(e.message || e))}
          onRemove={(target) => removeTicketLink(t.id, target).catch(() => {})} readOnly={!fullAccess} />
      </div>

      {CLOSED_STATES.includes(t.status) && (
        <div style={field}>
          <label style={label}>Satisfaction (CSAT)</label>
          <CsatWidget ticket={t} canRate={!t.requesterId || t.requesterId === myEmail} onRate={(rating) => patch({ csatRating: rating })}
            onComment={(comment) => patch({ csatComment: comment })} />
        </div>
      )}

        </>)}
        {tab === 'conversation' && <TicketConversation ticketId={t.id} nameOf={nameOf} />}
        {tab === 'attachments' && <TicketAttachments ticketId={t.id} ticketType={t.type} />}
        {tab === 'activity' && <TicketActivity ticketId={t.id} nameOf={nameOf} companies={companies} allDepts={allDepts} />}
      </div>
    </Modal>
    {requestingControl && (
      <LiveView email={t.requesterId} name={nameOf(t.requesterId) || t.requesterId} onClose={() => setRequestingControl(false)} />
    )}
    </>
  );
}

// ── Approvals ────────────────────────────────────────────────────────────────
// A small status chip, shown wherever a ticket is listed.
function ApprovalChip({ ticket }) {
  const meta = APPROVAL_META[ticket.approvalStatus];
  if (!meta) return null;   // "none" - this ticket never needed approval
  // Smaller than the status chip beside it - same reasoning as SlaBadge.
  return <span style={{ ...chip(meta.color, meta.tint), fontSize: 11, padding: '1px 7px' }}>{meta.label}</span>;
}

// The approval panel, in two acts.
//
// 1. A parked request arrives with no approver: an IT Admin picks who signs it
//    off and sends it. Nobody else can - a requester who chooses their own
//    approver has not been approved by anyone.
// 2. Once routed, the named approver (or an admin) sees the decision buttons;
//    everyone else sees who it's waiting on, or what was decided and why.
function ApprovalPanel({ ticket: t, myEmail, nameOf, onDecided }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [approver, setApprover] = useState(null);
  const [itAdmin, setItAdmin] = useState(false);
  const people = usePeople();
  useEffect(() => {
    let alive = true;
    // canAct here, not onDesk - an administrator must be able to unstick a
    // request whose desk was mis-configured.
    api.getMyTicketAccess().then((r) => { if (alive) setItAdmin(!!r?.canAct); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const status = t.approvalStatus || 'none';
  if (status === 'none') return null;

  const meta = APPROVAL_META[status];
  const mine = (t.approverId || '').toLowerCase() === (myEmail || '').toLowerCase();
  // Not yet routed. The desk's step, not the approver's.
  const needsRouting = status === 'pending' && !t.approverId;

  const sendForApproval = async () => {
    if (!approver) { setErr('Choose who should approve this.'); return; }
    setErr(''); setBusy('send');
    try { await api.requestTicketApproval(t.id, approver, note.trim()); await onDecided?.(); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  const decide = async (decision) => {
    // The backend requires a reason to reject; ask here rather than fail the call.
    if (decision === 'reject' && !note.trim()) {
      setErr('A reason is required to reject.');
      return;
    }
    setErr(''); setBusy(decision);
    try { await api.decideTicketApproval(t.id, decision, note.trim()); await onDecided?.(); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  return (
    <div style={{ border: `1px solid ${meta.color}`, background: meta.tint, borderRadius: 10, padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: status === 'pending' ? 10 : 6 }}>
        <ShieldAlert size={15} style={{ color: meta.color }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>{meta.label}</span>
        {t.approverId && (
          <span style={{ fontSize: 12.5, color: NX.dim }}>
            {status === 'pending' ? 'waiting on ' : 'by '}{mine ? 'you' : nameOf(t.approverId)}
          </span>
        )}
        {t.approvalDecidedAt && <span style={{ fontSize: 11.5, color: NX.faint, marginLeft: 'auto' }}>{fmtDate(t.approvalDecidedAt)}</span>}
      </div>

      {needsRouting ? (
        itAdmin ? (
          <>
            <div style={{ fontSize: 12, color: NX.dim, marginBottom: 8 }}>
              This request needs approval before it can be assigned. Choose who signs it off.
            </div>
            <div style={{ marginBottom: 8 }}>
              <PersonSelect value={approver} people={people.filter((p) => (p.email || '').toLowerCase() !== (t.requesterId || '').toLowerCase())}
                onChange={setApprover} placeholder="Select approver" />
            </div>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Note for the approver (optional)"
              style={{ ...inputStyle, marginBottom: 8 }} />
            <button onClick={sendForApproval} disabled={!!busy} style={btn('primary')}>
              <Send size={14} /> {busy === 'send' ? 'Sending…' : 'Send for Approval'}
            </button>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: NX.dim }}>
            Waiting for IT to send this for approval. It can't be worked on until it's approved.
          </div>
        )
      ) : status === 'pending' ? (
        mine ? (
          <>
            <div style={{ fontSize: 12, color: NX.dim, marginBottom: 8 }}>
              Approving releases this ticket for assignment. Rejecting closes it.
            </div>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Reason (required to reject, optional to approve)"
              style={{ ...inputStyle, marginBottom: 8 }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => decide('approve')} disabled={!!busy} style={btn('primary')}>
                <CheckCircle2 size={14} /> {busy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button onClick={() => decide('reject')} disabled={!!busy} style={{ ...btn('outline'), color: NX.red, borderColor: NX.red }}>
                <X size={14} /> {busy === 'reject' ? 'Rejecting…' : 'Reject'}
              </button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: NX.dim }}>
            This request can't be worked on until it's approved.
          </div>
        )
      ) : t.approvalNote ? (
        <div style={{ fontSize: 12.5, color: NX.dim }}>“{t.approvalNote}”</div>
      ) : null}
      {err && <div style={{ marginTop: 8, fontSize: 12.5, color: NX.red, fontWeight: 600 }}>{err}</div>}
    </div>
  );
}

// ── Tasks spawned from / linked to a ticket (one ticket → many tasks) ─────────
function TicketTasks({ taskIds, tasks, onSpawn, onLink, onUnlink, readOnly }) {
  const [linking, setLinking] = useState(false);
  const linked = taskIds.map((id) => tasks.find((x) => x.id === id)).filter(Boolean);
  const options = tasks.filter((x) => !taskIds.includes(x.id));
  return (
    <div>
      {linked.length === 0 && readOnly && <span style={{ fontSize: 12.5, color: NX.faint }}>No linked tasks</span>}
      {linked.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {linked.map((task) => (
            <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <ClipboardList size={13} style={{ color: NX.faint, flexShrink: 0 }} />
              <span style={{ color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {task.code ? `${task.code} · ` : ''}{task.title}
              </span>
              {task.status && <span style={{ fontSize: 11, color: NX.faint, flexShrink: 0 }}>{task.status === 'done' ? '✓ done' : task.status}</span>}
              {!readOnly && <button onClick={() => onUnlink(task.id)} title="Unlink task" style={{ ...btn('ghost'), padding: 2, marginLeft: 'auto', color: NX.faint }}><X size={13} /></button>}
            </div>
          ))}
        </div>
      )}
      {!readOnly && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={onSpawn} style={{ ...btn('outline'), fontSize: 12 }}><Plus size={13} /> Create Task from Ticket</button>
          {linking ? (
            <TicketSelect command placeholder="Select a task…" searchPlaceholder="Search tasks…"
              emptyText="No tasks to link." style={{ width: 'auto', minWidth: 180 }}
              options={options.map((task) => [task.id, `${task.code ? `${task.code} · ` : ''}${task.title}`])}
              onChange={(id) => { if (id) onLink(id); setLinking(false); }} />
          ) : (
            <button onClick={() => setLinking(true)} style={{ ...btn('ghost'), fontSize: 12, color: NX.dim }}><Link2 size={13} /> Link existing</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Ticket ↔ ticket links (relates / duplicate / blocks / blocked by) ─────────
function TicketLinks({ ticket, tickets, onAdd, onRemove, readOnly }) {
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState('');
  const [type, setType] = useState('relates');
  const links = ticket.links || [];
  const byId = (id) => tickets.find((x) => x.id === id);
  const options = tickets.filter((x) => x.id !== ticket.id && !links.some((l) => l.ticketId === x.id));

  const submit = () => { if (!target) return; onAdd(target, type); setTarget(''); setType('relates'); setAdding(false); };

  return (
    <div>
      {links.length === 0 && readOnly && <span style={{ fontSize: 12.5, color: NX.faint }}>No linked tickets</span>}
      {links.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {links.map((l) => {
            const lt = byId(l.ticketId);
            return (
              <div key={l.ticketId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ ...chip(NX.dim, NX.border2), flexShrink: 0 }}>{linkTypeLabel(l.type)}</span>
                <Link2 size={13} style={{ color: NX.faint, flexShrink: 0 }} />
                <span style={{ color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {lt ? `${ticketNoShort(lt.code) ? ticketNoShort(lt.code) + ' · ' : ''}${lt.subject}` : l.ticketId}
                </span>
                {!readOnly && <button onClick={() => onRemove(l.ticketId)} title="Remove link" style={{ ...btn('ghost'), padding: 2, marginLeft: 'auto', color: NX.faint }}><X size={13} /></button>}
              </div>
            );
          })}
        </div>
      )}
      {!readOnly && (<>
      {adding ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <TicketSelect value={type} onChange={setType} style={{ width: 'auto' }}
            options={LINK_TYPES.map((l) => [l.key, l.label])} />
          <TicketSelect value={target} onChange={setTarget} style={{ flex: 1, minWidth: 160 }}
            placeholder="Select a ticket…" searchPlaceholder="Search tickets…" emptyText="No tickets to link."
            options={[['', 'Select a ticket…'],
              ...options.map((x) => [x.id, `${ticketNoShort(x.code) ? `${ticketNoShort(x.code)} · ` : ''}${x.subject}`])]} />
          <button onClick={submit} disabled={!target} style={{ ...btn('primary'), opacity: target ? 1 : 0.5 }}>Link</button>
          <button onClick={() => setAdding(false)} style={btn('ghost')}>Cancel</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12 }}><Link2 size={13} /> Link a ticket</button>
      )}
      </>)}
    </div>
  );
}

// ── CSAT - a 1-5 satisfaction rating shown once a ticket is resolved/closed ────
function CsatWidget({ ticket, canRate, onRate, onComment }) {
  const [hover, setHover] = useState(0);
  const rating = ticket.csatRating || 0;
  const [comment, setComment] = useState(ticket.csatComment || '');
  useEffect(() => setComment(ticket.csatComment || ''), [ticket.csatComment]);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} size={22} onClick={() => canRate && onRate(n)} onMouseEnter={() => canRate && setHover(n)} onMouseLeave={() => setHover(0)}
            style={{ cursor: canRate ? 'pointer' : 'default', color: (hover || rating) >= n ? NX.amber : NX.border, fill: (hover || rating) >= n ? NX.amber : 'none' }} />
        ))}
        {rating > 0 && <span style={{ fontSize: 12.5, color: NX.dim, marginLeft: 6 }}>{rating}/5</span>}
      </div>
      {canRate ? (
        <input value={comment} onChange={(e) => setComment(e.target.value)} onBlur={() => { if (comment !== (ticket.csatComment || '')) onComment(comment); }}
          placeholder="Optional feedback…" style={{ ...inputStyle, marginTop: 8 }} />
      ) : ticket.csatComment ? (
        <p style={{ margin: '6px 0 0', fontSize: 12.5, color: NX.dim, fontStyle: 'italic' }}>“{ticket.csatComment}”</p>
      ) : null}
    </div>
  );
}

// ── Reports - open-by-status/type/assignee, avg resolution, SLA compliance ─────
function TicketReports({ tickets, nameOf, hrDeptName }) {
  const stats = useMemo(() => {
    const open = tickets.filter((t) => !CLOSED_STATES.includes(t.status));
    const byStatus = TICKET_STATUS_ORDER.map((s) => ({ label: TICKET_STATUS_META[s].label, value: tickets.filter((t) => t.status === s).length, color: TICKET_STATUS_META[s].color })).filter((d) => d.value > 0);
    const byType = TICKET_TYPE_ORDER.map((ty) => ({ label: TICKET_TYPE_META[ty].label, value: tickets.filter((t) => (t.type || 'request') === ty).length, color: TICKET_TYPE_META[ty].color })).filter((d) => d.value > 0);
    const byPriority = PRIORITY_ORDER.map((p) => ({ label: PRIORITY_META[p].label, value: tickets.filter((t) => t.priority === p).length, color: PRIORITY_META[p].color })).filter((d) => d.value > 0);
    const PAL = ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#dc2626', '#0891b2', '#db2777', '#65a30d'];
    // top assignees among open tickets
    const acc = new Map();
    for (const t of open) { const k = t.assigneeId || ''; acc.set(k, (acc.get(k) || 0) + 1); }
    const byAssignee = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, n], i) => ({ label: k ? (nameOf(k) || k) : 'Unassigned', value: n, color: PAL[i % 8] }));
    // Where tickets come from. HR Department is the routing dimension - it decides
    // which lead triages the ticket - so it's the cut worth showing.
    const deptAcc = new Map();
    for (const t of tickets) { const k = t.hrDepartmentId || ''; deptAcc.set(k, (deptAcc.get(k) || 0) + 1); }
    const byDepartment = [...deptAcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, n], i) => ({ label: k ? (hrDeptName(k) || k) : 'No department', value: n, color: PAL[i % 8] }));
    // Which apps generate the work, and which service areas carry it. The two
    // cuts the desk cannot get from any other dimension: department says whose
    // problem it is, these say what the problem is IN.
    const appAcc = new Map();
    for (const t of tickets) { const k = t.application || ''; if (!k) continue; appAcc.set(k, (appAcc.get(k) || 0) + 1); }
    const byApplication = [...appAcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, n], i) => ({ label: k, value: n, color: PAL[i % 8] }));
    const areaAcc = new Map();
    for (const t of tickets) { const k = t.serviceArea || ''; areaAcc.set(k, (areaAcc.get(k) || 0) + 1); }
    const byServiceArea = [...areaAcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, n], i) => ({ label: k ? (serviceAreaLabel(k) || k) : 'Not set', value: n, color: PAL[i % 8] }));
    // recurrence signal - cluster by normalised subject; 2+ = a repeat worth investigating
    const norm = (s) => (s || '').toLowerCase().replace(/[0-9]+/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const recAcc = new Map();
    for (const t of tickets) { const k = norm(t.subject); if (!k) continue; if (!recAcc.has(k)) recAcc.set(k, { label: t.subject, count: 0 }); recAcc.get(k).count += 1; }
    const recurring = [...recAcc.values()].filter((g) => g.count >= 2).sort((a, b) => b.count - a.count).slice(0, 6);
    // avg resolution time (days) for resolved tickets with both timestamps
    const resolved = tickets.filter((t) => t.resolvedAt && t.createdAt);
    const avgDays = resolved.length
      ? (resolved.reduce((s, t) => s + Math.max(0, (new Date(t.resolvedAt) - new Date(t.createdAt))), 0) / resolved.length) / 86400000
      : null;
    // SLA compliance among closed tickets that had a due date: resolved on/before due
    const closedWithSla = tickets.filter((t) => CLOSED_STATES.includes(t.status) && t.slaDueOn && t.resolvedAt);
    const met = closedWithSla.filter((t) => t.resolvedAt.slice(0, 10) <= t.slaDueOn).length;
    const compliance = closedWithSla.length ? Math.round((met / closedWithSla.length) * 100) : null;
    const breaching = tickets.filter((t) => slaState(t) === 'breached').length;
    const atRisk = tickets.filter((t) => slaState(t) === 'at_risk').length;
    const rated = tickets.filter((t) => (t.csatRating || 0) > 0);
    const avgCsat = rated.length ? rated.reduce((s, t) => s + t.csatRating, 0) / rated.length : null;
    return { total: tickets.length, open: open.length, byStatus, byType, byPriority, byAssignee, byDepartment, byApplication, byServiceArea, recurring, avgDays, compliance, breaching, atRisk, avgCsat };
  }, [tickets, nameOf, hrDeptName]);

  if (tickets.length === 0) return <EmptyState icon={BarChart3} title="No Data" hint="No tickets match your filters." />;

  const Stat = ({ label: lab, value, color }) => (
    <div style={{ flex: '1 1 130px', borderRadius: 14, border: `1px solid ${NX.border}`, background: NX.surface, padding: '14px 16px' }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: color || NX.ink }}>{value}</div>
      <div style={{ fontSize: 12, color: NX.dim, marginTop: 2 }}>{lab}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="Total Tickets" value={stats.total} />
        <Stat label="Open" value={stats.open} color={NX.blue} />
        <Stat label="SLA breached" value={stats.breaching} color={stats.breaching ? NX.red : NX.ink} />
        <Stat label="Due soon" value={stats.atRisk} color={stats.atRisk ? NX.amber : NX.ink} />
        <Stat label="Avg Resolution" value={stats.avgDays == null ? '-' : `${stats.avgDays.toFixed(1)}d`} />
        <Stat label="SLA Compliance" value={stats.compliance == null ? '-' : `${stats.compliance}%`} color={stats.compliance != null && stats.compliance < 80 ? NX.red : NX.green} />
        <Stat label="Avg CSAT" value={stats.avgCsat == null ? '-' : `${stats.avgCsat.toFixed(1)}★`} color={stats.avgCsat != null && stats.avgCsat >= 4 ? NX.green : NX.ink} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        <Card title="By status"><Donut segments={stats.byStatus} total={stats.byStatus.reduce((s, d) => s + d.value, 0)} /></Card>
        <Card title="By type"><LightBar data={stats.byType} /></Card>
        <Card title="By priority"><LightBar data={stats.byPriority} /></Card>
        <Card title="By department"><LightBar data={stats.byDepartment} /></Card>
        <Card title="By service area"><LightBar data={stats.byServiceArea} /></Card>
        <Card title="By application">
          {stats.byApplication.length === 0
            ? <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 12, color: NX.faint }}>No tickets name an application yet.</div>
            : <LightBar data={stats.byApplication} />}
        </Card>
        <Card title="Open by assignee"><LightBar data={stats.byAssignee} /></Card>
        <Card title="Recurring issues (repeat signal)">
          {stats.recurring.length === 0
            ? <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 12, color: NX.faint }}>No repeats yet - every subject is unique.</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {stats.recurring.map((g) => (
                  <div key={g.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ ...chip(NX.red, 'rgba(220,38,38,0.14)'), flexShrink: 0 }}>×{g.count}</span>
                    <span style={{ fontSize: 12.5, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: NX.faint, marginTop: 2 }}>Repeats often signal a fix-once/capital-replacement opportunity, not more repairs.</div>
              </div>
            )}
        </Card>
      </div>
    </div>
  );
}

// ── Conversation thread ──────────────────────────────────────────────────────
// The same editor the task module's comments use (RichDescription), not a bare
// textarea: formatting, links and - the point of the change - @mentions, which
// this thread simply did not have (Sagar, Sept 2 2026). A mention is written as
// a mailto link, which is exactly what routers/task_util.extract_mentions reads
// on the way in, so one editor and one parser serve tasks and tickets both.
function TicketConversation({ ticketId, nameOf }) {
  const [rows, setRows] = useState(null);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const people = usePeople();
  const reload = () => api.getTicketComments(ticketId).then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ticketId]);

  const send = async () => {
    if (isEmptyDoc(body) || busy) return;
    setBusy(true);
    try { await api.addTicketComment(ticketId, { body, internal }); setBody(''); await reload(); }
    catch { /* ignore */ } finally { setBusy(false); }
  };
  const del = async (id) => { await api.deleteTicketComment(id).catch(() => {}); reload(); };

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
        {rows === null ? <div style={{ padding: '6px 0' }}><SkeletonBlocks count={4} height={44} /></div>
          : rows.length === 0 ? <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>No comments yet.</div>
            : rows.map((c) => (
              <div key={c.id} style={{ display: 'flex', gap: 8, ...(c.internal ? { background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 10, padding: 8 } : {}) }}>
                <Avatar email={c.authorId} name={nameOf(c.authorId)} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{nameOf(c.authorId) || c.authorId}</span>
                    {c.internal && <span style={{ ...chip(NX.amber, 'rgba(245,158,11,0.16)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}><Lock size={10} /> Internal note</span>}
                    <span style={{ fontSize: 11, color: NX.faint }}>{fmtDate(c.createdAt)}</span>
                    <button onClick={() => del(c.id)} title="Delete" style={{ ...btn('ghost'), padding: 2, marginLeft: 'auto', color: NX.faint }}><X size={13} /></button>
                  </div>
                  {/* richBodyHtml sanitizes, and wraps a plain-text body (every
                      comment written before this change) in paragraphs - so old
                      and new comments render the same way. */}
                  <div className="nx-rich-body" style={{ fontSize: 13, color: NX.dim, marginTop: 2 }}
                    dangerouslySetInnerHTML={{ __html: richBodyHtml(c.body, nameOf) }} />
                </div>
              </div>
            ))}
      </div>
      {/* Public reply vs internal note toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {[['reply', 'Public reply', false], ['note', 'Internal note', true]].map(([k, lab, isInt]) => (
          <button key={k} onClick={() => setInternal(isInt)} style={{
            ...btn('ghost'), padding: '5px 10px', fontSize: 12, borderRadius: 7,
            background: internal === isInt ? (isInt ? 'rgba(245,158,11,0.16)' : 'rgba(37,99,235,0.12)') : 'transparent',
            color: internal === isInt ? (isInt ? NX.amber : NX.blue) : NX.dim, fontWeight: internal === isInt ? 700 : 600,
          }}>{isInt ? <Lock size={12} /> : <MessageSquare size={12} />}{lab}</button>
        ))}
      </div>
      {/* The internal-note tint moves to a wrapper: the editor owns its own box,
          and a note still has to LOOK unlike a public reply at a glance. */}
      <div style={internal ? { borderRadius: 10, padding: 2, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)' } : undefined}>
        <RichDescription
          value={body}
          onChange={setBody}
          onSubmit={send}
          mentionPeople={people}
          minHeight={64}
          placeholder={internal ? 'Internal note - visible to agents, not the requester…' : 'Public reply…'}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <span style={{ fontSize: 11, color: NX.faint }}>
          Type <b>@</b> to mention someone - they'll be added to the ticket and told. ⌘/Ctrl+Enter to send.
        </span>
        <button onClick={send} disabled={isEmptyDoc(body) || busy}
          style={{ ...btn('primary'), marginLeft: 'auto', flexShrink: 0, opacity: (isEmptyDoc(body) || busy) ? 0.55 : 1, ...(internal ? { background: NX.amber, borderColor: NX.amber } : {}) }}>
          <Send size={14} /> {busy ? 'Sending…' : internal ? 'Add note' : 'Send'}
        </button>
      </div>
    </div>
  );
}

// ── Attachment viewer ────────────────────────────────────────────────────────
// In-app viewer: images, recordings and PDFs open over the drawer instead of a
// new tab. z sits ABOVE the ticket modal (4000) and BELOW the recorder pill
// (6000). Escape is captured so it closes the viewer without also closing the
// drawer underneath; files with no inline renderer (docx, xlsx…) get a clean
// download card rather than a broken embed.
function AttachmentViewer({ att, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  if (!att) return null;
  const isPdf = /\.pdf($|\?)/i.test(att.name || '') || /\.pdf($|\?)/i.test(att.url || '');
  const body = att.kind === 'image' ? (
    <img src={att.url} alt={att.name} style={{ maxWidth: '92vw', maxHeight: '78vh', objectFit: 'contain', borderRadius: 8 }} />
  ) : att.kind === 'video' ? (
    <video src={att.url} controls autoPlay style={{ maxWidth: '92vw', maxHeight: '78vh', borderRadius: 8, background: '#000' }} />
  ) : isPdf ? (
    <iframe src={att.url} title={att.name} style={{ width: '92vw', height: '78vh', border: 'none', borderRadius: 8, background: '#fff' }} />
  ) : (
    <div onClick={(e) => e.stopPropagation()} style={{ background: NX.surface, borderRadius: 14, padding: '34px 44px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, maxWidth: '86vw' }}>
      <Paperclip size={30} style={{ color: NX.faint }} />
      <div style={{ fontSize: 14.5, fontWeight: 700, color: NX.ink, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</div>
      <div style={{ fontSize: 12.5, color: NX.dim }}>No inline preview for this file type.</div>
      <a href={att.url} download={att.name} style={{ ...btn('primary'), textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Download size={14} /> Download
      </a>
    </div>
  );
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 5500, background: 'rgba(9,14,11,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: FONT }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 20px', color: '#fff' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
        <span style={{ fontSize: 12, opacity: 0.65 }}>{att.size}</span>
        <span style={{ flex: 1 }} />
        {att.url && <a href={att.url} download={att.name} title="Download" style={{ color: '#fff', opacity: 0.8, display: 'flex' }}><Download size={16} /></a>}
        <button onClick={onClose} aria-label="Close viewer" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff', display: 'flex', padding: 4 }}><X size={19} /></button>
      </div>
      <div onClick={(e) => e.stopPropagation()}>{body}</div>
    </div>
  );
}

// ── Attachments ──────────────────────────────────────────────────────────────
// Card size for the attachment gallery - wide/tall enough for a video thumbnail
// to actually read as a preview rather than an icon, narrow enough that a
// handful still fit before wrapping.
const ATT_CARD_W = 138;
const ATT_THUMB_H = 84;

function TicketAttachments({ ticketId, ticketType }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null);   // attachment open in the in-app viewer
  const [hoverId, setHoverId] = useState(null);
  const isMobile = useIsMobile();   // no hover on touch - actions stay visible instead
  const reload = () => api.getTicketAttachments(ticketId).then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ticketId]);

  const sendFile = async (f) => {
    setBusy(true);
    const size = `${Math.max(1, Math.round(f.size / 1024))} KB`;
    const kind = attachmentKindOf(f);
    let url = '';
    try {
      url = await uploadTicketEvidence(f, kind);
    } catch (e) {
      alert(`"${f.name}" was recorded but couldn't be stored: ${e?.message || 'upload failed'}. It won't be playable/downloadable.`);
    }
    await api.addTicketAttachment(ticketId, { name: f.name, size, kind, url }).catch(() => {});
    setBusy(false);
    reload();
  };
  const onFile = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) sendFile(f); };
  const onPaste = (e) => { const files = filesFromPaste(e); if (files.length) { e.preventDefault(); files.forEach(sendFile); } };
  const del = async (id) => { await api.deleteTicketAttachment(id).catch(() => {}); reload(); };
  // Recording from an EXISTING ticket's Attachments tab, mirroring the create
  // form's onRecChange (recordingDraft.js): sendFile already uploads fine
  // even if this component unmounts mid-flight (it's just async API calls,
  // no navigation involved). What's missing without this is getting the
  // person BACK to this ticket once they stop - if they're still looking at
  // it, isTicketDrawerOpen is true and there's nothing to do (sendFile's own
  // reload() refreshes the list). If they navigated away - closed the
  // drawer, switched tickets, or left the module entirely - stash the id and
  // fire both the live event (drawer already mounted, showing something
  // else) and the module navigate (TicketsView itself unmounted) so
  // whichever one applies brings this exact ticket back up.
  const onRecChange = (v) => {
    if (v || isTicketDrawerOpen(ticketId)) return;
    setPendingOpen('ticket', ticketId);
    window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId } }));
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tickets' } }));
  };

  return (
    <div onPaste={onPaste} tabIndex={0} style={{ outline: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <RecordUploadButtons onFile={sendFile} disabled={busy} showRecord={!NO_RECORDING_TYPES.includes(ticketType)}
          onRecordingChange={onRecChange} />
        {busy && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: NX.faint }} />}
        <span style={{ fontSize: 11, color: NX.faint }}>or press Ctrl+V to paste a screenshot</span>
      </div>
      {rows === null ? (
        <div style={{ padding: '6px 0' }}>
          <SkeletonBlocks count={4} height={ATT_THUMB_H + 40} borderRadius={12}
            gridTemplateColumns={`repeat(auto-fill, minmax(${ATT_CARD_W}px, ${ATT_CARD_W}px))`} />
        </div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>No attachments yet.</div>
      ) : (
        // A small card gallery, not a row of tags: a real thumbnail earns a
        // click, a filename buried in a chip does not - a screen recording
        // especially needs to read as "press play", not as a broken image.
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {rows.map((a) => {
            const failed = !a.url;
            const showActions = isMobile || hoverId === a.id;
            const actionBtn = { width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.62)', color: '#fff', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'none' };
            return (
              <div key={a.id} onMouseEnter={() => setHoverId(a.id)} onMouseLeave={() => setHoverId((h) => (h === a.id ? null : h))}
                style={{ width: ATT_CARD_W, border: `1px solid ${NX.border}`, borderRadius: 12, overflow: 'hidden', background: NX.surface, position: 'relative' }}>
                <button type="button" disabled={failed} onClick={() => a.url && setView(a)}
                  title={failed ? "This file failed to upload and isn't available - remove it and re-attach" : `View ${a.name}`}
                  style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'none', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: failed ? 'default' : 'pointer' }}>
                  <div style={{ position: 'relative', width: '100%', height: ATT_THUMB_H, background: NX.border2, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: failed ? 0.5 : 1 }}>
                    {a.kind === 'image' && a.url ? (
                      <img src={a.url} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : a.kind === 'video' && a.url ? (
                      <>
                        {/* preload+seek past frame 0 - webm's first frame is often
                            solid black, which used to make every recording look
                            like a broken embed rather than a clickable preview. */}
                        <video src={a.url} muted preload="metadata" playsInline
                          onLoadedMetadata={(e) => { try { e.currentTarget.currentTime = 0.1; } catch { /* ignore */ } }}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
                        <span style={{ position: 'absolute', width: 30, height: 30, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Play size={14} fill="#fff" style={{ color: '#fff', marginLeft: 2 }} />
                        </span>
                      </>
                    ) : a.kind === 'video' ? (
                      <Play size={22} style={{ color: NX.faint }} />
                    ) : (
                      <Paperclip size={22} style={{ color: NX.faint }} />
                    )}
                    {failed && (
                      <span title="Upload failed" style={{ position: 'absolute', top: 6, right: 6, width: 20, height: 20, borderRadius: '50%', background: NX.red, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <ShieldAlert size={12} style={{ color: '#fff' }} />
                      </span>
                    )}
                  </div>
                  <div style={{ padding: '7px 9px' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: failed ? NX.faint : NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: failed ? 'line-through' : 'none' }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: NX.faint, marginTop: 1 }}>{a.size}</div>
                  </div>
                </button>
                {showActions && (
                  <div style={{ position: 'absolute', top: 6, left: 6, display: 'flex', gap: 4 }}>
                    {a.url && <a href={a.url} download={a.name} title="Download" style={actionBtn}><Download size={12} /></a>}
                    <button onClick={() => del(a.id)} title="Remove" style={actionBtn}><X size={12} /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {view && <AttachmentViewer att={view} onClose={() => setView(null)} />}
    </div>
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
    || Object.values(SERVICE_FIELDS).flat().find((f) => f.key === key)
    || { key, label: key, type: 'text' };
}

// The original submission, exactly as raised - see _ticket_snapshot on the
// backend. A permanent, un-editable audit copy: if a requester's mistake in
// any of these gets corrected later, this card is the proof of what the
// ticket originally said (Pranshu, Sept 8 2026).
function CreatedSnapshotCard({ snapshot, nameOf, companies, allDepts }) {
  const rows = [
    ['Type', TICKET_TYPE_META[snapshot.type]?.label || snapshot.type || '-'],
    ['Priority', PRIORITY_META[snapshot.priority]?.label || snapshot.priority || '-'],
    ['Application', snapshot.application || '-'],
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
      {snapshot.description && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: NX.faint, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Description</div>
          <p style={{ margin: 0, fontSize: 13, color: NX.dim, whiteSpace: 'pre-wrap' }}>{snapshot.description}</p>
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
        return (
          <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <Avatar email={a.actorId} name={nameOf(a.actorId)} size={22} />
              <span style={{ color: NX.ink, fontWeight: 600 }}>{nameOf(a.actorId) || a.actorId || 'Someone'}</span>
              <span style={{ color: NX.dim }}>
                {snapshot ? 'created this ticket' : comment ? (comment.internal ? 'added an internal note' : 'commented') : a.detail}
              </span>
              {comment?.internal && <span style={{ ...chip(NX.amber, 'rgba(245,158,11,0.16)'), display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '1px 7px' }}><Lock size={10} /> Internal</span>}
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
function TicketBoard({ tickets, nameOf, onOpen, onMove }) {
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 8 }}>
      {TICKET_STATUS_ORDER.map((s) => {
        const m = TICKET_STATUS_META[s];
        const col = tickets.filter((t) => t.status === s);
        return (
          <div key={s}
            onDragOver={(e) => { e.preventDefault(); setOver(s); }}
            onDragLeave={() => setOver((o) => (o === s ? null : o))}
            onDrop={() => { if (dragId) onMove(dragId, s); setDragId(null); setOver(null); }}
            style={{ width: 260, flexShrink: 0, background: over === s ? `${m.color}12` : NX.surface2, border: `1px solid ${over === s ? m.color : NX.border}`, borderRadius: 12, padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color }} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: NX.ink }}>{m.label}</span>
              <span style={{ fontSize: 12, color: NX.faint, marginLeft: 'auto' }}>{col.length}</span>
            </div>
            {col.slice(0, 100).map((t) => (
              <div key={t.id} draggable onDragStart={() => setDragId(t.id)} onDragEnd={() => setDragId(null)} onClick={() => onOpen(t.id)}
                style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, padding: 10, cursor: 'grab', opacity: dragId === t.id ? 0.5 : 1, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
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
              </div>
            ))}
            {col.length > 100 && <div style={{ fontSize: 11.5, color: NX.faint, textAlign: 'center', padding: '6px 0' }}>+ {col.length - 100} more - filter to narrow down</div>}
            {col.length === 0 && <div style={{ fontSize: 11.5, color: NX.faint, textAlign: 'center', padding: '10px 0' }}>-</div>}
          </div>
        );
      })}
    </div>
  );
}
