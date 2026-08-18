/* eslint-disable react-hooks/refs -- the dropdown measures its trigger's DOM rect during render to clamp/flip the panel within the viewport (mobile); a safe intentional ref read the React-Compiler rule flags */
// Task Module - productivity bar: Filters, Sort, Saved views, Templates, Intake.
// Ported from the export's productivity/* (FilterSortGroupBar, SavedViewsMenu,
// TemplatePicker, IntakeFormModal) into one inline-styled component wired to the
// TasksContext store. The export's store had applyTemplate/submitIntakeForm/
// saveView helpers; here those are expressed directly via createTask/createSavedView.
import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, ArrowUpDown, Bookmark, LayoutTemplate, Inbox, Plus, Trash2, X, ListChecks, CalendarRange, LayoutGrid, ChevronRight, Search } from 'lucide-react';
import { BottomSheet } from './MobileTaskBar';
import { useTasks } from './TasksContext';
import { Modal, PersonSelect, usePeople, useIsMobile, DateField } from './components';
import { NX, FONT, btn, CONTROL_H, CONTROL_FS, CONTROL_ICON, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { emailToName, rootZoom } from '../lib/utils';

const SORT_OPTIONS = [
  { key: 'manual', label: 'Manual' }, { key: 'dueOn', label: 'Due Date' },
  { key: 'priority', label: 'Priority' }, { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status' }, { key: 'assignee', label: 'Assignee' },
];
const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

// Small popover anchored to its trigger. `sheet` = rendered inside the mobile
// filter bottom-sheet (full-width labelled trigger, menu flips up near the edge).
function Popover({ label, icon: Icon, active, width = 240, children, sheet = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const isMobile = useIsMobile();
  const showLabel = !isMobile || sheet;
  // On mobile the trigger sits near the left edge (or inside a bottom sheet), so a
  // right-anchored dropdown would spill off-screen. Position it as a fixed panel,
  // clamped to the viewport and flipped above the trigger when space below is tight.
  const menuStyle = { width, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 4100, padding: 12, maxHeight: '70vh', overflowY: 'auto' };
  if (isMobile && open && triggerRef.current) {
    // r / innerWidth are in the OUTER space, the widths and offsets written below
    // are CSS lengths in the INNER one - see rootZoom.
    const z = rootZoom();
    const r = triggerRef.current.getBoundingClientRect();
    const w = Math.min(width, (window.innerWidth - 16) / z);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w * z - 8)) / z;
    const flipUp = window.innerHeight - r.bottom < 300 * z;
    Object.assign(menuStyle, flipUp
      ? { position: 'fixed', bottom: (window.innerHeight - r.top + 6) / z, left, width: w }
      : { position: 'fixed', top: (r.bottom + 6) / z, left, width: w });
  } else {
    Object.assign(menuStyle, { position: 'absolute', top: '100%', right: 0, marginTop: 6 });
  }
  return (
    <div ref={ref} style={{ position: sheet ? 'static' : 'relative' }}>
      {/* Icon-only on phones - four labelled buttons don't fit one row (except in the sheet). */}
      <button ref={triggerRef} onClick={() => setOpen((o) => !o)} title={label} style={{ ...btn('outline'), padding: isMobile && !sheet ? 7 : '0 9px', height: sheet ? undefined : CONTROL_H, fontSize: sheet ? undefined : CONTROL_FS, gap: 5, width: sheet ? '100%' : undefined, justifyContent: sheet ? 'flex-start' : undefined, color: active ? NX.blue : NX.ink, borderColor: active || open ? NX.blue : NX.border }}>
        <Icon size={sheet ? 15 : CONTROL_ICON} />{showLabel && label}
      </button>
      {open && (
        <div style={menuStyle}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
const capWord = (s = '') => s.replace(/^\w/, (c) => c.toUpperCase());
const groupHead = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 6 };
const pill = (on, color, tint) => ({ borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none', background: on ? color : tint, color: on ? '#fff' : color });

// Chips for the currently-selected ids in a multi-select list, shown above the
// search box so picks stay visible without scrolling through the full list.
function SelectedChips({ items, onRemove }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
      {items.map((it) => (
        <span key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 999, padding: '2px 4px 2px 9px', fontSize: 11.5, fontWeight: 600, background: NX.border2, color: NX.ink }}>
          {it.label}
          <button onClick={() => onRemove(it.id)} title="Remove" style={{ display: 'flex', alignItems: 'center', border: 'none', background: 'none', cursor: 'pointer', color: NX.faint, padding: 2 }}><X size={11} /></button>
        </span>
      ))}
    </div>
  );
}

// ── Category bodies - shared by the desktop popovers and the mobile drill-in sheet ──
function FiltersBody({ filters, setFilters, people, projects, lockedProjectId, hideAssignee, statusOrder = STATUS_ORDER, statusMeta = STATUS_META, customFields = [] }) {
  const activeFilterCount = (hideAssignee ? 0 : filters.assigneeIds.length) + (filters.collaboratorIds || []).length + filters.statuses.length + filters.priorities.length + (lockedProjectId ? 0 : filters.projectIds.length)
    + Object.values(filters.customFields || {}).reduce((n, v) => n + (v?.length || 0), 0);
  // Only select fields are filterable - a bounded option list is what makes a
  // checkbox list possible at all. Text and number fields would need operators.
  // Multiselect filters the same way a select does - the value is a list, and
  // matchesFilter treats a hit on any chosen option as a match.
  const filterFields = (customFields || []).filter(
    (f) => (f.type === 'select' || f.type === 'multiselect') && (f.options || []).length);
  const cfSelected = (fid) => (filters.customFields || {})[fid] || [];
  const toggleCf = (fid, optId) => {
    const cur = cfSelected(fid);
    const next = cur.includes(optId) ? cur.filter((x) => x !== optId) : [...cur, optId];
    const all = { ...(filters.customFields || {}) };
    if (next.length) all[fid] = next; else delete all[fid];
    setFilters({ ...filters, customFields: all });
  };
  const [assigneeQuery, setAssigneeQuery] = useState('');
  const [collabQuery, setCollabQuery] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const searchInput = { ...inputStyle, padding: '6px 9px', fontSize: 12.5, marginBottom: 6 };
  const shownPeople = people.filter((u) => u.name.toLowerCase().includes(assigneeQuery.toLowerCase()));
  const shownCollabs = people.filter((u) => u.name.toLowerCase().includes(collabQuery.toLowerCase()));
  const collaboratorIds = filters.collaboratorIds || [];
  const shownProjects = projects.filter((p) => p.name.toLowerCase().includes(projectQuery.toLowerCase()));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={groupHead}>Status</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {statusOrder.map((s) => { const on = filters.statuses.includes(s); const m = statusMeta[s] || { label: s, color: NX.dim, tint: NX.border2 }; return <button key={s} onClick={() => setFilters({ ...filters, statuses: toggle(filters.statuses, s) })} style={pill(on, m.color, m.tint)}>{m.label}</button>; })}
        </div>
      </div>
      <div>
        <div style={groupHead}>Priority</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {PRIORITY_ORDER.map((p) => { const on = filters.priorities.includes(p); const m = PRIORITY_META[p]; return <button key={p} onClick={() => setFilters({ ...filters, priorities: toggle(filters.priorities, p) })} style={pill(on, m.color, m.tint)}>{m.label}</button>; })}
        </div>
      </div>
      {!hideAssignee && (
        <div>
          <div style={groupHead}>Assignee</div>
          <SelectedChips
            items={filters.assigneeIds.map((id) => ({ id, label: people.find((u) => u.email === id)?.name || emailToName(id) }))}
            onRemove={(id) => setFilters({ ...filters, assigneeIds: toggle(filters.assigneeIds, id) })}
          />
          <input value={assigneeQuery} onChange={(e) => setAssigneeQuery(e.target.value)} placeholder="Search people…" style={searchInput} />
          <div style={{ maxHeight: 108, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8 }}>
            {shownPeople.map((u) => (
              <label key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={filters.assigneeIds.includes(u.email)} onChange={() => setFilters({ ...filters, assigneeIds: toggle(filters.assigneeIds, u.email) })} />
                {u.name}
              </label>
            ))}
            {shownPeople.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{people.length === 0 ? 'No people' : 'No matches'}</div>}
          </div>
        </div>
      )}
      {/* Collaborator = follower list. Shown on My Tasks too (where Assignee is
          hidden because it is always you): "what am I copied on with X" is a
          real question there. */}
      <div>
        <div style={groupHead}>Collaborator</div>
        <SelectedChips
          items={collaboratorIds.map((id) => ({ id, label: people.find((u) => u.email === id)?.name || emailToName(id) }))}
          onRemove={(id) => setFilters({ ...filters, collaboratorIds: toggle(collaboratorIds, id) })}
        />
        <input value={collabQuery} onChange={(e) => setCollabQuery(e.target.value)} placeholder="Search people…" style={searchInput} />
        <div style={{ maxHeight: 108, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8 }}>
          {shownCollabs.map((u) => (
            <label key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={collaboratorIds.includes(u.email)} onChange={() => setFilters({ ...filters, collaboratorIds: toggle(collaboratorIds, u.email) })} />
              {u.name}
            </label>
          ))}
          {shownCollabs.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{people.length === 0 ? 'No people' : 'No matches'}</div>}
        </div>
      </div>
      {!lockedProjectId && (
        <div>
          <div style={groupHead}>Project</div>
          <SelectedChips
            items={filters.projectIds.map((id) => ({ id, label: projects.find((p) => p.id === id)?.name || id }))}
            onRemove={(id) => setFilters({ ...filters, projectIds: toggle(filters.projectIds, id) })}
          />
          <input value={projectQuery} onChange={(e) => setProjectQuery(e.target.value)} placeholder="Search projects…" style={searchInput} />
          <div style={{ maxHeight: 108, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8 }}>
            {shownProjects.map((p) => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={filters.projectIds.includes(p.id)} onChange={() => setFilters({ ...filters, projectIds: toggle(filters.projectIds, p.id) })} />
                {p.name}
              </label>
            ))}
            {shownProjects.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{projects.length === 0 ? 'No projects' : 'No matches'}</div>}
          </div>
        </div>
      )}
      <p style={{ margin: 0, fontSize: 11, color: NX.faint }}>Applies to this tab. Switching to Board, Calendar or any other tab clears these filters.</p>
      {filterFields.map((f) => (
        <div key={f.id}>
          <div style={groupHead}>{f.name}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(f.options || []).map((o) => {
              const opt = typeof o === 'string' ? { id: o, label: o, color: '' } : o;
              const on = cfSelected(f.id).includes(opt.id);
              return (
                <label key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={() => toggleCf(f.id, opt.id)} style={{ cursor: 'pointer' }} />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {opt.color && <span style={{ width: 9, height: 9, borderRadius: 3, background: opt.color, flexShrink: 0 }} />}
                    {opt.label}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}

      {activeFilterCount > 0 && (
        <button onClick={() => setFilters({ ...filters, assigneeIds: [], collaboratorIds: [], statuses: [], priorities: [], projectIds: [], customFields: {} })} style={{ ...btn('outline'), justifyContent: 'center' }}>Clear Filters</button>
      )}
    </div>
  );
}

function DateBody({ filters, setFilters }) {
  const dateActive = (filters.due && filters.due !== 'any') || filters.dueFrom || filters.dueTo;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={groupHead}>Due</div>
        <select value={filters.due || 'any'} onChange={(e) => setFilters({ ...filters, due: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }}>
          <option value="any">Any time</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="week">Due this week</option>
          <option value="none">No due date</option>
        </select>
      </div>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={groupHead}>Custom Range</span>
          {(filters.dueFrom || filters.dueTo) && (
            <button onClick={() => setFilters({ ...filters, dueFrom: null, dueTo: null })} style={{ ...btn('ghost'), padding: '2px 6px', fontSize: 11, color: NX.blue }}>Clear</button>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 10, color: NX.faint, marginBottom: 3 }}>From</span>
            <DateField value={filters.dueFrom || ''} onChange={(v) => setFilters({ ...filters, dueFrom: v })} style={{ ...inputStyle, padding: '6px 8px', fontSize: 12 }} />
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 10, color: NX.faint, marginBottom: 3 }}>To</span>
            <DateField value={filters.dueTo || ''} onChange={(v) => setFilters({ ...filters, dueTo: v })} style={{ ...inputStyle, padding: '6px 8px', fontSize: 12 }} />
          </label>
        </div>
        {filters.dueFrom && filters.dueTo && filters.dueFrom > filters.dueTo && (
          <p style={{ margin: '6px 0 0', fontSize: 11, color: NX.red }}>"From" is after "To".</p>
        )}
      </div>
      {dateActive && (
        <button onClick={() => setFilters({ ...filters, due: 'any', dueFrom: null, dueTo: null })} style={{ ...btn('outline'), justifyContent: 'center' }}>Clear Date Filter</button>
      )}
    </div>
  );
}

function SortBody({ sort, setSort, close, sortFieldOptions = [] }) {
  // Custom fields sit after the built-ins so the familiar list doesn't shift
  // around as fields are added.
  const opts = [...SORT_OPTIONS, ...sortFieldOptions];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {opts.map((o) => (
        <button key={o.key} onClick={() => { setSort({ ...sort, key: o.key }); close(); }} style={{ ...btn('ghost'), justifyContent: 'flex-start', color: sort.key === o.key ? NX.blue : NX.ink, background: sort.key === o.key ? NX.hover : 'transparent' }}>{o.label}</button>
      ))}
      <div style={{ borderTop: `1px solid ${NX.border2}`, margin: '4px 0' }} />
      <button onClick={() => setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })} style={{ ...btn('ghost'), justifyContent: 'flex-start' }}>Direction: {sort.dir === 'asc' ? 'Ascending' : 'Descending'}</button>
    </div>
  );
}

function GroupBody({ group, setGroup, groupOptions, close }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {groupOptions.map((o) => (
        <button key={o.key} onClick={() => { setGroup(o.key); close(); }} style={{ ...btn('ghost'), justifyContent: 'flex-start', color: group === o.key ? NX.blue : NX.ink, background: group === o.key ? NX.hover : 'transparent' }}>{o.label}</button>
      ))}
    </div>
  );
}

export function ProductivityBar({ filters, setFilters, sort, setSort, lockedProjectId, hideAssignee, current, onApplyView, onOpenTask, group, setGroup, groupOptions, customFields = [], sortFieldOptions = [], sheet = false }) {
  const store = useTasks();
  const { savedViews, createSavedView, deleteSavedView, templates, intakeForms, projects, projectName, createTask, myEmail } = store;
  const people = usePeople();
  const isMobile = useIsMobile();

  const activeFilterCount = (hideAssignee ? 0 : filters.assigneeIds.length) + (filters.collaboratorIds || []).length + filters.statuses.length + filters.priorities.length
    + (lockedProjectId ? 0 : filters.projectIds.length);
  const dateActive = (filters.due && filters.due !== 'any') || filters.dueFrom || filters.dueTo;

  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: sheet ? 'column' : 'row', alignItems: sheet ? 'stretch' : 'center', gap: sheet ? 6 : (isMobile ? 6 : 8), flexWrap: (sheet || !isMobile) ? 'wrap' : 'nowrap', fontFamily: FONT }}>
      {/* Filters */}
      <Popover sheet={sheet} label={activeFilterCount ? `Filters · ${activeFilterCount}` : 'Filters'} icon={SlidersHorizontal} active={activeFilterCount > 0} width={260}>
        {() => <FiltersBody filters={filters} setFilters={setFilters} people={people} projects={projects} lockedProjectId={lockedProjectId} hideAssignee={hideAssignee} statusOrder={store.statusOrderFor ? store.statusOrderFor(lockedProjectId) : store.statusOrder} statusMeta={store.statusMeta} customFields={customFields} />}
      </Popover>

      {/* Date - separate from Filters, matching the export's dedicated Date button */}
      <Popover sheet={sheet} label="Date" icon={CalendarRange} active={dateActive} width={240}>
        {() => <DateBody filters={filters} setFilters={setFilters} />}
      </Popover>

      {/* Sort */}
      <Popover sheet={sheet} label="Sort" icon={ArrowUpDown} width={190}>
        {(close) => <SortBody sort={sort} setSort={setSort} close={close} sortFieldOptions={sortFieldOptions} />}
      </Popover>

      {/* Group - optional; rendered between Sort and Saved views to match the export */}
      {groupOptions && setGroup && (
        <Popover sheet={sheet} label="Group" icon={LayoutGrid} width={190}>
          {(close) => <GroupBody group={group} setGroup={setGroup} groupOptions={groupOptions} close={close} />}
        </Popover>
      )}

      {/* Saved views */}
      <Popover sheet={sheet} label="Saved Views" icon={Bookmark} width={260}>
        {(close) => <SavedViews {...{ savedViews, createSavedView, deleteSavedView, current, filters, sort, onApplyView, close }} />}
      </Popover>

      {templates.length > 0 && (
        <button onClick={() => setTemplatesOpen(true)} title="Templates" style={{ ...btn('outline'), padding: isMobile && !sheet ? 7 : '0 9px', height: sheet ? undefined : CONTROL_H, fontSize: sheet ? undefined : CONTROL_FS, gap: 5, width: sheet ? '100%' : undefined, justifyContent: sheet ? 'flex-start' : undefined }}><LayoutTemplate size={CONTROL_ICON} />{(!isMobile || sheet) && 'Templates'}</button>
      )}
      {intakeForms.length > 0 && (
        <button onClick={() => setIntakeOpen(true)} title="Intake" style={{ ...btn('outline'), padding: isMobile && !sheet ? 7 : '0 9px', height: sheet ? undefined : CONTROL_H, fontSize: sheet ? undefined : CONTROL_FS, gap: 5, width: sheet ? '100%' : undefined, justifyContent: sheet ? 'flex-start' : undefined }}><Inbox size={CONTROL_ICON} />{(!isMobile || sheet) && 'Intake'}</button>
      )}

      {templatesOpen && <TemplatesModal templates={templates} createTask={createTask} onOpenTask={onOpenTask} onClose={() => setTemplatesOpen(false)} />}
      {intakeOpen && <IntakeModal forms={intakeForms} projectName={projectName} createTask={createTask} myEmail={myEmail} onOpenTask={onOpenTask} onClose={() => setIntakeOpen(false)} />}
    </div>
  );
}

// Asana-style mobile filter sheet: a category list that drills into a full panel
// (Filters / Date / Sort / Group / Saved Views) with a back arrow - no popovers.
// `columnControls` - the List view's Hide / + Column pair. On desktop they sit
// in the toolbar; there is no toolbar on mobile, so they ride along at the
// bottom of this sheet rather than being unreachable on a phone.
export function MobileFilters({ filters, setFilters, sort, setSort, group, setGroup, groupOptions, current, onApplyView, search, setSearch, lockedProjectId, hideAssignee, columnControls, customFields = [], sortFieldOptions = [], onClose }) {
  const store = useTasks();
  const { savedViews, createSavedView, deleteSavedView, projects } = store;
  const people = usePeople();
  const [cat, setCat] = useState(null);

  const activeFilterCount = (hideAssignee ? 0 : filters.assigneeIds.length) + (filters.collaboratorIds || []).length + filters.statuses.length + filters.priorities.length + (lockedProjectId ? 0 : filters.projectIds.length)
    + Object.values(filters.customFields || {}).reduce((n, v) => n + (v?.length || 0), 0);
  const dateActive = (filters.due && filters.due !== 'any') || filters.dueFrom || filters.dueTo;
  const hasGroup = groupOptions && setGroup;

  const cats = [
    { key: 'filters', label: 'Filters', icon: SlidersHorizontal, badge: activeFilterCount || null },
    { key: 'date', label: 'Date', icon: CalendarRange, badge: dateActive ? '•' : null },
    { key: 'sort', label: 'Sort', icon: ArrowUpDown },
    ...(hasGroup ? [{ key: 'group', label: 'Group', icon: LayoutGrid }] : []),
    { key: 'saved', label: 'Saved Views', icon: Bookmark },
  ];

  if (!cat) {
    return (
      <BottomSheet title="Filter & Sort" onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {setSearch && (
            <div style={{ position: 'relative', marginBottom: 10 }}>
              <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
              <input value={search || ''} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks…" style={{ ...inputStyle, paddingLeft: 32, width: '100%' }} />
            </div>
          )}
          {cats.map((c) => (
            <button key={c.key} onClick={() => setCat(c.key)} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '14px 6px', border: 'none', borderBottom: `1px solid ${NX.border2}`, background: 'transparent', cursor: 'pointer', fontSize: 15, fontWeight: 600, color: NX.ink, fontFamily: FONT, textAlign: 'left' }}>
              <c.icon size={18} style={{ color: NX.dim }} />
              <span style={{ flex: 1 }}>{c.label}</span>
              {c.badge != null && <span style={{ fontSize: 12, fontWeight: 700, color: NX.blue }}>{c.badge}</span>}
              <ChevronRight size={18} style={{ color: NX.faint }} />
            </button>
          ))}
          {columnControls && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 6px 2px' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: NX.dim, flex: 1 }}>Columns</span>
              {columnControls}
            </div>
          )}
        </div>
      </BottomSheet>
    );
  }

  const catLabel = { filters: 'Filters', date: 'Date', sort: 'Sort', group: 'Group', saved: 'Saved Views' }[cat];
  return (
    <BottomSheet title={catLabel} onClose={onClose} onBack={() => setCat(null)}>
      {cat === 'filters' && <FiltersBody filters={filters} setFilters={setFilters} people={people} projects={projects} lockedProjectId={lockedProjectId} hideAssignee={hideAssignee} statusOrder={store.statusOrderFor ? store.statusOrderFor(lockedProjectId) : store.statusOrder} statusMeta={store.statusMeta} customFields={customFields} />}
      {cat === 'date' && <DateBody filters={filters} setFilters={setFilters} />}
      {cat === 'sort' && <SortBody sort={sort} setSort={setSort} close={() => {}} sortFieldOptions={sortFieldOptions} />}
      {cat === 'group' && <GroupBody group={group} setGroup={setGroup} groupOptions={groupOptions} close={() => {}} />}
      {cat === 'saved' && <SavedViews {...{ savedViews, createSavedView, deleteSavedView, current, filters, sort, onApplyView, close: onClose }} />}
    </BottomSheet>
  );
}

function SavedViews({ savedViews, createSavedView, deleteSavedView, current, filters, sort, onApplyView, close }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const save = async () => {
    const n = name.trim(); if (!n) return;
    await createSavedView({ name: n, view: current.view, group: current.group, filters, sort }).catch(() => {});
    setName(''); setNaming(false); close();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {savedViews.length === 0 && <div style={{ fontSize: 12, color: NX.faint, padding: '4px 6px' }}>No saved views yet.</div>}
      {savedViews.map((v) => (
        <div key={v.id} style={{ display: 'flex', alignItems: 'center' }}>
          <button onClick={() => { onApplyView(v); close(); }} style={{ ...btn('ghost'), justifyContent: 'flex-start', flex: 1 }}>{v.name}</button>
          <button onClick={() => { if (confirm(`Delete view "${v.name}"?`)) deleteSavedView(v.id); }} title="Delete View" style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><Trash2 size={13} /></button>
        </div>
      ))}
      <div style={{ borderTop: `1px solid ${NX.border2}`, margin: '4px 0' }} />
      {naming ? (
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} placeholder="View name…" style={{ ...inputStyle, fontSize: 13 }} />
      ) : (
        <button onClick={() => setNaming(true)} style={{ ...btn('ghost'), justifyContent: 'flex-start' }}><Plus size={15} />Save Current View</button>
      )}
    </div>
  );
}

function TemplatesModal({ templates, createTask, onOpenTask, onClose }) {
  const [busy, setBusy] = useState(false);
  const apply = async (tpl) => {
    if (busy) return; setBusy(true);
    try {
      const patch = tpl.patch || {};
      const parent = await createTask({ title: tpl.name, type: 'task', status: 'not_started', priority: patch.priority || 'medium', ...patch });
      for (const st of (tpl.subtaskTitles || [])) {
        await createTask({ title: st, parentTaskId: parent.id, status: 'not_started', priority: 'medium', type: 'task' }).catch(() => {});
      }
      onClose(); onOpenTask?.(parent.id);
    } catch { /* store refetch surfaces errors */ } finally { setBusy(false); }
  };
  return (
    <Modal title="Task Templates" onClose={onClose} width={560}>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: NX.dim }}>Start from a standardized checklist. Applying a template creates a parent task with its subtasks pre-filled.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {templates.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, border: `1px solid ${NX.border}`, borderRadius: 12, padding: 14 }}>
            <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: NX.hover, color: NX.purple }}><LayoutTemplate size={18} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: NX.ink }}>{t.name}</div>
              {t.description && <div style={{ fontSize: 12, color: NX.dim }}>{t.description}</div>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {(t.subtaskTitles || []).map((s) => <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: NX.surface2, borderRadius: 6, padding: '2px 6px', fontSize: 11, color: NX.dim }}><ListChecks size={10} />{s}</span>)}
              </div>
            </div>
            <button onClick={() => apply(t)} disabled={busy} style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }}>Use</button>
          </div>
        ))}
        {templates.length === 0 && <div style={{ fontSize: 13, color: NX.faint }}>No templates defined yet.</div>}
      </div>
    </Modal>
  );
}

function IntakeModal({ forms, projectName, createTask, myEmail, onOpenTask, onClose }) {
  const form = forms[0];
  const [summary, setSummary] = useState('');
  const [priority, setPriority] = useState('medium');
  const [neededBy, setNeededBy] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = !!(summary.trim() || neededBy || priority !== 'medium');
  if (!form) return null;
  const submit = async () => {
    if (!summary.trim() || busy) return; setBusy(true);
    try {
      const t = await createTask({ title: summary.trim(), priority, projectId: form.targetProjectId || '', dueOn: neededBy || '', status: 'not_started', type: 'task', assigneeId: '' });
      onClose(); onOpenTask?.(t.id);
    } catch { /* surfaced by refetch */ } finally { setBusy(false); }
  };
  return (
    <Modal title={form.title || 'Submit a request'} onClose={onClose}
      isDirty={dirty} onSave={summary.trim() ? submit : undefined}
      footer={<>
        <button onClick={onClose} style={btn('outline')}>Cancel</button>
        <button onClick={submit} disabled={!summary.trim() || busy} style={{ ...btn('primary'), opacity: !summary.trim() || busy ? 0.6 : 1 }}>Submit Request</button>
      </>}>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: NX.dim }}>Submit a structured request. On submit, a task is created{form.targetProjectId ? ` in ${projectName(form.targetProjectId)}` : ''}.</p>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>Summary</label>
        <input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Describe your request" style={inputStyle} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>Needed By</label>
          <DateField value={neededBy} onChange={(v) => setNeededBy(v || '')} placeholder="Pick a date" style={inputStyle} />
        </div>
      </div>
    </Modal>
  );
}
