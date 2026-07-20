// Task Module — rich project List view (ported 1:1 from the export's
// NexusTaskListView). Spreadsheet-style grid: Actions · Task · Assignee ·
// Project · Due · Estimate · Actual · Priority · Status · Team · +Column,
// with inline pill-menu editing, per-row action icons, select-all, collapsible
// groups, and add/remove custom-field columns — all wired to the TasksContext.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2, Circle, MessageSquare, Paperclip, Diamond, ChevronDown, Check, Minus, ListTree, Plus, Trash2, Folder,
  Hash, List, Calendar, CheckSquare, ListOrdered, CircleDot, BarChart3, TrendingUp, Star, CalendarPlus, CalendarClock, Timer, ArrowLeft,
} from 'lucide-react';
import { groupTasks, matchesFilter, sortTasks, topLevel, groupAddDefaults } from '../lib';
import { NX, FONT, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER, STATUS_META, STATUS_ORDER, colorForKey } from '../theme';
import { Avatar, useClickOutside, DateField } from '../components';

const BASE_COLS = [
  { key: 'checkbox', label: '', width: 28 },
  { key: 'actions', label: 'Actions', width: 118 },
  { key: 'task', label: 'Task', width: 280, grow: true },
  { key: 'assignee', label: 'Assignee', width: 140 },
  { key: 'project', label: 'Project', width: 132 },
  { key: 'due', label: 'Due Date', width: 112 },
  { key: 'estimate', label: 'Estimate', width: 104 },
  { key: 'actual', label: 'Actual', width: 86 },
  { key: 'priority', label: 'Priority', width: 96, center: true },
  { key: 'status', label: 'Status', width: 116, center: true },
  { key: 'team', label: 'Team', width: 126, center: true },
];

// Type picker for "+ Column" — matches the export's AddColumnMenu grid exactly
// (grouped: Recommended / Basic / Planning-Status / Date). Nexus's backend only
// persists 4 kinds of value (text, number, date, select) plus checkbox added
// here — so every visual type below maps onto one of those five storage kinds;
// duplicates (e.g. "Dropdown list" appears twice) just map to the same one.
const TYPE_GROUPS = [
  { label: 'Recommended', types: [
    { key: 'text', label: 'Text/number', icon: Hash, storage: 'text' },
    { key: 'select', label: 'Dropdown List', icon: List, storage: 'select' },
    { key: 'date', label: 'Date', icon: Calendar, storage: 'date' },
    { key: 'checkbox', label: 'Checkbox', icon: CheckSquare, storage: 'checkbox' },
  ] },
  { label: 'Basic', types: [
    { key: 'text2', label: 'Text/number', icon: Hash, storage: 'text' },
    { key: 'autonumber', label: 'Auto-number', icon: ListOrdered, storage: 'number' },
  ] },
  { label: 'Planning/Status', types: [
    { key: 'select2', label: 'Dropdown List', icon: List, storage: 'select' },
    { key: 'checkbox2', label: 'Checkbox', icon: CheckSquare, storage: 'checkbox' },
    { key: 'status', label: 'Status', icon: CircleDot, storage: 'select' },
    { key: 'progress', label: 'Progress', icon: BarChart3, storage: 'number' },
    { key: 'trends', label: 'Trends', icon: TrendingUp, storage: 'number' },
    { key: 'rating', label: 'Ratings', icon: Star, storage: 'number' },
  ] },
  { label: 'Date', types: [
    { key: 'date2', label: 'Date', icon: Calendar, storage: 'date' },
    { key: 'created_date', label: 'Created Date', icon: CalendarPlus, storage: 'date' },
    { key: 'modified_date', label: 'Modified Date', icon: CalendarClock, storage: 'date' },
    { key: 'duration', label: 'Duration', icon: Timer, storage: 'number' },
  ] },
];
const FIELD_PALETTE = [NX.blue, NX.purple, NX.green, NX.teal, NX.amber, NX.red, NX.pink, NX.dim];

// Renders its children into document.body, fixed-positioned against
// `anchorRef`'s current on-screen rect. The rich-list table scrolls both
// axes and clips/relocates any position:absolute content that tries to
// escape it (e.g. a dropdown near the table's right edge) — a portal sidesteps
// that entirely by positioning against real viewport coordinates instead of
// an ancestor that might clip or scroll.
function PortalDropdown({ anchorRef, panelRef, align = 'left', width, bare = false, children }) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = { top: r.bottom + 4 };
    if (align === 'right') next.right = Math.max(8, window.innerWidth - r.right);
    else next.left = r.left;
    setPos(next);
  }, [anchorRef, align]);
  if (!pos) return null;
  return createPortal(
    <div ref={panelRef} onClick={(e) => e.stopPropagation()} style={{
      position: 'fixed', top: pos.top, left: pos.left, right: pos.right, width, zIndex: 200,
      ...(bare ? {} : {
        background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,0.16)',
      }),
    }}>
      {children}
    </div>,
    document.body,
  );
}

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
  const panelRef = useRef(null);
  const close = () => setOpen(false);
  useClickOutside([ref, panelRef], close, open);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', justifyContent: center ? 'center' : 'flex-start' }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', padding: '2px 8px', borderRadius: 999,
        fontSize: 12, fontWeight: 600, background: tint, color, border: 'none', cursor: 'pointer',
      }}>
        {icon}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <ChevronDown size={12} className="rl-chevron" style={{ flexShrink: 0 }} />
      </button>
      {open && (
        <PortalDropdown anchorRef={ref} panelRef={panelRef} align={center ? 'left' : 'left'} width={168}>
          <div style={{ maxHeight: 256, overflowY: 'auto', padding: 4 }}>
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
        </PortalDropdown>
      )}
    </div>
  );
}

function AssigneeCell({ value, people, onSelect }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const panelRef = useRef(null);
  useClickOutside([ref, panelRef], () => { setOpen(false); setQ(''); }, open);
  const name = value ? (people.find((p) => p.email === value)?.name || value) : null;
  const pick = (em) => { onSelect(em); setOpen(false); setQ(''); };
  const filtered = q ? people.filter((p) => (p.name + p.email).toLowerCase().includes(q.toLowerCase())) : people;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* The cell value itself is the dropdown trigger — clicking it opens the
          people list directly (no nested picker button inside the popover). */}
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: 0 }}>
        {value ? <Avatar email={value} name={name} size={22} /> : null}
        <span style={{ fontSize: 13, color: value ? NX.dim : NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || 'Unassigned'}</span>
      </button>
      {open && (
        <PortalDropdown anchorRef={ref} panelRef={panelRef} width={240}>
          <div className="nx-scroll" style={{ maxHeight: 280, overflowY: 'auto' }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }} />
            <div onClick={() => pick(null)} style={{ padding: '8px 12px', fontSize: 13, color: NX.dim, cursor: 'pointer' }}>Unassigned</div>
            {filtered.map((p) => (
              <div key={p.email} onClick={() => pick(p.email)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink, background: p.email === value ? NX.hover : 'transparent' }}>
                <Avatar email={p.email} name={p.name} size={22} />
                <span style={{ flex: 1 }}>{p.name}</span>
                {p.email === value && <Check size={14} style={{ color: NX.blue }} />}
              </div>
            ))}
          </div>
        </PortalDropdown>
      )}
    </div>
  );
}

function ActionIcons({ t, store, onOpen }) {
  const fileRef = useRef(null);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 1, color: NX.faint }}>
      <button title="Comments" onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} style={{ ...btn('ghost'), padding: 5 }}><MessageSquare size={13} /></button>
      <button title="Attach File" onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }} style={{ ...btn('ghost'), padding: 5 }}><Paperclip size={13} /></button>
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={() => { /* attach wired in detail drawer */ }} />
      <button title="Toggle Milestone" onClick={(e) => { e.stopPropagation(); store.updateTask(t.id, { isMilestone: !t.isMilestone }); }} style={{ ...btn('ghost'), padding: 5, color: t.isMilestone ? NX.purple : NX.faint }}><Diamond size={13} /></button>
      <button title="Complete" onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} style={{ ...btn('ghost'), padding: 5, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={13} /> : <Circle size={13} />}</button>
    </div>
  );
}

function TaskRow({ t, cols, customFields = [], template, store, people, selected, toggleSel, onOpen }) {
  const cellPad = { minWidth: 0 };
  // Editable cells get a highlight + reveal picker affordance on hover (see
  // .rl-cell in style.css). Padding gives the highlight box some breathing room.
  const editCell = { minWidth: 0, padding: '3px 6px' };
  const pm = PRIORITY_META[t.priority] || { label: t.priority, color: NX.dim, tint: NX.border2 };
  const sm = store.statusMeta[t.status] || { label: t.status, color: NX.dim, tint: NX.border2 };
  const team = t.teamId ? store.teamById(t.teamId) : null;
  const estH = t.estimateHours ? Math.floor(t.estimateHours) : '';
  const estM = t.estimateHours && t.estimateHours % 1 ? Math.round((t.estimateHours % 1) * 60) : '';
  const setEst = (h, m) => store.updateTask(t.id, { estimateHours: (h || m) ? (Number(h || 0) + Number(m || 0) / 60) : null });
  return (
    <div onClick={() => onOpen(t.id)} style={{ borderBottom: `1px solid ${NX.border2}`, background: selected ? 'rgba(37,99,235,0.10)' : 'transparent', cursor: 'pointer' }}
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
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}><AssigneeCell value={t.assigneeId || null} people={people} onSelect={(em) => store.updateTask(t.id, { assigneeId: em || '' })} /></div>
        {/* project */}
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
          <select value={t.projectId || ''} onChange={(e) => store.updateTask(t.id, { projectId: e.target.value || null })} style={{ border: 'none', borderRadius: 6, padding: 0, fontSize: 13, color: t.projectId ? NX.dim : NX.faint, background: 'transparent', fontFamily: FONT, width: '100%', cursor: 'pointer' }}>
            <option value="">No project</option>
            {store.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {/* due */}
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
          <DateField value={t.dueOn || ''} onChange={(v) => store.updateTask(t.id, { dueOn: v })} color={dueColor(t.dueOn, t.completed)} title="Due Date" style={{ fontSize: 12, width: '100%' }} />
        </div>
        {/* estimate */}
        <div className="rl-cell" style={{ ...editCell, display: 'flex', alignItems: 'center', gap: 2 }} onClick={(e) => e.stopPropagation()}>
          <input type="number" className="rl-num" min={0} value={estH} placeholder="hrs" onChange={(e) => setEst(e.target.value, estM)} style={{ width: 30, textAlign: 'right', border: 'none', background: 'transparent', fontSize: 12, color: NX.dim, outline: 'none', fontFamily: FONT }} />
          <span style={{ color: NX.faint, fontSize: 12 }}>:</span>
          <input type="number" className="rl-num" min={0} max={59} step={5} value={estM} placeholder="min" onChange={(e) => setEst(estH, e.target.value)} style={{ width: 30, textAlign: 'left', border: 'none', background: 'transparent', fontSize: 12, color: NX.dim, outline: 'none', fontFamily: FONT }} />
        </div>
        {/* actual */}
        <div className="rl-cell" style={{ ...editCell, display: 'flex', alignItems: 'center', gap: 3 }} onClick={(e) => e.stopPropagation()}>
          <input type="number" className="rl-num" min={0} value={t.actualHours ?? ''} placeholder="0" onChange={(e) => store.updateTask(t.id, { actualHours: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 34, textAlign: 'right', border: 'none', background: 'transparent', fontSize: 12, color: NX.dim, outline: 'none', fontFamily: FONT }} />
          <span style={{ color: NX.faint, fontSize: 12 }}>h</span>
        </div>
        {/* priority */}
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
          <PillSelect center label={pm.label} color={pm.color} tint={pm.tint} currentKey={t.priority}
            options={PRIORITY_ORDER.map((p) => ({ key: p, label: PRIORITY_META[p].label, color: PRIORITY_META[p].color }))}
            onSelect={(k) => store.updateTask(t.id, { priority: k })} />
        </div>
        {/* status */}
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
          <PillSelect center label={sm.label} color={sm.color} tint={sm.tint} currentKey={t.status}
            options={store.statusOrder.map((s) => ({ key: s, label: store.statusMeta[s]?.label || s, color: store.statusMeta[s]?.color }))}
            onSelect={(k) => store.setStatus(t.id, k)} />
        </div>
        {/* team — scoped to this task's own project, since a team lives inside one project */}
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
          <PillSelect center
            label={team ? team.name : '—'} color={team ? team.color : NX.faint} tint={team ? `${team.color}1a` : 'transparent'}
            icon={team ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: team.color, flexShrink: 0 }} /> : null}
            currentKey={t.teamId || ''}
            options={[{ key: '', label: 'No team', color: NX.faint }, ...store.teams.filter((tm) => tm.projectId === t.projectId).map((tm) => ({ key: tm.id, label: tm.name, color: tm.color }))]}
            onSelect={(k) => store.updateTask(t.id, { teamId: k || null })} />
        </div>
        {/* custom fields */}
        {customFields.map((f) => (
          <div key={f.id} className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
            <FieldCell field={f} value={(t.customFieldValues || {})[f.id]}
              onChange={(v) => store.updateTask(t.id, { customFieldValues: { ...(t.customFieldValues || {}), [f.id]: v } })} />
          </div>
        ))}
        <div />
      </div>
    </div>
  );
}

// Drag handle on a header cell's right edge — matches the export's ColResizer.
function ColResizer({ onMouseDown }) {
  const [hover, setHover] = useState(false);
  return (
    <div onMouseDown={onMouseDown} onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      title="Drag to resize" style={{
        position: 'absolute', top: 0, right: -6, bottom: 0, width: 12, zIndex: 1,
        cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
      <span style={{ height: '60%', width: 1, background: hover ? NX.blue : NX.border }} />
    </div>
  );
}

// "+ Column" — creates a new custom field. Two steps, matching the export's
// AddColumnMenu: pick a type from the grouped grid, then name/configure it.
// New fields show up as columns immediately since every configured custom
// field is rendered as one (see RichListView below).
function AddFieldMenu({ createCustomField }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState('pick'); // 'pick' | 'config'
  const [picked, setPicked] = useState(null); // the TYPE_GROUPS entry chosen
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState(['']);
  const ref = useRef(null);
  const panelRef = useRef(null);
  const close = () => setOpen(false);
  useClickOutside([ref, panelRef], close, open);

  const reset = () => { setStep('pick'); setPicked(null); setName(''); setDescription(''); setOptions(['']); };
  const pickType = (t) => { setPicked(t); setName(t.label); setStep('config'); };
  const create = () => {
    if (!picked || !name.trim()) return;
    const opts = picked.storage === 'select' ? options.map((o) => o.trim()).filter(Boolean) : [];
    createCustomField({ name: name.trim(), description: description.trim(), type: picked.storage, options: opts }).catch(() => {});
    reset(); close();
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={(e) => { e.stopPropagation(); if (!open) reset(); setOpen((o) => !o); }} style={{ ...btn('ghost'), padding: '4px 8px', gap: 5, border: `1px dashed ${NX.border}`, color: NX.dim, fontSize: 12, fontWeight: 600 }}>
        <Plus size={13} />Column
      </button>
      {open && (
        <PortalDropdown anchorRef={ref} panelRef={panelRef} align="right" width={288}>
        <div style={{ maxHeight: '70vh', overflowY: 'auto', padding: 12 }}>
          {step === 'pick' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {TYPE_GROUPS.map((g) => (
                <div key={g.label}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: NX.faint, marginBottom: 6 }}>{g.label}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
                    {g.types.map((t) => (
                      <button key={t.key} onClick={() => pickType(t)} style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, border: 'none',
                        background: 'transparent', cursor: 'pointer', fontSize: 13, color: NX.ink, textAlign: 'left', fontFamily: FONT,
                      }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                        <t.icon size={15} style={{ color: NX.dim, flexShrink: 0 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => setStep('pick')} style={{ ...btn('ghost'), padding: 0, fontSize: 12, fontWeight: 600, color: NX.dim, justifyContent: 'flex-start' }}>
                <ArrowLeft size={13} />{picked?.label}
              </button>
              <div>
                <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: NX.dim, marginBottom: 4 }}>Column name</label>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                  style={{ ...inputStyle, fontSize: 13, padding: '6px 8px' }} onKeyDown={(e) => e.key === 'Enter' && create()} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: NX.dim, marginBottom: 4 }}>Column description (optional)</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                  style={{ ...inputStyle, fontSize: 12.5, padding: '6px 8px', resize: 'none' }} />
              </div>
              {picked?.storage === 'select' && (
                <div>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: NX.dim, marginBottom: 4 }}>
                    {picked.key === 'status' ? 'Status' : 'Dropdown list'} values
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {options.map((o, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 12, height: 12, borderRadius: 4, background: FIELD_PALETTE[i % FIELD_PALETTE.length], flexShrink: 0 }} />
                        <input value={o} onChange={(e) => setOptions((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))}
                          placeholder="Enter value" style={{ ...inputStyle, fontSize: 12.5, padding: '5px 7px' }} />
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setOptions((arr) => [...arr, ''])} style={{ ...btn('ghost'), fontSize: 11.5, padding: '4px 6px', marginTop: 4 }}><Plus size={11} />Add Value</button>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 2 }}>
                <button onClick={close} style={{ ...btn('ghost'), fontSize: 12.5, padding: '5px 10px' }}>Cancel</button>
                <button onClick={create} disabled={!name.trim()} style={{ ...btn('primary'), fontSize: 12.5, padding: '5px 12px', opacity: name.trim() ? 1 : 0.5 }}>Add Column</button>
              </div>
            </div>
          )}
        </div>
        </PortalDropdown>
      )}
    </div>
  );
}

// Value editor for one custom-field cell, keyed by type.
function FieldCell({ field, value, onChange }) {
  if (field.type === 'checkbox') {
    return (
      <button onClick={() => onChange(!value)} title={value ? 'Checked' : 'Unchecked'} style={{
        width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${value ? NX.primary : NX.border}`,
        background: value ? NX.primary : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0,
      }}>
        {value && <Check size={12} strokeWidth={3} color="#fff" />}
      </button>
    );
  }
  if (field.type === 'select') {
    const opts = (field.options || []).map((label, i) => ({ key: label, label, color: FIELD_PALETTE[i % FIELD_PALETTE.length] }));
    const cur = opts.find((o) => o.key === value);
    return (
      <PillSelect label={cur ? cur.label : '—'} color={cur ? cur.color : NX.faint} tint={cur ? `${cur.color}1a` : 'transparent'}
        currentKey={value || ''} options={[{ key: '', label: 'None', color: NX.faint }, ...opts]} onSelect={onChange} />
    );
  }
  if (field.type === 'date') {
    return <DateField value={value || ''} onChange={onChange} color={NX.dim} style={{ fontSize: 12, width: '100%' }} />;
  }
  if (field.type === 'number') {
    return <input type="number" className="rl-num" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} placeholder="—"
      style={{ width: '100%', border: 'none', background: 'transparent', fontSize: 12.5, color: NX.dim, outline: 'none', fontFamily: FONT }} />;
  }
  return <input type="text" value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder="—"
    style={{ width: '100%', border: 'none', background: 'transparent', fontSize: 12.5, color: NX.dim, outline: 'none', fontFamily: FONT }} />;
}

// Inline "+ Add task" under each group section — the created task inherits the
// section's group context (status / priority / project / due-date bucket) plus
// the workspace's locked project, matching Asana's add-from-a-section flow.
function AddTaskInline({ store, defaults, lockedProjectId }) {
  const [title, setTitle] = useState('');
  const add = () => {
    const t = title.trim(); if (!t) return;
    store.createTask({
      title: t, type: 'task',
      status: defaults.status || 'not_started', priority: defaults.priority || 'medium',
      projectId: defaults.projectId || lockedProjectId || '', teamId: defaults.teamId || '',
      dueOn: defaults.dueOn || '', assigneeId: defaults.assigneeId || '',
    }).catch(() => {});
    setTitle('');
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 16px 6px 40px', borderBottom: `1px solid ${NX.border2}`, color: NX.faint }}>
      <Plus size={13} style={{ flexShrink: 0 }} />
      <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); if (e.key === 'Escape') setTitle(''); }}
        placeholder="Add task…" style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13, fontFamily: FONT, color: NX.ink, width: '100%' }} />
    </div>
  );
}

export default function RichListView({ visible, group, ctx, store, people, selected, toggleSel, onOpen, onSelectAll, lockedProjectId = '' }) {
  const [collapsed, setCollapsed] = useState(new Set());
  const effGroup = group === 'none' ? 'status' : group;
  const cols = BASE_COLS;
  const customFields = store.customFields || [];
  const [widths, setWidths] = useState(() => Object.fromEntries(BASE_COLS.map((c) => [c.key, c.width])));

  const startResize = useCallback((key, startWidth) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const onMove = (ev) => setWidths((w) => ({ ...w, [key]: Math.max(60, startWidth + (ev.clientX - startX)) }));
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const template = [
    ...cols.map((c) => `${widths[c.key] ?? c.width}px`),
    ...customFields.map((f) => `${widths[f.id] ?? 150}px`),
    '110px',
  ].join(' ');

  const groupCtx = { ...ctx, statusMeta: store.statusMeta, statusOrder: store.statusOrder };
  const groups = useMemo(() => groupTasks(visible, effGroup, groupCtx).filter((g) => g.tasks.length > 0), [visible, effGroup, ctx, store.statusMeta, store.statusOrder]);
  const visibleIds = groups.flatMap((g) => g.tasks.map((t) => t.id));
  const allSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSel = !allSel && visibleIds.some((id) => selected.has(id));
  const toggleGroup = (k) => setCollapsed((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  if (visible.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 16, background: NX.surface, padding: '56px 0', margin: 16, textAlign: 'center' }}>
        <Folder size={26} style={{ color: NX.faint }} />
        <div style={{ fontSize: 14, fontWeight: 600, color: NX.ink }}>No Tasks Yet</div>
        <div style={{ fontSize: 13, color: NX.dim }}>Create your first task with the “New Task” button.</div>
      </div>
    );
  }

  return (
    <div className="nx-list-scroll" style={{ margin: 16, minHeight: 'calc(100% - 32px)', border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface }}>
      <div style={{ minWidth: 'fit-content' }}>
        {/* header */}
        <div style={{ display: 'grid', gridTemplateColumns: template, alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface2, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: NX.faint }}>
          <button onClick={onSelectAll} title={allSel ? 'Deselect all' : 'Select all'} style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${allSel || someSel ? NX.primary : NX.border}`, background: allSel || someSel ? NX.primary : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}>
            {allSel ? <Check size={11} strokeWidth={3} color="#fff" /> : someSel ? <Minus size={11} strokeWidth={3} color="#fff" /> : null}
          </button>
          {cols.slice(1).map((c) => (
            <div key={c.key} style={{ position: 'relative', display: 'flex', justifyContent: c.center ? 'center' : 'flex-start', minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
              <ColResizer onMouseDown={startResize(c.key, widths[c.key] ?? c.width)} />
            </div>
          ))}
          {customFields.map((f) => (
            <div key={f.id} style={{ position: 'relative', display: 'flex', minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <ColResizer onMouseDown={startResize(f.id, widths[f.id] ?? 150)} />
            </div>
          ))}
          <div style={{ justifySelf: 'end' }} onClick={(e) => e.stopPropagation()}>
            <AddFieldMenu createCustomField={store.createCustomField} />
          </div>
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
                <TaskRow key={t.id} t={t} cols={cols} customFields={customFields} template={template} store={store} people={people} selected={selected.has(t.id)} toggleSel={toggleSel} onOpen={onOpen} />
              ))}
              {!isCol && <AddTaskInline store={store} lockedProjectId={lockedProjectId} defaults={groupAddDefaults(effGroup, g.key)} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
