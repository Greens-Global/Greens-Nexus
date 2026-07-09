// Task Module — the Tasks workspace: toolbar (search / group / view-kind) + the
// List and Board views + bulk action bar. Owns the shared view state, mirroring
// the export's viewContext. Calendar/Timeline/Dashboard live in ./views/extras.
import { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  List, Columns3, Calendar as CalIcon, GanttChart, LayoutDashboard, Paperclip, Gauge, Plus, Search,
  CheckCircle2, Circle, Trash2, X, ChevronDown, Check, Minus, Diamond, ListTree, ThumbsUp,
  MoreHorizontal, Copy, Pencil, FolderInput, ListPlus, PanelRightOpen, PanelRightClose, ChevronsRight,
} from 'lucide-react';
import { useTasks } from './TasksContext';
import { EMPTY_FILTER, matchesFilter, topLevel, sortTasks, groupTasks, taskStats } from './lib';
import { NX, FONT, btn, input as inputStyle, STATUS_ORDER, STATUS_META, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { Avatar, PriorityChip, EmptyState, PersonSelect, usePeople } from './components';
import {
  useColumnWidths, ColResizer, CustomFieldCell, useConfirm, toast,
  FIELD_TYPE_GROUPS, FIELD_HAS_OPTIONS, normalizeOptions, Popover,
} from './shared';
import CreateTaskModal from './CreateTaskModal';
import TaskDetailDrawer from './TaskDetailDrawer';
import { CalendarView, DashboardView } from './views/extras';
import { TimelineView, FilesView, WorkloadView } from './views/more';
import { ProductivityBar } from './productivity';

const VIEW_KINDS = [
  { key: 'list', label: 'List', icon: List },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'calendar', label: 'Calendar', icon: CalIcon },
  { key: 'timeline', label: 'Timeline', icon: GanttChart },
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'workload', label: 'Workload', icon: Gauge },
  { key: 'files', label: 'Files', icon: Paperclip },
];
const GROUPS = ['status', 'priority', 'assignee', 'project', 'date', 'department', 'none'];
const SECTION_PALETTE = ['#4573fa', '#8b6bf0', '#14a76c', '#e8a33d', '#e0844e', '#e8384f', '#29a8ab', '#db2777'];

// Combined status metadata: built-ins from STATUS_META, custom sections from the store.
function statusMetaOf(status, customStatuses) {
  if (STATUS_META[status]) return STATUS_META[status];
  const c = (customStatuses || []).find((s) => s.id === status);
  if (c) return { label: c.label, color: c.color || NX.dim, tint: `${c.color || NX.dim}1a` };
  return { label: status, color: NX.dim, tint: NX.border2 };
}
const pillStyle = (color, tint) => ({
  display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', padding: '2px 9px',
  borderRadius: 999, fontSize: 12, fontWeight: 600, color, background: tint, border: 'none',
  cursor: 'pointer', fontFamily: FONT, whiteSpace: 'nowrap',
});
const menuRow = (active) => ({
  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 7,
  fontSize: 13, cursor: 'pointer', color: NX.ink, background: active ? NX.hover : 'transparent',
});

// ── Dropdown primitives (built on the shared Popover) ────────────────────────
function PillMenu({ trigger, options, currentKey, onSelect, width = 176 }) {
  return (
    <Popover width={width} trigger={(toggle) => (
      <button type="button" onClick={(e) => { e.stopPropagation(); toggle(); }} style={pillStyle(trigger.color, trigger.tint)} title={trigger.label}>
        {trigger.icon}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{trigger.label}</span>
        <ChevronDown size={12} style={{ opacity: 0.5, flexShrink: 0 }} />
      </button>
    )}>
      {(close) => (
        <>
          {options.map((o) => (
            <div key={o.key} onClick={() => { onSelect(o.key); close(); }} style={menuRow(o.key === currentKey)}
              onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = o.key === currentKey ? NX.hover : 'transparent'; }}>
              {o.icon || <span style={{ width: 10, height: 10, borderRadius: 3, background: o.color || NX.faint, flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              {o.key === currentKey && <Check size={13} style={{ marginLeft: 'auto', color: NX.blue }} />}
            </div>
          ))}
        </>
      )}
    </Popover>
  );
}

function TextMenu({ label, placeholder, options, currentKey, onSelect, width = 200 }) {
  return (
    <Popover width={width} trigger={(toggle) => (
      <button type="button" onClick={(e) => { e.stopPropagation(); toggle(); }} style={{ ...btn('ghost'), padding: '2px 4px', width: '100%', justifyContent: 'space-between' }}>
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', fontSize: 13, color: label ? NX.dim : NX.faint }}>{label ?? placeholder}</span>
        <ChevronDown size={12} style={{ color: NX.faint, flexShrink: 0 }} />
      </button>
    )}>
      {(close) => (
        <>
          {options.map((o) => (
            <div key={o.key} onClick={() => { onSelect(o.key); close(); }} style={menuRow(o.key === currentKey)}
              onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = o.key === currentKey ? NX.hover : 'transparent'; }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              {o.key === currentKey && <Check size={13} style={{ marginLeft: 'auto', color: NX.blue }} />}
            </div>
          ))}
        </>
      )}
    </Popover>
  );
}

// Add-Column control: pick a field type (FIELD_TYPE_GROUPS) → name (+ options) → createCustomField.
function AddColumnMenu({ createCustomField }) {
  const [step, setStep] = useState('list');
  const [type, setType] = useState('text');
  const [name, setName] = useState('');
  const [optsText, setOptsText] = useState('');
  const groupLabel = { fontSize: 10.5, fontWeight: 700, color: NX.faint, textTransform: 'uppercase', letterSpacing: 0.4, padding: '6px 9px 2px' };
  return (
    <Popover width={236} align="right" trigger={(toggle) => (
      <button type="button" onClick={(e) => { e.stopPropagation(); setStep('list'); toggle(); }} style={{ ...btn('ghost'), padding: '3px 6px' }} title="Add column"><Plus size={15} /></button>
    )}>
      {(close) => step === 'list' ? (
        <div>
          {FIELD_TYPE_GROUPS.map((g) => (
            <div key={g.label}>
              <div style={groupLabel}>{g.label}</div>
              {g.types.map((t, i) => (
                <div key={`${t.type}-${i}`} onClick={() => { setType(t.type); setName(''); setOptsText(''); setStep('form'); }} style={menuRow(false)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  <t.icon size={14} style={{ color: NX.dim, flexShrink: 0 }} />{t.label}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: 6 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Column name" style={{ ...inputStyle, padding: '6px 8px', marginBottom: 6 }}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) e.currentTarget.blur(); }} />
          {FIELD_HAS_OPTIONS.includes(type) && (
            <input value={optsText} onChange={(e) => setOptsText(e.target.value)} placeholder="Options, comma-separated" style={{ ...inputStyle, padding: '6px 8px', marginBottom: 6 }} />
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button style={{ ...btn('outline'), padding: '5px 9px' }} onClick={() => setStep('list')}>Back</button>
            <button style={{ ...btn('primary'), padding: '5px 9px', opacity: name.trim() ? 1 : 0.4 }} disabled={!name.trim()} onClick={() => {
              const options = FIELD_HAS_OPTIONS.includes(type)
                ? normalizeOptions(optsText.split(',').map((s) => s.trim()).filter(Boolean))
                : undefined;
              createCustomField({ name: name.trim(), type, options });
              toast('Column added', 'success');
              close();
            }}>Add</button>
          </div>
        </div>
      )}
    </Popover>
  );
}

// ── Row / card context menu (Duplicate / Edit / Move / Add subtask / Details / Delete) ──
function ActionsMenu({ menu, onClose, store, customStatuses, openId, onOpen, onAddSubtask, confirm }) {
  const ref = useRef(null);
  const [subOpen, setSubOpen] = useState(false);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  if (!menu) return null;
  const { task, x, y } = menu;
  const detailsOpen = openId === task.id;
  const statuses = [...STATUS_ORDER, ...customStatuses.map((s) => s.id)];
  const item = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink, whiteSpace: 'nowrap' };
  const hoverOn = (e) => { e.currentTarget.style.background = NX.hover; };
  const hoverOff = (e) => { e.currentTarget.style.background = 'transparent'; };
  return createPortal(
    <div ref={ref} style={{
      position: 'fixed', top: Math.min(y, window.innerHeight - 280), left: Math.min(x, window.innerWidth - 220),
      width: 208, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12,
      boxShadow: '0 16px 40px rgba(0,0,0,0.22)', padding: 4, zIndex: 6000, fontFamily: FONT,
    }}>
      <div style={item} onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={() => { onClose(); store.duplicateTask(task.id); toast('Task duplicated', 'success'); }}><Copy size={14} />Duplicate task</div>
      <div style={item} onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={() => { onClose(); onOpen(task.id); }}><Pencil size={14} />Edit task</div>
      <div>
        <div style={item} onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={() => setSubOpen((o) => !o)}>
          <FolderInput size={14} />Move to section<ChevronsRight size={13} style={{ marginLeft: 'auto', color: NX.faint }} />
        </div>
        {subOpen && (
          <div style={{ paddingLeft: 8 }}>
            {statuses.map((s) => {
              const m = statusMetaOf(s, customStatuses);
              return (
                <div key={s} style={{ ...item, padding: '6px 12px' }} onMouseEnter={hoverOn} onMouseLeave={hoverOff}
                  onClick={() => { store.setStatus(task.id, s); onClose(); }}>
                  {s === task.status ? <Check size={13} style={{ color: NX.blue }} /> : <span style={{ width: 13 }} />}
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: m.color }} />{m.label}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div style={item} onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={() => { onClose(); onAddSubtask(task); }}><ListPlus size={14} />Add subtask</div>
      <div style={item} onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={() => { onClose(); detailsOpen ? onOpen(null) : onOpen(task.id); }}>
        {detailsOpen ? <><PanelRightClose size={14} />Close task details</> : <><PanelRightOpen size={14} />Open task details</>}
      </div>
      <div style={{ ...item, color: NX.red }} onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={async () => {
        onClose();
        const ok = await confirm({ title: 'Delete this task?', message: `"${task.title}" and its subtasks will be permanently deleted.`, danger: true, confirmLabel: 'Delete task' });
        if (ok) { store.deleteTask(task.id); toast('Task deleted'); }
      }}><Trash2 size={14} />Delete task</div>
    </div>,
    document.body,
  );
}

export default function TasksWorkspace({ lockedProjectId = null, mine = false, title = 'Tasks' }) {
  const store = useTasks();
  const { tasks, nameOf, projectName, deptName, bulkUpdate, bulkComplete, bulkDelete, deleteTask, myEmail } = store;
  const people = usePeople();
  const [confirm, confirmNode] = useConfirm();
  const [view, setView] = useState('list');
  const [group, setGroup] = useState('status');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTER);
  const [sort, setSort] = useState({ key: 'manual', dir: 'asc' });
  const [selected, setSelected] = useState(new Set());
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState(null);   // { task, x, y }

  const filter = {
    ...filters, search,
    projectIds: lockedProjectId ? [lockedProjectId] : filters.projectIds,
    assigneeIds: mine && myEmail ? [myEmail] : filters.assigneeIds,
  };
  const visible = useMemo(
    () => sortTasks(topLevel(tasks).filter((t) => matchesFilter(t, filter)), sort),
    [tasks, search, filters, sort, lockedProjectId, mine, myEmail],
  );

  const applyView = (v) => {
    if (v.filters) setFilters({ ...EMPTY_FILTER, ...v.filters });
    if (v.sort) setSort(v.sort);
    if (v.group) setGroup(v.group);
    if (v.view) setView(v.view);
  };
  const stats = useMemo(() => taskStats(visible), [visible]);

  const toggleSel = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  const ctx = { nameOf, projectName, deptName };
  const onContext = (task, x, y) => setMenu({ task, x, y });
  const openSubtask = async (task) => { try { await store.addSubtask(task); } catch (e) { /* ignore */ } setOpenId(task.id); };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${NX.border}`, flexWrap: 'wrap', background: NX.surface }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2 }}>
          {VIEW_KINDS.map((v) => (
            <button key={v.key} onClick={() => setView(v.key)} title={v.label} style={{
              ...btn('ghost'), padding: '6px 10px', borderRadius: 7,
              background: view === v.key ? NX.surface : 'transparent', color: view === v.key ? NX.ink : NX.dim,
              boxShadow: view === v.key ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}><v.icon size={15} />{v.label}</button>
          ))}
        </div>
        <div style={{ position: 'relative', minWidth: 200, flex: '1 1 200px', maxWidth: 340 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks…" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        {(view === 'list' || view === 'board') && (
          <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}>
            {GROUPS.map((g) => <option key={g} value={g}>Group: {g === 'none' ? 'None' : g[0].toUpperCase() + g.slice(1)}</option>)}
          </select>
        )}
        <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={() => setCreating(true)}><Plus size={15} />New task</button>
      </div>

      {/* Productivity bar */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px', borderBottom: `1px solid ${NX.border2}`, background: NX.surface }}>
        <ProductivityBar
          filters={filters} setFilters={setFilters} sort={sort} setSort={setSort}
          lockedProjectId={lockedProjectId} current={{ view, group }} onApplyView={applyView} onOpenTask={setOpenId}
        />
      </div>

      {/* Body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: view === 'board' ? NX.canvas : NX.surface }}>
        {visible.length === 0 && (view === 'list' || view === 'board') ? (
          <EmptyState icon={CheckCircle2} title="No tasks yet" hint="Create your first task to get going." />
        ) : view === 'list' ? (
          <ListView visible={visible} group={group} ctx={ctx} store={store} people={people}
            selected={selected} toggleSel={toggleSel} onOpen={setOpenId} onContext={onContext} confirm={confirm} />
        ) : view === 'board' ? (
          <BoardView visible={visible} group={group} ctx={ctx} store={store} nameOf={nameOf}
            lockedProjectId={lockedProjectId} onOpen={setOpenId} onContext={onContext} confirm={confirm} />
        ) : view === 'calendar' ? (
          <CalendarView tasks={visible} onOpen={setOpenId} />
        ) : view === 'timeline' ? (
          <TimelineView tasks={visible} onOpen={setOpenId} />
        ) : view === 'files' ? (
          <FilesView tasks={visible} onOpen={setOpenId} />
        ) : view === 'workload' ? (
          <WorkloadView tasks={visible} nameOf={nameOf} />
        ) : (
          <DashboardView tasks={visible} stats={stats} store={store} />
        )}
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div style={{ position: 'absolute', left: '50%', bottom: 22, transform: 'translateX(-50%)', background: NX.primary, color: '#fff', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.28)', zIndex: 30 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{selected.size} selected</span>
          <button onClick={() => { bulkComplete([...selected]); clearSel(); }} style={{ ...btn('ghost'), color: '#fff' }}><CheckCircle2 size={15} />Complete</button>
          <select onChange={(e) => { if (e.target.value) { bulkUpdate([...selected], { priority: e.target.value }); clearSel(); } }} defaultValue="" style={{ ...inputStyle, width: 'auto', padding: '5px 8px', background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}>
            <option value="" disabled>Priority…</option>
            {PRIORITY_ORDER.map((p) => <option key={p} value={p} style={{ color: NX.ink }}>{PRIORITY_META[p].label}</option>)}
          </select>
          <select onChange={(e) => { if (e.target.value) { bulkUpdate([...selected], { status: e.target.value, completed: e.target.value === 'completed' }); clearSel(); } }} defaultValue="" style={{ ...inputStyle, width: 'auto', padding: '5px 8px', background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}>
            <option value="" disabled>Set status…</option>
            {STATUS_ORDER.map((s) => <option key={s} value={s} style={{ color: NX.ink }}>{STATUS_META[s].label}</option>)}
          </select>
          <button onClick={async () => { const ok = await confirm({ title: `Delete ${selected.size} task(s)?`, message: 'This cannot be undone.', danger: true, confirmLabel: 'Delete' }); if (ok) { bulkDelete([...selected]); clearSel(); } }} style={{ ...btn('ghost'), color: '#fff' }}><Trash2 size={15} />Delete</button>
          <button onClick={clearSel} style={{ ...btn('ghost'), color: '#fff', padding: 5 }}><X size={16} /></button>
        </div>
      )}

      <ActionsMenu menu={menu} onClose={() => setMenu(null)} store={store} customStatuses={store.customStatuses}
        openId={openId} onOpen={setOpenId} onAddSubtask={openSubtask} confirm={confirm} />
      {confirmNode}
      {creating && <CreateTaskModal defaults={{ projectId: lockedProjectId || '' }} onClose={() => setCreating(false)} />}
      {openId && <TaskDetailDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// ═══════════════════════════════ LIST VIEW ═══════════════════════════════════
const BASE_COLS = [
  { key: 'select', width: 32 },
  { key: 'complete', width: 34 },
  { key: 'name', width: 300, label: 'Name' },
  { key: 'assignee', width: 160, label: 'Assignee' },
  { key: 'due', width: 118, label: 'Due date' },
  { key: 'priority', width: 112, label: 'Priority' },
  { key: 'status', width: 132, label: 'Status' },
  { key: 'project', width: 150, label: 'Project' },
  { key: 'estimate', width: 90, label: 'Estimate' },
  { key: 'actual', width: 90, label: 'Actual' },
  { key: 'department', width: 140, label: 'Department' },
];

function ListView({ visible, group, ctx, store, people, selected, toggleSel, onOpen, onContext, confirm }) {
  const { customFields, customStatuses } = store;
  const [collapsed, setCollapsed] = useState(new Set());
  const toggleGroup = (key) => setCollapsed((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const groups = useMemo(() => groupTasks(visible, group, ctx).filter((g) => g.tasks.length > 0), [visible, group, ctx]);

  const cols = useMemo(() => [
    ...BASE_COLS,
    ...customFields.map((f) => ({ key: f.id, width: 160, label: f.name })),
    { key: '__add', width: 92, label: '' },
  ], [customFields]);
  const { widths, startResize, template } = useColumnWidths(cols, { growKey: 'name' });

  const visibleIds = groups.flatMap((g) => g.tasks.map((t) => t.id));
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = !allSelected && visibleIds.some((id) => selected.has(id));
  const toggleAll = () => {
    if (allSelected) visibleIds.forEach((id) => selected.has(id) && toggleSel(id));
    else visibleIds.forEach((id) => !selected.has(id) && toggleSel(id));
  };

  const headBox = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint };
  const checkBox = (on, ind) => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, flexShrink: 0,
    borderRadius: 4, cursor: 'pointer', border: `1.5px solid ${on || ind ? NX.primary : NX.border}`,
    background: on || ind ? NX.primary : 'transparent',
  });

  return (
    <div style={{ width: '100%' }}>
      {/* Header */}
      <div style={{ display: 'grid', gridTemplateColumns: template, alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface2, position: 'sticky', top: 0, zIndex: 3 }}>
        <button onClick={toggleAll} title={allSelected ? 'Deselect all' : 'Select all'} style={{ ...checkBox(allSelected, someSelected), padding: 0 }}>
          {allSelected ? <Check size={11} strokeWidth={3} color="#fff" /> : someSelected ? <Minus size={11} strokeWidth={3} color="#fff" /> : null}
        </button>
        <span />
        {BASE_COLS.slice(2).map((c) => (
          <div key={c.key} style={{ position: 'relative', display: 'flex', minWidth: 0, alignItems: 'center', justifyContent: ['priority', 'status', 'department'].includes(c.key) ? 'center' : 'flex-start' }}>
            <span style={{ ...headBox, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
            <ColResizer onMouseDown={startResize(c.key, widths[c.key] ?? c.width)} />
          </div>
        ))}
        {customFields.map((f) => (
          <div key={f.id} style={{ position: 'relative', display: 'flex', minWidth: 0, alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
            <button title="Delete column" onClick={async () => {
              const ok = await confirm({ title: `Delete column "${f.name}"?`, message: 'This custom field and its values on every task will be removed.', danger: true, confirmLabel: 'Delete column' });
              if (ok) { store.deleteCustomField(f.id); toast(`Column "${f.name}" removed`); }
            }} style={{ ...btn('ghost'), padding: 2, color: NX.faint, flexShrink: 0 }}><Trash2 size={12} /></button>
            <ColResizer onMouseDown={startResize(f.id, widths[f.id] ?? 160)} />
          </div>
        ))}
        <div style={{ justifySelf: 'end' }}><AddColumnMenu createCustomField={store.createCustomField} /></div>
      </div>

      {/* Groups */}
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        return (
          <div key={g.key}>
            {g.label != null && g.label !== 'All tasks' && (
              <button onClick={() => toggleGroup(g.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 16px', border: 'none', borderBottom: `1px solid ${NX.border2}`, background: NX.surface2, cursor: 'pointer', textAlign: 'left', fontFamily: FONT }}>
                {g.color && <span style={{ width: 10, height: 10, borderRadius: '50%', background: g.color }} />}
                <ChevronDown size={15} style={{ color: NX.faint, transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.13s' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>{g.label}</span>
                <span style={{ fontSize: 12, color: NX.faint }}>{g.tasks.length}</span>
              </button>
            )}
            {!isCollapsed && g.tasks.map((t) => (
              <ListRow key={t.id} t={t} store={store} people={people} customFields={customFields} customStatuses={customStatuses}
                template={template} selected={selected.has(t.id)} anySelected={selected.size > 0}
                onToggleSel={() => toggleSel(t.id)} onOpen={() => onOpen(t.id)} onContext={onContext} checkBox={checkBox} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ListRow({ t, store, people, customFields, customStatuses, template, selected, anySelected, onToggleSel, onOpen, onContext, checkBox }) {
  const { nameOf, projectName, projects, departments } = store;
  const overdue = t.dueOn && t.dueOn < new Date().toISOString().slice(0, 10) && !t.completed;
  const sm = statusMetaOf(t.status, customStatuses);
  const pm = PRIORITY_META[t.priority] || PRIORITY_META.none;
  const dept = t.departmentId ? departments.find((d) => d.id === t.departmentId) : null;
  const cell = { minWidth: 0, display: 'flex', alignItems: 'center' };
  return (
    <div onContextMenu={(e) => { e.preventDefault(); onContext(t, e.clientX, e.clientY); }}
      style={{ display: 'grid', gridTemplateColumns: template, alignItems: 'center', gap: 12, padding: '7px 16px', borderBottom: `1px solid ${NX.border2}`, background: selected ? '#eef4ff' : NX.surface }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = NX.surface2; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = NX.surface; }}>
      <button onClick={onToggleSel} style={{ ...checkBox(selected, false), padding: 0 }}>
        {selected && <Check size={11} strokeWidth={3} color="#fff" />}
      </button>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} title="Toggle complete" style={{ ...btn('ghost'), padding: 2, color: t.completed ? NX.green : NX.faint }}>
          {t.completed ? <CheckCircle2 size={18} /> : <Circle size={18} />}
        </button>
      </div>
      {/* Name */}
      <div style={{ ...cell, gap: 6 }}>
        {t.isMilestone && <Diamond size={13} style={{ color: NX.purple, flexShrink: 0 }} />}
        <button onClick={onOpen} style={{ ...btn('ghost'), padding: 0, minWidth: 0, flex: 1, justifyContent: 'flex-start' }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
        </button>
        {t.subtaskIds?.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11, color: NX.faint, flexShrink: 0 }}>{t.subtaskIds.length}<ListTree size={12} /></span>
        )}
        {t.likedByIds?.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11, color: NX.blue, flexShrink: 0 }}>{t.likedByIds.length}<ThumbsUp size={11} fill="currentColor" /></span>
        )}
      </div>
      {/* Assignee */}
      <div style={cell} onClick={(e) => e.stopPropagation()}>
        <PersonSelect value={t.assigneeId || null} people={people} onChange={(email) => store.setAssignee(t.id, email)} />
      </div>
      {/* Due */}
      <div style={cell} onClick={(e) => e.stopPropagation()}>
        <input type="date" value={t.dueOn || ''} onChange={(e) => store.setDue(t.id, e.target.value || null)}
          style={{ ...inputStyle, padding: '4px 6px', fontSize: 12, color: overdue ? NX.red : (t.dueOn ? NX.dim : NX.faint), fontWeight: overdue ? 600 : 400 }} />
      </div>
      {/* Priority */}
      <div style={{ ...cell, justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
        <PillMenu trigger={{ label: pm.label, color: pm.color, tint: pm.tint }} currentKey={t.priority}
          options={PRIORITY_ORDER.map((p) => ({ key: p, label: PRIORITY_META[p].label, color: PRIORITY_META[p].color }))}
          onSelect={(k) => store.setPriority(t.id, k)} />
      </div>
      {/* Status */}
      <div style={{ ...cell, justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
        <PillMenu trigger={{ label: sm.label, color: sm.color, tint: sm.tint }} currentKey={t.status}
          options={[...STATUS_ORDER, ...customStatuses.map((s) => s.id)].map((s) => { const m = statusMetaOf(s, customStatuses); return { key: s, label: m.label, color: m.color }; })}
          onSelect={(k) => store.setStatus(t.id, k)} />
      </div>
      {/* Project */}
      <div style={cell} onClick={(e) => e.stopPropagation()}>
        <TextMenu label={t.projectId ? (projectName(t.projectId) || null) : null} placeholder="No project" currentKey={t.projectId || ''}
          options={[{ key: '', label: 'No project' }, ...projects.map((p) => ({ key: p.id, label: p.name }))]}
          onSelect={(k) => store.updateTask(t.id, { projectId: k || '' })} />
      </div>
      {/* Estimate */}
      <div style={{ ...cell, gap: 3 }} onClick={(e) => e.stopPropagation()}>
        <input type="number" min={0} value={t.estimateHours ?? ''} placeholder="—"
          onChange={(e) => store.updateTask(t.id, { estimateHours: e.target.value === '' ? null : Number(e.target.value) })}
          style={{ width: '100%', border: 'none', background: 'transparent', fontSize: 12, color: NX.dim, textAlign: 'right', outline: 'none', fontFamily: FONT }} />
        <span style={{ fontSize: 12, color: NX.faint }}>h</span>
      </div>
      {/* Actual */}
      <div style={{ ...cell, gap: 3 }} onClick={(e) => e.stopPropagation()}>
        <input type="number" min={0} value={t.actualHours ?? ''} placeholder="0"
          onChange={(e) => store.updateTask(t.id, { actualHours: e.target.value === '' ? null : Number(e.target.value) })}
          style={{ width: '100%', border: 'none', background: 'transparent', fontSize: 12, color: NX.dim, textAlign: 'right', outline: 'none', fontFamily: FONT }} />
        <span style={{ fontSize: 12, color: NX.faint }}>h</span>
      </div>
      {/* Department */}
      <div style={{ ...cell, justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
        <PillMenu trigger={dept ? { label: dept.name, color: dept.color || NX.dim, tint: `${dept.color || NX.dim}1a` } : { label: '—', color: NX.faint, tint: 'transparent' }}
          currentKey={t.departmentId || ''}
          options={[{ key: '', label: 'No department', color: NX.faint }, ...departments.map((d) => ({ key: d.id, label: d.name, color: d.color || NX.dim }))]}
          onSelect={(k) => store.updateTask(t.id, { departmentId: k || '' })} />
      </div>
      {/* Custom fields */}
      {customFields.map((f) => (
        <div key={f.id} style={cell} onClick={(e) => e.stopPropagation()}>
          <CustomFieldCell field={f} value={t.customFieldValues?.[f.id]} createdAt={t.createdAt} modifiedAt={t.modifiedAt}
            onChange={(v) => store.setCustomFieldValue(t, f.id, v)} />
        </div>
      ))}
      <span />
    </div>
  );
}

// ═══════════════════════════════ BOARD VIEW ══════════════════════════════════
function useWipLimits() {
  const [limits, setLimits] = useState(() => {
    try { return JSON.parse(localStorage.getItem('nexus.taskWip') || '{}'); } catch { return {}; }
  });
  const setLimit = (key, n) => setLimits((prev) => {
    const next = { ...prev };
    if (n == null || n <= 0) delete next[key]; else next[key] = n;
    localStorage.setItem('nexus.taskWip', JSON.stringify(next));
    return next;
  });
  return { limits, setLimit };
}

function BoardView({ visible, group, ctx, store, nameOf, lockedProjectId, onOpen, onContext, confirm }) {
  const { customStatuses } = store;
  const boardGroup = group === 'none' ? 'status' : group;
  const { limits, setLimit } = useWipLimits();
  const [dragId, setDragId] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [createDefaults, setCreateDefaults] = useState(null);
  const [addingSection, setAddingSection] = useState(false);
  const [sectionName, setSectionName] = useState('');

  // Build the columns for the active grouping.
  const columns = useMemo(() => {
    if (boardGroup === 'status') {
      const ids = [...STATUS_ORDER, ...customStatuses.map((s) => s.id)];
      return ids.map((s) => { const m = statusMetaOf(s, customStatuses); return { key: s, label: m.label, color: m.color, custom: !STATUS_META[s], tasks: visible.filter((t) => t.status === s) }; });
    }
    return groupTasks(visible, boardGroup, ctx).map((g) => ({ ...g, custom: false }));
  }, [boardGroup, visible, customStatuses, ctx]);

  const applyDrop = (colKey) => {
    if (!dragId) return;
    if (boardGroup === 'status') store.setStatus(dragId, colKey);
    else if (boardGroup === 'priority') store.setPriority(dragId, colKey === 'none' ? 'none' : colKey);
    else if (boardGroup === 'assignee') store.setAssignee(dragId, colKey === 'none' ? null : colKey);
    else if (boardGroup === 'project') store.updateTask(dragId, { projectId: colKey === 'none' ? '' : colKey });
    else if (boardGroup === 'department') store.updateTask(dragId, { departmentId: colKey === 'none' ? '' : colKey });
    setDragId(null);
    setDragOver(null);
  };
  const defaultsFor = (colKey) => {
    const d = { projectId: lockedProjectId || '' };
    if (boardGroup === 'status') d.status = colKey;
    else if (boardGroup === 'priority' && colKey !== 'none') d.priority = colKey;
    else if (boardGroup === 'assignee' && colKey !== 'none') d.assigneeId = colKey;
    else if (boardGroup === 'project' && colKey !== 'none') d.projectId = colKey;
    else if (boardGroup === 'department' && colKey !== 'none') d.departmentId = colKey;
    return d;
  };
  const createSection = () => {
    if (!sectionName.trim()) return;
    const color = SECTION_PALETTE[customStatuses.length % SECTION_PALETTE.length];
    store.createCustomStatus({ label: sectionName.trim(), color });
    setSectionName('');
    setAddingSection(false);
  };

  const renderCard = (t) => {
    const pm = PRIORITY_META[t.priority] || PRIORITY_META.none;
    return (
      <div key={t.id} draggable onDragStart={() => setDragId(t.id)} onClick={() => onOpen(t.id)}
        onContextMenu={(e) => { e.preventDefault(); onContext(t, e.clientX, e.clientY); }}
        style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, padding: 11, cursor: 'grab', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: NX.faint }}>{t.code}</span>
          {t.isMilestone && <Diamond size={11} style={{ color: NX.purple }} />}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
            <button title="More actions" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onContext(t, r.right - 208, r.bottom + 4); }}
              onMouseDown={(e) => e.stopPropagation()} draggable={false} style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><MoreHorizontal size={15} /></button>
            <button onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} style={{ ...btn('ghost'), padding: 2, color: t.completed ? NX.green : NX.faint }}>
              {t.completed ? <CheckCircle2 size={15} /> : <Circle size={15} />}
            </button>
          </div>
        </div>
        <div style={{ marginTop: 6, fontSize: 13.5, fontWeight: 500, color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <PriorityChip priority={t.priority} />
          {t.dueOn && <span style={{ fontSize: 11.5, color: NX.dim }}>{t.dueOn}</span>}
          {t.projectId && <span style={{ fontSize: 11.5, color: NX.faint }}>{store.projectName(t.projectId)}</span>}
          <div style={{ marginLeft: 'auto' }}>{t.assigneeId ? <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={22} /> : null}</div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', gap: 14, padding: 16, alignItems: 'flex-start', minHeight: '100%' }}>
      {columns.map((c) => {
        const limit = limits[c.key];
        const over = limit != null && c.tasks.length > limit;
        return (
          <div key={c.key}
            onDragOver={(e) => { e.preventDefault(); setDragOver(c.key); }}
            onDragLeave={() => setDragOver((d) => (d === c.key ? null : d))}
            onDrop={() => applyDrop(c.key)}
            style={{ width: 300, flexShrink: 0, background: NX.surface, borderRadius: 12, border: `1px solid ${over ? NX.red : dragOver === c.key ? NX.blue : NX.border}` }}>
            <div style={{ padding: '10px 12px', borderBottom: `1px solid ${NX.border2}`, display: 'flex', alignItems: 'center', gap: 6 }}>
              {c.color && <span style={{ width: 10, height: 10, borderRadius: '50%', background: c.color, flexShrink: 0 }} />}
              <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label || 'Tasks'}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: over ? NX.red : NX.faint, background: over ? `${NX.red}1a` : 'transparent', borderRadius: 4, padding: '0 4px' }}>{c.tasks.length}{limit != null ? ` / ${limit}` : ''}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
                <WipEditor colKey={c.key} limits={limits} setLimit={setLimit} />
                {boardGroup === 'status' && c.custom && (
                  <button title="Delete section" onClick={async () => {
                    const ok = await confirm({ title: `Delete "${c.label}"?`, message: "Tasks in this section keep their status but the column is removed.", danger: true, confirmLabel: 'Delete section' });
                    if (ok) { store.deleteCustomStatus(c.key); toast('Section deleted'); }
                  }} style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><Trash2 size={14} /></button>
                )}
                <button title="Add task" onClick={() => setCreateDefaults(defaultsFor(c.key))} style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><Plus size={15} /></button>
              </div>
            </div>
            {over && <div style={{ margin: '8px 10px 0', borderRadius: 8, background: `${NX.red}1a`, padding: '4px 8px', fontSize: 11, fontWeight: 600, color: NX.red }}>Over WIP limit ({c.tasks.length}/{limit})</div>}
            <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 9, maxHeight: '68vh', overflowY: 'auto' }}>
              {c.tasks.map(renderCard)}
              {c.tasks.length === 0 && <div style={{ fontSize: 12, color: NX.faint, textAlign: 'center', padding: 14 }}>Empty</div>}
            </div>
          </div>
        );
      })}

      {/* Add-section column (status grouping only) */}
      {boardGroup === 'status' && (
        <div style={{ width: 260, flexShrink: 0, borderRadius: 12, border: `1px dashed ${NX.border}`, padding: 10 }}>
          {addingSection ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input autoFocus value={sectionName} onChange={(e) => setSectionName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createSection(); if (e.key === 'Escape') { setAddingSection(false); setSectionName(''); } }}
                placeholder="Section name" style={{ ...inputStyle, padding: '7px 10px' }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={{ ...btn('primary'), padding: '6px 10px', opacity: sectionName.trim() ? 1 : 0.4 }} disabled={!sectionName.trim()} onClick={createSection}>Add</button>
                <button style={{ ...btn('ghost'), padding: '6px 10px' }} onClick={() => { setAddingSection(false); setSectionName(''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAddingSection(true)} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', color: NX.faint }}><Plus size={15} />Add section</button>
          )}
        </div>
      )}

      {createDefaults && <CreateTaskModal defaults={createDefaults} onClose={() => setCreateDefaults(null)} />}
    </div>
  );
}

function WipEditor({ colKey, limits, setLimit }) {
  return (
    <Popover width={176} align="right" trigger={(toggle) => (
      <button type="button" onClick={(e) => { e.stopPropagation(); toggle(); }} style={{ ...btn('ghost'), padding: 2, color: NX.faint }} title="Set WIP limit"><Gauge size={14} /></button>
    )}>
      {(close) => (
        <div style={{ padding: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 4 }}>WIP limit</div>
          <input type="number" min={0} autoFocus defaultValue={limits[colKey] ?? ''} placeholder="No limit"
            onKeyDown={(e) => { if (e.key === 'Enter') { setLimit(colKey, Number(e.currentTarget.value) || null); close(); } }}
            style={{ ...inputStyle, padding: '6px 8px' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <button style={{ ...btn('ghost'), padding: '4px 8px' }} onClick={() => { setLimit(colKey, null); close(); }}>Clear</button>
            <span style={{ fontSize: 10, color: NX.faint }}>Enter to save</span>
          </div>
        </div>
      )}
    </Popover>
  );
}
