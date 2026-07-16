// Task Module — Tickets. A support/IT request list backed by the real
// TasksContext store (createTicket / updateTicket / deleteTicket). Ticket
// statuses get their own colour map here (STATUS_META in theme.js is for tasks,
// not tickets). Inline-styled to match the rest of the module.
import { useMemo, useState } from 'react';
import { Ticket, Plus, Search, Link2, Trash2, CheckCircle2, Clock } from 'lucide-react';
import { useTasks } from './TasksContext';
import { fmtDate as fmtDateRaw } from './lib';

const fmtDate = (iso) => (iso ? fmtDateRaw(iso) : '—');
import { NX, FONT, chip, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { Avatar, PriorityChip, EmptyState, Modal, PersonSelect, usePeople, DateField } from './components';

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

function TicketStatusChip({ status }) {
  const m = TICKET_STATUS_META[status] || { label: status, color: NX.dim, tint: NX.border2 };
  return <span style={chip(m.color, m.tint)}>{m.label}</span>;
}

const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
const field = { marginBottom: 14 };

export default function TicketsView() {
  const { tickets, nameOf, deptName } = useTasks();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tickets.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (q) {
        const hay = `${t.code} ${t.subject} ${t.description} ${nameOf(t.requesterId) || ''} ${nameOf(t.assigneeId) || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tickets, search, statusFilter, priorityFilter, nameOf]);

  const selStyle = { ...inputStyle, width: 'auto', cursor: 'pointer' };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${NX.border}`, flexWrap: 'wrap', background: NX.surface }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Tickets</div>
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
        <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={() => setCreating(true)}><Plus size={15} />New Ticket</button>
      </div>

      {/* Body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, padding: 16 }}>
        {visible.length === 0 ? (
          <EmptyState icon={Ticket} title="No Tickets" hint={tickets.length ? 'No tickets match your filters.' : 'Raise a ticket to get started.'} />
        ) : (
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, overflow: 'hidden' }}>
            {visible.map((t) => (
              <TicketRow key={t.id} t={t} nameOf={nameOf} deptName={deptName} onOpen={() => setOpenId(t.id)} />
            ))}
          </div>
        )}
      </div>

      {creating && <CreateTicketModal onClose={() => setCreating(false)} />}
      {openId && <TicketDrawer ticketId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function TicketRow({ t, nameOf, deptName, onOpen }) {
  const overdue = t.slaDueOn && t.slaDueOn < today() && !CLOSED_STATES.includes(t.status);
  const dept = t.departmentId ? deptName(t.departmentId) : '';
  return (
    <div onClick={onOpen} style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '11px 16px',
      borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer', background: NX.surface,
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = NX.surface2; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = NX.surface; }}>
      <div style={{ minWidth: 0, flex: '1 1 240px' }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t.subject}
          {t.linkedTaskId && <Link2 size={13} style={{ color: NX.faint, marginLeft: 6, verticalAlign: 'middle' }} />}
        </div>
        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 1 }}>
          {t.code || '—'}{dept ? ` · ${dept}` : ''}
        </div>
      </div>
      <TicketStatusChip status={t.status} />
      <PriorityChip priority={t.priority} />
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
  const { createTicket, departments, myEmail } = useTasks();
  const people = usePeople();
  const [form, setForm] = useState({
    subject: '', description: '', priority: 'medium', status: 'new',
    requesterId: myEmail || null, assigneeId: null, departmentId: '', slaDueOn: '', tags: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.subject.trim() || busy) return;
    setBusy(true);
    try {
      await createTicket({
        subject: form.subject.trim(), description: form.description, priority: form.priority, status: form.status,
        requesterId: form.requesterId || '', assigneeId: form.assigneeId || '', departmentId: form.departmentId || '',
        slaDueOn: form.slaDueOn || '',
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
  const { tickets, tasks, departments, nameOf, updateTicket, deleteTicket } = useTasks();
  const people = usePeople();
  const t = tickets.find((x) => x.id === ticketId);
  if (!t) return null;

  const patch = (p) => updateTicket(t.id, p).catch((e) => alert(`Could not update ticket: ${e.message || e}`));
  const overdue = t.slaDueOn && t.slaDueOn < today() && !CLOSED_STATES.includes(t.status);
  const linkedTask = t.linkedTaskId ? tasks.find((x) => x.id === t.linkedTaskId) : null;

  const remove = () => {
    if (!window.confirm(`Delete ticket ${t.code || t.subject}? This cannot be undone.`)) return;
    deleteTicket(t.id).then(onClose).catch((e) => alert(`Could not delete ticket: ${e.message || e}`));
  };

  const sel = { ...inputStyle, appearance: 'auto', cursor: 'pointer' };
  return (
    <Modal title={t.code || 'Ticket'} onClose={onClose} width={620} footer={
      <>
        <button style={{ ...btn('outline'), color: NX.red, borderColor: NX.border, marginRight: 'auto' }} onClick={remove}><Trash2 size={14} /> Delete</button>
        {!CLOSED_STATES.includes(t.status)
          ? <button style={{ ...btn('outline'), color: NX.green }} onClick={() => patch({ status: 'resolved' })}><CheckCircle2 size={14} /> Mark Resolved</button>
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
        {t.resolvedAt && <span style={{ fontSize: 12, color: NX.green, display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={13} /> Resolved {fmtDate(t.resolvedAt)}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
          <label style={label}>SLA Due Date</label>
          <DateField value={t.slaDueOn || ''} onChange={(v) => patch({ slaDueOn: v || '' })} color={overdue ? NX.red : undefined}
            style={{ ...inputStyle, ...(overdue ? { fontWeight: 700 } : {}) }} />
        </div>
      </div>

      <div style={field}>
        <label style={label}>Linked Task</label>
        <select value={t.linkedTaskId || ''} onChange={(e) => patch({ linkedTaskId: e.target.value })} style={{ ...sel, width: '100%' }}>
          <option value="">Not linked</option>
          {tasks.map((task) => <option key={task.id} value={task.id}>{task.code ? `${task.code} · ` : ''}{task.title}</option>)}
        </select>
        {linkedTask && (
          <div style={{ marginTop: 6, fontSize: 12, color: NX.dim, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Link2 size={13} style={{ color: NX.faint }} /> {linkedTask.code ? `${linkedTask.code} · ` : ''}{linkedTask.title}
          </div>
        )}
      </div>

      {(t.tags || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
          {t.tags.map((tag) => <span key={tag} style={chip(NX.dim, NX.border2)}>{tag}</span>)}
        </div>
      )}
    </Modal>
  );
}
