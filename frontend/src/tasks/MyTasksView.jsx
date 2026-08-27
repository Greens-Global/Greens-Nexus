// Task Module - My Tasks page (ported 1:1 from the export's MyTasksPage).
// A dedicated personal view: avatar + "My tasks" header, List/Board/Calendar/
// Dashboard/Files tabs, and a List grouped into the four due-date buckets with
// inline "Add task" rows, a "Task visibility" column, and "Add section".
import { Fragment, useMemo, useRef, useState } from 'react';
import { ChevronDown, Plus, List as ListIcon, Columns3, Calendar as CalIcon, LayoutDashboard, Paperclip, Square, CheckSquare, CheckCircle2, CornerDownRight } from 'lucide-react';
import { useTasks } from './TasksContext';
import { EMPTY_FILTER, matchesFilter, sortTasks, groupTasks, taskIdFromUrl, personScoped, rootParent, effectiveProjectId } from './lib';
import { NX, FONT, btn, CONTROL_H, CONTROL_FS, input as inputStyle } from './theme';
import { Avatar, EmptyState, useClickOutside, useIsMobile, DateField, TaskCountBadges, SearchSelect } from './components';
import { ProductivityBar, MobileFilters } from './productivity';
import MobileTaskBar from './MobileTaskBar';
import CreateTaskModal from './CreateTaskModal';
import QuickCreateTask from './QuickCreateTask';
import TaskDetailDrawer from './TaskDetailDrawer';
import { CalendarView, DashboardView } from './views/extras';
import { FilesView } from './views/more';
import BoardView from './views/board';
import { useTableColumns, TableHead, ResetColumnsButton, useTableValue, useTableSetting } from './tableCols';
import { matchPeople, onEnterPickFirst } from '../lib/peopleSearch';

const VIEW_TABS = [
  { key: 'list', label: 'List', icon: ListIcon },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'calendar', label: 'Calendar', icon: CalIcon },
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'files', label: 'Files', icon: Paperclip },
];
// Group options for the mobile filter drill-in (mirrors the desktop Group select).
const MY_GROUP_OPTIONS = [
  { key: 'date', label: 'Due Date' }, { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' },
  { key: 'project', label: 'Project' }, { key: 'assignee', label: 'Assignee' }, { key: 'none', label: 'None' },
];

// The four list columns, in grid order, with the sort key each header drives.
// Same keys the toolbar's Sort menu writes, so a header click and a Sort pick
// stay one state rather than two competing ones. Name is elastic; the rest are
// fixed until someone drags them wider.
// Stable identity: a fresh object each render would re-run consumers' memos.
// Alphabetical A-Z out of the box (Sagar, Aug 27) - a list you have never
// sorted should read in an order you can predict and scan. Cycling a header
// back past descending still returns to Manual, which is the order row
// drag-reorder works under.
const DEFAULT_SORT = { key: 'title', dir: 'asc' };
const LIST_COLS = [
  { key: 'title', label: 'Name', template: 'minmax(220px,1fr)' },
  { key: 'dueOn', label: 'Due Date', width: 118 },
  { key: 'collaborators', label: 'Collaborators', width: 132 },
  { key: 'project', label: 'Projects', width: 150 },
];

const dueColor = (iso, completed) => {
  if (!iso || completed) return NX.faint;
  const today = new Date().toISOString().slice(0, 10);
  if (iso < today) return NX.red;
  if (iso === today) return NX.amber;
  return NX.dim;
};

function CollaboratorPicker({ value = [], people, onChange, anchor }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const toggle = (email) => onChange(value.includes(email) ? value.filter((e) => e !== email) : [...value, email]);
  const filtered = q.trim() ? matchPeople(people, q)
    : people.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' }));
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} title="Add collaborators" style={{ ...btn('ghost'), padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 3 }}>
        {value.length ? (
          <>
            <div style={{ display: 'flex' }}>{value.slice(0, 3).map((em, i) => <span key={em} style={{ marginLeft: i ? -6 : 0 }}><Avatar email={em} size={20} /></span>)}</div>
            {/* Always-visible "+" so a row with collaborators still reads as
                clickable to add more, not just as a display of who's on it. */}
            <span style={{
              width: 16, height: 16, borderRadius: '50%', border: `1.5px dashed ${NX.border}`,
              color: NX.faint, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}><Plus size={10} /></span>
          </>
        ) : anchor ? <span style={{ color: NX.faint }}>{anchor}</span> : (
          <span style={{
            width: 20, height: 20, borderRadius: '50%', border: `1.5px dashed ${NX.border}`,
            color: NX.faint, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}><Plus size={12} /></span>
        )}
      </button>
      {open && (
        <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 208, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 50 }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…"
            onKeyDown={onEnterPickFirst(filtered, (u) => toggle(u.email))}
            style={{ width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '6px 8px', fontSize: 13, outline: 'none', fontFamily: FONT, background: 'transparent', color: NX.ink }} />
          <div style={{ maxHeight: 200, overflowY: 'auto', padding: 4 }}>
            {filtered.map((u) => (
              <label key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={value.includes(u.email)} onChange={() => toggle(u.email)} /> {u.name}
              </label>
            ))}
            {filtered.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{people.length === 0 ? 'No people' : 'No match'}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// Options for the project cell's picker. Archived projects are left out of
// every task picker - filing new work into an archive is the confusion
// archiving exists to avoid - and the rest are alphabetical, because database
// order is no order at all once a workspace carries ~90 of them.
function projectOptions(projects) {
  return [{ id: '', label: 'No project' },
    ...(projects || []).filter((p) => !p.archived).slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
      .map((p) => ({ id: p.id, label: p.name }))];
}

// `band` = this row sits on an odd index inside its group, so it gets the
// zebra tint. Banding is what lets the eye follow a row all the way out to the
// Collaborators/Projects columns on a wide screen.
function TaskRow({ t, people, projects, store, onOpen, band = false, cols = LIST_COLS }) {
  // A subtask's project is its parent's; the project cell then names the parent
  // (click-through) rather than offering a select that would re-home the subtask.
  const parent = t.parentTaskId ? rootParent(t, store.taskById) : null;
  const projectId = parent ? effectiveProjectId(t, store.taskById) : t.projectId;
  // Due date reads as a tinted pill (kit grammar), not bare colored text -
  // red tint overdue, amber tint today, quiet gray otherwise.
  const today = new Date().toISOString().slice(0, 10);
  const dueBg = !t.dueOn || t.completed ? 'transparent'
    : t.dueOn < today ? 'rgba(220,38,38,0.10)'
    : t.dueOn === today ? 'rgba(232,163,61,0.16)'
    : NX.surface2;
  const rowBg = band ? NX.zebra : 'transparent';
  // Cells are keyed and rendered in the header's order, not in source order -
  // once columns can be dragged, a row that renders them in a fixed sequence
  // puts every value under the wrong heading.
  const cells = {
    title: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        <button onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} style={{ ...btn('ghost'), padding: 0, flexShrink: 0, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckSquare size={17} /> : <Square size={17} />}</button>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
        {/* Same badges the Task List shows. Without them the same task looked
            emptier here than there, which is the kind of difference that reads
            as data missing rather than as a different screen. */}
        <TaskCountBadges t={t} store={store} />
      </div>
    ),
    dueOn: (
      <DateField value={t.dueOn || ''} onChange={(v) => store.updateTask(t.id, { dueOn: v })} color={dueColor(t.dueOn, t.completed)}
        title="Due Date" style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 12, background: dueBg, width: 'fit-content' }} />
    ),
    collaborators: (
      <CollaboratorPicker value={t.followerIds || []} people={people} onChange={(v) => store.updateTask(t.id, { followerIds: v })} />
    ),
    project: parent ? (
      <button onClick={(e) => { e.stopPropagation(); onOpen(parent.id); }} title={`Subtask of "${parent.title}"${projectId ? ` in ${store.projectName(projectId)}` : ''}`}
        style={{ ...btn('ghost'), padding: '2px 4px', fontSize: 12.5, color: NX.dim, minWidth: 0, maxWidth: '100%', justifyContent: 'flex-start' }}>
        <CornerDownRight size={12} style={{ flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{parent.title}{projectId ? ` · ${store.projectName(projectId)}` : ''}</span>
      </button>
    ) : (
      // The cell is an inline editor sitting inside a clickable row, so the
      // picker swallows its own clicks - opening it must not open the task.
      <div onClick={(e) => e.stopPropagation()} style={{ minWidth: 0, maxWidth: '100%' }}>
        <SearchSelect value={t.projectId || ''} placeholder="No project" searchPlaceholder="Search projects…"
          emptyText="No projects yet." options={projectOptions(projects)}
          buttonStyle={{ border: '1px solid transparent', borderRadius: 6, padding: '2px 4px', fontSize: 13, color: NX.dim, background: 'transparent', fontFamily: FONT, width: '100%', maxWidth: '100%', cursor: 'pointer', height: 'auto', fontWeight: 400 }}
          onPick={(id) => store.updateTask(t.id, { projectId: id || null })} />
      </div>
    ),
  };
  return (
    // NX.border2 (#eef0f3) is nearly invisible against the zebra band
    // (#f8fafc) they sit between - fine as a subtle rule under a row full of
    // text, but the Due Date/Collaborators columns are mostly blank, so
    // there's nothing else to read the row boundary from and the divider
    // needs to actually show up. NX.border is the same 1px line, darker.
    <div onClick={() => onOpen(t.id)} className="stack-table-row" data-task-row style={{ display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'center', gap: 8, padding: '5px 16px', boxShadow: `inset 0 -1px 0 ${NX.border}`, fontSize: 13.5, cursor: 'pointer', background: rowBg }}
      onMouseEnter={(e) => (e.currentTarget.style.background = NX.hover)} onMouseLeave={(e) => (e.currentTarget.style.background = rowBg)}>
      {cols.map((c) => <Fragment key={c.key}>{cells[c.key]}</Fragment>)}
    </div>
  );
}


export default function MyTasksView() {
  const store = useTasks();
  const { tasks, projects, myEmail, nameOf } = store;
  // View / grouping / sort ride in the user's profile with their columns -
  // coming back to a screen you have to re-set every time is the same
  // complaint as re-hiding columns every morning.
  const [view, setView] = useTableValue('mytasks', 'view', 'list');
  const [group, setGroup] = useTableValue('mytasks', 'group', 'date');
  const [filters, setFilters] = useState(EMPTY_FILTER);
  const [sort, setSort] = useTableValue('mytasks', 'sort', DEFAULT_SORT);
  const { cols: listCols, template, startResize, resetWidth, widths, wrapRef, dragProps } =
    useTableColumns({ table: 'mytasks', cols: LIST_COLS });
  // Person / Project / Collaborator sorts order by the NAME on screen, not the
  // email or uuid underneath it - these are the resolvers that do that.
  const sortCtx = useMemo(
    () => ({ nameOf, projectName: store.projectName, teamName: store.teamName }),
    [nameOf, store.projectName, store.teamName],
  );
  const [openId, setOpenId] = useState(taskIdFromUrl);
  const [creating, setCreating] = useState(null); // full CreateTaskModal defaults (desktop / "Full details")
  const [quickCreate, setQuickCreate] = useState(null); // mobile Asana-style quick-add defaults
  const isMobile = useIsMobile();
  // Mobile → lightweight quick-add sheet; desktop → the full form. Same context defaults either way.
  const openCreate = (defs) => (isMobile ? setQuickCreate(defs) : setCreating(defs));

  // People directory for collaborator pickers (excludes me - I'm the assignee).
  const people = useMemo(() => {
    const seen = new Map();
    for (const t of tasks) for (const em of (t.followerIds || [])) if (em && !seen.has(em)) seen.set(em, { email: em, name: nameOf(em) });
    for (const p of projects) for (const em of (p.memberIds || [])) if (em && !seen.has(em)) seen.set(em, { email: em, name: nameOf(em) });
    return [...seen.values()].filter((u) => u.email !== myEmail);
  }, [tasks, projects, myEmail, nameOf]);

  const filter = { ...filters, assigneeIds: myEmail ? [myEmail] : [] };
  // My Tasks is a to-do list, so finished work is hidden by default. Asking for
  // it explicitly (Filters -> Completed) has to win over that default, or the
  // filter matches nothing and reads as broken. `completed` and `status` are
  // kept in sync server-side, so the status filter alone is enough to decide.
  // Switching tabs starts clean. A filter set in List used to follow you into
  // Board, where the panel is out of sight, so the missing rows read as lost
  // data rather than a filter still doing its job. Saved Views set the view and
  // its filters together and go through onApplyView, not this.
  const switchView = (next) => { setView(next); setFilters(EMPTY_FILTER); };

  const wantsCompleted = filters.statuses.includes('completed');
  // Subtasks assigned to me are rows here, as in Asana's My Tasks - see
  // personScoped in lib.js for why the old top-level-only rule was wrong.
  const mine = useMemo(
    () => sortTasks(personScoped(tasks, filter).filter((t) => (wantsCompleted || !t.completed)
                                        && matchesFilter(t, filter, store.taskById)), sort, [], sortCtx),
    [tasks, filters, sort, myEmail, wantsCompleted, store.taskById, sortCtx],
  );
  const allMine = useMemo(() => personScoped(tasks, filter).filter((t) => matchesFilter(t, filter, store.taskById)), [tasks, filters, myEmail, store.taskById]);
  const ctx = { nameOf, projectName: store.projectName, teamName: store.teamName, taskById: store.taskById };
  // Board renders allMine (completed included); every other view renders `mine`.
  const shownCount = view === 'board' ? allMine.length : mine.length;
  const groups = useMemo(() => groupTasks(mine, group, ctx), [mine, group, nameOf, store.projectName, store.teamName, store.taskById]);
  const boardTasks = useMemo(() => sortTasks(allMine, sort, [], sortCtx), [allMine, sort, sortCtx]);

  // Collapsed group keys, persisted per person like the rest of this table's
  // settings (view/group/sort) - see richlist.jsx's identical pattern.
  const [collapsedList, setCollapsedList] = useTableSetting('mytasks', 'collapsed', []);
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);
  const toggleGroup = (k) => {
    const n = new Set(collapsed);
    n.has(k) ? n.delete(k) : n.add(k);
    setCollapsedList([...n]);
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', height: '100%', background: NX.canvas }}>
      {/* Header - white band over the gray canvas (same anatomy as the project
          workspace; the agreed world is cards on canvas, never a white page). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: isMobile ? '12px 12px 8px' : '18px 24px 12px', flexWrap: 'wrap', background: NX.surface }}>
        {/* No avatar: you already know whose tasks these are, and no chevron -
            the title never opened a menu, so a decorative dropdown affordance
            is a lie (owner flag, Jul 28) */}
        <div style={{ fontSize: isMobile ? 19 : 22, fontWeight: 700 }}>My Tasks</div>
        {/* How many tasks are actually on screen - so it tracks the filters and
            the completed-hidden default rather than reporting a total the view
            never shows. Board sorts the same rows through its own list, hence
            the two sources. */}
        <span title={`${shownCount} ${shownCount === 1 ? 'task' : 'tasks'} in this view`}
          style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: NX.dim, background: NX.surface2, border: `1px solid ${NX.border2}`, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' }}>
          {shownCount} {shownCount === 1 ? 'Task' : 'Tasks'}
        </span>
        {!isMobile && <button style={{ ...btn('primary') }} onClick={() => openCreate({ assigneeId: myEmail })}><Plus size={15} /> New Task</button>}
      </div>

      {/* Desktop: view tabs + toolbar. Mobile: replaced by the floating MobileTaskBar. */}
      {!isMobile && (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${NX.border}`, padding: '0 24px', flexWrap: 'wrap', background: NX.surface }}>
        {/* Segmented view switcher - same control as the project workspace's
            (consistency overwrite, Jul 28: no more underline tabs here) */}
        <div data-tour="task-views" className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, margin: '8px 0', overflowX: 'auto', flexShrink: 0 }}>
          {VIEW_TABS.map((tb) => (
            <button key={tb.key} onClick={() => switchView(tb.key)} title={tb.label} style={{
              ...btn('ghost'), padding: '6px 10px', borderRadius: 7, whiteSpace: 'nowrap',
              background: view === tb.key ? NX.surface : 'transparent', color: view === tb.key ? NX.ink : NX.dim,
              boxShadow: view === tb.key ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}><tb.icon size={15} /> {tb.label}</button>
          ))}
        </div>
        {view === 'list' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', overflowX: 'visible', flexWrap: 'wrap' }}>
            <ProductivityBar filters={filters} setFilters={setFilters} sort={sort} setSort={setSort} hideAssignee current={{ view, group }} onApplyView={(v) => { if (v.group) setGroup(v.group); }} onOpenTask={setOpenId} />
            <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ ...inputStyle, width: 'auto', flexShrink: 0, cursor: 'pointer', height: CONTROL_H, fontSize: CONTROL_FS, padding: '0 8px' }}>
              {['date', 'status', 'priority', 'project', 'assignee', 'none'].map((g) => <option key={g} value={g}>Group: {g === 'date' ? 'Due Date' : g === 'none' ? 'None' : g[0].toUpperCase() + g.slice(1)}</option>)}
            </select>
            <ResetColumnsButton style={{ height: CONTROL_H }} />
          </div>
        )}
      </div>
      )}

      {/* Body */}
      <div className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: view === 'list' ? 16 : 0, paddingBottom: isMobile ? 88 : 76 }}>
        {view === 'list' ? (
          <div className={isMobile ? 'nx-edge-card' : undefined} style={{ border: `1px solid ${NX.border}`, borderRadius: 12, overflow: 'hidden', background: NX.surface }}>
            {/* Fixed-width columns (Due date/Collaborators/Projects) don't shrink
                below their content size - scroll horizontally on narrow
                viewports instead of getting clipped by the card's rounded corners. */}
            <div style={{ overflowX: 'auto' }}>
              <div ref={wrapRef} style={{ minWidth: 560, '--nx-grid': template }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'var(--nx-grid)', gap: 8, padding: '6px 16px', boxShadow: `inset 0 -1px 0 ${NX.border}`, background: NX.surface2, fontSize: 12.5, fontWeight: 600, color: NX.dim }}>
                  {listCols.map((c) => (
                    <TableHead key={c.key} label={c.label} sortKey={c.key} sort={sort} setSort={setSort}
                      sortReset={{ key: 'manual', dir: 'asc' }} style={{ color: NX.dim }}
                      drag={dragProps(c.key)}
                      onResizeStart={startResize(c.key, widths[c.key] ?? c.width ?? 150)}
                      onResizeReset={() => resetWidth(c.key)} />
                  ))}
                </div>
                {groups.map((g) => {
                  const isCol = collapsed.has(g.key);
                  return (
                    /* Group header = a tinted full-width band (kit grammar) so
                       groups read at a glance against white task rows. */
                    <div key={g.key}>
                      <button onClick={() => toggleGroup(g.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 16px', border: 'none', background: NX.surface2, boxShadow: `inset 0 -1px 0 ${NX.border}`, fontSize: 13.5, fontWeight: 700, color: NX.ink, cursor: 'pointer', textAlign: 'left', fontFamily: FONT }}>
                        <ChevronDown size={14} style={{ color: NX.faint, transform: isCol ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />
                        {g.label} <span style={{ color: NX.faint, fontWeight: 600, fontSize: 12 }}>{g.tasks.length} item{g.tasks.length !== 1 ? 's' : ''}</span>
                      </button>
                      {!isCol && g.tasks.map((t, i) => <TaskRow key={t.id} t={t} people={people} projects={projects} store={store} onOpen={setOpenId} band={i % 2 === 1} cols={listCols} />)}
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Said "Add Section" and opened the Create Task modal. There are no
                sections on this screen - the groups above come from the group-by
                control - so it is what it always was: a new task assigned to me. */}
            <button onClick={() => openCreate({ assigneeId: myEmail })} style={{ ...btn('ghost'), padding: '8px 16px', color: NX.faint }}><Plus size={15} /> Add Task</button>
          </div>
        ) : view === 'calendar' ? (
          <CalendarView tasks={mine} onOpen={setOpenId} onCreate={(iso) => openCreate({ assigneeId: myEmail, dueOn: iso })} />
        ) : view === 'files' ? (
          <FilesView tasks={allMine} onOpen={setOpenId} nameOf={nameOf} />
        ) : view === 'dashboard' ? (
          <DashboardView tasks={allMine} stats={{}} store={store} scopeKey="my-tasks" />
        ) : (
          // Same board as a project's (status columns, drag-and-drop, WIP limits,
          // swimlanes, Add section). Completed tasks are included so the
          // Completed column isn't always empty.
          <BoardView visible={boardTasks} ctx={ctx} store={store} onOpen={setOpenId} defaultAssigneeId={myEmail} />
        )}
        {view === 'list' && mine.length === 0 && group !== 'date' && <EmptyState icon={CheckCircle2} title="No Tasks" hint="You're all caught up." />}
      </div>

      {isMobile && (
        <MobileTaskBar
          views={VIEW_TABS} view={view} setView={switchView}
          onCreate={() => openCreate({ assigneeId: myEmail })}
          filterSheet={(onClose) => (
            <MobileFilters
              filters={filters} setFilters={setFilters} sort={sort} setSort={setSort}
              group={group} setGroup={setGroup} groupOptions={MY_GROUP_OPTIONS} hideAssignee
              current={{ view, group }} onApplyView={(v) => { if (v.group) setGroup(v.group); }}
              onClose={onClose}
            />
          )}
        />
      )}

      {quickCreate && <QuickCreateTask defaults={quickCreate} onClose={() => setQuickCreate(null)} onFullDetails={(d) => { setQuickCreate(null); setCreating({ ...quickCreate, ...d }); }} />}
      {creating && <CreateTaskModal defaults={creating} onClose={() => setCreating(null)} />}
      {openId && <TaskDetailDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
