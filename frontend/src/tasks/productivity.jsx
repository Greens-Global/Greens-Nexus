/* eslint-disable react-hooks/refs -- the dropdown measures its trigger's DOM rect during render to clamp/flip the panel within the viewport (mobile); a safe intentional ref read the React-Compiler rule flags */
// Task Module - productivity bar: Filters, Sort, Saved views, Templates, Intake.
// Ported from the export's productivity/* (FilterSortGroupBar, SavedViewsMenu,
// TemplatePicker, IntakeFormModal) into one inline-styled component wired to the
// TasksContext store. The export's store had applyTemplate/submitIntakeForm/
// saveView helpers; here those are expressed directly via createTask/createSavedView.
import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, ArrowUpDown, Bookmark, LayoutTemplate, Inbox, Plus, Trash2, X, ListChecks, CalendarRange, LayoutGrid, ChevronRight, Search, Palette } from 'lucide-react';
import { BottomSheet } from './MobileTaskBar';
import { useTasks } from './TasksContext';
import { Modal, PersonSelect, usePeople, useIsMobile, DateField } from './components';
import { NX, FONT, btn, CONTROL_H, CONTROL_FS, CONTROL_ICON, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { emailToName, rootZoom } from '../lib/utils';
import { matchPeople } from '../lib/peopleSearch';
import { useListNav } from '../lib/listNav';
import { requiredFieldsFor, isBlankValue } from './lib';
import { recurrenceLabel } from './recurrence';
import { CustomFieldInput } from './TaskDetailDrawer';

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
// Selected = a deep shade of the color (Oct 14 2026: Low/Medium priority are
// light slates now, too pale for white text on the raw color).
const pill = (on, color, tint) => ({ borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none', background: on ? `color-mix(in srgb, ${color} 75%, #000)` : tint, color: on ? '#fff' : `color-mix(in srgb, ${color} 72%, #000)` });

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
function FiltersBody({ filters, setFilters, people, projects, teams = [], lockedProjectId, hideAssignee, statusOrder = STATUS_ORDER, statusMeta = STATUS_META, customFields = [] }) {
  const activeFilterCount = (hideAssignee ? 0 : filters.assigneeIds.length) + (filters.collaboratorIds || []).length + filters.statuses.length + filters.priorities.length + (filters.fromTicket ? 1 : 0) + (lockedProjectId ? 0 : filters.projectIds.length)
    + (filters.teamIds || []).length
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
  const shownPeople = matchPeople(people, assigneeQuery);
  const shownCollabs = matchPeople(people, collabQuery);
  const collaboratorIds = filters.collaboratorIds || [];
  const shownProjects = projects.filter((p) => p.name.toLowerCase().includes(projectQuery.toLowerCase()));
  // Up / Down / Enter in each search box (lib/listNav.js). These lists are
  // always on screen, so the highlight shows only while something is typed.
  const peopleNav = useListNav(shownPeople, { open: !!assigneeQuery.trim(), query: assigneeQuery,
    onPick: (u) => setFilters({ ...filters, assigneeIds: toggle(filters.assigneeIds, u.email) }) });
  const collabNav = useListNav(shownCollabs, { open: !!collabQuery.trim(), query: collabQuery,
    onPick: (u) => setFilters({ ...filters, collaboratorIds: toggle(collaboratorIds, u.email) }) });
  const projectNav = useListNav(shownProjects, { open: !!projectQuery.trim(), query: projectQuery,
    onPick: (p) => setFilters({ ...filters, projectIds: toggle(filters.projectIds, p.id) }) });
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
      {/* Where the task came from (Oct 14 2026): the work raised by tickets. */}
      <div>
        <div style={groupHead}>Source</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          <button onClick={() => setFilters({ ...filters, fromTicket: !filters.fromTicket })} aria-pressed={!!filters.fromTicket}
            style={pill(!!filters.fromTicket, NX.primary, `${NX.primary}1a`)}>From Ticket</button>
        </div>
      </div>
      {!hideAssignee && (
        <div>
          <div style={groupHead}>Assignee</div>
          <SelectedChips
            items={filters.assigneeIds.map((id) => ({ id, label: people.find((u) => u.email === id)?.name || emailToName(id) }))}
            onRemove={(id) => setFilters({ ...filters, assigneeIds: toggle(filters.assigneeIds, id) })}
          />
          <input value={assigneeQuery} onChange={(e) => setAssigneeQuery(e.target.value)} placeholder="Search people…"
            {...peopleNav.inputProps} onKeyDown={peopleNav.onKeyDown}
            style={searchInput} />
          <div style={{ maxHeight: 108, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8 }}>
            {shownPeople.map((u, i) => (
              <label key={u.email} {...peopleNav.optionProps(i)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', fontSize: 13, cursor: 'pointer' }}>
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
        <input value={collabQuery} onChange={(e) => setCollabQuery(e.target.value)} placeholder="Search people…"
          {...collabNav.inputProps} onKeyDown={collabNav.onKeyDown}
          style={searchInput} />
        <div style={{ maxHeight: 108, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8 }}>
          {shownCollabs.map((u, i) => (
            <label key={u.email} {...collabNav.optionProps(i)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', fontSize: 13, cursor: 'pointer' }}>
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
          <input value={projectQuery} onChange={(e) => setProjectQuery(e.target.value)} placeholder="Search projects…"
            {...projectNav.inputProps} onKeyDown={projectNav.onKeyDown} style={searchInput} />
          <div style={{ maxHeight: 108, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8 }}>
            {shownProjects.map((p, i) => (
              <label key={p.id} {...projectNav.optionProps(i)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={filters.projectIds.includes(p.id)} onChange={() => setFilters({ ...filters, projectIds: toggle(filters.projectIds, p.id) })} />
                {p.name}
              </label>
            ))}
            {shownProjects.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{projects.length === 0 ? 'No projects' : 'No matches'}</div>}
          </div>
        </div>
      )}
      {/* Team. matchesFilter has always honored filters.teamIds - there was
          simply no control that set it, so the Team column could be read but
          never filtered on. */}
      {teams.length > 0 && (
        <div>
          <div style={groupHead}>Team</div>
          <SelectedChips
            items={(filters.teamIds || []).map((id) => ({ id, label: teams.find((t) => t.id === id)?.name || id }))}
            onRemove={(id) => setFilters({ ...filters, teamIds: toggle(filters.teamIds || [], id) })}
          />
          <div style={{ maxHeight: 108, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8 }}>
            {teams.map((t) => (
              <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={(filters.teamIds || []).includes(t.id)}
                  onChange={() => setFilters({ ...filters, teamIds: toggle(filters.teamIds || [], t.id) })} />
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: t.color || NX.purple, flexShrink: 0 }} />
                {t.name}
              </label>
            ))}
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
        <button onClick={() => setFilters({ ...filters, assigneeIds: [], collaboratorIds: [], statuses: [], priorities: [], projectIds: [], teamIds: [], customFields: {}, fromTicket: false })} style={{ ...btn('outline'), justifyContent: 'center' }}>Clear Filters</button>
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
  const { savedViews, createSavedView, deleteSavedView, templates, intakeForms, projects, projectName, createTask, myEmail, teams } = store;
  const people = usePeople();
  const isMobile = useIsMobile();

  const activeFilterCount = (hideAssignee ? 0 : filters.assigneeIds.length) + (filters.collaboratorIds || []).length + filters.statuses.length + filters.priorities.length + (filters.fromTicket ? 1 : 0)
    + (lockedProjectId ? 0 : filters.projectIds.length) + (filters.teamIds || []).length;
  const dateActive = (filters.due && filters.due !== 'any') || filters.dueFrom || filters.dueTo;

  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: sheet ? 'column' : 'row', alignItems: sheet ? 'stretch' : 'center', gap: sheet ? 6 : (isMobile ? 6 : 8), flexWrap: (sheet || !isMobile) ? 'wrap' : 'nowrap', fontFamily: FONT }}>
      {/* Filters */}
      <Popover sheet={sheet} label={activeFilterCount ? `Filters · ${activeFilterCount}` : 'Filters'} icon={SlidersHorizontal} active={activeFilterCount > 0} width={260}>
        {() => <FiltersBody teams={teams} filters={filters} setFilters={setFilters} people={people} projects={projects} lockedProjectId={lockedProjectId} hideAssignee={hideAssignee} statusOrder={store.statusOrderFor ? store.statusOrderFor(lockedProjectId) : store.statusOrder} statusMeta={store.statusMeta} customFields={customFields} />}
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

      {templatesOpen && <TemplatesModal templates={templates} onOpenTask={onOpenTask} onClose={() => setTemplatesOpen(false)} />}
      {intakeOpen && <IntakeModal forms={intakeForms} projectName={projectName} createTask={createTask} myEmail={myEmail} onOpenTask={onOpenTask} onClose={() => setIntakeOpen(false)} />}
    </div>
  );
}

// Asana-style mobile filter sheet: a category list that drills into a full panel
// (Filters / Date / Sort / Group / Saved Views) with a back arrow - no popovers.
// `columnControls` - the List view's Hide / + Column pair. On desktop they sit
// in the toolbar; there is no toolbar on mobile, so they ride along at the
// bottom of this sheet rather than being unreachable on a phone.
export function MobileFilters({ filters, setFilters, sort, setSort, group, setGroup, groupOptions, current, onApplyView, search, setSearch, lockedProjectId, hideAssignee, columnControls, rowColors = null, customFields = [], sortFieldOptions = [], onClose }) {
  const store = useTasks();
  const { savedViews, createSavedView, deleteSavedView, projects, teams } = store;
  const people = usePeople();
  const [cat, setCat] = useState(null);

  const activeFilterCount = (hideAssignee ? 0 : filters.assigneeIds.length) + (filters.collaboratorIds || []).length + filters.statuses.length + filters.priorities.length + (filters.fromTicket ? 1 : 0) + (lockedProjectId ? 0 : filters.projectIds.length)
    + (filters.teamIds || []).length
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
          {/* Row Colors (Oct 22 2026): the project's color rules editor, for
              its editors - the desktop button lives in the project header,
              which a phone does not show. */}
          {rowColors && (
            <button onClick={() => { onClose?.(); rowColors(); }} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '14px 6px', border: 'none', borderBottom: `1px solid ${NX.border2}`, background: 'transparent', cursor: 'pointer', fontSize: 15, fontWeight: 600, color: NX.ink, fontFamily: FONT, textAlign: 'left' }}>
              <Palette size={18} style={{ color: NX.dim }} />
              <span style={{ flex: 1 }}>Row Colors</span>
              <ChevronRight size={18} style={{ color: NX.faint }} />
            </button>
          )}
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
      {cat === 'filters' && <FiltersBody teams={teams} filters={filters} setFilters={setFilters} people={people} projects={projects} lockedProjectId={lockedProjectId} hideAssignee={hideAssignee} statusOrder={store.statusOrderFor ? store.statusOrderFor(lockedProjectId) : store.statusOrder} statusMeta={store.statusMeta} customFields={customFields} />}
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

function TemplatesModal({ templates, onOpenTask, onClose }) {
  const [using, setUsing] = useState(null);   // the template being started
  if (using) return <UseTemplateModal template={using} onBack={() => setUsing(null)} onOpenTask={onOpenTask} onClose={onClose} />;
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
            <button onClick={() => setUsing(t)} style={btn('primary')}>Use</button>
          </div>
        ))}
        {templates.length === 0 && <div style={{ fontSize: 13, color: NX.faint }}>No templates defined yet.</div>}
      </div>
    </Modal>
  );
}

/** Start a task from a template (Oct 14 2026): its name, the due date its
 *  subtasks are dated from, and the field values that make this one
 *  different (the Entity) - a changed value goes onto every subtask too.
 *  The server builds the task, subtasks and checklists in one go. */
function UseTemplateModal({ template: t, onBack, onOpenTask, onClose }) {
  const { startFromTemplate, customFields = [], projectName } = useTasks();
  const patch = t.patch || {};
  const fields = customFields.filter((f) => !f.readOnly && Object.prototype.hasOwnProperty.call(patch.customFieldValues || {}, f.id));
  const [title, setTitle] = useState(t.name);
  const [dueOn, setDueOn] = useState('');
  const [values, setValues] = useState(() => ({ ...(patch.customFieldValues || {}) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const subs = t.subtasks?.length ? t.subtasks : (t.subtaskTitles || []).map((title) => ({ title }));
  const dated = subs.some((s) => Number.isInteger(s.dueOffsetDays));
  const go = async () => {
    if (!title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const task = await startFromTemplate(t.id, { title: title.trim(), dueOn, customFieldValues: values });
      onClose(); onOpenTask?.(task.id);
    } catch (e) {
      setError(e?.message || 'Could not start the task.');
    } finally { setBusy(false); }
  };
  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <button type="button" onClick={onBack} style={btn('ghost')}>Back</button>
      <button type="button" onClick={go} disabled={busy || !title.trim()} style={{ ...btn('primary'), opacity: busy || !title.trim() ? 0.6 : 1 }}>
        {busy ? 'Creating…' : 'Create Task'}
      </button>
    </div>
  );
  const head = { fontSize: 12.5, fontWeight: 600, color: NX.dim };
  return (
    <Modal title={`Use "${t.name}"`} onClose={onClose} footer={footer} width="min(540px, 100vw)">
      <div style={{ display: 'grid', gap: 16, fontFamily: FONT, fontSize: 13 }}>
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={head}>Task Name</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} style={inputStyle} />
        </label>
        <div style={{ display: 'grid', gap: 5 }}>
          <span style={head}>Due Date</span>
          <DateField value={dueOn} onChange={(v) => setDueOn(v || '')} noPast placeholder="No due date"
            style={{ ...inputStyle, width: 'auto', padding: '7px 10px', fontSize: 13 }} />
          {dated && <span style={{ fontSize: 12, color: NX.faint }}>The subtasks are dated from this, as they were in the original.</span>}
        </div>
        {fields.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            <span style={head}>Field Values{subs.length ? ' on the Task and Its Subtasks' : ''}</span>
            {fields.map((f) => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ width: 110, color: NX.faint }}>{f.name}</span>
                <CustomFieldInput field={f} value={values[f.id]} onChange={(v) => setValues((x) => ({ ...x, [f.id]: v }))} />
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 12.5, color: NX.dim, lineHeight: 1.5 }}>
          {subs.length > 0 && <div>{subs.length} subtask{subs.length === 1 ? '' : 's'}: {subs.map((s) => s.title).join(', ')}</div>}
          {patch.recurrence?.freq && <div>Repeats: {recurrenceLabel(patch.recurrence)}</div>}
          {patch.projectId && projectName?.(patch.projectId) && <div>Project: {projectName(patch.projectId)}</div>}
        </div>
        {error && <div role="alert" style={{ fontSize: 12.5, color: NX.red }}>{error}</div>}
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
  // The target project's required custom fields (Oct 13 2026): asked for
  // here, since the server will not create the task without them.
  const { customFields } = useTasks();
  const [cfValues, setCfValues] = useState({});
  const [error, setError] = useState('');
  const reqFields = form ? requiredFieldsFor(customFields, form.targetProjectId || '') : [];
  const reqMissing = reqFields.some((f) => isBlankValue(cfValues[f.id]));
  const dirty = !!(summary.trim() || neededBy || priority !== 'medium' || Object.keys(cfValues).length);
  if (!form) return null;
  const canSubmit = !!summary.trim() && !reqMissing && !busy;
  const submit = async () => {
    if (!canSubmit) return; setBusy(true); setError('');
    try {
      const t = await createTask({ title: summary.trim(), priority, projectId: form.targetProjectId || '', dueOn: neededBy || '', status: 'not_started', type: 'task', assigneeId: '', customFieldValues: cfValues });
      onClose(); onOpenTask?.(t.id);
    } catch (e) {
      // Said here: a refused request used to close nothing and say nothing.
      setError(e?.message || 'Could not submit the request.');
    } finally { setBusy(false); }
  };
  return (
    <Modal title={form.title || 'Submit a request'} onClose={onClose}
      isDirty={dirty} onSave={canSubmit ? submit : undefined}
      footer={<>
        <button onClick={onClose} style={btn('outline')}>Cancel</button>
        <button onClick={submit} disabled={!canSubmit} style={{ ...btn('primary'), opacity: canSubmit ? 1 : 0.6 }}>Submit Request</button>
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
        {reqFields.map((f) => (
          <div key={f.id}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>{f.name} <span style={{ color: NX.red }}>*</span></label>
            <CustomFieldInput field={f} value={cfValues[f.id]} onChange={(v) => setCfValues((cur) => ({ ...cur, [f.id]: v }))} />
          </div>
        ))}
      </div>
      {error && <div role="alert" style={{ marginTop: 12, fontSize: 12.5, color: NX.red }}>{error}</div>}
    </Modal>
  );
}
