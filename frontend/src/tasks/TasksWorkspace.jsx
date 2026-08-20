// Task Module - the Tasks workspace: toolbar (search / group / view-kind) + the
// List and Board views + bulk action bar. Owns the shared view state, mirroring
// the export's viewContext. Calendar/Timeline/Dashboard live in ./views/extras.
import { useMemo, useState } from 'react';
import { List, Columns3, Calendar as CalIcon, GanttChart, LayoutDashboard, Paperclip, Gauge, Plus, Search, CheckCircle2, Circle, Trash2, X, FolderKanban, ArrowLeft, Copy } from 'lucide-react';
import { useTasks } from './TasksContext';
import { useRole } from '../contexts/RoleContext';
import { EMPTY_FILTER, matchesFilter, personScoped, sortTasks, groupTasks, taskStats, taskIdFromUrl, fieldsForProject, cfKey } from './lib';
import { NX, FONT, btn, CONTROL_H, CONTROL_FS, CONTROL_ICON, input as inputStyle, STATUS_ORDER, STATUS_META, chip } from './theme';
import { Avatar, StatusChip, PriorityChip, EmptyState, usePeople, useIsMobile, ProjectAccessButton } from './components';
import CreateTaskModal from './CreateTaskModal';
import QuickCreateTask from './QuickCreateTask';
import MobileTaskBar from './MobileTaskBar';
import TaskDetailDrawer from './TaskDetailDrawer';
import { CalendarView, DashboardView } from './views/extras';
import { TimelineView, FilesView, WorkloadView } from './views/more';
import { ProductivityBar, MobileFilters } from './productivity';
import RichListView, { useHiddenCols, ListColumnControls } from './views/richlist';
import BoardView from './views/board';

const VIEW_KINDS = [
  { key: 'list', label: 'List', icon: List },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'calendar', label: 'Calendar', icon: CalIcon },
  { key: 'timeline', label: 'Timeline', icon: GanttChart },
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'workload', label: 'Workload', icon: Gauge },
  { key: 'files', label: 'Files', icon: Paperclip },
];
const GROUPS = ['status', 'priority', 'assignee', 'project', 'none'];

export default function TasksWorkspace({ lockedProjectId = null, mine = false, title = 'Tasks', onBack,
                                         initialFilters = null, initialSearch = '' }) {
  const store = useTasks();
  const { tasks, nameOf, projectName, teamName, projectById, portfolioById, toggleComplete, bulkUpdate, deleteTask, myEmail, teams } = store;
  // Owned here so the Hide / + Column controls can live in the toolbar above
  // while RichListView below renders according to them.
  const [hiddenCols, setHiddenCols] = useHiddenCols();
  const { can } = useRole();
  // Workload visibility:
  //  • Never on the project task view (lockedProjectId set) - removed per request.
  //  • Elsewhere (e.g. the Manage → Task List embed): management/oversight view,
  //    shown only to manage access (manager+), matching the ChangelogView convention.
  const canManage = !!can?.('manager');
  const showWorkload = !lockedProjectId && canManage;
  const viewKinds = showWorkload ? VIEW_KINDS : VIEW_KINDS.filter((v) => v.key !== 'workload');
  const people = usePeople();
  const isMobile = useIsMobile();
  const [view, setView] = useState('list');
  const [group, setGroup] = useState('status');
  const [search, setSearch] = useState(initialSearch || '');
  // Seeded, not forced: header search opens "everything assigned to X" through
  // this, and the user can then clear or widen it like any other filter.
  const [filters, setFilters] = useState(initialFilters || EMPTY_FILTER);
  const [sort, setSort] = useState({ key: 'manual', dir: 'asc' });
  const [selected, setSelected] = useState(new Set());
  const [openId, setOpenId] = useState(taskIdFromUrl);
  const [creating, setCreating] = useState(null); // full CreateTaskModal defaults (desktop / "Full details")
  const [quickCreate, setQuickCreate] = useState(null); // mobile Asana-style quick-add defaults
  // Mobile → lightweight quick-add sheet; desktop → the full form. Same context defaults either way.
  const openCreate = (defs) => (isMobile ? setQuickCreate(defs) : setCreating(defs));

  const filter = {
    ...filters, search,
    projectIds: lockedProjectId ? [lockedProjectId] : filters.projectIds,
    assigneeIds: mine && myEmail ? [myEmail] : filters.assigneeIds,
  };
  // Fields in play here - drives the Group/Sort/Filter menus below as well as
  // the columns, so all four offer exactly the same set.
  const activeFields = useMemo(
    () => fieldsForProject(store.customFields || [], lockedProjectId),
    [store.customFields, lockedProjectId],
  );
  // Person-scoped (My Tasks mode or an assignee filter) lists subtasks as their
  // own rows, like Asana; a project/general list stays top-level with subtasks
  // reached through their parent. Project scope resolves through the parent
  // chain so a subtask still counts as being in its parent's project.
  const visible = useMemo(
    () => sortTasks(personScoped(tasks, filter).filter((t) => matchesFilter(t, filter, store.taskById)), sort, activeFields),
    [tasks, search, filters, sort, lockedProjectId, mine, myEmail, activeFields, store.taskById],
  );

  const applyView = (v) => {
    if (v.filters) setFilters({ ...EMPTY_FILTER, ...v.filters });
    if (v.sort) setSort(v.sort);
    if (v.group) setGroup(v.group);
    // setView, not switchView: a saved view carries its own filters and must
    // not have them wiped by the tab change it asks for.
    if (v.view) setView(v.view);
  };

  // Switching tabs starts clean. A filter set in List used to follow you into
  // Board, where the panel is out of sight, so the missing rows read as lost
  // data rather than a filter still doing its job.
  const switchView = (next) => { setView(next); setFilters(EMPTY_FILTER); };
  const stats = useMemo(() => taskStats(visible), [visible]);

  const toggleSel = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  const selectAll = () => setSelected((s) => {
    const ids = visible.map((t) => t.id);
    const all = ids.length > 0 && ids.every((id) => s.has(id));
    return all ? new Set() : new Set(ids);
  });
  const ctx = { nameOf, projectName, teamName, customFields: activeFields, taskById: store.taskById };
  const lockedProject = lockedProjectId ? projectById(lockedProjectId) : null;
  // Only select fields can group or sort meaningfully - a free-text field would
  // make one group per distinct string.
  const groupableFields = activeFields.filter((f) => f.type === 'select');
  const groupOptions = [
    ...GROUPS.map((g) => ({ key: g, label: g === 'none' ? 'None' : g[0].toUpperCase() + g.slice(1) })),
    ...groupableFields.map((f) => ({ key: cfKey(f.id), label: f.name })),
  ];
  const sortFieldOptions = activeFields
    .filter((f) => ['select', 'number', 'date', 'text', 'checkbox'].includes(f.type))
    .map((f) => ({ key: cfKey(f.id), label: f.name }));

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', background: NX.canvas }}>
      {/* Row 1 - back to Projects + project name/team, New task on the right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px 12px', flexWrap: 'wrap', background: NX.surface }}>
        {onBack && (
          <button onClick={onBack} title="Back" aria-label="Back" style={{ ...btn('ghost'), padding: 6, marginLeft: -6, color: NX.dim }}><ArrowLeft size={18} /></button>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 20, fontWeight: 700, minWidth: 0 }}>
          {lockedProject ? (
            <>
              <FolderKanban size={19} style={{ color: lockedProject.color || NX.purple, flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lockedProject.name}</span>
              {lockedProject.hrDepartmentName && <span style={chip(NX.dim, NX.border2)}>{lockedProject.hrDepartmentName}</span>}
              {lockedProject.portfolioId && portfolioById(lockedProject.portfolioId) && (
                <span style={chip(NX.purple, NX.border2)}>{portfolioById(lockedProject.portfolioId).name}</span>
              )}
            </>
          ) : title}
        </div>
        {!isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
            {lockedProject && <ProjectAccessButton project={lockedProject} teams={teams} people={people} />}
            <button style={btn('primary')} onClick={() => openCreate({ projectId: lockedProjectId || '' })}><Plus size={15} />New Task</button>
          </div>
        )}
      </div>

      {/* Row 2 - view tabs + search & filters (desktop). Mobile: replaced by the floating MobileTaskBar. */}
      {!isMobile && (
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, padding: '0 20px 12px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, overflowX: 'visible' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, flexShrink: 0, maxWidth: '100%', overflowX: 'visible' }}>
          {viewKinds.map((v) => (
            <button key={v.key} onClick={() => switchView(v.key)} title={v.label} style={{
              ...btn('ghost'), padding: '6px 10px', borderRadius: 7, whiteSpace: 'nowrap',
              background: view === v.key ? NX.surface : 'transparent', color: view === v.key ? NX.ink : NX.dim,
              boxShadow: view === v.key ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}><v.icon size={15} />{v.label}</button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <div style={{ position: 'relative', width: 143 }}>
            <Search size={CONTROL_ICON} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks…" style={{ ...inputStyle, paddingLeft: 28, height: CONTROL_H, fontSize: CONTROL_FS, padding: '0 10px 0 28px' }} />
          </div>
          <ProductivityBar
            filters={filters} setFilters={setFilters} sort={sort} setSort={setSort}
            lockedProjectId={lockedProjectId} current={{ view, group }} onApplyView={applyView} onOpenTask={setOpenId}
            group={group} setGroup={setGroup}
            customFields={activeFields} sortFieldOptions={sortFieldOptions}
            groupOptions={(view === 'list' || view === 'board') ? groupOptions : null}
          />
          {/* Column controls belong to the List view only - they'd have nothing
              to act on in Board/Calendar/Timeline. */}
          {view === 'list' && (
            <ListColumnControls
              hidden={hiddenCols} setHidden={setHiddenCols}
              customFields={fieldsForProject(store.customFields || [], lockedProjectId)} createCustomField={store.createCustomField}
              lockedProjectId={lockedProjectId}
            />
          )}
        </div>
      </div>
      )}

      {/* Body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, paddingBottom: isMobile ? 88 : undefined }}>
        {view === 'list' ? (
          <RichListView visible={visible} group={group} sort={sort} ctx={ctx} store={store} people={people} selected={selected} toggleSel={toggleSel} onOpen={setOpenId} onSelectAll={selectAll} lockedProjectId={lockedProjectId} hidden={hiddenCols} setHidden={setHiddenCols} />
        ) : visible.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No Tasks Yet" hint="Create your first task to get going." />
        ) : view === 'board' ? (
          <BoardView visible={visible} group={group} ctx={ctx} store={store} onOpen={setOpenId} lockedProjectId={lockedProjectId} />
        ) : view === 'calendar' ? (
          <CalendarView tasks={visible} onOpen={setOpenId} onCreate={(iso) => openCreate({ projectId: lockedProjectId || '', dueOn: iso })} />
        ) : view === 'timeline' ? (
          <TimelineView tasks={visible} onOpen={setOpenId} nameOf={nameOf} />
        ) : view === 'files' ? (
          <FilesView tasks={visible} onOpen={setOpenId} nameOf={nameOf} />
        ) : (view === 'workload' && showWorkload) ? (
          <WorkloadView tasks={visible} nameOf={nameOf} />
        ) : (
          <DashboardView tasks={visible} stats={stats} store={store} scopeKey={lockedProjectId || 'workspace'} />
        )}
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (() => {
        const selStyle = { ...inputStyle, width: 'auto', padding: '5px 8px', background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' };
        const duplicate = async () => {
          const picked = tasks.filter((t) => selected.has(t.id));
          for (const t of picked) {
            await store.createTask({
              title: `${t.title} (copy)`, type: t.type || 'task', description: t.description || '',
              status: t.status || 'not_started', priority: t.priority || 'medium',
              projectId: t.projectId || '', teamId: t.teamId || '', assigneeId: t.assigneeId || '',
              followerIds: t.followerIds || [], dueOn: t.dueOn || '', startOn: t.startOn || '',
              tags: t.tags || [], estimateHours: t.estimateHours ?? null, isMilestone: !!t.isMilestone,
              customFieldValues: t.customFieldValues || {},
            }).catch(() => {});
          }
          clearSel();
        };
        return (
        <div style={{ position: 'absolute', left: '50%', bottom: 22, transform: 'translateX(-50%)', background: NX.primary, color: '#fff', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.28)', zIndex: 30, flexWrap: 'wrap', maxWidth: '92vw' }}>
          <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{selected.size} selected</span>
          <select onChange={(e) => { if (e.target.value) { bulkUpdate([...selected], { status: e.target.value }); clearSel(); } }} defaultValue="" style={selStyle}>
            <option value="" disabled>Status…</option>
            {/* Scoped to the project in view - see richlist's groupCtx note. */}
            {(store.statusOrderFor ? store.statusOrderFor(lockedProjectId) : store.statusOrder).map((s) => <option key={s} value={s} style={{ color: NX.ink }}>{store.statusMeta[s]?.label || s}</option>)}
          </select>
          <select onChange={(e) => { if (e.target.value) { bulkUpdate([...selected], { priority: e.target.value }); clearSel(); } }} defaultValue="" style={selStyle}>
            <option value="" disabled>Priority…</option>
            {['urgent', 'high', 'medium', 'low'].map((p) => <option key={p} value={p} style={{ color: NX.ink }}>{p[0].toUpperCase() + p.slice(1)}</option>)}
          </select>
          <select onChange={(e) => { if (e.target.value) { bulkUpdate([...selected], { assigneeId: e.target.value === '-' ? '' : e.target.value }); clearSel(); } }} defaultValue="" style={selStyle}>
            <option value="" disabled>Assign…</option>
            <option value="-" style={{ color: NX.ink }}>Unassigned</option>
            {people.map((p) => <option key={p.email} value={p.email} style={{ color: NX.ink }}>{p.name}</option>)}
          </select>
          <button onClick={duplicate} title="Duplicate the selected tasks" style={{ ...btn('ghost'), color: '#fff' }}><Copy size={14} />Duplicate</button>
          <button onClick={() => { if (confirm(`Delete ${selected.size} task(s)?`)) { [...selected].forEach(deleteTask); clearSel(); } }} style={{ ...btn('ghost'), color: '#fff' }}><Trash2 size={15} />Delete</button>
          <button onClick={clearSel} style={{ ...btn('ghost'), color: '#fff', padding: 5 }}><X size={16} /></button>
        </div>
        );
      })()}

      {isMobile && (
        <MobileTaskBar
          views={viewKinds} view={view} setView={switchView}
          onCreate={() => openCreate({ projectId: lockedProjectId || '' })}
          filterSheet={(onClose) => (
            <MobileFilters
              filters={filters} setFilters={setFilters} sort={sort} setSort={setSort}
              group={group} setGroup={setGroup}
              customFields={activeFields} sortFieldOptions={sortFieldOptions}
              groupOptions={(view === 'list' || view === 'board') ? groupOptions : null}
              current={{ view, group }} onApplyView={applyView}
              search={search} setSearch={setSearch}
              lockedProjectId={lockedProjectId}
              columnControls={view === 'list' ? (
                <ListColumnControls
                  hidden={hiddenCols} setHidden={setHiddenCols}
                  customFields={fieldsForProject(store.customFields || [], lockedProjectId)} createCustomField={store.createCustomField}
                  lockedProjectId={lockedProjectId}
                />
              ) : null}
              onClose={onClose}
            />
          )}
        />
      )}

      {quickCreate && <QuickCreateTask defaults={quickCreate} onClose={() => setQuickCreate(null)} onFullDetails={(d) => { setQuickCreate(null); setCreating({ ...quickCreate, ...d }); }} />}
      {creating && <CreateTaskModal defaults={creating} onClose={() => setCreating(null)} lockedProjectId={lockedProjectId || ''} />}
      {openId && <TaskDetailDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function TaskRow({ t, store, selected, toggleSel, onOpen }) {
  const { nameOf, toggleComplete, projectName } = store;
  const overdue = t.dueOn && t.dueOn < new Date().toISOString().slice(0, 10) && !t.completed;
  return (
    <div onClick={() => onOpen(t.id)} data-task-row style={{
      display: 'grid', gridTemplateColumns: '26px 26px 1fr auto auto auto', alignItems: 'center', gap: 10,
      padding: '9px 16px', borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer', background: selected.has(t.id) ? 'rgba(37,99,235,0.10)' : NX.surface,
    }}
      onMouseEnter={(e) => { if (!selected.has(t.id)) e.currentTarget.style.background = NX.surface2; }}
      onMouseLeave={(e) => { if (!selected.has(t.id)) e.currentTarget.style.background = NX.surface; }}>
      <input type="checkbox" checked={selected.has(t.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleSel(t.id)} style={{ cursor: 'pointer' }} />
      <button onClick={(e) => { e.stopPropagation(); toggleComplete(t); }} title="Toggle Complete" style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint }}>
        {t.completed ? <CheckCircle2 size={19} /> : <Circle size={19} />}
      </button>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: NX.ink, textDecoration: t.completed ? 'line-through' : 'none', opacity: t.completed ? 0.6 : 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
        {t.projectId && <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 1 }}>{projectName(t.projectId)}</div>}
      </div>
      {t.assigneeId ? <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={24} /> : <span style={{ width: 24 }} />}
      <PriorityChip priority={t.priority} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, color: overdue ? NX.red : NX.dim, fontWeight: overdue ? 600 : 400, minWidth: 74, textAlign: 'right' }}>{t.dueOn || '-'}</span>
        <StatusChip status={t.status} />
      </div>
    </div>
  );
}

function ListBody({ groups, store, selected, toggleSel, onOpen }) {
  return (
    <div>
      {groups.map((g) => (
        <div key={g.key}>
          {g.label && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px 6px', fontSize: 13, fontWeight: 700, color: NX.dim }}>
              {g.label} <span style={{ color: NX.faint, fontWeight: 600 }}>{g.tasks.length}</span>
            </div>
          )}
          {g.tasks.map((t) => <TaskRow key={t.id} t={t} store={store} selected={selected} toggleSel={toggleSel} onOpen={onOpen} />)}
        </div>
      ))}
    </div>
  );
}

function BoardBody({ visible, group, ctx, store, onOpen }) {
  // Board always groups into columns; default to status when group is 'none'.
  const cols = groupTasks(visible, group === 'none' ? 'status' : group, ctx);
  const { nameOf, toggleComplete, projectName } = store;
  return (
    <div style={{ display: 'flex', gap: 14, padding: 16, alignItems: 'flex-start', minHeight: '100%' }}>
      {cols.map((c) => (
        <div key={c.key} style={{ width: 288, flexShrink: 0, background: NX.surface, borderRadius: 12, border: `1px solid ${NX.border}` }}>
          <div style={{ padding: '11px 13px', borderBottom: `1px solid ${NX.border2}`, fontSize: 13, fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>
            <span>{c.label || 'Tasks'}</span><span style={{ color: NX.faint }}>{c.tasks.length}</span>
          </div>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 9, maxHeight: '68vh', overflowY: 'auto' }}>
            {c.tasks.map((t) => (
              <div key={t.id} onClick={() => onOpen(t.id)} data-task-row style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, padding: 11, cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <button onClick={(e) => { e.stopPropagation(); toggleComplete(t); }} style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={17} /> : <Circle size={17} />}</button>
                  <div style={{ fontSize: 13.5, fontWeight: 500, flex: 1, textDecoration: t.completed ? 'line-through' : 'none', opacity: t.completed ? 0.6 : 1 }}>{t.title}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
                  <PriorityChip priority={t.priority} />
                  {t.dueOn && <span style={{ fontSize: 11.5, color: NX.dim }}>{t.dueOn}</span>}
                  {t.projectId && <span style={{ fontSize: 11.5, color: NX.faint }}>{projectName(t.projectId)}</span>}
                  <div style={{ marginLeft: 'auto' }}>{t.assigneeId ? <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={22} /> : null}</div>
                </div>
              </div>
            ))}
            {c.tasks.length === 0 && <div style={{ fontSize: 12, color: NX.faint, textAlign: 'center', padding: 14 }}>Empty</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
