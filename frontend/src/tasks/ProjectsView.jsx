// Task Module - Projects. A card grid of projects with live task rollups, an
// add/edit modal, and a drill-in that reuses the Tasks workspace locked to one
// project. Ported from the export's ProjectsPage/ProjectOverview into the Nexus
// inline-style idiom.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Plus, Search, FolderKanban, AlertTriangle, Pencil, Trash2, Archive, Globe, Lock, Copy, LayoutTemplate, ArrowLeft } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { taskStats, teamInProject, teamProjectIds, fieldsForProjectEntity, taskInProject, projectToForm} from './lib';
import { NX, FONT, btn, input as inputStyle, card, chip } from './theme';
import { Avatar, EmptyState, Modal, usePeople, PersonSelect, useIsMobile, MobileFab, SearchSelect, ViewToggle } from './components';
import TasksWorkspace from './TasksWorkspace';
import { useTableColumns, TableHead, ResetColumnsButton, useTableValue } from './tableCols';
import { CustomFieldInput } from './TaskDetailDrawer';
// The two reuse flows live with the Templates screen so all three entry points
// (Templates tab, this grid, and a project's own header) open the same dialogs.
import { SaveTemplateModal, DuplicateProjectModal, todayIso } from './TemplatesView';

const EMPTY_FORM = {
  name: '', description: '', color: NX.blue, ownerId: null,
  portfolioId: '', accessLevel: 'restricted', status: 'not_started',
  startOn: '', dueOn: '', archived: false, customFieldValues: {},
};

const VISIBILITY_OPTS = [
  { key: 'org', icon: Globe, label: 'Nexus Global', desc: 'Any organization member can find and access this project.' },
  { key: 'restricted', icon: Lock, label: 'Collaborators only', desc: 'Only the owner, its teams’ members, and task assignees can access.' },
];

// Project status is a READ-OUT of the task rollup, not a field anyone sets:
// nothing started = Not Started, some work moving = In Progress, everything done
// = Completed. A card reading "Not Started" over a half-full progress bar was
// the tell that the stored `status` column was a value nobody ever updated -
// there was no editor for it anywhere in the UI.
//
// The stored TaskProject.status is therefore no longer what the UI shows. It is
// left untouched on the row (legacy/seeded values like "on_track" still sit in
// dev data) rather than migrated, because nothing else reads it.
const PROJECT_STATUS_META = {
  not_started: { label: 'Not Started', color: NX.dim,    tint: NX.border2 },
  in_progress: { label: 'In Progress', color: '#b26a00', tint: 'rgba(253,171,61,0.18)' },
  completed:   { label: 'Completed',   color: '#0a7d4b', tint: 'rgba(0,200,117,0.16)' },
};
// Sorting Status by this order, not alphabetically - "Completed, In Progress,
// Not Started" is alphabetical and reads as noise; lifecycle order is what
// someone sorting by status is actually asking for.
const PROJECT_STATUS_ORDER = ['not_started', 'in_progress', 'completed'];
// Stable identity: a fresh object each render would re-run consumers' memos.
const PROJECTS_DEFAULT_SORT = { key: 'name', dir: 'asc' };

/** Derive a project's status from its task rollup (see taskStats).
 *  `inProgress` counts too, not just `completed`: a project whose tasks are all
 *  underway but none finished sits at 0% and is still plainly not "Not Started". */
function projectStatusFor(stats) {
  if (!stats.total) return 'not_started';
  if (stats.completed >= stats.total) return 'completed';
  return (stats.completed > 0 || stats.inProgress > 0) ? 'in_progress' : 'not_started';
}

// Grid or list, remembered per browser like the board's WIP limits. Cards are
// the better browse when there are a dozen projects; past that the list wins,
// because comparing rollups down a column is what people actually come here to
// do and a 4-across grid makes that a scavenger hunt.
const VIEW_KEY = 'nexus.projects.view';
// One template for the header and every row, so the columns cannot drift apart.
// Teams and Owner are the first to go on a narrow screen - the name, how far
// along it is, and its status are what the row is for.
const LIST_COLS = '1fr auto';   // mobile: name + actions on one line, rollup beneath
// Desktop columns in grid order, with the sort key each header drives. Name and
// Teams are elastic; the rest are fixed until someone drags them.
const LIST_COLS_WIDE = [
  { key: 'name',     label: 'Project',  sort: 'name',     template: 'minmax(0,2.4fr)' },
  { key: 'teams',    label: 'Teams',    sort: 'teams',    template: 'minmax(0,1.3fr)' },
  { key: 'progress', label: 'Progress', sort: 'progress', width: 190 },
  { key: 'owner',    label: 'Owner',    sort: 'owner',    width: 150 },
  { key: 'status',   label: 'Status',   sort: 'status',   width: 118 },
  // 104px, not 64: on desktop this cell holds four 23px icon buttons plus their
  // gaps (~98px). At 64 the row's icons overflowed their track to the LEFT
  // (justifyContent: flex-end), spilling across the Status divider so they no
  // longer lined up with any header (Sagar, Aug 27).
  { key: 'actions',  label: '',                           width: 104, fixed: true },
];

export default function ProjectsView({ onNavigate }) {
  const isMobile = useIsMobile();
  const store = useTasks();
  const { projects, portfolios, tasks, nameOf, portfolioById, teams, customFields,
    createProject, updateProject, deleteProject, myEmail } = store;
  const people = usePeople();
  // Project-scoped select fields (Location, etc.) - each gets its own filter
  // dropdown. Multiselect/text/etc. project fields are out of scope for now;
  // a select is what a "filter through X" ask actually means.
  const filterableFields = useMemo(
    () => fieldsForProjectEntity(customFields).filter((f) => f.type === 'select'),
    [customFields],
  );

  const [openId, setOpenId] = useState(null);      // drilled-into project
  const [search, setSearch] = useState('');
  // active | archived | all. Was a bare "Show archived" checkbox, which could
  // only ever ADD archived projects to the live list - there was no way to look
  // at the archive on its own, which is the usual reason to go looking.
  const [archiveFilter, setArchiveFilter] = useState('active');
  // {fieldId: optionId}. Empty/missing = that filter is off.
  const [fieldFilters, setFieldFilters] = useState({});
  const setFieldFilter = (fieldId, optionId) =>
    setFieldFilters((f) => (optionId ? { ...f, [fieldId]: optionId } : Object.fromEntries(Object.entries(f).filter(([k]) => k !== fieldId))));
  const [editing, setEditing] = useState(null);    // form object | null
  const [deleting, setDeleting] = useState(null);  // { project, busy, err } | null
  const [duplicating, setDuplicating] = useState(null);  // project being copied | null
  const [templating, setTemplating] = useState(null);    // project being saved as a template | null
  // Grid or list, in the user's profile with everything else they set here -
  // it used to be a per-browser choice, so the same person got the grid on one
  // machine and the list on another. Anyone who has already picked keeps their
  // pick; only a first visit lands on the list.
  const [view, setView] = useTableValue('projects', 'view', 'list');
  const switchView = (v) => setView(v);
  // One-time migration of the old per-browser choice, so nobody's preference is
  // silently reset by the move. Runs once, then the local copy is retired.
  useEffect(() => {
    let local = null;
    try { local = localStorage.getItem(VIEW_KEY); } catch { return; }
    if (local !== 'list' && local !== 'grid') return;
    setView(local);
    try { localStorage.removeItem(VIEW_KEY); } catch { /* private mode */ }
  }, [setView]);

  // Rollups per project: count / done / progress / overdue, from live tasks.
  const cards = useMemo(() => {
    const q = search.trim().toLowerCase();
    // A team serves many projects, so this reads the team side of the link
    // rather than any single field on the project.
    const teamsOf = (pid) => (teams || []).filter((t) => teamInProject(t, pid));
    return projects
      .filter((p) => (archiveFilter === 'all' ? true : archiveFilter === 'archived' ? !!p.archived : !p.archived))
      .map((p) => ({ ...p, teams: teamsOf(p.id) }))
      // Team names are searchable too now that they are what the card shows.
      .filter((p) => !q || p.name.toLowerCase().includes(q)
        || (p.hrDepartmentName || '').toLowerCase().includes(q)
        || p.teams.some((t) => (t.name || '').toLowerCase().includes(q)))
      .filter((p) => Object.entries(fieldFilters).every(
        ([fieldId, optionId]) => (p.customFieldValues || {})[fieldId] === optionId))
      .map((p) => {
        const own = tasks.filter((t) => taskInProject(t, p.id));
        return { project: p, stats: taskStats(own) };
      })
      .sort((a, b) => Number(a.project.archived) - Number(b.project.archived)
        || a.project.name.localeCompare(b.project.name));
  }, [projects, tasks, teams, search, archiveFilter, fieldFilters]);

  // Archived projects render under their own heading rather than mixed into the
  // grid greyed-out - "where did that project go" is a question the heading
  // answers and a dimmed card does not.
  const archivedCards = cards.filter((c) => c.project.archived);
  // Archived cards already sort last, so the section boundary is just the first
  // of them. Rendered as a full-width band inside the same grid rather than a
  // second grid, so column widths stay identical across the divide.
  const firstArchivedAt = cards.findIndex((c) => c.project.archived);
  const archivedHeading = (
    <div style={{
      gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8,
      margin: '10px 0 2px', fontSize: 12, fontWeight: 700, letterSpacing: '.04em',
      textTransform: 'uppercase', color: NX.faint,
    }}>
      <Archive size={13} />
      Archived Projects
      <span style={{ fontWeight: 600, letterSpacing: 0, textTransform: 'none' }}>
        ({archivedCards.length}) - kept for reference, not offered when filing new tasks
      </span>
      <span style={{ flex: 1, height: 1, background: NX.border2 }} />
    </div>
  );

  const openProject = openId ? projects.find((p) => p.id === openId) : null;

  // ── Drill-in: reuse the Tasks workspace locked to this project. Its own Row 1
  // header owns the back arrow (icon-only) + project name/team, so no separate
  // header wrapper here. ──────────────────────────────────────────────────────
  if (openProject) {
    return <TasksWorkspace lockedProjectId={openProject.id} title={openProject.name} onBack={() => setOpenId(null)} />;
  }

  // New projects default the owner to whoever's creating it - same reasoning
  // as CreateTaskModal's task owner default - still freely changeable below.
  const startCreate = () => setEditing({ ...EMPTY_FORM, ownerId: myEmail || null });
  const startEdit = (p) => setEditing(projectToForm(p));

  // Deleting is permanent, so it gets a real confirmation dialog. Used to also
  // ask "does the Asana project go too?" for a synced project - dropped with
  // Asana severed (Aug 27): the backend now refuses a live delete-in-Asana
  // call anyway, so offering the choice was a dead end. The project's own
  // Asana link/mapping is still cleared locally either way (deleteProject).
  const remove = (p) => setDeleting({ project: p, busy: false, err: '' });

  const confirmRemove = async () => {
    const { project } = deleting;
    setDeleting((d) => ({ ...d, busy: true, err: '' }));
    try {
      await deleteProject(project.id, { deleteInAsana: false });
      setDeleting(null);
    } catch (e) {
      setDeleting((d) => ({ ...d, busy: false, err: e.message || 'Could not delete the project.' }));
    }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: NX.canvas }}>
      {/* Header - title/subtitle left, New Project top-right, full-width search below */}
      <div style={{ padding: isMobile ? '12px 12px 10px' : '20px 24px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: isMobile ? 20 : 26, fontWeight: 800, letterSpacing: '-0.02em' }}>Projects</div>
            {!isMobile && <div style={{ fontSize: 13.5, color: NX.dim, marginTop: 4 }}>Every project in the workspace with live task rollups.</div>}
          </div>
          {/* Desktop keeps the labelled buttons; on mobile a floating + at the
              bottom of the screen creates a project instead (see MobileFab below),
              and Templates rides the icon-only button below next to search. */}
          {!isMobile && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button title="Browse and manage reusable project blueprints"
                style={{ ...btn('outline'), padding: '10px 16px', fontSize: 13.5, borderRadius: 10 }}
                onClick={() => onNavigate?.('templates')}><LayoutTemplate size={16} />Templates</button>
              <button style={{ ...btn('primary'), padding: '10px 18px', fontSize: 13.5, borderRadius: 10 }} onClick={startCreate}><Plus size={16} />New Project</button>
            </div>
          )}
        </div>
        {/* Search · filters · view toggle - wraps on mobile rather than forcing
            one line: the archive filter, any custom-field filter (e.g.
            Location), and the view toggle all refuse to shrink (flexShrink:0),
            so a forced nowrap row put all the squeeze onto the search box
            alone, crushing it to a sliver. Search takes its own full row on
            mobile (flex-basis 100%) so nothing else can share it and shrink
            it; the filters/toggle wrap onto the row(s) below. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14, marginTop: isMobile ? 10 : 16, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: isMobile ? '1 1 100%' : '1 1 260px', minWidth: 0, maxWidth: isMobile ? 'none' : 420 }}>
            <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects…"
              style={{ ...inputStyle, paddingLeft: 40, paddingTop: isMobile ? 8 : 10, paddingBottom: isMobile ? 8 : 10, borderRadius: 999 }} />
          </div>
          <select value={archiveFilter} onChange={(e) => setArchiveFilter(e.target.value)} title="Archive filter"
            style={{ ...inputStyle, width: 'auto', flexShrink: 0, padding: isMobile ? '7px 9px' : '9px 10px', borderRadius: 999, fontSize: isMobile ? 12 : 13, cursor: 'pointer' }}>
            <option value="active">Active Projects</option>
            <option value="archived">Archived Projects</option>
            <option value="all">All Projects</option>
          </select>
          {filterableFields.map((f) => (
            <select key={f.id} value={fieldFilters[f.id] || ''} onChange={(e) => setFieldFilter(f.id, e.target.value)}
              style={{ ...inputStyle, width: 'auto', flexShrink: 0, padding: isMobile ? '7px 9px' : '9px 10px', borderRadius: 999, fontSize: isMobile ? 12 : 13, cursor: 'pointer' }}>
              <option value="">All {f.name}</option>
              {(f.options || []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          ))}
          {/* Mobile has no room for a labelled header button (New Project already
              gave that spot to the floating +), so Templates rides here instead,
              icon-only like the view toggle it sits beside. */}
          {isMobile && (
            <button title="Templates" onClick={() => onNavigate?.('templates')}
              style={{ ...btn('outline'), padding: '7px 9px', borderRadius: 9 }}>
              <LayoutTemplate size={15} />
            </button>
          )}
          {/* Right-hand cluster. The switcher belongs on the far edge whatever
              else is in the row, so the group owns the auto margin - hanging it
              off ResetColumnsButton put the switcher mid-row on any profile
              that had never resized a column, since that button renders null
              until it has something to reset. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14, marginLeft: 'auto', flexShrink: 0 }}>
            {/* List view only - the grid has no columns to restore. */}
            {!isMobile && view === 'list' && <ResetColumnsButton />}
            {/* The shared switcher, so Projects, Portfolios, Teams and Templates
                cannot drift apart on padding, radius or active state. */}
            <ViewToggle view={view} onChange={switchView} isMobile={isMobile} />
          </div>
        </div>
      </div>

      {/* Grid - grey body, white project cards */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas }}>
      {cards.length === 0 ? (
        <EmptyState icon={FolderKanban} title={search.trim() ? 'No Projects Match Your Search' : 'No Projects Yet'} hint={search.trim() ? undefined : 'Create your first project to group tasks and track progress.'} />
      ) : view === 'list' ? (
        <ProjectList
          cards={cards} isMobile={isMobile} nameOf={nameOf} portfolioById={portfolioById}
          onOpen={setOpenId} onEdit={startEdit} onDelete={remove}
          onDuplicate={setDuplicating} onSaveTemplate={setTemplating}
        />
      ) : (
        <div className="nx-gutter" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: 14, padding: '16px 16px 76px' }}>
          {cards.map(({ project: p, stats }, idx) => {
            const pf = p.portfolioId ? portfolioById(p.portfolioId) : null;
            const dcolor = p.color || NX.blue;
            return (
              <Fragment key={p.id}>
              {idx === firstArchivedAt && archivedHeading}
              <div onClick={() => setOpenId(p.id)} style={{
                ...card, padding: 0, overflow: 'hidden', cursor: 'pointer', display: 'flex', flexDirection: 'column',
                opacity: p.archived ? 0.62 : 1, position: 'relative',
              }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 6px 18px rgba(0,0,0,0.09)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px 14px', flex: 1 }}>
                {/* Head row: the project's color rides its icon tile on the left,
                    name beside it, actions right. This replaces a 54px cover band
                    that spent the card's whole top edge on one centered icon. */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{
                      width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: `${dcolor}1f`, color: dcolor,
                    }}><FolderKanban size={15} /></span>
                    <div title={p.name} style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                    <div style={{ display: 'flex', gap: 2, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                      <button title="Save as Template" onClick={() => setTemplating(p)} style={{ ...btn('ghost'), padding: 5, borderRadius: 7 }}><LayoutTemplate size={13} /></button>
                      <button title="Duplicate Project" onClick={() => setDuplicating(p)} style={{ ...btn('ghost'), padding: 5, borderRadius: 7 }}><Copy size={13} /></button>
                      <button title="Edit Project" onClick={() => startEdit(p)} style={{ ...btn('ghost'), padding: 5, borderRadius: 7 }}><Pencil size={13} /></button>
                      <button title="Delete Project" onClick={() => remove(p)} style={{ ...btn('ghost'), padding: 5, color: NX.red, borderRadius: 7 }}><Trash2 size={13} /></button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    {/* The teams that work this project, each in its own color.
                        This used to show hrDepartmentName - the CREATOR's People
                        department - so every project imported by one person read
                        as that person's department ("IT" across the board),
                        which says nothing about the project. Department is the
                        fallback only where no team is assigned yet. */}
                    {p.teams.length > 0
                      ? p.teams.slice(0, 2).map((t) => (
                          <span key={t.id} style={chip(t.color || NX.blue, `${t.color || NX.blue}1a`)}>{t.name}</span>
                        ))
                      : p.hrDepartmentName && <span style={chip(dcolor, `${dcolor}1a`)}>{p.hrDepartmentName}</span>}
                    {p.teams.length > 2 && (
                      <span title={p.teams.map((t) => t.name).join(', ')} style={chip(NX.dim, NX.border2)}>+{p.teams.length - 2}</span>
                    )}
                    {p.archived && <span style={chip(NX.faint, NX.border2)}><Archive size={11} />Archived</span>}
                  </div>
                </div>

                {p.description && (
                  <div style={{ fontSize: 12.5, color: NX.dim, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.description}</div>
                )}

                {/* Progress rollup */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: NX.dim, marginBottom: 5 }}>
                    <span>{stats.completed}/{stats.total} done</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {stats.overdue > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: NX.red, fontWeight: 600 }}><AlertTriangle size={12} />{stats.overdue}</span>}
                      <span style={{ fontWeight: 700, color: NX.ink }}>{stats.pct}%</span>
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 999, background: NX.border2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${stats.pct}%`, borderRadius: 999, background: NX.green }} />
                  </div>
                </div>

                {/* Footer: owner + portfolio + status */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto', paddingTop: 3 }}>
                  {p.ownerId ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <Avatar email={p.ownerId} name={nameOf(p.ownerId)} size={22} />
                      <span style={{ fontSize: 12, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(p.ownerId)}</span>
                    </span>
                  ) : <span style={{ fontSize: 12, color: NX.faint }}>No owner</span>}
                  {pf && <span style={chip(NX.purple, `${NX.purple}1a`)}>{pf.name}</span>}
                  {(() => {
                    const m = PROJECT_STATUS_META[projectStatusFor(stats)];
                    return <span style={{ ...chip(m.color, m.tint), marginLeft: 'auto' }}>{m.label}</span>;
                  })()}
                </div>
                </div>
              </div>
              </Fragment>
            );
          })}
        </div>
      )}
      </div>

      {isMobile && <MobileFab title="New Project" onClick={startCreate} />}

      {editing && (
        <ProjectModal
          form={editing}
          setForm={setEditing}
          people={people}
          portfolios={portfolios}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      {templating && (
        <SaveTemplateModal projectId={templating.id} onClose={() => setTemplating(null)} />
      )}

      {/* A fresh copy is worth landing in, so the new project opens straight away. */}
      {duplicating && (
        <DuplicateProjectModal
          project={duplicating}
          onClose={() => setDuplicating(null)}
          onCreated={(made) => setOpenId(made.id)}
        />
      )}

      {deleting && (
        <DeleteProjectModal
          state={deleting}
          onConfirm={confirmRemove}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

// Permanent delete. For a synced project the Asana copy is the only place the
// work still exists afterwards, so the choice is spelled out rather than buried
// in a checkbox label: keep it (the default - re-import later) or delete it too.
/** Projects as rows. Same data the card carries and the same click target -
 *  only the shape differs, so nothing has to be learned twice. Sorting is
 *  inherited from `cards` (archived last, then by name), matching the grid. */
export function ProjectList({ cards, isMobile, nameOf, portfolioById, onOpen, onEdit, onDelete,
                             onDuplicate, onSaveTemplate }) {
  const cell = { minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 };
  // Header sort. `null` is the unsorted state - the order `cards` arrives in
  // (archived last, then by name) - which is where a third click returns to.
  // Alphabetical A-Z by default, so the header shows what the list is actually
  // doing rather than leaving the order implicit.
  const [sort, setSort] = useTableValue('projects', 'sort', PROJECTS_DEFAULT_SORT);
  const { cols: listCols, template, startResize, resetWidth, autofitWidth, widths, wrapRef, dragProps } =
    useTableColumns({ table: 'projects', cols: LIST_COLS_WIDE });
  const cols = isMobile ? LIST_COLS : 'var(--nx-grid)';
  const rows = useMemo(() => {
    if (isMobile || !sort?.key) return cards;
    const val = ({ project: p, stats }) => {
      switch (sort.key) {
        case 'teams':    return (p.teams || []).length;
        case 'progress': return stats.pct;
        case 'owner':    return (p.ownerId ? nameOf(p.ownerId) : '').toLowerCase();
        case 'status':   return PROJECT_STATUS_ORDER.indexOf(projectStatusFor(stats));
        default:         return (p.name || '').toLowerCase();
      }
    };
    const dir = sort.dir === 'desc' ? -1 : 1;
    return cards.slice().sort((a, b) => {
      // Archived stays at the bottom whatever the sort - it is a different
      // class of row, and interleaving it alphabetically buries live projects.
      if (!!a.project.archived !== !!b.project.archived) return a.project.archived ? 1 : -1;
      const x = val(a), y = val(b);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y), 'en', { sensitivity: 'base' }) * dir;
    });
  }, [cards, sort, isMobile, nameOf]);
  return (
    <div className="nx-gutter" style={{ padding: isMobile ? 12 : 16 }}>
      <div ref={wrapRef} style={{ ...card, padding: 0, overflow: 'hidden', '--nx-grid': template }}>
        {!isMobile && (
          <div style={{
            display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center',
            padding: '9px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface2,
            fontSize: 11.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: NX.faint,
          }}>
            {listCols.map((c) => (
              <TableHead key={c.key} label={c.label} sortKey={c.sort} sort={sort} setSort={setSort}
                drag={dragProps(c.key, !c.fixed)}
                onResizeStart={startResize(c.key, widths[c.key] ?? c.width ?? 190)}
                onResizeReset={() => resetWidth(c.key)}
              onResizeAutofit={() => autofitWidth(c.key)} />
            ))}
          </div>
        )}
        {rows.map(({ project: p, stats }, idx) => {
          // Zebra band on alternate rows, same token/behavior as the Task
          // list (richlist.jsx): hover restores to the row's own band rather
          // than to transparent, so an odd row doesn't flash lighter on
          // mouse-out.
          const rowBg = idx % 2 === 1 ? NX.zebra : 'transparent';
          const pf = p.portfolioId ? portfolioById(p.portfolioId) : null;
          const dcolor = p.color || NX.blue;
          const meta = PROJECT_STATUS_META[projectStatusFor(stats)];
          const actionsCell = (
            <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end',
              // Pinned beside the name on mobile; without this the rollup's
              // full-width span pushes it onto a third row of its own.
              ...(isMobile ? { gridRow: 1, gridColumn: 2 } : null) }}
              onClick={(e) => e.stopPropagation()}>
              {/* Template/Duplicate are desktop-only here: the mobile row already
                  pins its actions beside the name in a two-column grid, and four
                  icon buttons there crowd out the project name itself. Both are
                  still reachable on mobile from the grid view's cards. */}
              {!isMobile && onSaveTemplate && (
                <button title="Save as Template" onClick={() => onSaveTemplate(p)} style={{ ...btn('ghost'), padding: 5, borderRadius: 7 }}><LayoutTemplate size={13} /></button>
              )}
              {!isMobile && onDuplicate && (
                <button title="Duplicate Project" onClick={() => onDuplicate(p)} style={{ ...btn('ghost'), padding: 5, borderRadius: 7 }}><Copy size={13} /></button>
              )}
              <button title="Edit Project" onClick={() => onEdit(p)} style={{ ...btn('ghost'), padding: 5, borderRadius: 7 }}><Pencil size={13} /></button>
              <button title="Delete Project" onClick={() => onDelete(p)} style={{ ...btn('ghost'), padding: 5, color: NX.red, borderRadius: 7 }}><Trash2 size={13} /></button>
            </div>
          );
          return (
            <div key={p.id} onClick={() => onOpen(p.id)} className="stack-table-row"
              style={{
                display: 'grid', gridTemplateColumns: cols, gap: isMobile ? 6 : 12, alignItems: 'center',
                padding: isMobile ? '11px 12px' : '10px 16px', borderBottom: `1px solid ${NX.border2}`,
                cursor: 'pointer', opacity: p.archived ? 0.62 : 1, background: rowBg,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = NX.hover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = rowBg)}>

              {/* Cells are keyed and rendered in the header's order, not in
                  source order - once columns can be dragged, a row that renders
                  them in a fixed sequence puts every value under the wrong
                  heading. Mobile has no header to follow: it renders the name
                  cell alone (plus the rollup and actions below), so it takes
                  the same entry straight out of the map. */}
              {(isMobile ? listCols.filter((c) => c.key === 'name') : listCols).map((c) => <Fragment key={c.key}>{({
                name: (
              <div style={cell}>
                <span style={{
                  width: 26, height: 26, borderRadius: 8, flexShrink: 0,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: `${dcolor}1f`, color: dcolor,
                }}><FolderKanban size={14} /></span>
                <span title={p.name} style={{ minWidth: 0, fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {p.archived && <span style={{ ...chip(NX.faint, NX.border2), flexShrink: 0 }}><Archive size={11} />Archived</span>}
                {pf && !isMobile && <span style={{ ...chip(NX.purple, `${NX.purple}1a`), flexShrink: 0 }}>{pf.name}</span>}
              </div>
                ),
                teams: (
                  <div style={{ ...cell, gap: 5, flexWrap: 'nowrap', overflow: 'hidden' }}>
                    {p.teams.length > 0
                      ? p.teams.slice(0, 2).map((t) => (
                          <span key={t.id} style={{ ...chip(t.color || NX.blue, `${t.color || NX.blue}1a`), flexShrink: 0 }}>{t.name}</span>
                        ))
                      : p.hrDepartmentName
                        ? <span style={{ ...chip(dcolor, `${dcolor}1a`), flexShrink: 0 }}>{p.hrDepartmentName}</span>
                        : <span style={{ fontSize: 12, color: NX.faint }}>-</span>}
                    {p.teams.length > 2 && (
                      <span title={p.teams.map((t) => t.name).join(', ')} style={{ ...chip(NX.dim, NX.border2), flexShrink: 0 }}>+{p.teams.length - 2}</span>
                    )}
                  </div>
                ),
                progress: (
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11.5, color: NX.dim, marginBottom: 4 }}>
                      <span>{stats.completed}/{stats.total} done</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        {stats.overdue > 0 && <span title={`${stats.overdue} overdue`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: NX.red, fontWeight: 600 }}><AlertTriangle size={11} />{stats.overdue}</span>}
                        <span style={{ fontWeight: 700, color: NX.ink }}>{stats.pct}%</span>
                      </span>
                    </div>
                    <div style={{ height: 5, borderRadius: 999, background: NX.border2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${stats.pct}%`, borderRadius: 999, background: NX.green }} />
                    </div>
                  </div>
                ),
                owner: (
                  <div style={cell}>
                    {p.ownerId ? (
                      <>
                        <Avatar email={p.ownerId} name={nameOf(p.ownerId)} size={22} />
                        <span style={{ fontSize: 12, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(p.ownerId)}</span>
                      </>
                    ) : <span style={{ fontSize: 12, color: NX.faint }}>No owner</span>}
                  </div>
                ),
                status: (
                  <div style={cell}><span style={chip(meta.color, meta.tint)}>{meta.label}</span></div>
                ),
                actions: actionsCell,
              })[c.key]}</Fragment>)}

              {/* Mobile keeps a compact rollup + status under the name instead of
                  dropping them entirely - they are why the row is being read. */}
              {isMobile && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 34, gridColumn: '1 / -1' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: NX.dim, marginBottom: 4 }}>
                      <span>{stats.completed}/{stats.total} done</span>
                      {stats.overdue > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: NX.red, fontWeight: 600 }}><AlertTriangle size={11} />{stats.overdue}</span>}
                      <span style={{ fontWeight: 700, color: NX.ink, marginLeft: 'auto' }}>{stats.pct}%</span>
                    </div>
                    <div style={{ height: 5, borderRadius: 999, background: NX.border2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${stats.pct}%`, borderRadius: 999, background: NX.green }} />
                    </div>
                  </div>
                  <span style={{ ...chip(meta.color, meta.tint), flexShrink: 0 }}>{meta.label}</span>
                </div>
              )}

              {isMobile && actionsCell}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function DeleteProjectModal({ state, onConfirm, onClose }) {
  const { project, busy, err } = state;

  return (
    <Modal
      title={`Delete "${project.name}"?`}
      onClose={busy ? () => {} : onClose}
      footer={(
        <>
          <button onClick={onClose} disabled={busy} style={btn('outline')}>Cancel</button>
          <button onClick={onConfirm} disabled={busy}
            style={{ ...btn('primary'), background: NX.red, borderColor: NX.red, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </>
      )}
    >
      <p style={{ fontSize: 13.5, color: NX.ink, marginBottom: 12 }}>
        This permanently deletes the project, <strong>all of its tasks</strong> (subtasks, comments and
        attachments included), and its teams. This can’t be undone.
      </p>

      {err && <div style={{ marginTop: 10, fontSize: 12.5, color: NX.red }}>{err}</div>}
    </Modal>
  );
}

// ── Add / Edit modal ─────────────────────────────────────────────────────────
// Owns the full save flow (project fields + team assignment diffs), since
// applying team assignments needs the project's id, which for a new project
// only exists after createProject resolves. Callers just get an onSaved(project)
// callback for their own post-save action (close, navigate, etc).
//
// `template` switches it into build-from-a-template mode. This is deliberately
// the SAME form rather than a second one: a template is a blueprint that
// carries no owner, no members, no teams, no portfolio, no department and no
// visibility (see the backend note in task_projects.py), so every one of those
// has to be asked for - which is exactly the questions this modal already asks.
// Template mode adds a start date (the anchor the saved day-offsets re-hang
// from) and routes Save through createProjectFromTemplate.
export function ProjectModal({ form, setForm, people, portfolios, onClose, onSaved, template = null }) {
  const { teams, tasks, customFields, createProject, updateProject, updateTeam,
    createProjectFromTemplate } = useTasks();
  const projectFields = useMemo(() => fieldsForProjectEntity(customFields), [customFields]);
  const [dirty, setDirty] = useState(false);
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); };
  // Read-only: status is computed from this project's tasks, the same rollup the
  // card's progress bar draws. Shown rather than hidden so the modal answers
  // "why does it say that?" in place, instead of looking like a missing field.
  const stats = useMemo(() => taskStats(form.id ? tasks.filter((t) => taskInProject(t, form.id)) : []), [tasks, form.id]);
  const statusMeta = PROJECT_STATUS_META[projectStatusFor(stats)];
  const label = { fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
  const valid = form.name.trim().length > 0;
  const [saving, setSaving] = useState(false);
  // autoFocus on a text input inside a modal pops the on-screen keyboard the
  // instant the modal opens on touch devices. The modal's sizing is vh-based
  // (Modal component: 7vh top padding, 86vh max-height), and mobile Chrome
  // recalculates vh against the keyboard-shrunk viewport differently than
  // Safari/Edge - its scroll-focused-input-into-view then overshoots and
  // scrolls the whole modal content past Name/Description/Owner, landing on
  // Department options for the picker above. Names only - see
  // list_project_departments for why this is not the People module's endpoint.
  const [departments, setDepartments] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getProjectDepartments()
      .then((rows) => { if (alive) setDepartments(rows || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const multiCompany = new Set(departments.map((d) => d.companyId)).size > 1;

  // Department instead (reported: fields "missing" in Chrome mobile, present
  // in Safari/Edge). Skipping autoFocus on mobile avoids triggering that
  // keyboard-open scroll entirely - desktop keeps the autofocus convenience.
  const isMobile = useIsMobile();

  // Teams currently assigned to this project (none yet for a brand-new one),
  // staged locally until Save so create and edit behave the same way.
  const [teamIds, setTeamIds] = useState(() => teams.filter((t) => teamInProject(t, form.id)).map((t) => t.id));
  const toggleTeam = (id) => { setTeamIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])); setDirty(true); };

  const save = async (override) => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const { id, ...rest } = form;
      const data = { ...rest, ...(override || {}) };
      // A blank due date must be OMITTED, not sent as "": the backend reads
      // "not sent" as "use the template's own due offset" and "" as "this
      // project has no due date". The form has no due-date field, so sending
      // its empty default would throw away a due date the blueprint carries.
      if (template && !data.dueOn) delete data.dueOn;
      const project = template
        // Team assignment still goes through the diff below rather than the
        // endpoint's own team_ids, so create-blank and create-from-template
        // apply teams by one mechanism instead of two.
        ? await createProjectFromTemplate(template.id, data)
        : id ? await updateProject(id, data) : await createProject(data);
      // A team can serve several projects, so this edits only THIS project's membership
      // in each team's list - a bare project_id would replace the team's whole set and
      // drop the other projects it works on.
      const pid = id || project.id;
      const wasAssigned = teams.filter((t) => teamInProject(t, pid)).map((t) => t.id);
      const toAssign = teamIds.filter((tid) => !wasAssigned.includes(tid));
      const toUnassign = wasAssigned.filter((tid) => !teamIds.includes(tid));
      const projectsOf = (tid) => teamProjectIds(teams.find((t) => t.id === tid));
      await Promise.all([
        ...toAssign.map((tid) => updateTeam(tid, { project_ids: [...projectsOf(tid), pid] }).catch(() => {})),
        ...toUnassign.map((tid) => updateTeam(tid, { project_ids: projectsOf(tid).filter((x) => x !== pid) }).catch(() => {})),
      ]);
      onSaved(project);
    } catch (e) {
      setSaving(false);
      window.alert(e?.message || (template ? 'Could not create the project from this template.' : 'Could not save the project.'));
    }
  };

  return (
    <Modal
      title={template ? `New Project from "${template.name}"` : form.id ? 'Edit Project' : 'Create a Project'}
      onClose={onClose}
      isDirty={dirty}
      onSave={valid ? save : undefined}
      footer={<>
        {/* Archive sits at the opposite end from Cancel/Save (marginRight:
            auto splits the footer's flex-end row into a left island and a
            right group) - a lifecycle action reads as separate from the
            save/cancel pair, not one more choice in that row. Red because
            archiving, while reversible, is still "take this out of active
            use" - Unarchive stays green (a restore, not a warning).
            Save-and-archive in one press: the toggle goes through the same
            save path, so team membership and every other edit in the form
            land with it. */}
        {form.id && (
          <button
            style={{
              ...btn('outline'), marginRight: 'auto',
              color: form.archived ? NX.green : NX.red,
              borderColor: form.archived ? NX.border : NX.red,
              opacity: saving ? 0.5 : 1, pointerEvents: saving ? 'none' : 'auto',
            }}
            title={form.archived
              ? 'Restore this project to the active list'
              : 'Archive - keeps the project and its tasks, hides it from the active list and from project pickers'}
            onClick={() => save({ archived: !form.archived })}>
            <Archive size={15} />{form.archived ? 'Unarchive' : 'Archive'}
          </button>
        )}
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: valid && !saving ? 1 : 0.5, pointerEvents: valid && !saving ? 'auto' : 'none' }} onClick={() => save()}>{saving ? 'Creating…' : form.id ? 'Save Changes' : 'Create Project'}</button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {template && (
          <div style={{ display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 10, background: NX.surface2, border: `1px solid ${NX.border2}` }}>
            <LayoutTemplate size={16} style={{ color: NX.purple, marginTop: 1, flexShrink: 0 }} />
            <div style={{ fontSize: 12.5, color: NX.dim, lineHeight: 1.5 }}>
              <strong style={{ color: NX.ink }}>{template.name}</strong> brings the structure -{' '}
              {template.taskCount} task{template.taskCount === 1 ? '' : 's'}
              {template.sectionCount ? `, ${template.sectionCount} section${template.sectionCount === 1 ? '' : 's'}` : ''}
              {template.fieldCount ? `, ${template.fieldCount} custom field${template.fieldCount === 1 ? '' : 's'}` : ''}
              {template.statusCount ? `, ${template.statusCount} custom status${template.statusCount === 1 ? '' : 'es'}` : ''}.
              Everything below is yours to set: the template carries no owner, members, teams or visibility, and the
              tasks arrive unassigned.
            </div>
          </div>
        )}

        <div>
          <label style={label}>Name</label>
          <input autoFocus={!isMobile} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Project Name" style={inputStyle} />
        </div>

        {template && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            <div>
              <label style={label}>Start Date</label>
              <input type="date" value={form.startOn || ''} onChange={(e) => set({ startOn: e.target.value })}
                style={{ ...inputStyle, cursor: 'pointer' }} />
              <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
                {template.hasDates
                  ? 'Saved dates are day offsets - every one re-hangs from this date.'
                  : 'This template carries no dates, so tasks arrive without them.'}
              </div>
            </div>
            <div>
              <label style={label}>Tasks</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', padding: '7px 0' }}>
                <input type="checkbox" checked={form.includeTasks !== false}
                  onChange={(e) => set({ includeTasks: e.target.checked })} style={{ cursor: 'pointer' }} />
                Create the template's tasks
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: form.includeTasks === false ? 'default' : 'pointer', opacity: form.includeTasks === false ? 0.5 : 1 }}>
                <input type="checkbox" checked={form.resetStatus !== false} disabled={form.includeTasks === false}
                  onChange={(e) => set({ resetStatus: e.target.checked })} style={{ cursor: 'pointer' }} />
                Start them all at Not Started
              </label>
            </div>
          </div>
        )}

        <div>
          <label style={label}>Description</label>
          <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="What's this project about?" rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
        </div>

        <div>
          <label style={label}>Owner</label>
          <PersonSelect value={form.ownerId} onChange={(email) => set({ ownerId: email })} people={people} placeholder="No owner" />
        </div>

        <div>
          <label style={label}>Status</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={chip(statusMeta.color, statusMeta.tint)}>{statusMeta.label}</span>
            <span style={{ fontSize: 12.5, color: NX.faint }}>
              {form.id
                ? (stats.total
                    ? `Set automatically from task progress - ${stats.completed}/${stats.total} done.`
                    : 'Set automatically from task progress. This project has no tasks yet.')
                : 'Set automatically from task progress once this project has tasks.'}
            </span>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={label}>Department</label>
            {form.id ? (
              /* Editable: the creator's own department is only a first guess,
                 and a project raised by IT for Accounting belongs to Accounting.
                 Departments are company-scoped, so the label carries the company
                 when more than one is in play. */
              <SearchSelect value={form.hrDepartmentId || ''} placeholder="None" searchPlaceholder="Search departments…"
                emptyText="No departments yet." onPick={(id) => set({ hrDepartmentId: id })}
                buttonStyle={{ ...inputStyle, cursor: 'pointer', justifyContent: 'space-between' }}
                options={[{ id: '', label: 'None' },
                          /* A department deleted from People leaves the project's stored
                             name behind - keep it selectable rather than silently
                             switching the project to None on the next save. */
                          ...(form.hrDepartmentId && !departments.some((d) => d.id === form.hrDepartmentId)
                            ? [{ id: form.hrDepartmentId, label: form.hrDepartmentName || 'Current department' }] : []),
                          ...departments.map((d) => ({
                            id: d.id,
                            label: multiCompany && d.companyName ? `${d.companyName} - ${d.name}` : d.name,
                            keywords: d.companyName || '',
                          }))]} />
            ) : (
              <div style={{ fontSize: 12.5, color: NX.faint, padding: '8px 0' }}>
                Auto-populated from your own People-module profile once created.
              </div>
            )}
          </div>
          <div>
            <label style={label}>Portfolio</label>
            <SearchSelect value={form.portfolioId || ''} placeholder="None" searchPlaceholder="Search portfolios…"
              buttonStyle={{ ...inputStyle, cursor: 'pointer', justifyContent: 'space-between' }}
              emptyText="No portfolios yet."
              options={[{ id: '', label: 'None' },
                        ...portfolios.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
                          .map((pf) => ({ id: pf.id, label: pf.name }))]}
              onPick={(id) => set({ portfolioId: id })} />
          </div>
        </div>

        {projectFields.map((f) => (
          <div key={f.id}>
            <label style={label}>{f.name}</label>
            <CustomFieldInput field={f} value={(form.customFieldValues || {})[f.id]}
              onChange={(v) => set({ customFieldValues: { ...(form.customFieldValues || {}), [f.id]: v } })} />
            {f.description && <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>{f.description}</div>}
          </div>
        ))}

        <div>
          <label style={label}>Teams</label>
          {teams.length === 0 ? (
            <div style={{ fontSize: 12.5, color: NX.faint }}>No teams yet - create one from the Manage tab, then assign it here.</div>
          ) : (
            <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {teams.map((t) => {
                const on = teamIds.includes(t.id);
                return (
                  <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={() => toggleTeam(t.id)} style={{ cursor: 'pointer' }} />
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: t.color || NX.purple, flexShrink: 0 }} />
                    {/* No "currently elsewhere" marker: a team belongs to any number
                        of projects (TaskTeam.project_ids), so being on another one is
                        ordinary rather than a conflict worth flagging. The old marker
                        also read the legacy singular project_id - a write-only mirror of
                        project_ids[0] - so it fired on every project but the first in a
                        team's list, contradicting the ticked checkbox beside it. */}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <label style={label}>Who can access</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {VISIBILITY_OPTS.map((o) => (
              <button key={o.key} type="button" onClick={() => set({ accessLevel: o.key })} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', padding: 10, borderRadius: 10, border: `1px solid ${form.accessLevel === o.key ? NX.blue : NX.border}`, background: form.accessLevel === o.key ? 'rgba(37,99,235,0.10)' : NX.surface, cursor: 'pointer', fontFamily: FONT }}>
                <o.icon size={15} style={{ color: NX.dim, marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{o.label}</div>
                  <div style={{ fontSize: 11.5, color: NX.dim, marginTop: 1 }}>{o.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>


      </div>
    </Modal>
  );
}

// ── New project: the three ways in ───────────────────────────────────────────
// Asana's New-project dialog, same three choices: start blank, start from a
// template, or copy a project that already exists. One entry point everywhere
// (the Projects header, the mobile +, and the navbar Create menu) so none of
// them can offer a different set.
//
// Blank and template both land in ProjectModal - the template one with a
// `template` prop, because a blueprint carries no settings and so needs the
// same questions asked. Copy has its own dialog: a copy already HAS the
// settings, and what it needs instead is a "what should come across?" list.
const START_MODES = [
  {
    key: 'blank', icon: FolderKanban, label: 'Blank Project',
    desc: 'Start from nothing and add your own sections and tasks.',
  },
  {
    key: 'template', icon: LayoutTemplate, label: 'Use a Template',
    desc: 'Start from a saved blueprint - its sections, tasks, custom fields and statuses, with every saved date re-anchored to your start date.',
  },
  {
    key: 'copy', icon: Copy, label: 'From an Existing Project',
    desc: 'Copy a project you already have, with as much of its content and its people as you want to bring across.',
  },
];

export function ProjectCreateModal({ onClose, onCreated, defaults }) {
  const { portfolios, projects, projectTemplates, myEmail } = useTasks();
  const people = usePeople();
  const isMobile = useIsMobile();
  const [mode, setMode] = useState(null);          // null = the three-choice list
  const [template, setTemplate] = useState(null);  // picked template
  const [copyFrom, setCopyFrom] = useState(null);  // picked project
  const [pickQ, setPickQ] = useState('');          // filters the step-two list
  // Owner defaults to the creator - same as CreateTaskModal's task owner
  // default - still freely changeable in the form below.
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, ownerId: myEmail || null, ...(defaults || {}) }));
  const done = (p) => { onCreated && onCreated(p); onClose(); };

  // Picking a template seeds the form with its suggested name/description/color
  // and today as the anchor. All still editable - they are defaults the
  // template offers, not settings it imposes.
  const pickTemplate = (t) => {
    setTemplate(t);
    setForm((f) => ({
      ...f,
      name: t.defaults?.name || t.name || f.name,
      description: t.defaults?.description || f.description,
      color: t.defaults?.color || f.color,
      startOn: todayIso(),
      includeTasks: true, resetStatus: true,
    }));
  };

  if (mode === 'blank' || template) {
    return (
      <ProjectModal
        form={form} setForm={setForm} people={people} portfolios={portfolios}
        template={template}
        onClose={onClose}
        onSaved={done}
      />
    );
  }

  if (copyFrom) {
    return <DuplicateProjectModal project={copyFrom} onClose={onClose} onCreated={done} />;
  }

  const usable = (projectTemplates || []).filter((t) => !t.archived);
  const copyable = (projects || []).filter((p) => !p.archived)
    .slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  // Step two is a browse list rather than a dropdown: choosing a blueprint is a
  // "which one of these?" decision, and a select would hide the counts that
  // make one of them the right answer.
  const picker = (title, rows, empty, onPick, renderRow) => {
    // The list stays a browse list - the counts under each name are what make
    // one of them the right answer, and a dropdown would hide them - but it
    // gets a filter, because scrolling ~90 projects to find one is not
    // browsing.
    const needle = pickQ.trim().toLowerCase();
    const shown = needle
      ? rows.filter((r) => `${r.name || ''} ${r.description || ''} ${r.category || ''}`.toLowerCase().includes(needle))
      : rows;
    return (
    <div>
      <button onClick={() => { setMode(null); setPickQ(''); }}
        style={{ ...btn('ghost'), padding: '4px 6px', marginLeft: -6, marginBottom: 10, fontSize: 12.5, color: NX.dim }}>
        <ArrowLeft size={14} />Back
      </button>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 8 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12.5, color: NX.faint, padding: '14px 2px' }}>{empty}</div>
      ) : (
        <>
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
          <input autoFocus value={pickQ} onChange={(e) => setPickQ(e.target.value)} placeholder="Search…"
            style={{ ...inputStyle, paddingLeft: 30 }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '48vh', overflowY: 'auto' }}>
          {shown.length === 0 && (
            <div style={{ fontSize: 12.5, color: NX.faint, padding: '12px 2px' }}>No matches for &ldquo;{pickQ.trim()}&rdquo;.</div>
          )}
          {shown.map((r) => (
            <button key={r.id} type="button" onClick={() => onPick(r)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', width: '100%',
                padding: 11, borderRadius: 10, border: `1px solid ${NX.border}`, background: NX.surface,
                cursor: 'pointer', fontFamily: FONT,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = NX.blue; e.currentTarget.style.background = NX.hover; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = NX.border; e.currentTarget.style.background = NX.surface; }}>
              {renderRow(r)}
            </button>
          ))}
        </div>
        </>
      )}
    </div>
    );
  };

  const tile = (color) => ({
    width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', background: `${color}1f`, color,
  });

  return (
    <Modal
      title="New Project" onClose={onClose} width={mode ? 560 : 500}
      footer={<button style={btn('ghost')} onClick={onClose}>Cancel</button>}
    >
      {mode === 'template' ? picker(
        'Pick a template',
        usable,
        'No templates yet. Save a project as a template from the Projects list and it will show up here.',
        pickTemplate,
        (t) => (
          <>
            <span style={tile(t.color || NX.purple)}><LayoutTemplate size={15} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: NX.ink }}>{t.name}</span>
              <span style={{ display: 'block', fontSize: 11.5, color: NX.dim, marginTop: 2 }}>
                {t.taskCount} task{t.taskCount === 1 ? '' : 's'}
                {t.sectionCount ? ` · ${t.sectionCount} section${t.sectionCount === 1 ? '' : 's'}` : ''}
                {t.fieldCount ? ` · ${t.fieldCount} field${t.fieldCount === 1 ? '' : 's'}` : ''}
                {t.statusCount ? ` · ${t.statusCount} status${t.statusCount === 1 ? '' : 'es'}` : ''}
                {t.category ? ` · ${t.category}` : ''}
              </span>
              {t.description && (
                <span style={{ display: 'block', fontSize: 11.5, color: NX.faint, marginTop: 3 }}>{t.description}</span>
              )}
            </span>
          </>
        ),
      ) : mode === 'copy' ? picker(
        'Pick a project to copy',
        copyable,
        'No projects to copy yet.',
        setCopyFrom,
        (pr) => (
          <>
            <span style={tile(pr.color || NX.blue)}><FolderKanban size={15} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: NX.ink }}>{pr.name}</span>
              {pr.description && (
                <span style={{ display: 'block', fontSize: 11.5, color: NX.faint, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pr.description}</span>
              )}
            </span>
          </>
        ),
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {START_MODES.map((m) => (
            <button key={m.key} type="button" onClick={() => setMode(m.key)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12, textAlign: 'left', width: '100%',
                padding: isMobile ? 12 : 14, borderRadius: 12, border: `1px solid ${NX.border}`,
                background: NX.surface, cursor: 'pointer', fontFamily: FONT,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = NX.blue; e.currentTarget.style.background = NX.hover; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = NX.border; e.currentTarget.style.background = NX.surface; }}>
              <span style={{
                width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center', background: `${NX.blue}14`, color: NX.blue,
              }}><m.icon size={17} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: NX.ink }}>{m.label}</span>
                <span style={{ display: 'block', fontSize: 12, color: NX.dim, marginTop: 3, lineHeight: 1.45 }}>{m.desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

