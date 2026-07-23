// Ticket Module — the support/IT request list.
//
// Split out of the task module (Jul 2026, "Option A"): the ticket files live
// here, but ticket state is still held in TasksContext and the shared UI atoms
// and theme still come from ../tasks — so the task module itself is untouched.
// Ticket statuses get their own colour map here (STATUS_META in tasks/theme.js
// is for tasks, not tickets). Inline-styled to match the rest of the app.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Ticket, Plus, Search, Link2, Trash2, CheckCircle2, Clock, ClipboardList, Paperclip, Send, X, Download, MessageSquare, History, List as ListIcon, Columns3, BarChart3, ShieldAlert, ArrowUp, Star, Lock, Bookmark, SlidersHorizontal, Image as ImageIcon, ScanText, Camera, ImagePlus } from 'lucide-react';
import { api } from '../api';
import { useTasks } from '../tasks/TasksContext';
import { filesFromPaste } from '../tasks/lib';
import { NX, FONT, chip, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER } from '../tasks/theme';
import { Avatar, PriorityChip, EmptyState, Modal, PersonSelect, usePeople, DateField, useIsMobile, useClickOutside } from '../tasks/components';
import MobileTaskBar, { BottomSheet } from '../tasks/MobileTaskBar';
import { Card, LightBar, Donut } from '../tasks/views/charts';
import {
  fmtDate, today, requiredHint, TICKET_TYPE_META, TICKET_TYPE_ORDER, TYPE_FIELDS,
  TICKET_RESOLUTION, LINK_TYPES, TICKET_STATUS_META, TICKET_STATUS_ORDER, CLOSED_STATES,
  SLA_TARGET_HOURS, SLA_META, slaState, slaDueFromPriority, isBlankFieldValue,
  label, field, resolutionLabel, linkTypeLabel, APPROVAL_META,
} from './ticketMeta';
import {
  TypeFieldInput, TicketTypeIcon, SlaBadge, TicketStatusChip, TicketCustomFieldInput,
} from './TicketAtoms';

// Views offered by the mobile bar's view sheet (desktop uses the inline switcher).
const TICKET_VIEW_TABS = [
  { key: 'list', label: 'List', icon: ListIcon },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
];

// Every filter the desktop toolbar shows, stacked into the mobile bar's sheet.
// Changes apply immediately — the sheet is a view onto the same state, so there
// is nothing to "save" and no way to lose a selection by dismissing it.
function TicketMobileFilters({
  onClose, statusFilter, setStatusFilter, priorityFilter, setPriorityFilter,
  typeFilter, setTypeFilter, slaFilter, setSlaFilter, hrDeptFilter, setHrDeptFilter, hrDepts,
  groupBy, setGroupBy, showGroup,
}) {
  const row = { ...inputStyle, appearance: 'auto', cursor: 'pointer', width: '100%', fontSize: 15, padding: '10px 12px' };
  const wrap = { marginBottom: 14 };
  const lab = { ...label, fontSize: 12.5 };
  // MobileTaskBar renders filterSheet(...) raw — the caller supplies the sheet
  // chrome (same contract as the task module's MobileFilters).
  return (
    <BottomSheet title="Filter & Group" onClose={onClose}>
      <div style={wrap}>
        <label style={lab}>Status</label>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={row}>
          <option value="all">All statuses</option>
          {TICKET_STATUS_ORDER.map((s) => <option key={s} value={s}>{TICKET_STATUS_META[s].label}</option>)}
        </select>
      </div>
      <div style={wrap}>
        <label style={lab}>Priority</label>
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} style={row}>
          <option value="all">All priorities</option>
          {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
        </select>
      </div>
      <div style={wrap}>
        <label style={lab}>Type</label>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={row}>
          <option value="all">All types</option>
          {TICKET_TYPE_ORDER.map((ty) => <option key={ty} value={ty}>{TICKET_TYPE_META[ty].label}</option>)}
        </select>
      </div>
      <div style={wrap}>
        <label style={lab}>SLA</label>
        <select value={slaFilter} onChange={(e) => setSlaFilter(e.target.value)} style={row}>
          <option value="all">Any SLA</option>
          <option value="breached">SLA breached</option>
          <option value="at_risk">Due soon</option>
          <option value="ok">On track</option>
        </select>
      </div>
      {hrDepts.length > 0 && (
        <div style={wrap}>
          <label style={lab}>Department</label>
          <select value={hrDeptFilter} onChange={(e) => setHrDeptFilter(e.target.value)} style={row}>
            <option value="all">All departments</option>
            <option value="">No department</option>
            {hrDepts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      )}
      {showGroup && (
        <div style={wrap}>
          <label style={lab}>Group by</label>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={row}>
            {['none', 'status', 'priority', 'type', 'assignee'].map((g) => (
              <option key={g} value={g}>{g === 'none' ? 'None' : g[0].toUpperCase() + g.slice(1)}</option>
            ))}
          </select>
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
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const active = [statusFilter, priorityFilter, typeFilter, slaFilter, hrDeptFilter].filter((v) => v !== 'all').length;
  const rowStyle = { ...inputStyle, appearance: 'auto', cursor: 'pointer', width: '100%' };
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
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={rowStyle}>
              <option value="all">All statuses</option>
              {TICKET_STATUS_ORDER.map((s) => <option key={s} value={s}>{TICKET_STATUS_META[s].label}</option>)}
            </select>
          </div>
          <div style={wrap}>
            <label style={lab}>Priority</label>
            <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} style={rowStyle}>
              <option value="all">All priorities</option>
              {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
            </select>
          </div>
          <div style={wrap}>
            <label style={lab}>Type</label>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={rowStyle}>
              <option value="all">All types</option>
              {TICKET_TYPE_ORDER.map((ty) => <option key={ty} value={ty}>{TICKET_TYPE_META[ty].label}</option>)}
            </select>
          </div>
          <div style={wrap}>
            <label style={lab}>SLA</label>
            <select value={slaFilter} onChange={(e) => setSlaFilter(e.target.value)} style={rowStyle}>
              <option value="all">Any SLA</option>
              <option value="breached">SLA breached</option>
              <option value="at_risk">Due soon</option>
              <option value="ok">On track</option>
            </select>
          </div>
          {hrDepts.length > 0 && (
            <div style={wrap}>
              <label style={lab}>Department</label>
              <select value={hrDeptFilter} onChange={(e) => setHrDeptFilter(e.target.value)} style={rowStyle}>
                <option value="all">All departments</option>
                <option value="">No department</option>
                {hrDepts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          )}
          {active > 0 && (
            <button onClick={() => { setStatusFilter('all'); setPriorityFilter('all'); setTypeFilter('all'); setSlaFilter('all'); setHrDeptFilter('all'); }}
              style={{ ...btn('ghost'), width: '100%', justifyContent: 'center', color: NX.red, fontSize: 12.5 }}>Clear filters</button>
          )}
        </div>
      )}
    </div>
  );
}

function SavedViewsMenu({ views, onApply, onSave, onDelete }) {
  const [open, setOpen] = useState(false);
  const btnStyle = { ...btn('outline'), padding: '7px 11px', fontSize: 13 };
  const item = { display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '8px 10px', fontSize: 13, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT, color: NX.ink, textAlign: 'left' };
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={btnStyle} title="Saved views"><Bookmark size={15} />Views{views.length ? ` · ${views.length}` : ''}</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 41, minWidth: 220, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', overflow: 'hidden', fontFamily: FONT }}>
            {views.length === 0 && <div style={{ padding: '10px 12px', fontSize: 12.5, color: NX.faint }}>No saved views yet.</div>}
            {views.map((v) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center' }}>
                <button onClick={() => { onApply(v); setOpen(false); }} style={{ ...item, flex: 1, minWidth: 0 }}>
                  <Bookmark size={13} style={{ color: NX.faint, flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
                </button>
                <button onClick={() => onDelete(v.id)} title="Delete view" style={{ ...btn('ghost'), padding: 6, color: NX.faint }}><X size={13} /></button>
              </div>
            ))}
            <div style={{ borderTop: `1px solid ${NX.border2}` }}>
              <button onClick={() => { onSave(); setOpen(false); }} style={{ ...item, color: NX.blue, fontWeight: 600 }}><Plus size={14} />Save current view…</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function TicketsView() {
  const { tickets, ticketViews = [], createTicketView, deleteTicketView,
    myEmail, nameOf, updateTicket, deleteTicket } = useTasks();
  const people = usePeople();
  const isMobile = useIsMobile();
  // HR departments carry the triage lead/backup; used for the Triage scope and the
  // department filter. Loaded here rather than in context — tickets are the only
  // consumer today.
  const [hrDepts, setHrDepts] = useState([]);
  useEffect(() => { api.getTicketDepartments().then(setHrDepts).catch(() => setHrDepts([])); }, []);
  const myDeptIds = useMemo(() => {
    const me = (myEmail || '').toLowerCase();
    // Guard the empty case: without it, "" matches every department whose lead is
    // unset, so a signed-out/loading user appears to lead the whole company.
    if (!me) return new Set();
    return new Set(hrDepts.filter((d) => (d.leadEmail || '').toLowerCase() === me
      || (d.backupEmail || '').toLowerCase() === me).map((d) => d.id));
  }, [hrDepts, myEmail]);
  const hrDeptName = (id) => hrDepts.find((d) => d.id === id)?.name || '';
  // Badge on the Triage tab — counts the whole queue, not the filtered view, so it
  // doesn't shrink as you narrow other filters.
  const triageCount = useMemo(() => tickets.filter(
    (t) => !t.assigneeId && myDeptIds.has(t.hrDepartmentId || '')).length, [tickets, myDeptIds]);
  // Requests parked on my approval — same reasoning: count the queue, not the view.
  const approvalCount = useMemo(() => {
    const me = (myEmail || '').toLowerCase();
    if (!me) return 0;   // same guard as myDeptIds — "" must not match "no approver"
    return tickets.filter((t) => t.approvalStatus === 'pending'
      && (t.approverId || '').toLowerCase() === me).length;
  }, [tickets, myEmail]);
  const [scope, setScope] = useState('all');   // all | mine (requester) | assigned | triage
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [hrDeptFilter, setHrDeptFilter] = useState('all');
  const [slaFilter, setSlaFilter] = useState('all');   // all | breached | at_risk | ok
  const [groupBy, setGroupBy] = useState('none');
  const [view, setView] = useState('list');   // 'list' | 'board' | 'reports'
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  // Deep-link support — the Outlook notification emails link to
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

  // Saved views — snapshot the current filter set + grouping + view kind.
  const applyTicketView = (v) => {
    const f = v.filters || {};
    setScope(f.scope ?? 'all'); setStatusFilter(f.statusFilter ?? 'all'); setPriorityFilter(f.priorityFilter ?? 'all');
    setTypeFilter(f.typeFilter ?? 'all'); setSlaFilter(f.slaFilter ?? 'all');
    setSearch(f.search ?? '');
    if (v.group) setGroupBy(v.group);
    if (v.view) setView(v.view);
  };
  const saveTicketView = () => {
    const name = window.prompt('Name this view');
    if (!name || !name.trim()) return;
    createTicketView({
      name: name.trim(), view, group: groupBy,
      filters: { scope, statusFilter, priorityFilter, typeFilter, slaFilter, search },
    }).catch((e) => alert(`Could not save view: ${e.message || e}`));
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const me = (myEmail || '').toLowerCase();
    return tickets.filter((t) => {
      if (scope === 'mine' && (t.requesterId || '').toLowerCase() !== me) return false;
      if (scope === 'assigned' && (t.assigneeId || '').toLowerCase() !== me) return false;
      // Triage queue: unassigned tickets for departments I lead or back up — the
      // work a department lead is notified about and expected to hand out.
      if (scope === 'triage' && ((t.assigneeId || '') || !myDeptIds.has(t.hrDepartmentId || ''))) return false;
      // Approval queue: requests parked on my decision.
      if (scope === 'approve' && !(t.approvalStatus === 'pending'
        && (t.approverId || '').toLowerCase() === me)) return false;
      if (hrDeptFilter !== 'all' && (t.hrDepartmentId || '') !== hrDeptFilter) return false;
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (typeFilter !== 'all' && (t.type || 'request') !== typeFilter) return false;
      if (slaFilter !== 'all' && slaState(t) !== slaFilter) return false;
      if (q) {
        const hay = `${t.code} ${t.subject} ${t.description} ${nameOf(t.requesterId) || ''} ${nameOf(t.assigneeId) || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tickets, scope, myEmail, search, statusFilter, priorityFilter, typeFilter, slaFilter, nameOf, myDeptIds, hrDeptFilter, approvalCount]);

  // Grouped sections for the list view.
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: '', rows: visible }];
    const buckets = new Map();
    const keyOf = (t) => (groupBy === 'status' ? t.status
      : groupBy === 'priority' ? t.priority
      : groupBy === 'type' ? (t.type || 'request')
      : groupBy === 'assignee' ? (t.assigneeId || '')
      : 'all');
    const labelOf = (k) => (groupBy === 'status' ? (TICKET_STATUS_META[k]?.label || k)
      : groupBy === 'priority' ? (PRIORITY_META[k]?.label || k)
      : groupBy === 'type' ? (TICKET_TYPE_META[k]?.label || k)
      : groupBy === 'assignee' ? (k ? nameOf(k) || k : 'Unassigned')
      : '');
    for (const t of visible) { const k = keyOf(t); if (!buckets.has(k)) buckets.set(k, { key: k || '—', label: labelOf(k), rows: [] }); buckets.get(k).rows.push(t); }
    return [...buckets.values()];
  }, [visible, groupBy, nameOf]);

  const selStyle = { ...inputStyle, width: 'auto', cursor: 'pointer' };
  const toggleBtn = (on) => ({ ...btn('ghost'), padding: '6px 10px', borderRadius: 7, gap: 6, background: on ? NX.surface : 'transparent', color: on ? NX.ink : NX.dim, boxShadow: on ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' });

  // Bulk selection (list view only). Selection is cleared when it no longer matches.
  const toggleSel = (id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  const selIds = [...selected].filter((id) => visible.some((t) => t.id === id));
  const bulkPatch = async (patch) => { await Promise.all(selIds.map((id) => updateTicket(id, patch).catch(() => {}))); clearSel(); };
  const bulkDelete = async () => {
    if (!window.confirm(`Delete ${selIds.length} ticket${selIds.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    await Promise.all(selIds.map((id) => deleteTicket(id).catch(() => {}))); clearSel();
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* Header — two rows, matching the task module: title + primary action, then
          a bordered tab strip with the toolbar on its right. On phones the tabs,
          filters and New Ticket move into the floating MobileTaskBar. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: isMobile ? '12px 12px 8px' : '18px 24px 12px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: isMobile ? 19 : 22, fontWeight: 700 }}>Tickets</div>
        {/* Scope pills scroll rather than wrap — there can be five once
            To Assign / To Approve appear. */}
        <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, maxWidth: '100%', overflowX: 'auto' }}>
          {[['all', 'All'], ['mine', isMobile ? 'Mine' : 'My Requests'], ['assigned', isMobile ? 'Assigned' : 'Assigned to Me'],
            ...(myDeptIds.size > 0 ? [['triage', `To Assign${triageCount ? ` (${triageCount})` : ''}`]] : []),
            ...(approvalCount > 0 ? [['approve', `To Approve (${approvalCount})`]] : [])].map(([k, lab]) => (
            <button key={k} onClick={() => setScope(k)} style={{ ...toggleBtn(scope === k), whiteSpace: 'nowrap' }}>{lab}</button>
          ))}
        </div>
        {!isMobile && <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={() => setCreating(true)}><Plus size={15} /> New Ticket</button>}
      </div>

      {!isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${NX.border}`, padding: '0 24px', flexWrap: 'wrap' }}>
          <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, overflowX: 'auto' }}>
            {TICKET_VIEW_TABS.map((tb) => (
              <button key={tb.key} onClick={() => setView(tb.key)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 12px', whiteSpace: 'nowrap',
                border: 'none', background: 'transparent', cursor: 'pointer',
                borderBottom: `2px solid ${view === tb.key ? NX.ink : 'transparent'}`, fontSize: 13, fontWeight: 600, fontFamily: FONT,
                color: view === tb.key ? NX.ink : NX.dim,
              }}><tb.icon size={15} /> {tb.label}</button>
            ))}
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
            />
            <SavedViewsMenu views={ticketViews} onApply={applyTicketView} onSave={saveTicketView} onDelete={(id) => deleteTicketView(id).catch(() => {})} />
            {view === 'list' && (
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ ...inputStyle, width: 'auto', flexShrink: 0, cursor: 'pointer' }}>
                {['none', 'status', 'priority', 'type', 'assignee'].map((g) => <option key={g} value={g}>Group: {g === 'none' ? 'None' : g[0].toUpperCase() + g.slice(1)}</option>)}
              </select>
            )}
          </div>
        </div>
      )}

      {/* Body. paddingBottom clears the floating mobile bar (matches My Tasks). */}
      <div className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, padding: view === 'board' ? 12 : 16, paddingBottom: isMobile ? 88 : undefined }}>
        {view === 'reports' ? (
          <TicketReports tickets={visible} nameOf={nameOf} hrDeptName={hrDeptName} />
        ) : view === 'board' ? (
          <TicketBoard tickets={visible} nameOf={nameOf} onOpen={setOpenId} onMove={(id, status) => updateTicket(id, { status }).catch(() => {})} />
        ) : visible.length === 0 ? (
          <EmptyState icon={Ticket} title="No Tickets" hint={tickets.length ? 'No tickets match your filters.' : 'Raise a ticket to get started.'} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: groupBy === 'none' ? 0 : 14 }}>
            {groups.map((g) => (
              <div key={g.key} className={isMobile ? 'nx-edge-card' : undefined} style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, overflow: 'hidden' }}>
                {groupBy !== 'none' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: NX.surface2, borderBottom: `1px solid ${NX.border2}`, fontSize: 13, fontWeight: 700 }}>
                    {g.label} <span style={{ color: NX.faint, fontWeight: 400 }}>{g.rows.length}</span>
                  </div>
                )}
                {g.rows.map((t) => (
                  <TicketRow key={t.id} t={t} nameOf={nameOf} hrDeptName={hrDeptName} onOpen={() => setOpenId(t.id)}
                    checked={selected.has(t.id)} onToggle={() => toggleSel(t.id)} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {view === 'list' && selIds.length > 0 && (
        <div style={{ position: 'sticky', bottom: 0, zIndex: 5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 16px', background: NX.ink, color: '#fff', borderTop: `1px solid ${NX.border}`, boxShadow: '0 -4px 16px rgba(0,0,0,0.14)' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{selIds.length} selected</span>
          <select defaultValue="" onChange={(e) => { if (e.target.value) bulkPatch({ status: e.target.value }); e.target.value = ''; }} style={{ ...selStyle, color: NX.ink }}>
            <option value="">Set status…</option>
            {TICKET_STATUS_ORDER.map((s) => <option key={s} value={s}>{TICKET_STATUS_META[s].label}</option>)}
          </select>
          <select defaultValue="" onChange={(e) => { if (e.target.value) bulkPatch({ priority: e.target.value }); e.target.value = ''; }} style={{ ...selStyle, color: NX.ink }}>
            <option value="">Set priority…</option>
            {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </select>
          <select defaultValue="" onChange={(e) => { bulkPatch({ assigneeId: e.target.value }); e.target.value = ''; }} style={{ ...selStyle, color: NX.ink, maxWidth: 200 }}>
            <option value="" disabled>Assign to…</option>
            <option value="">Unassign</option>
            {people.map((p) => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
          </select>
          <button style={{ ...btn('ghost'), color: '#fff', background: 'rgba(255,255,255,0.14)' }} onClick={() => bulkPatch({ status: 'resolved', resolution: 'fixed' })}><CheckCircle2 size={14} /> Resolve</button>
          <button style={{ ...btn('ghost'), color: '#fff', background: 'rgba(255,255,255,0.14)' }} onClick={bulkDelete}><Trash2 size={14} /> Delete</button>
          <button style={{ ...btn('ghost'), color: '#fff', marginLeft: 'auto' }} onClick={clearSel}><X size={14} /> Clear</button>
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

function TicketRow({ t, nameOf, hrDeptName, onOpen, checked, onToggle }) {
  const isMobile = useIsMobile();
  const overdue = t.slaDueOn && t.slaDueOn < today() && !CLOSED_STATES.includes(t.status);
  // The HR department is what routed this ticket, so it belongs on the row.
  const hrDept = t.hrDepartmentId ? hrDeptName(t.hrDepartmentId) : '';

  // Phones: two stacked lines instead of eight columns. Subject leads; the chips
  // and the assignee wrap underneath. Requester, the separate SLA date column and
  // the bulk-select checkbox are dropped — all reachable by opening the ticket,
  // and bulk edit is a desktop job.
  if (isMobile) {
    return (
      <div onClick={onOpen} style={{
        display: 'flex', flexDirection: 'column', gap: 6, padding: '11px 12px',
        borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer', background: NX.surface,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <TicketTypeIcon type={t.type} size={15} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: NX.ink, lineHeight: 1.35 }}>
              {t.subject}
              {t.linkedTaskId && <Link2 size={13} style={{ color: NX.faint, marginLeft: 6, verticalAlign: 'middle' }} />}
            </div>
            <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 2 }}>
              {t.code || '—'}{hrDept ? ` · ${hrDept}` : ''}
            </div>
          </div>
          {t.resolvedAt && <CheckCircle2 size={16} style={{ color: NX.green, flexShrink: 0 }} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <TicketStatusChip status={t.status} />
          {t.approvalStatus === 'pending' && <ApprovalChip ticket={t} />}
          <PriorityChip priority={t.priority} />
          <SlaBadge t={t} compact />
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            {t.assigneeId
              ? <><Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={20} />
                  <span style={{ fontSize: 12, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{nameOf(t.assigneeId)}</span></>
              : <span style={{ fontSize: 12, color: NX.faint }}>Unassigned</span>}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div onClick={onOpen} style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '11px 16px',
      borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer', background: checked ? NX.surface2 : NX.surface,
    }}
      onMouseEnter={(e) => { if (!checked) e.currentTarget.style.background = NX.surface2; }}
      onMouseLeave={(e) => { if (!checked) e.currentTarget.style.background = NX.surface; }}>
      <input type="checkbox" checked={!!checked} onChange={onToggle} onClick={(e) => e.stopPropagation()}
        title="Select" style={{ cursor: 'pointer', width: 15, height: 15, flexShrink: 0, accentColor: NX.blue }} />
      <TicketTypeIcon type={t.type} size={16} />
      <div style={{ minWidth: 0, flex: '1 1 240px' }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t.subject}
          {t.linkedTaskId && <Link2 size={13} style={{ color: NX.faint, marginLeft: 6, verticalAlign: 'middle' }} />}
        </div>
        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 1 }}>
          {t.code || '—'}{hrDept ? ` · ${hrDept}` : ''}
        </div>
      </div>
      <TicketStatusChip status={t.status} />
      {/* Only shows while pending — an approved request looks like any other. */}
      {t.approvalStatus === 'pending' && <ApprovalChip ticket={t} />}
      <PriorityChip priority={t.priority} />
      <SlaBadge t={t} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '0 1 150px' }} title={`Requester: ${nameOf(t.requesterId) || 'Unknown'}`}>
        {t.requesterId ? <Avatar email={t.requesterId} name={nameOf(t.requesterId)} size={22} /> : <span style={{ width: 22 }} />}
        <span style={{ fontSize: 12.5, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.requesterId ? nameOf(t.requesterId) : '—'}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '0 1 150px' }} title={`Assignee: ${t.assigneeId ? nameOf(t.assigneeId) : 'Unassigned'}`}>
        {t.assigneeId ? <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={22} /> : <span style={{ width: 22 }} />}
        <span style={{ fontSize: 12.5, color: t.assigneeId ? NX.dim : NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.assigneeId ? nameOf(t.assigneeId) : 'Unassigned'}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 92, justifyContent: 'flex-end' }}>
        <Clock size={12} style={{ color: overdue ? NX.red : NX.faint }} />
        <span style={{ fontSize: 12, color: overdue ? NX.red : NX.dim, fontWeight: overdue ? 700 : 400 }}>{t.slaDueOn ? fmtDate(t.slaDueOn) : '—'}</span>
      </div>
      {t.resolvedAt
        ? <CheckCircle2 size={16} style={{ color: NX.green, flexShrink: 0 }} title={`Resolved ${fmtDate(t.resolvedAt)}`} />
        : <span style={{ width: 16, flexShrink: 0 }} />}
    </div>
  );
}

// Posts one file to a ticket. Small files are inlined as a data URL (same rule as
// the drawer's attachment list); larger ones are recorded by name only.
async function uploadTicketFile(ticketId, f) {
  const size = `${Math.max(1, Math.round(f.size / 1024))} KB`;
  const kind = f.type.startsWith('image/') ? 'image' : 'doc';
  const url = f.size <= MAX_INLINE
    ? await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(typeof r.result === 'string' ? r.result : '');
        r.onerror = () => res('');
        r.readAsDataURL(f);
      })
    : '';
  return api.addTicketAttachment(ticketId, { name: f.name, size, kind, url }).catch(() => {});
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
    api.getTicketDepartments().then(setAllDepts).catch(() => setAllDepts([]));
  }, []);
  const [form, setForm] = useState({
    subject: '', description: '', type: 'bug', priority: 'medium', status: 'new',
    requesterId: myEmail || null, companyId: '', hrDepartmentId: '',
  });
  const [tf, setTf] = useState({});   // per-type field values (keyed by field key)
  const [step, setStep] = useState(1);                   // 1 = routing (company/dept/type), 2 = details
  const [showErrors, setShowErrors] = useState(false);   // only nag after a failed submit
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setTfVal = (k, v) => setTf((p) => ({ ...p, [k]: v }));
  const typeFieldDefs = useMemo(() => TYPE_FIELDS[form.type] || [], [form.type]);
  // Departments are scoped to the chosen company.
  const deptOptions = useMemo(
    () => (form.companyId ? allDepts.filter((d) => d.companyId === form.companyId) : []),
    [form.companyId, allDepts]);

  // ── Step 1 validation ──
  // Department is only demanded when the chosen company actually has departments —
  // requiring a choice with nothing to choose from would be an inescapable form.
  const missingStep1 = useMemo(() => {
    const out = new Set();
    if (!form.companyId) out.add('companyId');
    if (deptOptions.length > 0 && !form.hrDepartmentId) out.add('hrDepartmentId');
    return out;
  }, [form.companyId, form.hrDepartmentId, deptOptions]);

  // ── Step 2 validation ──
  // Recomputed each render, so red marks clear as soon as a field is filled. Only
  // the CURRENT type's fields are checked — leftovers from a previously selected
  // type are never submitted.
  const missing = useMemo(() => {
    const out = new Set();
    if (!form.subject.trim()) out.add('subject');
    for (const f of typeFieldDefs) {
      if (f.req && isBlankFieldValue(tf[f.key])) out.add(f.key);
    }
    return out;
  }, [form.subject, typeFieldDefs, tf]);

  const goNext = () => {
    if (missingStep1.size) { setShowErrors(true); return; }
    setShowErrors(false);   // step 2 starts clean
    setStep(2);
  };

  // ── Mobile capture shortcuts (mirrors CreateTaskModal) ──
  // Photo / attach / scan sit in the footer so they're one tap away on a phone.
  // Files are held locally and uploaded once the ticket exists — the attachment
  // API is keyed by ticket id, so there is nothing to attach to until then.
  const camRef = useRef(null);
  const libRef = useRef(null);
  const attachRef = useRef(null);
  const scanRef = useRef(null);
  const [attachments, setAttachments] = useState([]);
  const [photoMenu, setPhotoMenu] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
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
      // Persist the current type's fields, dropping blanks.
      const typeFields = {};
      for (const f of typeFieldDefs) {
        if (!isBlankFieldValue(tf[f.key])) typeFields[f.key] = tf[f.key];
      }
      const created = await createTicket({
        subject: form.subject.trim(), description: form.description, type: form.type, priority: form.priority, status: form.status,
        // Requester defaults to the current user; SLA due date is derived from priority.
        requesterId: form.requesterId || '', companyId: form.companyId || '', hrDepartmentId: form.hrDepartmentId || '',
        slaDueOn: slaDueFromPriority(form.priority),
        typeFields,
      });
      // Attachments can only be posted once the ticket has an id. A failure here
      // must not lose the ticket that was just created, so it's swallowed per file.
      if (created?.id && attachments.length) {
        await Promise.all(attachments.map((f) => uploadTicketFile(created.id, f)));
      }
      onClose();
    } catch (e) { alert(`Could not create ticket: ${e.message || e}`); setBusy(false); }
  };

  const sel = { ...inputStyle, appearance: 'auto', cursor: 'pointer' };
  const errStyle = (k, set_) => (showErrors && set_.has(k) ? { borderColor: NX.red } : null);

  // Phones get the Asana-style bottom sheet (same chrome as quick-create task);
  // desktop keeps the centred modal. A plain function, not a component — defining
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
    const companyName = companies.find((c) => c.id === form.companyId)?.name;
    return shell(isMobile ? 'New Ticket' : 'New Ticket · Step 1 of 2', {
      footer: (
        <>
          {showErrors && missingStep1.size > 0 && (
            <span style={{ fontSize: 12.5, color: NX.red, marginRight: 'auto', fontWeight: 600 }}>
              Select a company{missingStep1.has('hrDepartmentId') ? ' and department' : ''} to continue
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
        <div style={field}>
          <label style={label}>Company <span style={{ color: NX.red }}>*</span></label>
          <select autoFocus value={form.companyId}
            onChange={(e) => setForm((f) => ({ ...f, companyId: e.target.value, hrDepartmentId: '' }))}
            style={{ ...sel, ...errStyle('companyId', missingStep1) }}>
            <option value="">Select company</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {showErrors && missingStep1.has('companyId') && <div style={requiredHint}>Required</div>}
        </div>
        <div style={field}>
          <label style={label}>Department {deptOptions.length > 0 && <span style={{ color: NX.red }}>*</span>}</label>
          <select value={form.hrDepartmentId} onChange={(e) => set('hrDepartmentId', e.target.value)}
            style={{ ...sel, ...errStyle('hrDepartmentId', missingStep1) }} disabled={!form.companyId}>
            <option value="">{form.companyId ? 'Select department' : 'Select a company first'}</option>
            {deptOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {showErrors && missingStep1.has('hrDepartmentId') && <div style={requiredHint}>Required</div>}
          {form.companyId && deptOptions.length === 0 && (
            <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
              No departments set up for {companyName || 'this company'} — you can continue without one.
            </div>
          )}
        </div>
        <div style={field}>
          <label style={label}>Type <span style={{ color: NX.red }}>*</span></label>
          <select value={form.type} onChange={(e) => { set('type', e.target.value); setTf({}); }} style={sel}>
            {TICKET_TYPE_ORDER.map((ty) => <option key={ty} value={ty}>{TICKET_TYPE_META[ty].label}</option>)}
          </select>
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
            {typeFieldDefs.length} extra question{typeFieldDefs.length === 1 ? '' : 's'} on the next step.
          </div>
        </div>
      </>),
    });
  }

  // ── Step 2: the ticket itself, shaped by the type chosen in step 1. ──
  return shell(isMobile ? 'New Ticket' : 'New Ticket · Step 2 of 2', {
    onBack: isMobile ? () => { setStep(1); setShowErrors(false); } : undefined,
    // Phone only — same trio as Create a Task, so raising a ticket from a phone
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
            /* Opens upward — the footer is pinned to the bottom of the modal. */
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
      {/* Recap of step 1 — the choices shaping this form stay visible and editable. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', marginBottom: 14, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 8 }}>
        <TicketTypeIcon type={form.type} size={14} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: NX.ink }}>{TICKET_TYPE_META[form.type].label}</span>
        <span style={{ fontSize: 12.5, color: NX.dim }}>
          {companies.find((c) => c.id === form.companyId)?.name || '—'}
          {form.hrDepartmentId ? ` · ${deptOptions.find((d) => d.id === form.hrDepartmentId)?.name || ''}` : ''}
        </span>
        <button type="button" onClick={() => { setStep(1); setShowErrors(false); }}
          style={{ ...btn('ghost'), marginLeft: 'auto', padding: '2px 6px', fontSize: 12, color: NX.blue, fontWeight: 600 }}>Change</button>
      </div>

      <div style={field}>
        <label style={label}>Priority</label>
        <select value={form.priority} onChange={(e) => set('priority', e.target.value)} style={sel}>
          {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
        </select>
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

      {/* Type-specific details — the point of the ticket, so it's prominent. */}
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
    </>),
  });
}

// ── Edit drawer (modal) ───────────────────────────────────────────────────────
function TicketDrawer({ ticketId, onClose }) {
  const { tickets, tasks, projects = [], customFields = [],
    addTicketLink, removeTicketLink, escalateTicket, createTask, myEmail, nameOf, updateTicket, deleteTicket,
    refresh } = useTasks();
  // An approval decision changes status/resolution server-side, so pull the whole
  // list rather than patching one field locally.
  const onDecided = () => refresh?.();
  const people = usePeople();
  const isMobile = useIsMobile();
  const [tab, setTab] = useState('conversation');
  const [companies, setCompanies] = useState([]);
  const [allDepts, setAllDepts] = useState([]);
  useEffect(() => {
    api.getTicketCompanies().then(setCompanies).catch(() => setCompanies([]));
    api.getTicketDepartments().then(setAllDepts).catch(() => setAllDepts([]));
  }, []);
  const t = tickets.find((x) => x.id === ticketId);
  if (!t) return null;

  const patch = (p) => updateTicket(t.id, p).catch((e) => alert(`Could not update ticket: ${e.message || e}`));
  const escalate = () => escalateTicket(t.id).catch((e) => alert(`Could not escalate: ${e.message || e}`));
  // Same "ask a reason" pattern as the approval-reject flow — the Outlook
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
    if (!window.confirm(`Delete ticket ${t.code || t.subject}? This cannot be undone.`)) return;
    deleteTicket(t.id).then(onClose).catch((e) => alert(`Could not delete ticket: ${e.message || e}`));
  };

  const sel = { ...inputStyle, appearance: 'auto', cursor: 'pointer' };
  return (
    <Modal title={t.code || 'Ticket'} onClose={onClose} width={620} footer={
      <>
        <button style={{ ...btn('outline'), color: NX.red, borderColor: NX.border, marginRight: 'auto' }} onClick={remove}><Trash2 size={14} /> Delete</button>
        {t.priority !== 'urgent' && !CLOSED_STATES.includes(t.status) && (
          <button style={{ ...btn('outline'), color: NX.amber }} onClick={escalate} title="Bump priority and alert the assignee, watchers and managers"><ArrowUp size={14} /> Escalate</button>
        )}
        {!CLOSED_STATES.includes(t.status) ? (
          <button style={{ ...btn('outline'), color: NX.green }} onClick={() => patch({ status: 'resolved', resolution: t.resolution || 'fixed' })}><CheckCircle2 size={14} /> Mark Resolved</button>
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

      {/* Approval gate — the decision blocks triage, so it leads the drawer. */}
      <ApprovalPanel ticket={t} myEmail={myEmail} nameOf={nameOf} onDecided={onDecided} />

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
        <div style={field}>
          <label style={label}>Type</label>
          <select value={t.type || 'request'} onChange={(e) => patch({ type: e.target.value })} style={sel}>
            {TICKET_TYPE_ORDER.map((ty) => <option key={ty} value={ty}>{TICKET_TYPE_META[ty].label}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Status</label>
          <select value={t.status} onChange={(e) => patch({ status: e.target.value })} style={sel}>
            {TICKET_STATUS_ORDER.map((s) => <option key={s} value={s}>{TICKET_STATUS_META[s].label}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Priority</label>
          <select value={t.priority} onChange={(e) => patch({ priority: e.target.value })} style={sel}>
            {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Requester</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 34 }}>
            {t.requesterId ? <><Avatar email={t.requesterId} name={nameOf(t.requesterId)} size={22} /><span style={{ fontSize: 13, color: NX.ink }}>{nameOf(t.requesterId)}</span></> : <span style={{ fontSize: 13, color: NX.faint }}>—</span>}
          </div>
        </div>
        <div style={field}>
          <label style={label}>Assign To</label>
          <PersonSelect value={t.assigneeId || null} people={people} onChange={(v) => patch({ assigneeId: v || '' })} />
        </div>
        <div style={field}>
          <label style={label}>Company</label>
          <select value={t.companyId || ''} onChange={(e) => patch({ companyId: e.target.value, hrDepartmentId: '' })} style={sel}>
            <option value="">Select company</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Department</label>
          <select value={t.hrDepartmentId || ''} onChange={(e) => patch({ hrDepartmentId: e.target.value })} style={sel} disabled={!t.companyId}>
            <option value="">{t.companyId ? 'Select department' : 'Select a company first'}</option>
            {allDepts.filter((d) => d.companyId === t.companyId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>SLA Due Date</label>
          <DateField value={t.slaDueOn || ''} onChange={(v) => patch({ slaDueOn: v || '' })} color={overdue ? NX.red : undefined}
            style={{ ...inputStyle, ...(overdue ? { fontWeight: 700 } : {}) }} />
        </div>
        {CLOSED_STATES.includes(t.status) && (
          <div style={field}>
            <label style={label}>Resolution</label>
            <select value={t.resolution || ''} onChange={(e) => patch({ resolution: e.target.value })} style={sel}>
              <option value="">— pick —</option>
              {TICKET_RESOLUTION.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </div>
        )}
      </div>

      {(TYPE_FIELDS[t.type] || []).length > 0 && (
        <div style={field}>
          <label style={label}>{TICKET_TYPE_META[t.type]?.label} Details</label>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            {TYPE_FIELDS[t.type].map((f) => (
              <div key={f.key} style={{ gridColumn: (f.full || f.type === 'textarea' || f.type === 'checklist') ? '1 / -1' : 'auto' }}>
                <div style={{ ...label, fontSize: 11 }}>{f.label}</div>
                <TypeFieldInput field={f} value={t.typeFields?.[f.key]} onChange={(v) => patch({ typeFields: { ...(t.typeFields || {}), [f.key]: v } })} people={people} projects={projects} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={field}>
        <label style={label}>Tasks</label>
        <TicketTasks taskIds={taskIds} tasks={tasks} onSpawn={spawnTask} onLink={linkTask} onUnlink={unlinkTask} />
      </div>

      <div style={field}>
        <label style={label}>Watchers</label>
        <WatcherEditor watchers={t.watcherIds || []} people={people} nameOf={nameOf} onChange={(list) => patch({ watcherIds: list })} />
      </div>

      <div style={field}>
        <label style={label}>Linked Tickets</label>
        <TicketLinks ticket={t} tickets={tickets} onAdd={(target, type) => addTicketLink(t.id, target, type).catch((e) => alert(e.message || e))}
          onRemove={(target) => removeTicketLink(t.id, target).catch(() => {})} />
      </div>

      {CLOSED_STATES.includes(t.status) && (
        <div style={field}>
          <label style={label}>Satisfaction (CSAT)</label>
          <CsatWidget ticket={t} canRate={!t.requesterId || t.requesterId === myEmail} onRate={(rating) => patch({ csatRating: rating })}
            onComment={(comment) => patch({ csatComment: comment })} />
        </div>
      )}

      {customFields.length > 0 && (
        <div style={field}>
          <label style={label}>Custom Fields</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {customFields.map((f) => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, color: NX.dim }}>{f.name}</span>
                <TicketCustomFieldInput field={f} value={(t.customFieldValues || {})[f.id]}
                  onChange={(v) => patch({ customFieldValues: { ...(t.customFieldValues || {}), [f.id]: v } })} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tags, like Component, are triage-owned — editable here, not on create. */}
      <div style={field}>
        <label style={label}>Tags</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
          {(t.tags || []).map((tag) => (
            <span key={tag} style={{ ...chip(NX.dim, NX.border2), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {tag}
              <button type="button" onClick={() => patch({ tags: (t.tags || []).filter((x) => x !== tag) })}
                title={`Remove ${tag}`} style={{ ...btn('ghost'), padding: 0, lineHeight: 1, color: NX.faint }}>
                <X size={11} />
              </button>
            </span>
          ))}
          <input placeholder={(t.tags || []).length ? 'Add tag…' : 'Add a tag…'}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const v = e.target.value.trim();
              // Case-insensitive dedupe so "VPN" and "vpn" don't both accumulate.
              if (v && !(t.tags || []).some((x) => x.toLowerCase() === v.toLowerCase())) {
                patch({ tags: [...(t.tags || []), v] });
              }
              e.target.value = '';
            }}
            style={{ ...inputStyle, width: 130, padding: '4px 8px', fontSize: 12 }} />
        </div>
      </div>

      {/* Conversation · Attachments · Activity */}
      <div style={{ borderTop: `1px solid ${NX.border}`, marginTop: 16, paddingTop: 12 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          {[['conversation', 'Conversation', MessageSquare], ['attachments', 'Attachments', Paperclip], ['activity', 'Activity', History]].map(([k, lab, Icon]) => (
            <button key={k} onClick={() => setTab(k)} style={{ ...btn('ghost'), gap: 6, fontSize: 13, fontWeight: 600, padding: '6px 10px', borderRadius: 0, color: tab === k ? NX.blue : NX.dim, borderBottom: `2px solid ${tab === k ? NX.blue : 'transparent'}` }}><Icon size={14} />{lab}</button>
          ))}
        </div>
        {tab === 'conversation' && <TicketConversation ticketId={t.id} nameOf={nameOf} />}
        {tab === 'attachments' && <TicketAttachments ticketId={t.id} />}
        {tab === 'activity' && <TicketActivity ticketId={t.id} nameOf={nameOf} />}
      </div>
    </Modal>
  );
}

// ── Approvals ────────────────────────────────────────────────────────────────
// A small status chip, shown wherever a ticket is listed.
function ApprovalChip({ ticket }) {
  const meta = APPROVAL_META[ticket.approvalStatus];
  if (!meta) return null;   // "none" — this ticket never needed approval
  return <span style={chip(meta.color, meta.tint)}>{meta.label}</span>;
}

// The decision panel. Only the named approver (or an admin) sees the buttons;
// everyone else sees who it's waiting on, or what was decided and why.
function ApprovalPanel({ ticket: t, myEmail, nameOf, onDecided }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const status = t.approvalStatus || 'none';
  if (status === 'none') return null;

  const meta = APPROVAL_META[status];
  const mine = (t.approverId || '').toLowerCase() === (myEmail || '').toLowerCase();

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

      {status === 'pending' ? (
        mine ? (
          <>
            <div style={{ fontSize: 12, color: NX.dim, marginBottom: 8 }}>
              Approving releases this ticket to the department for assignment. Rejecting closes it.
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

// ── Watchers — get notified on status changes and new comments ────────────────
function WatcherEditor({ watchers, people, nameOf, onChange }) {
  const list = (watchers || []).map((e) => (e || '').toLowerCase()).filter(Boolean);
  const add = (email) => {
    const e = (email || '').toLowerCase();
    if (!e || list.includes(e)) return;
    onChange([...list, e]);
  };
  const remove = (email) => onChange(list.filter((e) => e !== email));
  return (
    <div>
      {list.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {list.map((e) => (
            <span key={e} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: NX.border2, borderRadius: 999, padding: '3px 8px 3px 3px', fontSize: 12.5, color: NX.ink }}>
              <Avatar email={e} name={nameOf(e)} size={20} />
              {nameOf(e) || e}
              <button onClick={() => remove(e)} title="Remove watcher" style={{ ...btn('ghost'), padding: 1, color: NX.faint }}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <PersonSelect value={null} people={people} onChange={add} placeholder="Add a watcher…" />
    </div>
  );
}

// ── Tasks spawned from / linked to a ticket (one ticket → many tasks) ─────────
function TicketTasks({ taskIds, tasks, onSpawn, onLink, onUnlink }) {
  const [linking, setLinking] = useState(false);
  const linked = taskIds.map((id) => tasks.find((x) => x.id === id)).filter(Boolean);
  const options = tasks.filter((x) => !taskIds.includes(x.id));
  return (
    <div>
      {linked.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {linked.map((task) => (
            <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <ClipboardList size={13} style={{ color: NX.faint, flexShrink: 0 }} />
              <span style={{ color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {task.code ? `${task.code} · ` : ''}{task.title}
              </span>
              {task.status && <span style={{ fontSize: 11, color: NX.faint, flexShrink: 0 }}>{task.status === 'done' ? '✓ done' : task.status}</span>}
              <button onClick={() => onUnlink(task.id)} title="Unlink task" style={{ ...btn('ghost'), padding: 2, marginLeft: 'auto', color: NX.faint }}><X size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={onSpawn} style={{ ...btn('outline'), fontSize: 12 }}><Plus size={13} /> Create Task from Ticket</button>
        {linking ? (
          <select autoFocus defaultValue="" onChange={(e) => { if (e.target.value) onLink(e.target.value); setLinking(false); }}
            onBlur={() => setLinking(false)} style={{ ...inputStyle, appearance: 'auto', width: 'auto', minWidth: 180, cursor: 'pointer' }}>
            <option value="">Select a task…</option>
            {options.map((task) => <option key={task.id} value={task.id}>{task.code ? `${task.code} · ` : ''}{task.title}</option>)}
          </select>
        ) : (
          <button onClick={() => setLinking(true)} style={{ ...btn('ghost'), fontSize: 12, color: NX.dim }}><Link2 size={13} /> Link existing</button>
        )}
      </div>
    </div>
  );
}

// ── Ticket ↔ ticket links (relates / duplicate / blocks / blocked by) ─────────
function TicketLinks({ ticket, tickets, onAdd, onRemove }) {
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState('');
  const [type, setType] = useState('relates');
  const links = ticket.links || [];
  const byId = (id) => tickets.find((x) => x.id === id);
  const options = tickets.filter((x) => x.id !== ticket.id && !links.some((l) => l.ticketId === x.id));

  const submit = () => { if (!target) return; onAdd(target, type); setTarget(''); setType('relates'); setAdding(false); };

  return (
    <div>
      {links.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {links.map((l) => {
            const lt = byId(l.ticketId);
            return (
              <div key={l.ticketId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ ...chip(NX.dim, NX.border2), flexShrink: 0 }}>{linkTypeLabel(l.type)}</span>
                <Link2 size={13} style={{ color: NX.faint, flexShrink: 0 }} />
                <span style={{ color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {lt ? `${lt.code ? lt.code + ' · ' : ''}${lt.subject}` : l.ticketId}
                </span>
                <button onClick={() => onRemove(l.ticketId)} title="Remove link" style={{ ...btn('ghost'), padding: 2, marginLeft: 'auto', color: NX.faint }}><X size={13} /></button>
              </div>
            );
          })}
        </div>
      )}
      {adding ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ ...inputStyle, appearance: 'auto', width: 'auto', cursor: 'pointer' }}>
            {LINK_TYPES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
          </select>
          <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ ...inputStyle, appearance: 'auto', flex: 1, minWidth: 160, cursor: 'pointer' }}>
            <option value="">Select a ticket…</option>
            {options.map((x) => <option key={x.id} value={x.id}>{x.code ? `${x.code} · ` : ''}{x.subject}</option>)}
          </select>
          <button onClick={submit} disabled={!target} style={{ ...btn('primary'), opacity: target ? 1 : 0.5 }}>Link</button>
          <button onClick={() => setAdding(false)} style={btn('ghost')}>Cancel</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12 }}><Link2 size={13} /> Link a ticket</button>
      )}
    </div>
  );
}

// ── CSAT — a 1-5 satisfaction rating shown once a ticket is resolved/closed ────
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

// ── Reports — open-by-status/type/assignee, avg resolution, SLA compliance ─────
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
    // Where tickets come from. HR Department is the routing dimension — it decides
    // which lead triages the ticket — so it's the cut worth showing.
    const deptAcc = new Map();
    for (const t of tickets) { const k = t.hrDepartmentId || ''; deptAcc.set(k, (deptAcc.get(k) || 0) + 1); }
    const byDepartment = [...deptAcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, n], i) => ({ label: k ? (hrDeptName(k) || k) : 'No department', value: n, color: PAL[i % 8] }));
    // recurrence signal — cluster by normalised subject; 2+ = a repeat worth investigating
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
    return { total: tickets.length, open: open.length, byStatus, byType, byPriority, byAssignee, byDepartment, recurring, avgDays, compliance, breaching, atRisk, avgCsat };
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
        <Stat label="Avg Resolution" value={stats.avgDays == null ? '—' : `${stats.avgDays.toFixed(1)}d`} />
        <Stat label="SLA Compliance" value={stats.compliance == null ? '—' : `${stats.compliance}%`} color={stats.compliance != null && stats.compliance < 80 ? NX.red : NX.green} />
        <Stat label="Avg CSAT" value={stats.avgCsat == null ? '—' : `${stats.avgCsat.toFixed(1)}★`} color={stats.avgCsat != null && stats.avgCsat >= 4 ? NX.green : NX.ink} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        <Card title="By status"><Donut segments={stats.byStatus} total={stats.byStatus.reduce((s, d) => s + d.value, 0)} /></Card>
        <Card title="By type"><LightBar data={stats.byType} /></Card>
        <Card title="By priority"><LightBar data={stats.byPriority} /></Card>
        <Card title="By department"><LightBar data={stats.byDepartment} /></Card>
        <Card title="Open by assignee"><LightBar data={stats.byAssignee} /></Card>
        <Card title="Recurring issues (repeat signal)">
          {stats.recurring.length === 0
            ? <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 12, color: NX.faint }}>No repeats yet — every subject is unique.</div>
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
function TicketConversation({ ticketId, nameOf }) {
  const [rows, setRows] = useState(null);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const reload = () => api.getTicketComments(ticketId).then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ticketId]);

  const send = async () => {
    const v = body.trim(); if (!v || busy) return;
    setBusy(true);
    try { await api.addTicketComment(ticketId, { body: v, internal }); setBody(''); await reload(); }
    catch { /* ignore */ } finally { setBusy(false); }
  };
  const del = async (id) => { await api.deleteTicketComment(id).catch(() => {}); reload(); };

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
        {rows === null ? <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>Loading…</div>
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
                  <div style={{ fontSize: 13, color: NX.dim, whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.body}</div>
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
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
          placeholder={internal ? 'Internal note — visible to agents, not the requester…  (⌘/Ctrl+Enter)' : 'Public reply…  (⌘/Ctrl+Enter to send)'} rows={2}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT, flex: 1, ...(internal ? { background: 'rgba(245,158,11,0.06)', borderColor: 'rgba(245,158,11,0.4)' } : {}) }} />
        <button onClick={send} disabled={!body.trim() || busy} style={{ ...btn('primary'), opacity: body.trim() && !busy ? 1 : 0.55, ...(internal ? { background: NX.amber } : {}) }}><Send size={14} /></button>
      </div>
    </div>
  );
}

// ── Attachments ──────────────────────────────────────────────────────────────
const MAX_INLINE = 2 * 1024 * 1024;
function TicketAttachments({ ticketId }) {
  const [rows, setRows] = useState(null);
  const fileRef = useRef(null);
  const reload = () => api.getTicketAttachments(ticketId).then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ticketId]);

  const sendFile = (f) => {
    const size = `${Math.max(1, Math.round(f.size / 1024))} KB`;
    const kind = f.type.startsWith('image/') ? 'image' : 'doc';
    const send = (url) => api.addTicketAttachment(ticketId, { name: f.name, size, kind, url: url || '' }).then(() => reload()).catch(() => {});
    if (f.size <= MAX_INLINE) { const r = new FileReader(); r.onload = () => send(typeof r.result === 'string' ? r.result : ''); r.onerror = () => send(''); r.readAsDataURL(f); }
    else send('');
  };
  const onFile = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) sendFile(f); };
  const onPaste = (e) => { const files = filesFromPaste(e); if (files.length) { e.preventDefault(); files.forEach(sendFile); } };
  const del = async (id) => { await api.deleteTicketAttachment(id).catch(() => {}); reload(); };

  return (
    <div onPaste={onPaste} tabIndex={0} style={{ outline: 'none' }}>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
      <button onClick={() => fileRef.current?.click()} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12, marginBottom: 12 }}><Paperclip size={13} /> Attach file</button>
      <span style={{ fontSize: 11, color: NX.faint, marginLeft: 8 }}>or press Ctrl+V to paste a screenshot</span>
      {rows === null ? <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>Loading…</div>
        : rows.length === 0 ? <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>No attachments yet.</div>
          : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {rows.map((a) => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 10, padding: '6px 10px', fontSize: 12 }}>
                  {a.kind === 'image' && a.url ? <img src={a.url} alt={a.name} style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }} /> : <Paperclip size={13} style={{ color: NX.dim }} />}
                  <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <span style={{ color: NX.faint }}>{a.size}</span>
                  {a.url && <a href={a.url} download={a.name} title="Download" style={{ color: NX.faint, display: 'flex' }}><Download size={13} /></a>}
                  <button onClick={() => del(a.id)} title="Remove" style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><X size={13} /></button>
                </div>
              ))}
            </div>
          )}
    </div>
  );
}

// ── Activity log ─────────────────────────────────────────────────────────────
function TicketActivity({ ticketId, nameOf }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.getTicketActivity(ticketId).then(setRows).catch(() => setRows([])); }, [ticketId]);
  if (rows === null) return <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>Loading…</div>;
  if (rows.length === 0) return <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>No activity yet.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((a) => (
        <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <Avatar email={a.actorId} name={nameOf(a.actorId)} size={22} />
          <span style={{ color: NX.ink, fontWeight: 600 }}>{nameOf(a.actorId) || a.actorId || 'Someone'}</span>
          <span style={{ color: NX.dim }}>{a.detail}</span>
          <span style={{ color: NX.faint, marginLeft: 'auto', fontSize: 11 }}>{fmtDate(a.at)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Kanban board — columns by status, drag a card to change its status ────────
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
            {col.map((t) => (
              <div key={t.id} draggable onDragStart={() => setDragId(t.id)} onDragEnd={() => setDragId(null)} onClick={() => onOpen(t.id)}
                style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, padding: 10, cursor: 'grab', opacity: dragId === t.id ? 0.5 : 1, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <TicketTypeIcon type={t.type} size={14} />
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: NX.faint }}>{t.code}</span>
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
            {col.length === 0 && <div style={{ fontSize: 11.5, color: NX.faint, textAlign: 'center', padding: '10px 0' }}>—</div>}
          </div>
        );
      })}
    </div>
  );
}
