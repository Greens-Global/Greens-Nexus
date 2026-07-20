// Task Module — Tickets. A support/IT request list backed by the real
// TasksContext store (createTicket / updateTicket / deleteTicket). Ticket
// statuses get their own colour map here (STATUS_META in theme.js is for tasks,
// not tickets). Inline-styled to match the rest of the module.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Ticket, Plus, Search, Link2, Trash2, CheckCircle2, Clock, Bug, AlertOctagon, Wrench, HelpCircle, ClipboardList, Paperclip, Send, X, Download, MessageSquare, History, List as ListIcon, Columns3, BarChart3, ShieldAlert, Timer, ArrowUp, Star } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { fmtDate as fmtDateRaw, filesFromPaste } from './lib';

const fmtDate = (iso) => (iso ? fmtDateRaw(iso) : '—');
import { NX, FONT, chip, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { Avatar, PriorityChip, EmptyState, Modal, PersonSelect, usePeople, DateField } from './components';
import { Card, LightBar, Donut } from './views/charts';

// ── Ticket issue types ───────────────────────────────────────────────────────
const TICKET_TYPE_META = {
  bug:             { label: 'Bug',             icon: Bug,           color: NX.red },
  incident:        { label: 'Incident',        icon: AlertOctagon,  color: NX.amber },
  service_request: { label: 'Service Request', icon: Wrench,        color: NX.blue },
  task:            { label: 'Task',            icon: ClipboardList, color: NX.purple },
  question:        { label: 'Question',        icon: HelpCircle,    color: NX.dim },
  request:         { label: 'Request',         icon: Ticket,        color: NX.blue },
};
const TICKET_TYPE_ORDER = ['request', 'bug', 'incident', 'service_request', 'task', 'question'];
const TICKET_RESOLUTION = [
  { key: 'fixed', label: 'Fixed' }, { key: 'done', label: 'Done' },
  { key: 'wont_fix', label: "Won't Fix" }, { key: 'duplicate', label: 'Duplicate' },
  { key: 'cannot_reproduce', label: 'Cannot Reproduce' },
];
const resolutionLabel = (k) => (TICKET_RESOLUTION.find((r) => r.key === k) || {}).label || '';
const LINK_TYPES = [
  { key: 'relates', label: 'Relates to' }, { key: 'duplicate', label: 'Duplicates' },
  { key: 'blocks', label: 'Blocks' }, { key: 'blocked_by', label: 'Blocked by' },
];
const linkTypeLabel = (k) => (LINK_TYPES.find((l) => l.key === k) || {}).label || k;
function TicketTypeIcon({ type, size = 15 }) {
  const m = TICKET_TYPE_META[type] || TICKET_TYPE_META.request;
  const Icon = m.icon;
  return <Icon size={size} style={{ color: m.color, flexShrink: 0 }} title={m.label} />;
}

// ── Ticket status metadata (sentence-case labels; NX colours) ────────────────
const TICKET_STATUS_META = {
  new:         { label: 'New',         color: NX.blue,   tint: 'rgba(37,99,235,0.15)' },
  open:        { label: 'Open',        color: NX.purple, tint: 'rgba(124,58,237,0.15)' },
  in_progress: { label: 'In progress', color: NX.amber,  tint: 'rgba(217,119,6,0.16)' },
  on_hold:     { label: 'On hold',     color: NX.dim,    tint: NX.border2 },
  resolved:    { label: 'Resolved',    color: NX.green,  tint: 'rgba(22,163,74,0.15)' },
  closed:      { label: 'Closed',      color: NX.faint,  tint: NX.border2 },
  reopened:    { label: 'Reopened',    color: NX.red,    tint: 'rgba(220,38,38,0.15)' },
};
const TICKET_STATUS_ORDER = ['new', 'open', 'in_progress', 'on_hold', 'resolved', 'closed', 'reopened'];
const CLOSED_STATES = ['resolved', 'closed'];

const today = () => new Date().toISOString().slice(0, 10);

// ── SLA policy — default resolution targets (hours) per priority. Used to
// auto-set a ticket's SLA due date on creation, and to flag breaches/at-risk. ──
const SLA_TARGET_HOURS = { urgent: 4, high: 24, medium: 72, low: 120 };
const slaDueFromPriority = (priority) => new Date(Date.now() + (SLA_TARGET_HOURS[priority] ?? 72) * 3600 * 1000).toISOString().slice(0, 10);
// 'breached' | 'at_risk' | 'ok' | 'none'
function slaState(t) {
  if (!t.slaDueOn || CLOSED_STATES.includes(t.status)) return 'none';
  const now = today();
  if (t.slaDueOn < now) return 'breached';
  const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (t.slaDueOn <= soon) return 'at_risk';
  return 'ok';
}
const SLA_META = {
  breached: { label: 'SLA breached', color: NX.red, tint: 'rgba(220,38,38,0.14)', Icon: ShieldAlert },
  at_risk:  { label: 'Due soon',     color: NX.amber, tint: 'rgba(217,119,6,0.16)', Icon: Timer },
};
function SlaBadge({ t, compact = false }) {
  const s = slaState(t);
  const m = SLA_META[s];
  if (!m) return null;
  return (
    <span title={`SLA due ${fmtDate(t.slaDueOn)}`} style={{ ...chip(m.color, m.tint), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <m.Icon size={12} />{compact ? '' : m.label}
    </span>
  );
}

function TicketStatusChip({ status }) {
  const m = TICKET_STATUS_META[status] || { label: status, color: NX.dim, tint: NX.border2 };
  return <span style={chip(m.color, m.tint)}>{m.label}</span>;
}

const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
const field = { marginBottom: 14 };

export default function TicketsView() {
  const { tickets, ticketComponents = [], myEmail, nameOf, deptName, updateTicket, deleteTicket } = useTasks();
  const people = usePeople();
  const [scope, setScope] = useState('all');   // all | mine (requester) | assigned
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [componentFilter, setComponentFilter] = useState('all');
  const [slaFilter, setSlaFilter] = useState('all');   // all | breached | at_risk | ok
  const [groupBy, setGroupBy] = useState('none');
  const [view, setView] = useState('list');   // 'list' | 'board' | 'reports'
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const me = (myEmail || '').toLowerCase();
    return tickets.filter((t) => {
      if (scope === 'mine' && (t.requesterId || '').toLowerCase() !== me) return false;
      if (scope === 'assigned' && (t.assigneeId || '').toLowerCase() !== me) return false;
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (typeFilter !== 'all' && (t.type || 'request') !== typeFilter) return false;
      if (componentFilter !== 'all' && (t.component || '') !== componentFilter) return false;
      if (slaFilter !== 'all' && slaState(t) !== slaFilter) return false;
      if (q) {
        const hay = `${t.code} ${t.subject} ${t.description} ${nameOf(t.requesterId) || ''} ${nameOf(t.assigneeId) || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tickets, scope, myEmail, search, statusFilter, priorityFilter, typeFilter, componentFilter, slaFilter, nameOf]);

  // Grouped sections for the list view.
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: '', rows: visible }];
    const buckets = new Map();
    const keyOf = (t) => (groupBy === 'status' ? t.status
      : groupBy === 'priority' ? t.priority
      : groupBy === 'type' ? (t.type || 'request')
      : groupBy === 'assignee' ? (t.assigneeId || '')
      : groupBy === 'component' ? (t.component || '')
      : groupBy === 'team' ? (t.departmentId || '') : 'all');
    const labelOf = (k) => (groupBy === 'status' ? (TICKET_STATUS_META[k]?.label || k)
      : groupBy === 'priority' ? (PRIORITY_META[k]?.label || k)
      : groupBy === 'type' ? (TICKET_TYPE_META[k]?.label || k)
      : groupBy === 'assignee' ? (k ? nameOf(k) || k : 'Unassigned')
      : groupBy === 'component' ? (k || 'No component')
      : groupBy === 'team' ? (k ? deptName(k) || k : 'No team') : '');
    for (const t of visible) { const k = keyOf(t); if (!buckets.has(k)) buckets.set(k, { key: k || '—', label: labelOf(k), rows: [] }); buckets.get(k).rows.push(t); }
    return [...buckets.values()];
  }, [visible, groupBy, nameOf, deptName]);

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
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${NX.border}`, flexWrap: 'wrap', background: NX.surface }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Tickets</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2 }}>
          {[['all', 'All'], ['mine', 'My Requests'], ['assigned', 'Assigned to Me']].map(([k, lab]) => (
            <button key={k} onClick={() => setScope(k)} style={toggleBtn(scope === k)}>{lab}</button>
          ))}
        </div>
        <div style={{ position: 'relative', minWidth: 200, flex: '1 1 200px', maxWidth: 340 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tickets…" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selStyle}>
          <option value="all">All statuses</option>
          {TICKET_STATUS_ORDER.map((s) => <option key={s} value={s}>{TICKET_STATUS_META[s].label}</option>)}
        </select>
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} style={selStyle}>
          <option value="all">All priorities</option>
          {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selStyle}>
          <option value="all">All types</option>
          {TICKET_TYPE_ORDER.map((ty) => <option key={ty} value={ty}>{TICKET_TYPE_META[ty].label}</option>)}
        </select>
        <select value={slaFilter} onChange={(e) => setSlaFilter(e.target.value)} style={selStyle} title="SLA status">
          <option value="all">Any SLA</option>
          <option value="breached">SLA breached</option>
          <option value="at_risk">Due soon</option>
          <option value="ok">On track</option>
        </select>
        {ticketComponents.length > 0 && (
          <select value={componentFilter} onChange={(e) => setComponentFilter(e.target.value)} style={selStyle} title="Component">
            <option value="all">All components</option>
            {ticketComponents.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        )}
        {view === 'list' && (
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={selStyle}>
            {['none', 'status', 'priority', 'type', 'assignee', 'component', 'team'].map((g) => <option key={g} value={g}>Group: {g === 'none' ? 'None' : g[0].toUpperCase() + g.slice(1)}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, marginLeft: 'auto' }}>
          <button onClick={() => setView('list')} style={toggleBtn(view === 'list')}><ListIcon size={15} />List</button>
          <button onClick={() => setView('board')} style={toggleBtn(view === 'board')}><Columns3 size={15} />Board</button>
          <button onClick={() => setView('reports')} style={toggleBtn(view === 'reports')}><BarChart3 size={15} />Reports</button>
        </div>
        <button style={btn('primary')} onClick={() => setCreating(true)}><Plus size={15} />New Ticket</button>
      </div>

      {/* Body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, padding: view === 'board' ? 12 : 16 }}>
        {view === 'reports' ? (
          <TicketReports tickets={visible} nameOf={nameOf} deptName={deptName} />
        ) : view === 'board' ? (
          <TicketBoard tickets={visible} nameOf={nameOf} onOpen={setOpenId} onMove={(id, status) => updateTicket(id, { status }).catch(() => {})} />
        ) : visible.length === 0 ? (
          <EmptyState icon={Ticket} title="No Tickets" hint={tickets.length ? 'No tickets match your filters.' : 'Raise a ticket to get started.'} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: groupBy === 'none' ? 0 : 14 }}>
            {groups.map((g) => (
              <div key={g.key} style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, overflow: 'hidden' }}>
                {groupBy !== 'none' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: NX.surface2, borderBottom: `1px solid ${NX.border2}`, fontSize: 13, fontWeight: 700 }}>
                    {g.label} <span style={{ color: NX.faint, fontWeight: 400 }}>{g.rows.length}</span>
                  </div>
                )}
                {g.rows.map((t) => (
                  <TicketRow key={t.id} t={t} nameOf={nameOf} deptName={deptName} onOpen={() => setOpenId(t.id)}
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

      {creating && <CreateTicketModal onClose={() => setCreating(false)} />}
      {openId && <TicketDrawer ticketId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function TicketRow({ t, nameOf, deptName, onOpen, checked, onToggle }) {
  const overdue = t.slaDueOn && t.slaDueOn < today() && !CLOSED_STATES.includes(t.status);
  const dept = t.departmentId ? deptName(t.departmentId) : '';
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
          {t.code || '—'}{t.component ? ` · ${t.component}` : ''}{dept ? ` · ${dept}` : ''}
        </div>
      </div>
      <TicketStatusChip status={t.status} />
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

// ── Create ───────────────────────────────────────────────────────────────────
export function CreateTicketModal({ onClose }) {
  const { createTicket, createTicketComponent, ticketComponents = [], departments, myEmail } = useTasks();
  const people = usePeople();
  const [form, setForm] = useState({
    subject: '', description: '', type: 'request', priority: 'medium', status: 'new',
    requesterId: myEmail || null, assigneeId: null, departmentId: '', component: '', slaDueOn: '', tags: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.subject.trim() || busy) return;
    setBusy(true);
    try {
      const component = form.component.trim();
      // self-populate the component list: register a newly-typed component name
      if (component && !ticketComponents.some((c) => c.name.toLowerCase() === component.toLowerCase())) {
        await createTicketComponent({ name: component }).catch(() => {});
      }
      await createTicket({
        subject: form.subject.trim(), description: form.description, type: form.type, priority: form.priority, status: form.status,
        requesterId: form.requesterId || '', assigneeId: form.assigneeId || '', departmentId: form.departmentId || '',
        component, slaDueOn: form.slaDueOn || slaDueFromPriority(form.priority),
        tags: form.tags.split(',').map((s) => s.trim()).filter(Boolean),
      });
      onClose();
    } catch (e) { alert(`Could not create ticket: ${e.message || e}`); setBusy(false); }
  };

  const sel = { ...inputStyle, appearance: 'auto', cursor: 'pointer' };
  return (
    <Modal title="New Ticket" onClose={onClose} footer={
      <>
        <button style={btn('outline')} onClick={onClose}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create Ticket'}</button>
      </>
    }>
      <div style={field}>
        <label style={label}>Subject</label>
        <input autoFocus value={form.subject} onChange={(e) => set('subject', e.target.value)} placeholder="What is the issue?" style={inputStyle}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
      </div>
      <div style={field}>
        <label style={label}>Description</label>
        <textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={field}>
          <label style={label}>Type</label>
          <select value={form.type} onChange={(e) => set('type', e.target.value)} style={sel}>
            {TICKET_TYPE_ORDER.map((ty) => <option key={ty} value={ty}>{TICKET_TYPE_META[ty].label}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Requester</label>
          <PersonSelect value={form.requesterId} onChange={(v) => set('requesterId', v)} people={people} placeholder="Select requester" />
        </div>
        <div style={field}>
          <label style={label}>Assign To</label>
          <PersonSelect value={form.assigneeId} onChange={(v) => set('assigneeId', v)} people={people} />
        </div>
        <div style={field}>
          <label style={label}>Priority</label>
          <select value={form.priority} onChange={(e) => set('priority', e.target.value)} style={sel}>
            {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Team</label>
          <select value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)} style={sel}>
            <option value="">No team</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Component</label>
          <input value={form.component} onChange={(e) => set('component', e.target.value)} list="ticket-components" placeholder="e.g. Billing, Network" style={inputStyle} />
          <datalist id="ticket-components">{ticketComponents.map((c) => <option key={c.id} value={c.name} />)}</datalist>
        </div>
        <div style={field}>
          <label style={label}>SLA Due Date</label>
          <DateField value={form.slaDueOn} onChange={(v) => set('slaDueOn', v || '')} placeholder="Pick a date" style={inputStyle} />
        </div>
        <div style={field}>
          <label style={label}>Tags</label>
          <input value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="Comma separated" style={inputStyle} />
        </div>
      </div>
    </Modal>
  );
}

// ── Edit drawer (modal) ───────────────────────────────────────────────────────
function TicketDrawer({ ticketId, onClose }) {
  const { tickets, tasks, departments, customFields = [], ticketComponents = [], createTicketComponent,
    addTicketLink, removeTicketLink, escalateTicket, createTask, myEmail, nameOf, updateTicket, deleteTicket } = useTasks();
  const people = usePeople();
  const [tab, setTab] = useState('conversation');
  const t = tickets.find((x) => x.id === ticketId);
  if (!t) return null;

  const patch = (p) => updateTicket(t.id, p).catch((e) => alert(`Could not update ticket: ${e.message || e}`));
  const escalate = () => escalateTicket(t.id).catch((e) => alert(`Could not escalate: ${e.message || e}`));
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
  const setComponent = async (name) => {
    const c = (name || '').trim();
    if (c && !ticketComponents.some((x) => x.name.toLowerCase() === c.toLowerCase())) await createTicketComponent({ name: c }).catch(() => {});
    patch({ component: c });
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
        {!CLOSED_STATES.includes(t.status)
          ? <button style={{ ...btn('outline'), color: NX.green }} onClick={() => patch({ status: 'resolved', resolution: t.resolution || 'fixed' })}><CheckCircle2 size={14} /> Mark Resolved</button>
          : <button style={btn('outline')} onClick={() => patch({ status: 'reopened' })}>Reopen</button>}
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
        {t.resolvedAt && <span style={{ fontSize: 12, color: NX.green, display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={13} /> Resolved {fmtDate(t.resolvedAt)}{t.resolution ? ` · ${resolutionLabel(t.resolution)}` : ''}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
          <label style={label}>Team</label>
          <select value={t.departmentId || ''} onChange={(e) => patch({ departmentId: e.target.value })} style={sel}>
            <option value="">No team</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Component</label>
          <input defaultValue={t.component || ''} list="ticket-components-drawer" placeholder="e.g. Billing"
            onBlur={(e) => { if ((e.target.value || '').trim() !== (t.component || '')) setComponent(e.target.value); }} style={inputStyle} />
          <datalist id="ticket-components-drawer">{ticketComponents.map((c) => <option key={c.id} value={c.name} />)}</datalist>
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

      {(t.tags || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
          {t.tags.map((tag) => <span key={tag} style={chip(NX.dim, NX.border2)}>{tag}</span>)}
        </div>
      )}

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

// ── Custom field input (reuses the Manage custom-field definitions) ───────────
function TicketCustomFieldInput({ field, value, onChange }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const style = { ...inputStyle, width: 'auto', minWidth: 180, padding: '6px 9px', fontSize: 13 };
  if (field.type === 'select' && Array.isArray(field.options)) {
    return (
      <select value={v} onChange={(e) => { setV(e.target.value); onChange(e.target.value); }} style={{ ...style, appearance: 'auto', cursor: 'pointer' }}>
        <option value="">—</option>
        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} value={v}
      onChange={(e) => setV(e.target.value)} onBlur={() => onChange(v)} style={style} />
  );
}

// ── Reports — open-by-status/type/assignee, avg resolution, SLA compliance ─────
function TicketReports({ tickets, nameOf, deptName }) {
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
    // volume by component/category and by team/facility — the "where do tickets come from" cuts
    const compAcc = new Map();
    for (const t of tickets) { const k = t.component || ''; compAcc.set(k, (compAcc.get(k) || 0) + 1); }
    const byComponent = [...compAcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, n], i) => ({ label: k || 'No component', value: n, color: PAL[i % 8] }));
    const teamAcc = new Map();
    for (const t of tickets) { const k = t.departmentId || ''; teamAcc.set(k, (teamAcc.get(k) || 0) + 1); }
    const byTeam = [...teamAcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, n], i) => ({ label: k ? (deptName(k) || k) : 'No team', value: n, color: PAL[i % 8] }));
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
    return { total: tickets.length, open: open.length, byStatus, byType, byPriority, byAssignee, byComponent, byTeam, recurring, avgDays, compliance, breaching, atRisk, avgCsat };
  }, [tickets, nameOf, deptName]);

  if (tickets.length === 0) return <EmptyState icon={BarChart3} title="No data" hint="No tickets match your filters." />;

  const Stat = ({ label: lab, value, color }) => (
    <div style={{ flex: '1 1 130px', borderRadius: 14, border: `1px solid ${NX.border}`, background: NX.surface, padding: '14px 16px' }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: color || NX.ink }}>{value}</div>
      <div style={{ fontSize: 12, color: NX.dim, marginTop: 2 }}>{lab}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="Total tickets" value={stats.total} />
        <Stat label="Open" value={stats.open} color={NX.blue} />
        <Stat label="SLA breached" value={stats.breaching} color={stats.breaching ? NX.red : NX.ink} />
        <Stat label="Due soon" value={stats.atRisk} color={stats.atRisk ? NX.amber : NX.ink} />
        <Stat label="Avg resolution" value={stats.avgDays == null ? '—' : `${stats.avgDays.toFixed(1)}d`} />
        <Stat label="SLA compliance" value={stats.compliance == null ? '—' : `${stats.compliance}%`} color={stats.compliance != null && stats.compliance < 80 ? NX.red : NX.green} />
        <Stat label="Avg CSAT" value={stats.avgCsat == null ? '—' : `${stats.avgCsat.toFixed(1)}★`} color={stats.avgCsat != null && stats.avgCsat >= 4 ? NX.green : NX.ink} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        <Card title="By status"><Donut segments={stats.byStatus} total={stats.byStatus.reduce((s, d) => s + d.value, 0)} /></Card>
        <Card title="By type"><LightBar data={stats.byType} /></Card>
        <Card title="By priority"><LightBar data={stats.byPriority} /></Card>
        <Card title="By component / category"><LightBar data={stats.byComponent} /></Card>
        <Card title="By team / facility"><LightBar data={stats.byTeam} /></Card>
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
  const [busy, setBusy] = useState(false);
  const reload = () => api.getTicketComments(ticketId).then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ticketId]);

  const send = async () => {
    const v = body.trim(); if (!v || busy) return;
    setBusy(true);
    try { await api.addTicketComment(ticketId, { body: v }); setBody(''); await reload(); }
    catch { /* ignore */ } finally { setBusy(false); }
  };
  const del = async (id) => { await api.deleteTicketComment(id).catch(() => {}); reload(); };

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
        {rows === null ? <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>Loading…</div>
          : rows.length === 0 ? <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>No comments yet.</div>
            : rows.map((c) => (
              <div key={c.id} style={{ display: 'flex', gap: 8 }}>
                <Avatar email={c.authorId} name={nameOf(c.authorId)} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{nameOf(c.authorId) || c.authorId}</span>
                    <span style={{ fontSize: 11, color: NX.faint }}>{fmtDate(c.createdAt)}</span>
                    <button onClick={() => del(c.id)} title="Delete" style={{ ...btn('ghost'), padding: 2, marginLeft: 'auto', color: NX.faint }}><X size={13} /></button>
                  </div>
                  <div style={{ fontSize: 13, color: NX.dim, whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.body}</div>
                </div>
              </div>
            ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
          placeholder="Add a comment…  (⌘/Ctrl+Enter to send)" rows={2} style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT, flex: 1 }} />
        <button onClick={send} disabled={!body.trim() || busy} style={{ ...btn('primary'), opacity: body.trim() && !busy ? 1 : 0.55 }}><Send size={14} /></button>
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
