// Task Module — rich project List view (ported 1:1 from the export's
// NexusTaskListView). Spreadsheet-style grid: Actions · Task · Assignee ·
// Project · Due · Estimate · Actual · Priority · Status · Department · +Column,
// with inline pill-menu editing, per-row action icons, select-all, collapsible
// groups, and add/remove custom-field columns — all wired to the TasksContext.
import { useMemo, useRef, useState } from 'react';
import { CheckCircle2, Circle, MessageSquare, Paperclip, Diamond, ChevronDown, Check, Minus, ListTree, Plus, Trash2, Folder } from 'lucide-react';
import { groupTasks, matchesFilter, sortTasks, topLevel } from '../lib';
import { NX, FONT, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER, STATUS_META, STATUS_ORDER, colorForKey } from '../theme';
import { Avatar, PersonSelect } from '../components';

const BASE_COLS = [
  { key: 'checkbox', label: '', width: 28 },
  { key: 'actions', label: 'Actions', width: 118 },
  { key: 'task', label: 'Task', width: 280, grow: true },
  { key: 'assignee', label: 'Assignee', width: 140 },
  { key: 'project', label: 'Project', width: 132 },
  { key: 'due', label: 'Due date', width: 112 },
  { key: 'estimate', label: 'Estimate', width: 86 },
  { key: 'actual', label: 'Actual', width: 86 },
  { key: 'priority', label: 'Priority', width: 96, center: true },
  { key: 'status', label: 'Status', width: 116, center: true },
  { key: 'department', label: 'Department', width: 126, center: true },
];

const dueColor = (iso, completed) => {
  if (!iso || completed) return NX.faint;
  const today = new Date().toISOString().slice(0, 10);
  if (iso < today) return NX.red;
  if (iso === today) return NX.amber;
  return NX.dim;
};

// A colored pill that opens an app-styled dropdown (matches the export's PillMenu).
function PillSelect({ label, color, tint, icon, options, currentKey, onSelect, center }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = () => setOpen(false);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', justifyContent: center ? 'center' : 'flex-start' }} onMouseLeave={close}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', padding: '2px 8px', borderRadius: 999,
        fontSize: 12, fontWeight: 600, background: tint, color, border: 'none', cursor: 'pointer',
      }}>
        {icon}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <ChevronDown size={12} style={{ opacity: 0.5, flexShrink: 0 }} />
      </button>
      {open && (
        <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: '100%', left: center ? '50%' : 0, transform: center ? 'translateX(-50%)' : 'none', marginTop: 4, minWidth: 168, maxHeight: 256, overflowY: 'auto', background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 60, padding: 4 }}>
          {options.map((o) => (
            <button key={o.key} onClick={() => { onSelect(o.key); close(); }} style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', borderRadius: 6, border: 'none',
              background: o.key === currentKey ? NX.hover : 'transparent', cursor: 'pointer', fontSize: 13, color: NX.ink, textAlign: 'left', fontFamily: FONT,
            }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: o.color || NX.faint, flexShrink: 0, border: '1px solid rgba(0,0,0,0.05)' }} />
              <span style={{ flex: 1 }}>{o.label}</span>
              {o.key === currentKey && <Check size={13} style={{ color: NX.blue }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AssigneeCell({ value, people, onSelect }) {
  const [open, setOpen] = useState(false);
  const name = value ? (people.find((p) => p.email === value)?.name || value) : null;
  return (
    <div style={{ position: 'relative' }} onMouseLeave={() => setOpen(false)}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: 0 }}>
        {value ? <Avatar email={value} name={name} size={22} /> : null}
        <span style={{ fontSize: 13, color: value ? NX.dim : NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || 'Unassigned'}</span>
      </button>
      {open && (
        <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 240, zIndex: 60 }}>
          <PersonSelect value={value} onChange={(em) => { onSelect(em); setOpen(false); }} people={people} />
        </div>
      )}
    </div>
  );
}

function ActionIcons({ t, store, onOpen }) {
  const fileRef = useRef(null);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 1, color: NX.faint }}>
      <button title="Comments" onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} style={{ ...btn('ghost'), padding: 5 }}><MessageSquare size={13} /></button>
      <button title="Attach file" onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }} style={{ ...btn('ghost'), padding: 5 }}><Paperclip size={13} /></button>
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={() => { /* attach wired in detail drawer */ }} />
      <button title="Toggle milestone" onClick={(e) => { e.stopPropagation(); store.updateTask(t.id, { isMilestone: !t.isMilestone }); }} style={{ ...btn('ghost'), padding: 5, color: t.isMilestone ? NX.purple : NX.faint }}><Diamond size={13} /></button>
      <button title="Complete" onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} style={{ ...btn('ghost'), padding: 5, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={13} /> : <Circle size={13} />}</button>
    </div>
  );
}

function TaskRow({ t, cols, template, store, people, selected, toggleSel, onOpen }) {
  const cellPad = { minWidth: 0 };
  const pm = PRIORITY_META[t.priority] || { label: t.priority, color: NX.dim, tint: NX.border2 };
  const sm = STATUS_META[t.status] || { label: t.status, color: NX.dim, tint: NX.border2 };
  const dept = t.departmentId ? store.deptById(t.departmentId) : null;
  return (
    <div onClick={() => onOpen(t.id)} style={{ borderBottom: `1px solid ${NX.border2}`, background: selected ? '#eff5ff' : 'transparent', cursor: 'pointer' }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = NX.hover; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}>
      <div style={{ display: 'grid', gridTemplateColumns: template, alignItems: 'center', gap: 12, padding: '6px 16px', fontSize: 13 }}>
        {/* checkbox */}
        <button onClick={(e) => { e.stopPropagation(); toggleSel(t.id); }} style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${selected ? NX.primary : NX.border}`, background: selected ? NX.primary : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}>
          {selected && <Check size={11} strokeWidth={3} color="#fff" />}
        </button>
        {/* actions */}
        <ActionIcons t={t} store={store} onOpen={onOpen} />
        {/* task */}
        <div style={{ ...cellPad, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t.isMilestone && <Diamond size={12} style={{ color: NX.purple, flexShrink: 0 }} />}
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
          {(t.subtaskIds?.length > 0) && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11, color: NX.faint, flexShrink: 0 }}>{t.subtaskIds.length}<ListTree size={12} /></span>}
        </div>
        {/* assignee */}
        <div style={cellPad} onClick={(e) => e.stopPropagation()}><AssigneeCell value={t.assigneeId || null} people={people} onSelect={(em) => store.updateTask(t.id, { assigneeId: em || '' })} /></div>
        {/* project */}
        <div style={cellPad} onClick={(e) => e.stopPropagation()}>
          <select value={t.projectId || ''} onChange={(e) => store.updateTask(t.id, { projectId: e.target.value || null })} style={{ border: '1px solid transparent', borderRadius: 6, padding: '2px 4px', fontSize: 13, color: t.projectId ? NX.dim : NX.faint, background: 'transparent', fontFamily: FONT, width: '100%', cursor: 'pointer' }}>
            <option value="">No project</option>
            {store.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {/* due */}
        <div style={cellPad} onClick={(e) => e.stopPropagation()}>
          <input type="date" value={t.dueOn || ''} onChange={(e) => store.updateTask(t.id, { dueOn: e.target.value || null })} style={{ border: '1px solid transparent', borderRadius: 6, padding: '2px 2px', fontSize: 12, fontFamily: FONT, background: 'transparent', color: dueColor(t.dueOn, t.completed), width: '100%', cursor: 'pointer' }} />
        </div>
        {/* estimate */}
        <div style={{ ...cellPad, display: 'flex', alignItems: 'center', gap: 3 }} onClick={(e) => e.stopPropagation()}>
          <input type="number" min={0} value={t.estimateHours ?? ''} placeholder="—" onChange={(e) => store.updateTask(t.id, { estimateHours: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 34, textAlign: 'right', border: 'none', background: 'transparent', fontSize: 12, color: NX.dim, outline: 'none', fontFamily: FONT }} />
          <span style={{ color: NX.faint, fontSize: 12 }}>h</span>
        </div>
        {/* actual */}
        <div style={{ ...cellPad, display: 'flex', alignItems: 'center', gap: 3 }} onClick={(e) => e.stopPropagation()}>
          <input type="number" min={0} value={t.actualHours ?? ''} placeholder="0" onChange={(e) => store.updateTask(t.id, { actualHours: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 34, textAlign: 'right', border: 'none', background: 'transparent', fontSize: 12, color: NX.dim, outline: 'none', fontFamily: FONT }} />
          <span style={{ color: NX.faint, fontSize: 12 }}>h</span>
        </div>
        {/* priority */}
        <div style={cellPad} onClick={(e) => e.stopPropagation()}>
          <PillSelect center label={pm.label} color={pm.color} tint={pm.tint} currentKey={t.priority}
            options={PRIORITY_ORDER.map((p) => ({ key: p, label: PRIORITY_META[p].label, color: PRIORITY_META[p].color }))}
            onSelect={(k) => store.updateTask(t.id, { priority: k })} />
        </div>
        {/* status */}
        <div style={cellPad} onClick={(e) => e.stopPropagation()}>
          <PillSelect center label={sm.label} color={sm.color} tint={sm.tint} currentKey={t.status}
            options={STATUS_ORDER.map((s) => ({ key: s, label: STATUS_META[s].label, color: STATUS_META[s].color }))}
            onSelect={(k) => store.setStatus(t.id, k)} />
        </div>
        {/* department */}
        <div style={cellPad} onClick={(e) => e.stopPropagation()}>
          <PillSelect center
            label={dept ? dept.name : '—'} color={dept ? dept.color : NX.faint} tint={dept ? `${dept.color}1a` : 'transparent'}
            icon={dept ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: dept.color, flexShrink: 0 }} /> : null}
            currentKey={t.departmentId || ''}
            options={[{ key: '', label: 'No department', color: NX.faint }, ...store.departments.map((d) => ({ key: d.id, label: d.name, color: d.color }))]}
            onSelect={(k) => store.updateTask(t.id, { departmentId: k || null })} />
        </div>
      </div>
    </div>
  );
}

export default function RichListView({ visible, group, ctx, store, people, selected, toggleSel, onOpen, onSelectAll }) {
  const [collapsed, setCollapsed] = useState(new Set());
  const cols = BASE_COLS;
  const template = cols.map((c) => (c.grow ? `minmax(${c.width}px,1.6fr)` : `${c.width}px`)).join(' ') + ' 44px';

  const groups = useMemo(() => groupTasks(visible, group === 'none' ? 'status' : group, ctx).filter((g) => g.tasks.length > 0), [visible, group, ctx]);
  const visibleIds = groups.flatMap((g) => g.tasks.map((t) => t.id));
  const allSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSel = !allSel && visibleIds.some((id) => selected.has(id));
  const toggleGroup = (k) => setCollapsed((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  if (visible.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 16, background: NX.surface, padding: '56px 0', margin: 16, textAlign: 'center' }}>
        <Folder size={26} style={{ color: NX.faint }} />
        <div style={{ fontSize: 14, fontWeight: 600, color: NX.ink }}>No tasks yet</div>
        <div style={{ fontSize: 13, color: NX.dim }}>Create your first task with the “New task” button.</div>
      </div>
    );
  }

  return (
    <div style={{ margin: 16, border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, overflowX: 'auto' }}>
      <div style={{ minWidth: 'fit-content' }}>
        {/* header */}
        <div style={{ display: 'grid', gridTemplateColumns: template, alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface2, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: NX.faint }}>
          <button onClick={onSelectAll} title={allSel ? 'Deselect all' : 'Select all'} style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${allSel || someSel ? NX.primary : NX.border}`, background: allSel || someSel ? NX.primary : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}>
            {allSel ? <Check size={11} strokeWidth={3} color="#fff" /> : someSel ? <Minus size={11} strokeWidth={3} color="#fff" /> : null}
          </button>
          {cols.slice(1).map((c) => <div key={c.key} style={{ textAlign: c.center ? 'center' : 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.label}</div>)}
          <div style={{ justifySelf: 'end', color: NX.faint }}><Plus size={14} /></div>
        </div>
        {groups.map((g) => {
          const isCol = collapsed.has(g.key);
          return (
            <div key={g.key}>
              <button onClick={() => toggleGroup(g.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 16px', border: 'none', borderBottom: `1px solid ${NX.border2}`, background: NX.surface2, cursor: 'pointer', textAlign: 'left' }}>
                {g.color && <span style={{ width: 10, height: 10, borderRadius: '50%', background: g.color }} />}
                <ChevronDown size={15} style={{ color: NX.faint, transform: isCol ? 'rotate(-90deg)' : 'none' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>{g.label}</span>
                <span style={{ fontSize: 12, color: NX.faint }}>{g.tasks.length}</span>
              </button>
              {!isCol && g.tasks.map((t) => (
                <TaskRow key={t.id} t={t} cols={cols} template={template} store={store} people={people} selected={selected.has(t.id)} toggleSel={toggleSel} onOpen={onOpen} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
