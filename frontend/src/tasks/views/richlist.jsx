// Task Module - rich project List view (ported 1:1 from the export's
// NexusTaskListView). Spreadsheet-style grid: Actions · Task · Assignee ·
// Project · Due · Estimate · Actual · Priority · Status · Team · +Column,
// with inline pill-menu editing, per-row action icons, select-all, collapsible
// groups, and add/remove custom-field columns - all wired to the TasksContext.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2, Circle, MessageSquare, Paperclip, Diamond, ChevronDown, Check, Minus, ListTree, Plus, Trash2, Folder,
  // (MessageSquare/Paperclip now render as count badges next to the title,
  // like the subtask badge below - not as ActionIcons buttons.)
  Hash, List, Calendar, CheckSquare, ListOrdered, CircleDot, BarChart3, TrendingUp, Star, CalendarPlus, CalendarClock, Timer, ArrowLeft, EyeOff,
  Lock, Users, ListChecks,
} from 'lucide-react';
import { groupTasks, matchesFilter, sortTasks, topLevel, groupAddDefaults, fieldsForProject, teamInProject } from '../lib';
import { NX, FONT, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER, STATUS_META, STATUS_ORDER, colorForKey } from '../theme';
import { Avatar, useClickOutside, DateField } from '../components';
import { emailToName, rootZoom } from '../../lib/utils';

const BASE_COLS = [
  { key: 'checkbox', label: '', width: 28 },
  { key: 'actions', label: 'Actions', width: 72 },
  { key: 'task', label: 'Task', width: 280, grow: true },
  { key: 'assignee', label: 'Person', width: 120 },
  { key: 'project', label: 'Project', width: 132 },
  { key: 'due', label: 'Due Date', width: 112 },
  { key: 'estimate', label: 'Estimate', width: 104 },
  { key: 'actual', label: 'Actual', width: 86 },
  { key: 'priority', label: 'Priority', width: 96, center: true },
  { key: 'status', label: 'Status', width: 116, center: true },
  { key: 'team', label: 'Team', width: 126, center: true },
  { key: 'timeline', label: 'Timeline', width: 148, center: true },
];
// Columns that can be hidden via the eye menu (task itself always shows).
const HIDEABLE = ['actions', 'assignee', 'project', 'due', 'estimate', 'actual', 'priority', 'status', 'team', 'timeline'];
const HIDDEN_KEY = 'nexus.richlist.hiddenCols';

// Type picker for "+ Column" - matches the export's AddColumnMenu grid exactly
// (grouped: Recommended / Basic / Planning-Status / Date). Nexus's backend only
// persists 4 kinds of value (text, number, date, select) plus checkbox added
// here - so every visual type below maps onto one of those five storage kinds;
// duplicates (e.g. "Dropdown list" appears twice) just map to the same one.
const TYPE_GROUPS = [
  { label: 'Recommended', types: [
    { key: 'text', label: 'Text/Number', icon: Hash, storage: 'text' },
    { key: 'select', label: 'Dropdown List', icon: List, storage: 'select' },
    { key: 'multiselect', label: 'Multi-Select', icon: ListChecks, storage: 'multiselect' },
    { key: 'people', label: 'People', icon: Users, storage: 'people' },
    { key: 'date', label: 'Date', icon: Calendar, storage: 'date' },
    { key: 'checkbox', label: 'Checkbox', icon: CheckSquare, storage: 'checkbox' },
  ] },
  { label: 'Basic', types: [
    { key: 'text2', label: 'Text/Number', icon: Hash, storage: 'text' },
    { key: 'autonumber', label: 'Auto-Number', icon: ListOrdered, storage: 'number' },
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
// Rows mounted per batch. Comfortably more than fills a tall screen, so the
// sentinel below the last row is normally already past the viewport.
const ROW_BATCH = 60;

// Renders its children into document.body, fixed-positioned against
// `anchorRef`'s current on-screen rect. The rich-list table scrolls both
// axes and clips/relocates any position:absolute content that tries to
// escape it (e.g. a dropdown near the table's right edge) - a portal sidesteps
// that entirely by positioning against real viewport coordinates instead of
// an ancestor that might clip or scroll.
const PANEL_MARGIN = 8;   // breathing room between a panel and the window edge

// See rootZoom in lib/utils: <html> carries a CSS zoom, so a rect measured in
// the outer space must be divided by it before being written as a CSS length.

function PortalDropdown({ anchorRef, panelRef, align = 'left', width, bare = false, children }) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    // Clamp to the viewport on BOTH axes. Positioning purely from the anchor
    // put a panel half off-screen whenever its column sat near the right edge -
    // and since this grid scrolls horizontally, any column can end up there.
    // A long option list near the bottom ran under the window the same way.
    const place = () => {
      const z = rootZoom();
      const r = el.getBoundingClientRect();
      const panel = panelRef.current;
      // The panel's own rect is in the outer space too, so every term below
      // stays in one space; only the final write is converted back.
      const pr = panel?.getBoundingClientRect();
      const w = pr?.width || (width || 168) * z;
      const h = pr?.height || 0;
      const gap = 4 * z;
      let left = align === 'right' ? r.right - w : r.left;
      left = Math.max(PANEL_MARGIN, Math.min(left, window.innerWidth - w - PANEL_MARGIN));
      let top = r.bottom + gap;
      if (h && top + h > window.innerHeight - PANEL_MARGIN) {
        // Flip above the anchor when there's room, else sit against the bottom.
        const above = r.top - gap - h;
        top = above >= PANEL_MARGIN ? above : Math.max(PANEL_MARGIN, window.innerHeight - h - PANEL_MARGIN);
      }
      // Back into the inner space, which is what a CSS length on this element means.
      // maxWidth is a CSS length on this element, so it belongs in the inner
      // space as well - `calc(100vw - …)` would be off by the same factor.
      setPos({ top: top / z, left: left / z, maxWidth: (window.innerWidth - PANEL_MARGIN * 2) / z });
    };
    place();
    // The first pass runs before the portal exists, so the panel has no real
    // size yet - measure again once it's mounted and correct the placement.
    const id = requestAnimationFrame(place);
    // A fixed panel is frozen in viewport space while its anchor moves with the
    // grid, so any scroll after opening leaves the menu behind - visibly offset
    // from the cell it belongs to. Capture-phase catches the grid's own scroll,
    // not just the window's.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchorRef, panelRef, align, width]);
  if (!pos) return null;
  return createPortal(
    <div ref={panelRef} onClick={(e) => e.stopPropagation()} style={{
      position: 'fixed', top: pos.top, left: pos.left, width, zIndex: 200, maxWidth: pos.maxWidth,
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
// `solid` renders the monday.com-style full-cell colored block (white text on the
// status color) instead of a translucent pill.
function PillSelect({ label, color, tint, icon, options, currentKey, onSelect, center, solid }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const panelRef = useRef(null);
  const close = () => setOpen(false);
  useClickOutside([ref, panelRef], close, open);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', justifyContent: center ? 'center' : 'flex-start', ...(solid ? { width: '100%', height: '100%' } : {}) }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} style={solid ? {
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, width: '100%', height: '100%', minHeight: 32,
        padding: '0 6px', borderRadius: 0, fontSize: 12.5, fontWeight: 500, background: color, color: '#fff', border: 'none',
        cursor: 'pointer', transition: 'filter 0.12s', whiteSpace: 'nowrap',
      } : {
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

function AssigneeCell({ value, people, onSelect, compact }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const panelRef = useRef(null);
  useClickOutside([ref, panelRef], () => { setOpen(false); setQ(''); }, open);
  const name = value ? (people.find((p) => p.email === value)?.name || emailToName(value)) : null;
  const pick = (em) => { onSelect(em); setOpen(false); setQ(''); };
  const filtered = q ? people.filter((p) => (p.name + p.email).toLowerCase().includes(q.toLowerCase())) : people;
  return (
    <div ref={ref} style={{ position: 'relative', ...(compact ? { width: '100%' } : {}) }}>
      {/* The cell value itself is the dropdown trigger - clicking it opens the
          people list directly (no nested picker button inside the popover).
          compact = monday-style Person cell: just the avatar, centered. */}
      <button title={name || 'Unassigned'} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} style={{ display: 'flex', alignItems: 'center', justifyContent: compact ? 'center' : 'flex-start', gap: 6, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: 0 }}>
        {value ? <Avatar email={value} name={name} size={compact ? 26 : 22} /> : compact ? (
          <span style={{ width: 26, height: 26, borderRadius: '50%', border: `1.5px dashed ${NX.border}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: NX.faint, fontSize: 13 }}>+</span>
        ) : null}
        {!compact && <span style={{ fontSize: 13, color: value ? NX.dim : NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || 'Unassigned'}</span>}
      </button>
      {open && (
        <PortalDropdown anchorRef={ref} panelRef={panelRef} width={240}>
          <div className="nx-scroll" style={{ maxHeight: 280, overflowY: 'auto' }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }} />
            <div onClick={() => pick(null)} style={{ padding: '8px 12px', fontSize: 13, color: NX.dim, cursor: 'pointer' }}>Unassigned</div>
            {filtered.map((p) => (
              <div key={p.email} onClick={() => pick(p.email)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink, background: p.email === value ? NX.hover : 'transparent' }}>
                <Avatar email={p.email} name={p.name} size={22} card={false} />
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

function ActionIcons({ t, store }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 1, color: NX.faint }}>
      <button title="Complete" onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} style={{ ...btn('ghost'), padding: 5, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={13} /> : <Circle size={13} />}</button>
    </div>
  );
}

function TaskRow({ t, cols, customFields = [], template, store, people, selected, toggleSel, onOpen, hidden = new Set(), groupColor, onDragStartRow, onDragEndRow }) {
  // Deferred until the project picker is first opened - see the select below.
  const [projOpen, setProjOpen] = useState(false);
  // monday-style spreadsheet cells: every cell carries a right border, rows are
  // a compact ~36px, and status/priority blocks fill their cell edge-to-edge.
  const cellPad = { minWidth: 0, display: 'flex', alignItems: 'center', minHeight: 36, padding: '2px 8px', borderRight: `1px solid ${NX.border2}`, boxSizing: 'border-box' };
  const editCell = { ...cellPad };
  const flushCell = { ...cellPad, padding: 0, alignItems: 'stretch' };
  const pm = PRIORITY_META[t.priority] || { label: t.priority, color: NX.dim, tint: NX.border2 };
  const sm = store.statusMeta[t.status] || { label: t.status, color: NX.dim, tint: NX.border2 };
  const team = t.teamId ? store.teamById(t.teamId) : null;
  const estH = t.estimateHours ? Math.floor(t.estimateHours) : '';
  const estM = t.estimateHours && t.estimateHours % 1 ? Math.round((t.estimateHours % 1) * 60) : '';
  const setEst = (h, m) => store.updateTask(t.id, { estimateHours: (h || m) ? (Number(h || 0) + Number(m || 0) / 60) : null });
  const show = (k) => !hidden.has(k);
  const followers = (t.followerIds || []).filter((f) => f && f !== t.assigneeId);
  const subIds = t.subtaskIds || [];
  const subs = subIds.map((id) => (store.taskById ? store.taskById[id] : null) || store.tasks?.find((x) => x.id === id)).filter(Boolean);
  const subsDone = subs.filter((s) => s.completed).length;
  const commentCount = (t.commentIds || []).length;
  const attachmentCount = (t.attachmentIds || []).length;
  return (
    <div onClick={() => onOpen(t.id)} data-task-row draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStartRow?.(t.id); }}
      onDragEnd={() => onDragEndRow?.()}
      style={{ borderBottom: `1px solid ${NX.border2}`, background: selected ? 'rgba(37,99,235,0.10)' : 'transparent', cursor: 'pointer' }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = NX.hover; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'stretch', fontSize: 13 }}>
        {/* checkbox */}
        <div style={{ ...cellPad, justifyContent: 'center', padding: '2px 4px' }}>
          <button onClick={(e) => { e.stopPropagation(); toggleSel(t.id); }} style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${selected ? NX.primary : NX.border}`, background: selected ? NX.primary : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
            {selected && <Check size={11} strokeWidth={3} color="#fff" />}
          </button>
        </div>
        {/* actions */}
        {show('actions') && <div style={{ ...cellPad, justifyContent: 'center' }}><ActionIcons t={t} store={store} /></div>}
        {/* task */}
        <div style={{ ...cellPad, gap: 6 }}>
          {t.isMilestone && <Diamond size={12} style={{ color: NX.purple, flexShrink: 0 }} />}
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
          {subs.length > 0 && (
            <span title={`${subsDone}/${subs.length} subtasks done`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: NX.faint, flexShrink: 0 }}>
              <ListTree size={12} />{subsDone}/{subs.length}
            </span>
          )}
          {/* Same badge language as subtasks above - icon + count, present only
              when there's something to show. No longer buttons in ActionIcons:
              those opened the drawer/file-picker regardless of whether the task
              had anything to show, which is what a plain indicator here avoids. */}
          {commentCount > 0 && (
            <span title={`${commentCount} comment${commentCount === 1 ? '' : 's'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: NX.faint, flexShrink: 0 }}>
              <MessageSquare size={12} />{commentCount}
            </span>
          )}
          {attachmentCount > 0 && (
            <span title={`${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: NX.faint, flexShrink: 0 }}>
              <Paperclip size={12} />{attachmentCount}
            </span>
          )}
        </div>
        {/* assignee - monday Person cell: avatar + follower stack */}
        {show('assignee') && (
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
            <span style={{ display: 'inline-flex', borderRadius: '50%', boxShadow: `0 0 0 2px ${NX.surface}`, zIndex: 2 }}>
              <AssigneeCell compact value={t.assigneeId || null} people={people} onSelect={(em) => store.updateTask(t.id, { assigneeId: em || '' })} />
            </span>
            {followers.slice(0, 2).map((f) => (
              <span key={f} style={{ display: 'inline-flex', marginLeft: -8, borderRadius: '50%', boxShadow: `0 0 0 2px ${NX.surface}`, zIndex: 1 }}>
                <Avatar email={f} size={24} />
              </span>
            ))}
            {followers.length > 2 && (
              <span title={`${followers.length - 2} more follower${followers.length - 2 !== 1 ? 's' : ''}`} style={{ marginLeft: -8, zIndex: 0, width: 24, height: 24, borderRadius: '50%', background: '#3c4a5d', color: '#fff', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 0 2px ${NX.surface}` }}>+{followers.length - 2}</span>
            )}
          </div>
        </div>
        )}
        {/* project */}
        {show('project') && (
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
          {/* Options are built only once this select is actually opened. Every
              other cell here is already lazy (PillSelect renders its menu on
              open), but this one eagerly emitted one <option> per project PER
              ROW - rows x projects DOM nodes before a single click, which is
              what pinned the main thread on a full task list. Closed, it renders
              just the selected option so the label still shows. */}
          <select value={t.projectId || ''} onMouseDown={() => setProjOpen(true)} onFocus={() => setProjOpen(true)}
            onChange={(e) => store.updateTask(t.id, { projectId: e.target.value || null })}
            style={{ border: 'none', borderRadius: 6, padding: 0, fontSize: 13, color: t.projectId ? NX.dim : NX.faint, background: 'transparent', fontFamily: FONT, width: '100%', cursor: 'pointer' }}>
            <option value="">No project</option>
            {projOpen
              ? store.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)
              : !!t.projectId && <option value={t.projectId}>{store.projectName(t.projectId)}</option>}
          </select>
        </div>
        )}
        {/* due */}
        {show('due') && (
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
          <DateField value={t.dueOn || ''} onChange={(v) => store.updateTask(t.id, { dueOn: v })} color={dueColor(t.dueOn, t.completed)} title="Due Date" style={{ fontSize: 12, width: '100%' }} />
        </div>
        )}
        {/* estimate */}
        {show('estimate') && (
        <div className="rl-cell" style={{ ...editCell, gap: 2 }} onClick={(e) => e.stopPropagation()}>
          <input type="number" className="rl-num" min={0} value={estH} placeholder="hrs" onChange={(e) => setEst(e.target.value, estM)} style={{ width: 30, textAlign: 'right', border: 'none', background: 'transparent', fontSize: 12, color: NX.dim, outline: 'none', fontFamily: FONT }} />
          <span style={{ color: NX.faint, fontSize: 12 }}>:</span>
          <input type="number" className="rl-num" min={0} max={59} step={5} value={estM} placeholder="min" onChange={(e) => setEst(estH, e.target.value)} style={{ width: 30, textAlign: 'left', border: 'none', background: 'transparent', fontSize: 12, color: NX.dim, outline: 'none', fontFamily: FONT }} />
        </div>
        )}
        {/* actual */}
        {show('actual') && (
        <div className="rl-cell" style={{ ...editCell, gap: 3 }} onClick={(e) => e.stopPropagation()}>
          <input type="number" className="rl-num" min={0} value={t.actualHours ?? ''} placeholder="0" onChange={(e) => store.updateTask(t.id, { actualHours: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 34, textAlign: 'right', border: 'none', background: 'transparent', fontSize: 12, color: NX.dim, outline: 'none', fontFamily: FONT }} />
          <span style={{ color: NX.faint, fontSize: 12 }}>h</span>
        </div>
        )}
        {/* priority - monday-style edge-to-edge colored cell */}
        {show('priority') && (
        <div style={flushCell} onClick={(e) => e.stopPropagation()}>
          <PillSelect solid center label={pm.label} color={pm.color} tint={pm.tint} currentKey={t.priority}
            options={PRIORITY_ORDER.map((p) => ({ key: p, label: PRIORITY_META[p].label, color: PRIORITY_META[p].color }))}
            onSelect={(k) => store.updateTask(t.id, { priority: k })} />
        </div>
        )}
        {/* status - monday-style edge-to-edge colored cell */}
        {show('status') && (
        <div style={flushCell} onClick={(e) => e.stopPropagation()}>
          <PillSelect solid center label={sm.label} color={sm.color} tint={sm.tint} currentKey={t.status}
            // This row's OWN project, not the view's - the list is cross-project in My Tasks.
            options={(store.statusOrderFor ? store.statusOrderFor(t.projectId) : store.statusOrder).map((s) => ({ key: s, label: store.statusMeta[s]?.label || s, color: store.statusMeta[s]?.color }))}
            onSelect={(k) => store.setStatus(t.id, k)} />
        </div>
        )}
        {/* team - scoped to this task's own project, since a team lives inside one project */}
        {show('team') && (
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
          <PillSelect center
            label={team ? team.name : '-'} color={team ? team.color : NX.faint} tint={team ? `${team.color}1a` : 'transparent'}
            icon={team ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: team.color, flexShrink: 0 }} /> : null}
            currentKey={t.teamId || ''}
            options={[{ key: '', label: 'No team', color: NX.faint }, ...store.teams.filter((tm) => teamInProject(tm, t.projectId)).map((tm) => ({ key: tm.id, label: tm.name, color: tm.color }))]}
            onSelect={(k) => store.updateTask(t.id, { teamId: k || null })} />
        </div>
        )}
        {/* timeline - monday date-range pill in the group's color */}
        {show('timeline') && (
        <div className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
          <TimelineCell t={t} color={groupColor || NX.blue} onChange={(patch) => store.updateTask(t.id, patch)} />
        </div>
        )}
        {/* custom fields (already filtered to visible ones by the caller) */}
        {customFields.map((f) => (
          <div key={f.id} className="rl-cell" style={editCell} onClick={(e) => e.stopPropagation()}>
            <FieldCell field={f} value={(t.customFieldValues || {})[f.id]} people={people}
              onChange={(v) => store.updateTask(t.id, { customFieldValues: { ...(t.customFieldValues || {}), [f.id]: v } })} />
          </div>
        ))}
        <div />
      </div>
    </div>
  );
}

// Drag handle on a header cell's right edge - matches the export's ColResizer.
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

// "+ Column" - creates a new custom field. Two steps, matching the export's
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
    const needsOptions = picked.storage === 'select' || picked.storage === 'multiselect';
    const opts = needsOptions ? options.map((o) => o.trim()).filter(Boolean) : [];
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
              {(picked?.storage === 'select' || picked?.storage === 'multiselect') && (
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

// A multiselect cell: the chosen options as chips, with a popover to toggle
// them. Deliberately not PillSelect - that one closes on pick, which is wrong
// when the whole point is choosing several.
// Serves both the multiselect and the people cell. Goes through PortalDropdown
// like every other menu here - an absolutely-positioned panel gets clipped by
// the grid, which scrolls on both axes. `email` on an option renders an avatar.
function MultiPillSelect({ options, picked, onToggle, placeholder = '-' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const panelRef = useRef(null);
  useClickOutside([ref, panelRef], () => setOpen(false), open);
  const chosen = options.filter((o) => picked.includes(o.key));
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} style={{
        width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT,
        display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', padding: '2px 0', minHeight: 22,
      }}>
        {chosen.length === 0 && <span style={{ fontSize: 12.5, color: NX.faint }}>{placeholder}</span>}
        {chosen.map((o) => (
          <span key={o.key} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 11.5, fontWeight: 600, color: o.color, background: `${o.color}1a`,
            border: `1px solid ${o.color}55`, borderRadius: 20,
            padding: o.email ? '1px 8px 1px 2px' : '1px 8px', whiteSpace: 'nowrap',
          }}>
            {o.email && <Avatar email={o.email} name={o.label} size={16} card={false} />}
            {o.label}
          </span>
        ))}
      </button>
      {open && (
        <PortalDropdown anchorRef={ref} panelRef={panelRef} width={208}>
          <div className="nx-scroll" style={{ maxHeight: 260, overflowY: 'auto', padding: 4 }}>
            {options.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12.5, color: NX.faint }}>No options</div>}
            {options.map((o) => {
              const on = picked.includes(o.key);
              return (
                <button key={o.key} onClick={(e) => { e.stopPropagation(); onToggle(o.key); }} style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  border: 'none', background: on ? NX.surface2 : 'transparent', cursor: 'pointer',
                  padding: '6px 8px', borderRadius: 7, fontFamily: FONT, fontSize: 12.5, color: NX.ink,
                }}>
                  <span style={{
                    width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                    border: `1.5px solid ${on ? o.color : NX.border}`, background: on ? o.color : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{on && <Check size={9} strokeWidth={3} color="#fff" />}</span>
                  {o.email && <Avatar email={o.email} name={o.label} size={18} card={false} />}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
                </button>
              );
            })}
          </div>
        </PortalDropdown>
      )}
    </div>
  );
}

// Options arrive as {id,label,color}; rows written before options carried colors
// hold plain strings, so read both shapes rather than assuming either.
const fieldOpts = (field) =>
  (field.options || []).map((o, i) => (typeof o === 'string'
    ? { key: o, label: o, color: FIELD_PALETTE[i % FIELD_PALETTE.length] }
    : { key: o.id, label: o.label, color: o.color || FIELD_PALETTE[i % FIELD_PALETTE.length] }));

// Value editor for one custom-field cell, keyed by type.
function FieldCell({ field, value, onChange, people = [] }) {
  if (field.readOnly) {
    // Calculated in Asana, which rejects writes - display only.
    return (
      <span title="Calculated in Asana - not editable here"
        style={{ fontSize: 12.5, color: NX.dim, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {value || '-'}
        <Lock size={10} style={{ color: NX.faint }} />
      </span>
    );
  }
  if (field.type === 'people') {
    const picked = Array.isArray(value) ? value : [];
    // People already chosen but no longer in the directory (someone offboarded,
    // or an Asana-only collaborator) still need to render, so union the two.
    const opts = [...people, ...picked.filter((em) => !people.some((p) => p.email === em))
      .map((em) => ({ email: em, name: emailToName(em) }))]
      .map((p, i) => ({ key: p.email, label: p.name, email: p.email, color: FIELD_PALETTE[i % FIELD_PALETTE.length] }));
    const toggle = (k) => onChange(picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k]);
    return <MultiPillSelect options={opts} picked={picked} onToggle={toggle} />;
  }
  if (field.type === 'multiselect') {
    const opts = fieldOpts(field);
    const picked = Array.isArray(value) ? value : [];
    const toggle = (k) => onChange(picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k]);
    return (
      <MultiPillSelect options={opts} picked={picked} onToggle={toggle} />
    );
  }
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
    const opts = fieldOpts(field);
    const cur = opts.find((o) => o.key === value);
    return (
      <PillSelect label={cur ? cur.label : '-'} color={cur ? cur.color : NX.faint} tint={cur ? `${cur.color}1a` : 'transparent'}
        currentKey={value || ''} options={[{ key: '', label: 'None', color: NX.faint }, ...opts]} onSelect={onChange} />
    );
  }
  if (field.type === 'date') {
    return <DateField value={value || ''} onChange={onChange} color={NX.dim} style={{ fontSize: 12, width: '100%' }} />;
  }
  if (field.type === 'number') {
    return <input type="number" className="rl-num" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} placeholder="-"
      style={{ width: '100%', border: 'none', background: 'transparent', fontSize: 12.5, color: NX.dim, outline: 'none', fontFamily: FONT }} />;
  }
  return <input type="text" value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder="-"
    style={{ width: '100%', border: 'none', background: 'transparent', fontSize: 12.5, color: NX.dim, outline: 'none', fontFamily: FONT }} />;
}

// monday-style Timeline cell: a colored date-range pill (start → due); click to
// edit both dates in a small popover. Uses the group's color like monday does.
function TimelineCell({ t, color, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const panelRef = useRef(null);
  useClickOutside([ref, panelRef], () => setOpen(false), open);
  const fmtShort = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const label = t.startOn && t.dueOn ? `${fmtShort(t.startOn)} – ${fmtShort(t.dueOn)}`
    : t.dueOn ? fmtShort(t.dueOn) : t.startOn ? `${fmtShort(t.startOn)} →` : '';
  return (
    <div ref={ref} style={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center' }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} title="Set timeline" style={{
        border: 'none', cursor: 'pointer', fontFamily: FONT, whiteSpace: 'nowrap', maxWidth: '100%',
        ...(label
          ? { padding: '3px 12px', borderRadius: 12, background: color, color: '#fff', fontSize: 11, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }
          : { padding: '3px 12px', borderRadius: 12, background: NX.border2, color: NX.faint, fontSize: 11, fontWeight: 600 }),
      }}>{label || '-'}</button>
      {open && (
        <PortalDropdown anchorRef={ref} panelRef={panelRef} width={218}>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: NX.faint }}>START
              <input type="date" value={t.startOn || ''} onChange={(e) => onChange({ startOn: e.target.value })}
                style={{ ...inputStyle, marginTop: 3, fontSize: 12.5, padding: '5px 8px' }} />
            </label>
            <label style={{ fontSize: 11, fontWeight: 700, color: NX.faint }}>DUE
              <input type="date" value={t.dueOn || ''} onChange={(e) => onChange({ dueOn: e.target.value })}
                style={{ ...inputStyle, marginTop: 3, fontSize: 12.5, padding: '5px 8px' }} />
            </label>
          </div>
        </PortalDropdown>
      )}
    </div>
  );
}

// Eye menu - hide/show columns, persisted per person (monday's "Hide" toolbar).
function HideColsMenu({ customFields, hidden, setHidden, lockedProjectId }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const panelRef = useRef(null);
  useClickOutside([ref, panelRef], () => setOpen(false), open);
  const toggle = (key) => {
    const n = new Set(hidden);
    n.has(key) ? n.delete(key) : n.add(key);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...n]));
    setHidden(n);
  };
  const entries = [
    // Project isn't offered inside a project - it isn't rendered there, so a
    // toggle for it would be a switch that does nothing.
    ...BASE_COLS.filter((c) => HIDEABLE.includes(c.key) && !(c.key === 'project' && lockedProjectId))
      .map((c) => ({ key: c.key, label: c.label })),
    ...customFields.map((f) => ({ key: f.id, label: f.name })),
  ];
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button title="Hide columns" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        style={{ ...btn('ghost'), padding: '4px 8px', gap: 5, color: hidden.size ? NX.blue : NX.dim, fontSize: 12, fontWeight: 600 }}>
        <EyeOff size={13} />{hidden.size ? `${hidden.size} hidden` : 'Hide'}
      </button>
      {open && (
        <PortalDropdown anchorRef={ref} panelRef={panelRef} align="right" width={200}>
          <div style={{ padding: 6, maxHeight: 300, overflowY: 'auto' }}>
            {entries.map((c) => (
              <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, fontSize: 13, color: NX.ink, cursor: 'pointer' }}>
                <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => toggle(c.key)} style={{ accentColor: 'var(--pine)', cursor: 'pointer' }} />
                {c.label}
              </label>
            ))}
          </div>
        </PortalDropdown>
      )}
    </div>
  );
}

// Inline "+ Add task" under each group section - the created task inherits the
// section's group context (status / priority / project / due-date bucket) plus
// the workspace's locked project, matching Asana's add-from-a-section flow.
// A project with exactly one team hands it to new tasks automatically; with
// several there's no right answer, so the Team cell stays blank.
const soleTeamId = (store, projectId) => {
  const own = (store.teams || []).filter((t) => teamInProject(t, projectId));
  return own.length === 1 ? own[0].id : '';
};

function AddTaskInline({ store, defaults, lockedProjectId }) {
  const [title, setTitle] = useState('');
  const add = () => {
    const t = title.trim(); if (!t) return;
    store.createTask({
      title: t, type: 'task',
      status: defaults.status || 'not_started', priority: defaults.priority || 'medium',
      projectId: defaults.projectId || lockedProjectId || '',
      teamId: defaults.teamId || soleTeamId(store, defaults.projectId || lockedProjectId || ''),
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

// Hidden columns (the Hide menu), persisted per person in localStorage. A hook so
// the state can live in TasksWorkspace - the controls belong in the main toolbar
// while the table that obeys them is down here.
export function useHiddenCols() {
  const [hidden, setHidden] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); } catch { return new Set(); }
  });
  return [hidden, setHidden];
}

// The Hide + "+ Column" pair, for the workspace toolbar. Rendered there rather
// than above the table so they cost no vertical space at all - they used to sit
// inside the column-header row, which repeated them once per group.
export function ListColumnControls({ hidden, setHidden, customFields, createCustomField, lockedProjectId }) {
  return (
    <>
      <HideColsMenu customFields={customFields} hidden={hidden} setHidden={setHidden} lockedProjectId={lockedProjectId} />
      <AddFieldMenu createCustomField={createCustomField} />
    </>
  );
}

export default function RichListView({ visible, group, ctx, store, people, selected, toggleSel, onOpen, onSelectAll, lockedProjectId = '', hidden, setHidden }) {
  const [collapsed, setCollapsed] = useState(new Set());
  const effGroup = group === 'none' ? 'status' : group;
  // Inside a project every row has the same project, so the column is noise. It has
  // to go through the hidden SET: TaskRow gates cells on `hidden` while the header
  // and grid template come from `cols`, so filtering one alone misaligns every row.
  const hiddenEff = useMemo(
    () => (lockedProjectId ? new Set([...hidden, 'project']) : hidden),
    [hidden, lockedProjectId],
  );
  const cols = BASE_COLS.filter((c) => !hiddenEff.has(c.key));
  // Only fields scoped to this project (plus global ones) become columns.
  // Unscoped, one field defined anywhere was a column on every board.
  const allCustomFields = fieldsForProject(store.customFields || [], lockedProjectId);
  const customFields = allCustomFields.filter((f) => !hiddenEff.has(f.id));
  const [widths, setWidths] = useState(() => Object.fromEntries(BASE_COLS.map((c) => [c.key, c.width])));
  // Drag a row onto another group to move it there (status/priority/project/…).
  const [dragId, setDragId] = useState(null);
  const [dropKey, setDropKey] = useState(null);
  const dropPatch = (key) => {
    if (effGroup === 'assignee') return { assigneeId: key === '-' ? '' : key };
    const d = groupAddDefaults(effGroup, key);
    return Object.keys(d).length ? d : null;
  };

  const wrapRef = useRef(null);
  const gridTemplate = (wd) => [
    ...cols.map((c) => `${wd[c.key] ?? c.width}px`),
    ...customFields.map((f) => `${wd[f.id] ?? 150}px`),
    // Trailing gutter - the empty cell after the last column. Header, rows and
    // group footer each render one, so the column has to stay.
    '12px',
  ].join(' ');
  const template = gridTemplate(widths);

  const startResize = useCallback((key, startWidth) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    let latest = startWidth, raf = 0;
    // During the drag, write the new widths straight to the grid's CSS variable
    // on the wrapper. The header and every rendered row read var(--nx-grid), so
    // the browser reflows the grid with ZERO React re-renders - that is what
    // makes resize smooth even with a hundred rows on screen. React state is
    // committed once, on release.
    const apply = () => {
      raf = 0;
      const el = wrapRef.current;
      if (el) el.style.setProperty('--nx-grid', gridTemplate({ ...widths, [key]: latest }));
    };
    const onMove = (ev) => { latest = Math.max(60, startWidth + (ev.clientX - startX)); if (!raf) raf = requestAnimationFrame(apply); };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (raf) cancelAnimationFrame(raf);
      setWidths((w) => ({ ...w, [key]: latest }));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [widths, cols, customFields]);

  // Scoped, not global. A status invented for one project used to become a
  // board column and a grouping bucket on EVERY project - the same scoping
  // fieldsForProject already did for custom fields. statusMeta stays global on
  // purpose: a task carries its status id wherever it is rendered (My Tasks,
  // search, a portfolio rollup) and a missed meta lookup would draw a raw uuid.
  const scopedStatusOrder = store.statusOrderFor ? store.statusOrderFor(lockedProjectId) : store.statusOrder;
  const groupCtx = { ...ctx, statusMeta: store.statusMeta, statusOrder: scopedStatusOrder, customFields: allCustomFields };
  const groups = useMemo(() => groupTasks(visible, effGroup, groupCtx).filter((g) => g.tasks.length > 0), [visible, effGroup, ctx, store.statusMeta, scopedStatusOrder]);
  // Incremental rendering. Every task used to mount a full row on first paint -
  // ~80 DOM nodes each, so the real workspace (2,400 tasks) built ~190k nodes
  // synchronously and the tab went "page isn't responding". Rows are handed out
  // from a budget that grows as the sentinel below scrolls into view, so the
  // first paint is bounded no matter how large the list is. Selection and the
  // group tallies still count every task - only the DOM is deferred.
  const totalRows = groups.reduce((n, g) => n + g.tasks.length, 0);
  const [renderBudget, setRenderBudget] = useState(ROW_BATCH);
  // A new filter or grouping is a different list - start over rather than
  // carrying a budget grown against the previous one. Keyed on length rather
  // than the array itself: `visible` is rebuilt upstream on every render, so
  // depending on its identity would reset the budget continuously and make
  // scrolling past the first batch impossible.
  useEffect(() => { setRenderBudget(ROW_BATCH); }, [effGroup, visible.length]);
  const groupBudgets = useMemo(() => {
    let left = renderBudget;
    return groups.map((g) => { const n = Math.max(0, Math.min(left, g.tasks.length)); left -= n; return n; });
  }, [groups, renderBudget]);
  const moreRef = useRef(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el || renderBudget >= totalRows) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setRenderBudget((b) => b + ROW_BATCH);
    }, { rootMargin: '600px' });   // grow before the user reaches the end
    io.observe(el);
    return () => io.disconnect();
  }, [renderBudget, totalRows]);
  const visibleIds = groups.flatMap((g) => g.tasks.map((t) => t.id));
  const allSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSel = !allSel && visibleIds.some((id) => selected.has(id));
  const toggleGroup = (k) => setCollapsed((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  if (visible.length === 0 && store.loading) {
    // Skeleton while the first fetch is in flight - never a bare "no tasks".
    return (
      <div style={{ margin: 16 }}>
        {[0, 1].map((b) => (
          <div key={b} style={{ marginTop: b ? 22 : 0 }}>
            <span className="skel" style={{ width: 160, height: 18, display: 'block', marginBottom: 10 }} />
            <div style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, padding: '4px 0' }}>
              {[0, 1, 2, 3].map((r) => (
                <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '9px 16px' }}>
                  <span className="skel" style={{ width: 16, height: 16, borderRadius: 4 }} />
                  <span className="skel" style={{ width: `${44 - r * 6}%`, height: 12 }} />
                  <span className="skel" style={{ width: 26, height: 26, borderRadius: '50%', marginLeft: 'auto' }} />
                  <span className="skel" style={{ width: 90, height: 22, borderRadius: 4 }} />
                  <span className="skel" style={{ width: 90, height: 22, borderRadius: 4 }} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (visible.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 16, background: NX.surface, padding: '56px 0', margin: 16, textAlign: 'center' }}>
        <Folder size={26} style={{ color: NX.faint }} />
        <div style={{ fontSize: 14, fontWeight: 600, color: NX.ink }}>No Tasks Yet</div>
        <div style={{ fontSize: 13, color: NX.dim }}>Create your first task with the “New Task” button.</div>
      </div>
    );
  }

  // monday repeats the column header inside every group block - this renders one.
  const headCell = { position: 'relative', display: 'flex', alignItems: 'center', minWidth: 0, minHeight: 34, padding: '2px 8px', borderRight: `1px solid ${NX.border2}`, boxSizing: 'border-box' };
  const groupHeader = (
    <div style={{ display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'stretch', borderBottom: `1px solid ${NX.border2}`, background: NX.surface, fontSize: 13, fontWeight: 400, color: NX.dim }}>
      <div style={{ ...headCell, justifyContent: 'center', padding: '2px 4px' }}>
        <button onClick={onSelectAll} title={allSel ? 'Deselect all' : 'Select all'} style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${allSel || someSel ? NX.primary : NX.border}`, background: allSel || someSel ? NX.primary : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
          {allSel ? <Check size={11} strokeWidth={3} color="#fff" /> : someSel ? <Minus size={11} strokeWidth={3} color="#fff" /> : null}
        </button>
      </div>
      {cols.slice(1).map((c) => (
        <div key={c.key} style={{ ...headCell, justifyContent: c.key === 'task' ? 'flex-start' : 'center' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
          <ColResizer onMouseDown={startResize(c.key, widths[c.key] ?? c.width)} />
        </div>
      ))}
      {customFields.map((f) => (
        <div key={f.id} style={{ ...headCell, justifyContent: 'center' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          <ColResizer onMouseDown={startResize(f.id, widths[f.id] ?? 150)} />
        </div>
      ))}
      {/* Trailing spacer. Hide / + Column used to live here - inside the header
          row, and therefore repeated in every group block and sitting flush
          against the last column's label. They're now one toolbar above the
          table (see below). */}
      <div />
    </div>
  );

  return (
    <div className="nx-list-scroll" style={{ margin: 16, minHeight: 'calc(100% - 32px)' }}>
      <div ref={wrapRef} style={{ minWidth: 'fit-content', '--nx-grid': template }}>
        {groups.map((g, gi) => {
          const isCol = collapsed.has(g.key);
          // monday.com-style group block: colored title, left color bar, and a
          // summary footer (due-date range + status distribution bar).
          const gc = g.color || colorForKey(g.key);
          const total = g.tasks.length;
          const byStatus = {};
          for (const t of g.tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
          const dues = g.tasks.map((t) => t.dueOn).filter(Boolean).sort();
          const fmtD = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const dueRange = dues.length ? (dues[0] === dues[dues.length - 1] ? fmtD(dues[0]) : `${fmtD(dues[0])} – ${fmtD(dues[dues.length - 1])}`) : '';
          const statusBar = (h) => (
            <div title={store.statusOrder.filter((s) => byStatus[s]).map((s) => `${store.statusMeta[s]?.label || s}: ${byStatus[s]}/${total}`).join(' · ')}
              style={{ display: 'flex', height: h, borderRadius: 4, overflow: 'hidden', background: NX.border2, width: '100%' }}>
              {store.statusOrder.filter((s) => byStatus[s]).map((s) => (
                <div key={s} style={{ flex: byStatus[s], background: store.statusMeta[s]?.color || NX.faint }} />
              ))}
            </div>
          );
          const isDropTarget = dragId && dropKey === g.key && dropPatch(g.key);
          return (
            <div key={g.key} style={{ marginTop: 22 }}
              onDragOver={(e) => { if (dragId && dropPatch(g.key)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropKey !== g.key) setDropKey(g.key); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropKey((k) => (k === g.key ? null : k)); }}
              onDrop={(e) => { e.preventDefault(); const patch = dropPatch(g.key); if (dragId && patch) store.updateTask(dragId, patch).catch(() => {}); setDragId(null); setDropKey(null); }}>
              <button onClick={() => toggleGroup(g.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 2px 8px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: FONT }}>
                <ChevronDown size={17} style={{ color: NX.faint, transform: isCol ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s' }} />
                <span style={{ width: 10, height: 10, borderRadius: 3, background: gc, flexShrink: 0 }} />
                <span style={{ fontSize: 16, fontWeight: 700, color: NX.ink, letterSpacing: -0.2 }}>{g.label}</span>
                <span style={{ fontSize: 12.5, color: NX.faint, fontWeight: 500, marginLeft: 4 }}>{total} item{total !== 1 ? 's' : ''}</span>
                {/* collapsed: the status mix stays visible on the header line */}
                {isCol && total > 0 && <span style={{ display: 'inline-flex', width: 130, marginLeft: 10 }}>{statusBar(12)}</span>}
              </button>
              {!isCol && (
                <div style={{ border: `1px solid ${isDropTarget ? gc : NX.border}`, borderRadius: 12, overflow: 'hidden', background: NX.surface, boxShadow: isDropTarget ? `0 0 0 2px ${gc}55` : 'none', transition: 'box-shadow 0.12s' }}>
                  {groupHeader}
                  {g.tasks.slice(0, groupBudgets[gi] ?? g.tasks.length).map((t) => (
                    <TaskRow key={t.id} t={t} cols={cols} customFields={customFields} template={template} store={store} people={people} selected={selected.has(t.id)} toggleSel={toggleSel} onOpen={onOpen}
                      hidden={hiddenEff} groupColor={gc} onDragStartRow={setDragId} onDragEndRow={() => { setDragId(null); setDropKey(null); }} />
                  ))}
                  <AddTaskInline store={store} lockedProjectId={lockedProjectId} defaults={groupAddDefaults(effGroup, g.key)} />
                  {/* summary footer - mirrors monday's group tallies */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'center', padding: '5px 0', fontSize: 12 }}>
                    {cols.map((c) => c.key === 'due' ? (
                      <div key={c.key} style={{ padding: '2px 8px', display: 'flex', justifyContent: 'center' }}>
                        {dueRange && (
                          <span title="Due-date range in this group" style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 12, background: '#00c875', color: '#fff', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{dueRange}</span>
                        )}
                      </div>
                    ) : c.key === 'status' ? (
                      <div key={c.key} style={{ padding: '2px 6px' }}>{statusBar(22)}</div>
                    ) : <div key={c.key} />)}
                    {customFields.map((f) => <div key={f.id} />)}
                    <div />
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {/* Grows the render budget as it comes into view - see ROW_BATCH. Kept
            in the flow (not fixed) so it only fires while the user is actually
            near the end of the list. */}
        {renderBudget < totalRows && (
          <div ref={moreRef} style={{ padding: '18px 2px', textAlign: 'center', fontSize: 12.5, color: NX.faint }}>
            Showing {renderBudget} of {totalRows}
            <button onClick={() => setRenderBudget(totalRows)}
              style={{ ...btn('ghost'), fontSize: 12.5, padding: '4px 10px', marginLeft: 8 }}>
              Show all
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
