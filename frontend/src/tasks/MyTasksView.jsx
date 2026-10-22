// Task Module - Tasks page, the person's own list (ported 1:1 from the
// export's MyTasksPage; the tab read "My Tasks" until Oct 13 2026).
// A dedicated personal view: "Tasks" header, List/Board/Calendar/
// Dashboard/Files tabs, and a List grouped into the four due-date buckets with
// inline "Add task" rows, a "Task visibility" column, and "Add section".
import { Fragment, useMemo, useRef, useState } from 'react';
import { ChevronDown, Plus, List as ListIcon, Columns3, Calendar as CalIcon, LayoutDashboard, Paperclip, Circle, CheckCircle2, XCircle, CornerDownRight, Check, Minus, Clock, Palette } from 'lucide-react';
import { useTasks } from './TasksContext';
import { EMPTY_FILTER, matchesFilter, sortTasks, groupTasks, taskIdFromUrl, personScoped, rootParent, effectiveProjectId, taskExportRows, taskAssignees, fmtDate, todayISO, fieldsForProject } from './lib';
import { NX, FONT, btn, CONTROL_H, CONTROL_FS, PRIORITY_META, input as inputStyle, isMissed, MISSED_TITLE } from './theme';
import { Avatar, EmptyState, useIsMobile, DateField, TaskCountBadges, SearchSelect, ExportMenu, usePeople } from './components';
import { ProductivityBar, MobileFilters } from './productivity';
import MobileTaskBar from './MobileTaskBar';
import CreateTaskModal from './CreateTaskModal';
import QuickCreateTask from './QuickCreateTask';
import TaskDetailDrawer from './TaskDetailDrawer';
import { CalendarView, DashboardView } from './views/extras';
import { FilesView } from './views/more';
import TimeSheetView from './TimeSheetView';
import BoardView from './views/board';
import { useTableColumns, TableHead, ResetColumnsButton, useTableValue, useTableSetting } from './tableCols';
import { matchPeople } from '../lib/peopleSearch';
import { useListNav } from '../lib/listNav';
import { selectionAfterClick } from './rowSelection';
import BulkActionBar from './BulkActionBar';
import { useCustomSections } from './customSections';
import { AddSectionButton, SectionMenu } from './SectionControls';
import TeamPicks, { pickableTeams, firstTeamPick, toggleRoster } from './teamPicks';
import DueBadge from './DueBadge';
import AnchoredMenu from '../components/AnchoredMenu';
import ChangeFlash from '../components/ChangeFlash';
import { changedRecently } from './recentChanges';
import { RowColorsProvider, useRowColorScope, useRuleContext, useMyColorRules, useRowColor, rowColorAttrs, boldTitleStyle, srOnly, onTint } from './rowColorState';
import { RowColorLegend } from './RowColors';
import ColorRulesEditor from './ColorRulesEditor';

const VIEW_TABS = [
  { key: 'list', label: 'List', icon: ListIcon },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'calendar', label: 'Calendar', icon: CalIcon },
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'files', label: 'Files', icon: Paperclip },
  // My time entries, a week at a time (Oct 2026) - effort on tasks, not punches.
  { key: 'time', label: 'Time', icon: Clock },
  // The Recycle Bin lived here for a day and moved to Home (Neil, Sept 9):
  // it is not a way of looking at MY TASKS, it is a module-wide place where
  // deleted things wait, and it will grow to cover projects, portfolios and
  // teams - none of which belong under a personal task list.
];
// Export columns. A function of the store rather than a constant because the
// labels come from it (custom statuses, people names) - and identical in shape
// to the project workspace's, so the two files open the same way.
const MY_TASK_EXPORT_COLS = (store, nameOf) => [
  { header: 'Task', width: 30, get: (r) => `${'    '.repeat(r.depth)}${r.task.title}` },
  { header: 'Parent Task', width: 22, get: (r) => r.parent?.title || '' },
  { header: 'Status', width: 12, get: (r) => store.statusMeta?.[r.task.status]?.label || r.task.status || '' },
  { header: 'Priority', width: 10, get: (r) => PRIORITY_META[r.task.priority]?.label || r.task.priority || '' },
  { header: 'Assignee', width: 20, get: (r) => taskAssignees(r.task).map((e) => nameOf(e)).join(', ') },
  { header: 'Project', width: 20, get: (r) => (r.task.projectId ? (store.projectName(r.task.projectId) || '') : '') },
  { header: 'Team', width: 14, get: (r) => (r.task.teamId ? (store.teamName(r.task.teamId) || '') : '') },
  { header: 'Start', width: 11, get: (r) => (r.task.startOn ? fmtDate(r.task.startOn) : '') },
  { header: 'Due', width: 11, get: (r) => (r.task.dueOn ? fmtDate(r.task.dueOn) : '') },
  { header: 'Estimate (h)', width: 11, get: (r) => (r.task.estimateHours ?? '') },
  { header: 'Actual (h)', width: 11, get: (r) => (r.task.actualHours ?? '') },
  { header: 'Completed', width: 10, get: (r) => (r.task.completed ? 'Yes' : 'No') },
];

// Group options for the mobile filter drill-in (mirrors the desktop Group select).
const MY_GROUP_OPTIONS = [
  { key: 'date', label: 'Due Date' }, { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' },
  { key: 'project', label: 'Project' }, { key: 'assignee', label: 'Assignee' }, { key: 'section', label: 'Custom' },
  { key: 'none', label: 'None' },
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
  { key: 'project', label: 'Project', width: 150 },
];

const dueColor = (iso, completed) => {
  if (!iso || completed) return NX.faint;
  const today = todayISO();
  if (iso < today) return NX.red;
  if (iso === today) return NX.amber;
  return NX.dim;
};

function CollaboratorPicker({ value = [], people, onChange, anchor }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const { teams, createTeam } = useTasks();
  const toggle = (email) => onChange(value.includes(email) ? value.filter((e) => e !== email) : [...value, email]);
  const filtered = q.trim() ? matchPeople(people, q)
    : people.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' }));
  const teamRows = pickableTeams(teams, people, q).length;
  const pickTeam = (next, adding) => { onChange(next); if (adding) setQ(''); };
  const nav = useListNav(filtered, { open, query: q, onPick: (u) => toggle(u.email) });
  return (
    <div>
      <button ref={ref} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} title="Add Collaborators" style={{ ...btn('ghost'), padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 3 }}>
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
      {/* Portaled so the table's scroller can't clip it. React events still
          bubble through the portal, so the click guard keeps the row from
          opening the task. */}
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)} role="dialog" onClick={(e) => e.stopPropagation()}
        style={{ width: 208, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)' }}>
        <input className="nx-inline-edit" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…"
          onKeyDown={(e) => {
            const team = (e.key === 'Enter' && !filtered.length) ? firstTeamPick(teams, people, q) : null;
            if (team) { e.preventDefault(); const r = toggleRoster(value, team.roster); pickTeam(r.next, r.adding); return; }
            nav.onKeyDown(e);
          }}
          {...nav.inputProps}
          style={{ width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '6px 8px', fontSize: 13, fontFamily: FONT, color: NX.ink }} />
        <div style={{ maxHeight: 240, overflowY: 'auto', padding: 4 }}>
          {/* Whole teams first (teamPicks.jsx), then people. */}
          <TeamPicks teams={teams} people={people} selected={value} query={q} inset={8}
            onSaveTeam={({ name, memberIds }) => createTeam({ name, memberIds, personal: true })}
            onChange={pickTeam} />
          {teamRows > 0 && filtered.length > 0 && <div role="presentation" style={{ padding: '9px 8px 4px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: NX.faint }}>People</div>}
          {filtered.map((u, i) => (
            <label key={u.email} {...nav.optionProps(i)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" className="nx-check" checked={value.includes(u.email)} onChange={() => toggle(u.email)} /> {u.name}
            </label>
          ))}
          {filtered.length === 0 && teamRows === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{people.length === 0 ? 'No people' : 'No match'}</div>}
        </div>
      </AnchoredMenu>
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

// Square select box, same look as the Task List's (views/richlist.jsx) so batch
// selection reads as one control across the module. `partial` = some but not
// all rows picked (header only).
function SelectBox({ checked, partial = false, onClick, title }) {
  const on = checked || partial;
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(e); }} title={title} aria-label={title} aria-pressed={checked}
      style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${on ? NX.primary : NX.border}`, background: on ? NX.primary : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
      {checked ? <Check size={11} strokeWidth={3} color="#fff" /> : partial ? <Minus size={11} strokeWidth={3} color="#fff" /> : null}
    </button>
  );
}

// The select box sits in its own leading track ahead of the user's columns, so
// dragging or resizing columns never moves it off the left edge.
const ROW_GRID = '16px var(--nx-grid)';

// `band` = this row sits on an odd index inside its group, so it gets the
// zebra tint. Banding is what lets the eye follow a row all the way out to the
// Collaborators/Project columns on a wide screen.
function TaskRow({ t, people, projects, store, onOpen, band = false, cols = LIST_COLS, isMobilePortrait = false, selected = false, onPick }) {
  // A subtask's project is its parent's; the project cell then names the parent
  // (click-through) rather than offering a select that would re-home the subtask.
  const parent = t.parentTaskId ? rootParent(t, store.taskById) : null;
  const projectId = parent ? effectiveProjectId(t, store.taskById) : t.projectId;
  // Due date reads as a tinted pill (kit grammar), not bare colored text -
  // red tint overdue, amber tint today, quiet gray otherwise.
  const today = todayISO();
  const dueBg = !t.dueOn || t.completed ? 'transparent'
    : t.dueOn < today ? 'rgba(220,38,38,0.10)'
    : t.dueOn === today ? 'rgba(232,163,61,0.16)'
    : NX.surface2;
  const rowBg = selected ? 'rgba(37,99,235,0.10)' : band ? NX.zebra : 'transparent';
  // The person's own row colors (Oct 22 2026) - accent bar + faint tint.
  const rc = useRowColor(t.id);
  const rcAttrs = rowColorAttrs(rc);
  // Cells are keyed and rendered in the header's order, not in source order -
  // once columns can be dragged, a row that renders them in a fixed sequence
  // puts every value under the wrong heading.
  const cells = {
    title: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        {/* Circle, like the Task List / Board / Home rows - a checkbox that
            marks a task done is the same control everywhere in the module, so
            it should not change shape from one screen to the next. The status
            color dot that used to sit between it and the title is gone
            (Sagar, Sept 1 2026): a bare swatch named nothing on its own, and
            Status is already a column you can add. */}
        <button onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} title={isMissed(t) ? MISSED_TITLE : t.completed ? 'Completed' : 'Mark Complete'} style={{ ...btn('ghost'), padding: 0, flexShrink: 0, color: isMissed(t) ? NX.faint : t.completed ? NX.green : NX.faint }}>{isMissed(t) ? <XCircle size={17} /> : t.completed ? <CheckCircle2 size={17} /> : <Circle size={17} />}</button>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none', ...boldTitleStyle(rc, t.completed) }}>{t.title}</span>
        {rc && <span style={srOnly}>, colored {rc.name}</span>}
        {/* Same badges the Task List shows. Without them the same task looked
            emptier here than there, which is the kind of difference that reads
            as data missing rather than as a different screen. */}
        <TaskCountBadges t={t} store={store} />
      </div>
    ),
    dueOn: (
      // Portrait phones drop Collaborators/Project (see baseCols in
      // MyTasksView), which leaves Due Date as the last column - flush it to
      // the row's right edge instead of the left-aligned default, so it isn't
      // stranded in a sea of empty space between it and the name column.
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, ...(isMobilePortrait ? { justifyContent: 'flex-end', width: '100%' } : null) }}>
        <DateField value={t.dueOn || ''} onChange={(v) => store.updateTask(t.id, { dueOn: v })} noPast color={onTint(dueColor(t.dueOn, t.completed), rc)}
          title="Due Date" compact
          style={t.dueOn ? { fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 12, background: dueBg, width: 'fit-content' } : undefined} />
        <DueBadge task={t} nameOf={store.nameOf} compact />
      </div>
    ),
    collaborators: (
      <CollaboratorPicker value={t.followerIds || []} people={people} onChange={(v) => store.updateTask(t.id, { followerIds: v })} />
    ),
    // Two plain lines (Neil, Oct 22 - "subtasks have a project but the main
    // one doesn't" was the parent's title read as a project): the project it
    // really sits in (its parent's), then "Subtask of: <parent>".
    project: parent ? (
      <button onClick={(e) => { e.stopPropagation(); onOpen(parent.id); }} title={`Subtask of "${parent.title}"${projectId ? ` in ${store.projectName(projectId)}` : ''} - open the parent task`}
        style={{ ...btn('ghost'), padding: '2px 4px', fontSize: 12.5, color: NX.dim, minWidth: 0, maxWidth: '100%', justifyContent: 'flex-start', textAlign: 'left' }}>
        <span style={{ display: 'grid', minWidth: 0, lineHeight: 1.3 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: projectId ? NX.ink : NX.faint }}>{projectId ? store.projectName(projectId) : 'No Project'}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0, fontSize: 11.5, color: NX.faint }}>
            <CornerDownRight size={11} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Subtask of: {parent.title}</span>
          </span>
        </span>
      </button>
    ) : t.parentTaskId ? (
      // A subtask whose parent is not shared with this person: its project is
      // the parent's, so no picker that would try to re-home it.
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 4px', fontSize: 12, color: NX.faint }} title="A subtask - its parent task is not shared with you">
        <CornerDownRight size={11} style={{ flexShrink: 0 }} /> Subtask
      </span>
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
    // Hover: .nx-row-hover (style.css) - the whole-row highlight every list shares.
    // Shift / Ctrl / Cmd + click on any cell picks the row instead of opening
    // it, the same as the project list (views/richlist.jsx); a Mac's
    // Ctrl+click arrives as contextmenu.
    <div onClick={() => onOpen(t.id)}
      onClickCapture={(e) => {
        if (!(e.shiftKey || e.ctrlKey || e.metaKey)) return;
        if (!e.currentTarget.contains(e.target) || e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        e.stopPropagation(); e.preventDefault();
        onPick(t.id, e);
      }}
      onContextMenu={(e) => {
        if (!e.ctrlKey || !e.currentTarget.contains(e.target)) return;
        e.preventDefault();
        onPick(t.id, e);
      }}
      className={`stack-table-row nx-row-hover${rcAttrs.className ? ` ${rcAttrs.className}` : ''}`} data-selected={selected ? 'true' : undefined} data-task-row data-row-color={rc?.id} style={{ position: 'relative', display: 'grid', gridTemplateColumns: ROW_GRID, alignItems: 'center', gap: 8, padding: '5px 16px', boxShadow: `inset 0 -1px 0 ${NX.border}`, fontSize: 13.5, cursor: 'pointer', background: rowBg, ...rcAttrs.style }}>
      <ChangeFlash value={`${t.status}:${!!t.completed}`} color={store.statusMeta?.[t.status]?.color} isFresh={() => changedRecently(t.id)} />
      <SelectBox checked={selected} onClick={(e) => onPick(t.id, e)} title={selected ? 'Deselect' : 'Select'} />
      {cols.map((c) => <Fragment key={c.key}>{cells[c.key]}</Fragment>)}
    </div>
  );
}


export default function MyTasksView({ onNavigate }) {
  const store = useTasks();
  const { tasks, projects, myEmail, nameOf } = store;
  // View / grouping / sort ride in the user's profile with their columns -
  // coming back to a screen you have to re-set every time is the same
  // complaint as re-hiding columns every morning.
  const [view, setView] = useTableValue('mytasks', 'view', 'list');
  const [group, setGroup] = useTableValue('mytasks', 'group', 'date');
  const [filters, setFilters] = useState(EMPTY_FILTER);
  const [sort, setSort] = useTableValue('mytasks', 'sort', DEFAULT_SORT);
  // Portrait phones only - landscape still has the room for all four. Only
  // Name/Due Date fit without every row wrapping or Name shrinking to
  // nothing, so Collaborators/Project drop rather than squeeze.
  const isMobilePortrait = useIsMobile('(max-width: 640px) and (orientation: portrait)');
  // Room for the "Ext 3x" badge beside the date, only when one of my tasks
  // has one (a width dragged by hand still wins - useTableColumns).
  const anyExtended = useMemo(
    () => tasks.some((t) => t.dueExtensionCount > 0 && !t.completed && taskAssignees(t).includes((myEmail || '').toLowerCase())),
    [tasks, myEmail],
  );
  const baseCols = useMemo(() => {
    const cols = anyExtended ? LIST_COLS.map((c) => (c.key === 'dueOn' ? { ...c, width: 172, minWidth: 172 } : c)) : LIST_COLS;
    return isMobilePortrait ? cols.filter((c) => c.key === 'title' || c.key === 'dueOn') : cols;
  }, [anyExtended, isMobilePortrait]);
  const { cols: listCols, template, startResize, resetWidth, autofitWidth, widths, wrapRef, dragProps } =
    useTableColumns({ table: 'mytasks', cols: baseCols });
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
  // Dashboard KPI tiles / bar charts drill into the List view pre-filtered to
  // whatever slice was clicked (e.g. "Overdue" -> List filtered to due=overdue).
  const goFiltered = (patch) => { setFilters({ ...EMPTY_FILTER, ...patch }); setView('list'); };

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
  // Same shape as the project workspace's export: the filtered rows, each
  // followed by its own subtasks. My Tasks already flattens subtasks assigned
  // to ME into the list (personScoped), but a subtask of mine hanging under a
  // parent that is NOT mine still belongs in my file - taskExportRows walks
  // down from whatever is visible either way.
  const exportRows = useMemo(
    () => taskExportRows(mine, tasks, filter, store.taskById),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mine, tasks, filters, myEmail, store.taskById],
  );
  // Board renders allMine (completed included); every other view renders `mine`.
  const shownCount = view === 'board' ? allMine.length : mine.length;
  // Custom grouping: the person's own sections (customSections.js) - theirs
  // alone, saved with their My Tasks settings.
  const sec = useCustomSections('');
  const groups = useMemo(() => groupTasks(mine, group, { ...ctx, sections: sec.sections, sectionOf: sec.sectionOf }),
    [mine, group, nameOf, store.projectName, store.teamName, store.taskById, sec.sections, sec.sectionOf]);
  // Drag a task onto a section to file it there (Custom grouping only).
  const [dragTask, setDragTask] = useState(null);
  const [dropGroup, setDropGroup] = useState(null);
  const sectionDrop = (g) => (group === 'section' ? {
    onDragOver: (e) => { if (dragTask) { e.preventDefault(); if (dropGroup !== g.key) setDropGroup(g.key); } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropGroup((k) => (k === g.key ? null : k)); },
    onDrop: (e) => { e.preventDefault(); if (dragTask) sec.move([dragTask], g.key).catch(() => {}); setDragTask(null); setDropGroup(null); },
  } : {});
  const boardTasks = useMemo(() => sortTasks(allMine, sort, [], sortCtx), [allMine, sort, sortCtx]);

  // Batch selection - same gestures as the Task List (click, shift+click for a
  // range, ctrl+click to add; see rowSelection.js) and the same bulk bar.
  // Only rows still on screen count: a filter or a completed task that drops a
  // row out of view drops it out of the batch too, so the bar never acts on
  // something the person can no longer see.
  const directory = usePeople();
  const [picked, setPicked] = useState(() => new Set());
  const [anchor, setAnchor] = useState({ anchorId: null, focusId: null });
  const visibleIds = useMemo(() => groups.flatMap((g) => g.tasks.map((t) => t.id)), [groups]);
  const selected = useMemo(() => {
    const onScreen = new Set(visibleIds);
    return new Set([...picked].filter((id) => onScreen.has(id)));
  }, [picked, visibleIds]);
  const pickRow = (id, e) => {
    const next = selectionAfterClick({
      selected, orderedIds: visibleIds, id,
      anchorId: anchor.anchorId, focusId: anchor.focusId,
      shift: e?.shiftKey, ctrl: e?.ctrlKey || e?.metaKey,
    });
    setPicked(next.selected);
    setAnchor({ anchorId: next.anchorId, focusId: next.focusId });
  };
  const clearSel = () => setPicked(new Set());
  const allSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSel = !allSel && selected.size > 0;
  const selectAll = () => setPicked(allSel ? new Set() : new Set(visibleIds));

  // Row colors (Neil, Oct 22 2026): the person's OWN rules here, kept in
  // their profile with the rest of their My Tasks settings - nobody else sees
  // them. Evaluated over every row any view here can show (the Board keeps
  // completed work). Only fields that apply everywhere can be conditions:
  // a project's own field means nothing on a task outside that project.
  const [myRules, saveMyRules] = useMyColorRules();
  const ruleCtx = useRuleContext({ projectId: '', sections: sec.sections, sectionOf: sec.sectionOf });
  const rowScope = useRowColorScope({ rules: myRules, tasks: allMine, ruleCtx });
  const editorCtx = useMemo(() => ({ ...ruleCtx, people: directory }), [ruleCtx, directory]);
  const globalFields = useMemo(() => fieldsForProject(store.customFields || [], ''), [store.customFields]);
  const [colorsOpen, setColorsOpen] = useState(false);

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
        <div style={{ fontSize: isMobile ? 19 : 22, fontWeight: 700 }}>Tasks</div>
        {/* How many tasks are actually on screen - so it tracks the filters and
            the completed-hidden default rather than reporting a total the view
            never shows. Board sorts the same rows through its own list, hence
            the two sources. */}
        <span title={`${shownCount} ${shownCount === 1 ? 'task' : 'tasks'} in this view`}
          style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: NX.dim, background: NX.surface2, border: `1px solid ${NX.border2}`, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' }}>
          {shownCount} {shownCount === 1 ? 'Task' : 'Tasks'}
        </span>
        {/* Next to the count rather than in the List toolbar below: the rows
            being exported are the same whichever view is on screen, and the
            project workspace's Export is not gated to List either - so looking
            for it on Board and not finding it would be the odd one out. */}
        {!isMobile && (
          <ExportMenu
            title="Tasks" subtitle={`${exportRows.length} task${exportRows.length === 1 ? '' : 's'} including subtasks, as filtered`}
            filenameBase="my-tasks" rows={exportRows} compact
            columns={MY_TASK_EXPORT_COLS(store, nameOf)}
          />
        )}
        {!isMobile && (
          <button type="button" onClick={() => setColorsOpen(true)} title="Color your rows by their data - only you see these"
            style={{ ...btn('outline'), padding: '0 10px', height: CONTROL_H, fontSize: CONTROL_FS, color: NX.dim, gap: 5 }}>
            <Palette size={13} />Row Colors
          </button>
        )}
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
              {['date', 'status', 'priority', 'project', 'assignee', 'section', 'none'].map((g) => <option key={g} value={g}>Group: {g === 'date' ? 'Due Date' : g === 'none' ? 'None' : g === 'section' ? 'Custom' : g[0].toUpperCase() + g.slice(1)}</option>)}
            </select>
            <ResetColumnsButton style={{ height: CONTROL_H }} />
          </div>
        )}
      </div>
      )}

      {(view === 'list' || view === 'board' || view === 'calendar') && (
        <RowColorLegend scope={rowScope} canEdit onEdit={() => setColorsOpen(true)} compact={isMobile} />
      )}

      {/* Body */}
      <RowColorsProvider map={rowScope.map}>
      <div className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: view === 'list' ? 16 : 0, paddingBottom: isMobile ? 88 : 76 }}>
        {view === 'list' ? (
          <div className={isMobile ? 'nx-edge-card' : undefined} style={{ border: `1px solid ${NX.border}`, borderRadius: 12, overflow: 'hidden', background: NX.surface }}>
            {/* Fixed-width columns (Due date/Collaborators/Project) don't shrink
                below their content size - scroll horizontally on narrow
                viewports instead of getting clipped by the card's rounded corners.
                Portrait phones drop to just Name/Due Date (see baseCols above),
                which fit this width on their own - the 560px floor calibrated for
                all four columns would otherwise force a pointless horizontal
                scrollbar on a screen with nothing to its right. */}
            <div style={{ overflowX: 'auto' }}>
              <div ref={wrapRef} style={{ minWidth: isMobilePortrait ? 0 : 560, '--nx-grid': template }}>
                <div style={{ display: 'grid', gridTemplateColumns: ROW_GRID, alignItems: 'center', gap: 8, padding: '6px 16px', boxShadow: `inset 0 -1px 0 ${NX.border}`, background: NX.surface2, fontSize: 12.5, fontWeight: 600, color: NX.dim }}>
                  <SelectBox checked={allSel} partial={someSel} onClick={selectAll} title={allSel ? 'Deselect All' : 'Select All'} />
                  {listCols.map((c) => (
                    <TableHead key={c.key} label={c.label} sortKey={c.key} sort={sort} setSort={setSort}
                      sortReset={{ key: 'manual', dir: 'asc' }} style={{ color: NX.dim }}
                      align={isMobilePortrait && c.key === 'dueOn' ? 'flex-end' : undefined}
                      drag={dragProps(c.key)}
                      onResizeStart={startResize(c.key, widths[c.key] ?? c.width ?? 150)}
                      onResizeReset={() => resetWidth(c.key)}
              onResizeAutofit={() => autofitWidth(c.key)} />
                  ))}
                </div>
                {groups.map((g) => {
                  const isCol = collapsed.has(g.key);
                  return (
                    /* Group header = a tinted full-width band (kit grammar) so
                       groups read at a glance against white task rows. */
                    <div key={g.key} {...sectionDrop(g)}
                      style={dropGroup === g.key ? { boxShadow: `inset 0 0 0 2px ${NX.blue}` } : undefined}>
                      <div style={{ display: 'flex', alignItems: 'center', background: NX.surface2, boxShadow: `inset 0 -1px 0 ${NX.border}`, paddingRight: 10 }}>
                        <button onClick={() => toggleGroup(g.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, padding: '6px 16px', border: 'none', background: 'transparent', fontSize: 13.5, fontWeight: 700, color: NX.ink, cursor: 'pointer', textAlign: 'left', fontFamily: FONT }}>
                          <ChevronDown size={14} style={{ color: NX.faint, transform: isCol ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />
                          {g.label} <span style={{ color: NX.faint, fontWeight: 600, fontSize: 12 }}>{g.tasks.length} item{g.tasks.length !== 1 ? 's' : ''}</span>
                        </button>
                        {g.section && <SectionMenu sec={sec} group={g} />}
                      </div>
                      {!isCol && g.tasks.map((t, i) => (
                        <div key={t.id} draggable={group === 'section'}
                          onDragStart={group === 'section' ? (e) => { e.dataTransfer.effectAllowed = 'move'; setDragTask(t.id); } : undefined}
                          onDragEnd={group === 'section' ? () => { setDragTask(null); setDropGroup(null); } : undefined}>
                          <TaskRow t={t} people={people} projects={projects} store={store} onOpen={setOpenId} band={i % 2 === 1} cols={listCols} isMobilePortrait={isMobilePortrait} selected={selected.has(t.id)} onPick={pickRow} />
                        </div>
                      ))}
                      {!isCol && group === 'section' && g.tasks.length === 0 && (
                        <div style={{ padding: '10px 16px 10px 40px', fontSize: 12.5, color: NX.faint }}>Drag tasks here, or select some and use Move to Section.</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            {group === 'section' && (
              <div style={{ padding: '8px 10px', borderTop: `1px solid ${NX.border}` }}><AddSectionButton sec={sec} /></div>
            )}
            {/* No "Add Task" row here: it was a third way to open the same Create
                Task form, next to the module bar's "+ Create" and the floating
                "+". Nothing is lost: the form defaults a new task's assignee to
                whoever creates it (CreateTaskModal). */}
          </div>
        ) : view === 'calendar' ? (
          <CalendarView tasks={mine} store={store} onOpen={setOpenId} onCreate={(iso) => openCreate({ assigneeId: myEmail, dueOn: iso })} />
        ) : view === 'files' ? (
          <FilesView tasks={allMine} onOpen={setOpenId} nameOf={nameOf} />
        ) : view === 'time' ? (
          <TimeSheetView onOpen={setOpenId} />
        ) : view === 'dashboard' ? (
          <DashboardView tasks={allMine} stats={{}} store={store} scopeKey="my-tasks" onFilter={goFiltered} />
        ) : (
          // Same board as a project's (status columns, drag-and-drop, WIP limits,
          // swimlanes, Add section). Completed tasks are included so the
          // Completed column isn't always empty.
          <BoardView visible={boardTasks} ctx={ctx} store={store} onOpen={setOpenId} defaultAssigneeId={myEmail} onFullCreate={openCreate} />
        )}
        {view === 'list' && mine.length === 0 && group !== 'date' && <EmptyState icon={CheckCircle2} title="No Tasks" hint="You're all caught up." />}
      </div>
      </RowColorsProvider>

      {colorsOpen && (
        <ColorRulesEditor
          title="Row Colors - Your Tasks"
          rules={myRules}
          onSave={saveMyRules}
          onClose={() => setColorsOpen(false)}
          ctx={editorCtx}
          customFields={globalFields}
          statusOrder={ruleCtx.statusOrder}
          countTasks={allMine}
          scopeNoun="in your tasks"
          personal
        />
      )}

      {view === 'list' && (
        <BulkActionBar selected={selected} clearSel={clearSel} store={store} people={directory} isMobile={isMobile} sections={sec} />
      )}

      {/* While tasks are selected the bulk bar takes this bar's place. */}
      {isMobile && !(view === 'list' && selected.size > 0) && (
        <MobileTaskBar
          views={VIEW_TABS} view={view} setView={switchView}
          onCreate={() => openCreate({ assigneeId: myEmail })}
          filterSheet={(onClose) => (
            <MobileFilters
              filters={filters} setFilters={setFilters} sort={sort} setSort={setSort}
              group={group} setGroup={setGroup} groupOptions={MY_GROUP_OPTIONS} hideAssignee
              current={{ view, group }} onApplyView={(v) => { if (v.group) setGroup(v.group); }}
              rowColors={() => setColorsOpen(true)}
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
