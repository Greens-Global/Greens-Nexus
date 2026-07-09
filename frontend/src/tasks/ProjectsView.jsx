// Task Module — Projects. A card grid of projects with live task rollups
// (progress / overdue / task-assignee avatars), an add/edit modal, and a rich
// project workspace popup: an Overview surface (description, health status,
// activity feed, roles, connected portfolios, due date) plus the Tasks
// workspace locked to the project. Ported from the export's ProjectsPage /
// ProjectOverview / ProjectPopup into the Nexus inline-style idiom.
//
// Access scoping: the source (ProjectsPage) gated non-admins to only the
// projects in departments they belong to (store.isAdmin ? all : dept members).
// Nexus's task store exposes no isAdmin here, so — best-effort — we show all
// projects to everyone. Re-introduce a dept-membership filter here if the store
// later surfaces the current user's admin flag.
import { useMemo, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, Search, FolderKanban, AlertTriangle, Pencil, Trash2, Archive,
  MoreHorizontal, Calendar, MessageSquare, UserPlus, Briefcase, X,
  CheckCircle2, CircleDot, Maximize2, Minimize2,
} from 'lucide-react';
import { useTasks } from './TasksContext';
import { taskStats } from './lib';
import {
  NX, FONT, btn, input as inputStyle, card, chip,
  STATUS_ORDER, STATUS_META, PROJECT_STATUS_META, PROJECT_STATUS_ORDER,
} from './theme';
import { Avatar, StatusChip, EmptyState, Modal, usePeople, PersonSelect } from './components';
import { useConfirm, toast, Popover } from './shared';
import TasksWorkspace from './TasksWorkspace';

// A small palette of NX-ish swatches for the project colour picker.
const SWATCHES = [NX.blue, NX.purple, NX.teal, NX.green, NX.amber, NX.red, NX.pink, NX.dim];

const EMPTY_FORM = {
  name: '', description: '', color: NX.blue, ownerId: null,
  departmentId: '', portfolioId: '', status: 'not_started',
  startOn: '', dueOn: '', archived: false,
};

// ── Per-project overview metadata (health status + activity feed) ────────────
// Description and due date persist server-side (updateProject), but the port's
// project model has no health-status/activity columns — so, like the source's
// projectMeta.ts, these live in localStorage keyed by project id.
const META_KEY = 'nexus.projectMeta';
const EMPTY_META = { status: 'none', activity: [] };
function readAllMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; }
}
function writeAllMeta(all) {
  try { localStorage.setItem(META_KEY, JSON.stringify(all)); } catch { /* quota / private mode */ }
}
function useProjectMeta(projectId) {
  const [meta, setMeta] = useState(() => ({ ...EMPTY_META, ...readAllMeta()[projectId] }));

  const commit = useCallback((updater) => {
    setMeta((prev) => {
      const merged = updater(prev);
      const all = readAllMeta();
      all[projectId] = merged;
      writeAllMeta(all);
      return merged;
    });
  }, [projectId]);

  const setStatus = useCallback((status, byId) => {
    commit((prev) => {
      const label = status === 'none'
        ? 'cleared the status'
        : `set status to ${PROJECT_STATUS_META[status]?.label ?? status}`;
      const entry = { id: `pa-${Date.now()}`, kind: 'status', at: new Date().toISOString(), byId: byId || undefined, status, text: label };
      return { ...prev, status, activity: [entry, ...prev.activity].slice(0, 40) };
    });
  }, [commit]);

  const addActivity = useCallback((entry) => {
    commit((prev) => ({ ...prev, activity: [entry, ...prev.activity].slice(0, 40) }));
  }, [commit]);

  return { meta, setStatus, addActivity };
}

// Overlapping avatar stack (up to `max` distinct emails, +N overflow chip).
function AvatarStack({ emails, nameOf, size = 24, max = 4 }) {
  const shown = emails.slice(0, max);
  const extra = emails.length - shown.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {shown.map((e, i) => (
        <span key={e} style={{ marginLeft: i ? -6 : 0, borderRadius: '50%', boxShadow: `0 0 0 2px ${NX.surface}`, display: 'inline-flex' }}>
          <Avatar email={e} name={nameOf(e)} size={size} />
        </span>
      ))}
      {extra > 0 && (
        <span style={{ marginLeft: -6, width: size, height: size, borderRadius: '50%', background: NX.border2, color: NX.dim, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.36, fontWeight: 700, boxShadow: `0 0 0 2px ${NX.surface}` }}>+{extra}</span>
      )}
    </div>
  );
}

export default function ProjectsView({ onNavigate }) {   // eslint-disable-line no-unused-vars
  const store = useTasks();
  const { projects, portfolios, departments, tasks, deptName, nameOf, portfolioById,
    createProject, updateProject, deleteProject } = store;
  const people = usePeople();
  const [confirm, confirmNode] = useConfirm();

  const [openId, setOpenId] = useState(null);      // project opened in popup
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);    // form object | null

  // Rollups per project: count / done / progress / overdue + distinct assignees.
  const cards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects
      .filter((p) => showArchived || !p.archived)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || deptName(p.departmentId).toLowerCase().includes(q))
      .map((p) => {
        const own = tasks.filter((t) => t.projectId === p.id);
        const assignees = [...new Set(own.map((t) => t.assigneeId).filter(Boolean))];
        return { project: p, stats: taskStats(own), assignees };
      })
      .sort((a, b) => Number(a.project.archived) - Number(b.project.archived)
        || a.project.name.localeCompare(b.project.name));
  }, [projects, tasks, search, showArchived, deptName]);

  const openProject = openId ? projects.find((p) => p.id === openId) : null;

  const startCreate = () => setEditing({ ...EMPTY_FORM });
  const startEdit = (p) => setEditing({
    id: p.id, name: p.name || '', description: p.description || '', color: p.color || NX.blue,
    ownerId: p.ownerId || null, departmentId: p.departmentId || '', portfolioId: p.portfolioId || '',
    status: p.status || 'not_started', startOn: p.startOn || '', dueOn: p.dueOn || '', archived: !!p.archived,
  });

  const remove = async (p) => {
    const ok = await confirm({
      title: 'Delete project?',
      message: `Delete project "${p.name}"? Its tasks will be unlinked, not deleted.`,
      confirmLabel: 'Delete project', danger: true,
    });
    if (!ok) return;
    try { await deleteProject(p.id); toast('Project deleted', 'success'); }
    catch { toast('Could not delete the project.'); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', overflow: 'auto', background: NX.surface }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: `1px solid ${NX.border}`, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700 }}>Projects</div>
          <div style={{ fontSize: 12.5, color: NX.dim, marginTop: 1 }}>Every project with live task rollups.</div>
        </div>
        <div style={{ position: 'relative', minWidth: 200, flex: '1 1 200px', maxWidth: 320, marginLeft: 'auto' }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects…" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: NX.dim, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ cursor: 'pointer' }} />
          Show archived
        </label>
        <button style={btn('primary')} onClick={startCreate}><Plus size={15} />New project</button>
      </div>

      {/* Grid */}
      {cards.length === 0 ? (
        <EmptyState icon={FolderKanban} title={search.trim() ? 'No projects match your search' : 'No projects yet'} hint={search.trim() ? undefined : 'Create your first project to group tasks and track progress.'} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14, padding: 16 }}>
          {cards.map(({ project: p, stats, assignees }) => {
            const pf = p.portfolioId ? portfolioById(p.portfolioId) : null;
            const dcolor = p.color || NX.blue;
            return (
              <div key={p.id} onClick={() => setOpenId(p.id)} style={{
                ...card, padding: 15, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 11,
                opacity: p.archived ? 0.62 : 1, position: 'relative',
              }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,0.06)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; }}>
                {/* Header: swatch + name + row actions */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${dcolor}1a`, color: dcolor }}>
                    <FolderKanban size={17} />
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                      {p.departmentId && deptName(p.departmentId) && <span style={chip(dcolor, `${dcolor}1a`)}>{deptName(p.departmentId)}</span>}
                      {p.archived && <span style={chip(NX.faint, NX.border2)}><Archive size={11} />Archived</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 2 }} onClick={(e) => e.stopPropagation()}>
                    <button title="Edit project" onClick={() => startEdit(p)} style={{ ...btn('ghost'), padding: 5 }}><Pencil size={14} /></button>
                    <button title="Delete project" onClick={() => remove(p)} style={{ ...btn('ghost'), padding: 5, color: NX.red }}><Trash2 size={14} /></button>
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
                    <div style={{ height: '100%', width: `${stats.pct}%`, borderRadius: 999, background: NX.green, transition: 'width 0.2s' }} />
                  </div>
                </div>

                {/* Footer: task-assignee avatars + portfolio + status */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto', paddingTop: 3 }}>
                  {assignees.length ? (
                    <AvatarStack emails={assignees} nameOf={nameOf} size={22} />
                  ) : <span style={{ fontSize: 12, color: NX.faint }}>No assignees</span>}
                  {pf && <span style={chip(NX.purple, `${NX.purple}1a`)}>{pf.name}</span>}
                  <span style={{ marginLeft: 'auto' }}><StatusChip status={p.status} /></span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openProject && (
        <ProjectPopup project={openProject} store={store} people={people} onClose={() => setOpenId(null)} />
      )}

      {editing && (
        <ProjectModal
          form={editing}
          setForm={setEditing}
          people={people}
          departments={departments}
          portfolios={portfolios}
          onClose={() => setEditing(null)}
          onSave={async () => {
            const { id, ...data } = editing;
            try {
              if (id) await updateProject(id, data);
              else await createProject(data);
              setEditing(null);
              toast(id ? 'Project saved' : 'Project created', 'success');
            } catch { toast('Could not save the project.'); }
          }}
        />
      )}

      {confirmNode}
    </div>
  );
}

// ── Project workspace popup ──────────────────────────────────────────────────
// Maximizable overlay with an Overview tab (rich surface) + a Tasks tab that
// reuses TasksWorkspace locked to this project. The source split the task views
// into separate List/Board/Timeline/Calendar/Dashboard/Files tabs, but Nexus's
// TasksWorkspace already carries its own view switcher for exactly those, so we
// delegate all of them to a single "Tasks" tab (see report note).
const POPUP_TABS = [{ key: 'overview', label: 'Overview' }, { key: 'tasks', label: 'Tasks' }];

function ProjectPopup({ project, store, people, onClose }) {
  const { deptById } = store;
  const dept = project.departmentId ? deptById(project.departmentId) : null;
  const memberEmails = dept?.memberIds || [];
  const [maximized, setMaximized] = useState(false);
  const [tab, setTab] = useState('overview');

  const shown = memberEmails.slice(0, 4);
  const extra = memberEmails.length - shown.length;
  const deptColor = dept?.color || project.color || NX.blue;

  return createPortal(
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 4500, background: 'rgba(17,24,39,0.42)',
        display: 'flex', fontFamily: FONT,
        alignItems: maximized ? 'stretch' : 'center', justifyContent: maximized ? 'stretch' : 'center',
        padding: maximized ? 0 : 16,
      }}
    >
      <div style={{
        display: 'flex', flexDirection: 'column', overflow: 'hidden', background: NX.surface,
        border: `1px solid ${NX.border}`, boxShadow: '0 24px 70px rgba(0,0,0,0.32)',
        width: maximized ? '100%' : '95vw', height: maximized ? '100%' : '92vh',
        maxWidth: maximized ? 'none' : 1600, borderRadius: maximized ? 0 : 18,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: `1px solid ${NX.border}`, flexShrink: 0 }}>
          <span style={{ width: 36, height: 36, borderRadius: 11, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${deptColor}1a`, color: deptColor }}>
            <FolderKanban size={18} />
          </span>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>{project.name || 'Project'}</h2>
          {dept && <span style={{ ...chip(deptColor, `${deptColor}1a`), flexShrink: 0 }}>{dept.name}</span>}
          <div style={{ display: 'flex', alignItems: 'center', marginLeft: 6 }}>
            {shown.map((e, i) => (
              <span key={e} title={store.nameOf(e)} style={{ marginLeft: i ? -8 : 0, borderRadius: '50%', boxShadow: `0 0 0 2px ${NX.surface}`, display: 'inline-flex' }}>
                <Avatar email={e} name={store.nameOf(e)} size={26} />
              </span>
            ))}
            {extra > 0 && (
              <span style={{ marginLeft: -8, width: 24, height: 24, borderRadius: '50%', background: NX.border2, color: NX.dim, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, boxShadow: `0 0 0 2px ${NX.surface}` }}>+{extra}</span>
            )}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => setMaximized((m) => !m)} style={{ ...btn('ghost'), padding: '6px 10px' }} title={maximized ? 'Restore' : 'Expand to full page'}>
              {maximized ? <><Minimize2 size={14} />Restore</> : <><Maximize2 size={14} />Full page</>}
            </button>
            <button onClick={onClose} style={{ ...btn('ghost'), padding: 6 }} title="Close" aria-label="Close"><X size={18} /></button>
          </div>
        </div>

        {/* Tabs */}
        <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 14px', borderBottom: `1px solid ${NX.border}`, flexShrink: 0, overflowX: 'auto' }}>
          {POPUP_TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              ...btn('ghost'), borderRadius: 0, padding: '11px 12px',
              borderBottom: `2px solid ${tab === t.key ? NX.ink : 'transparent'}`,
              color: tab === t.key ? NX.ink : NX.dim, fontWeight: 600,
            }}>{t.label}</button>
          ))}
        </div>

        {/* Body */}
        {tab === 'overview' ? (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 24 }}>
            <ProjectOverview key={project.id} project={project} store={store} people={people} />
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0 }}>
            <TasksWorkspace lockedProjectId={project.id} title={project.name} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Project overview surface ─────────────────────────────────────────────────
function ProjectOverview({ project, store, people }) {
  const { updateProject, updateDepartment, updatePortfolio, deptById, portfolios, nameOf, myEmail } = store;
  const { meta, setStatus, addActivity } = useProjectMeta(project.id);
  const [descDraft, setDescDraft] = useState(project.description || '');

  const dept = project.departmentId ? deptById(project.departmentId) : null;
  const memberEmails = dept?.memberIds || [];
  const ownerId = project.ownerId || memberEmails[0] || null;

  const connected = useMemo(() => portfolios.filter((pf) => (pf.projectIds || []).includes(project.id)), [portfolios, project.id]);
  const otherPortfolios = useMemo(() => portfolios.filter((pf) => !(pf.projectIds || []).includes(project.id)), [portfolios, project.id]);

  const saveDesc = () => {
    if (descDraft !== (project.description || '')) {
      updateProject(project.id, { description: descDraft }).catch(() => toast('Could not save the description.'));
    }
  };

  const addMember = (email) => {
    if (!dept) { toast('Assign this project to a department first.'); return; }
    if (memberEmails.includes(email)) return;
    updateDepartment(dept.id, { memberIds: [...memberEmails, email] })
      .then(() => {
        addActivity({ id: `pa-${Date.now()}`, kind: 'member_joined', at: new Date().toISOString(), byId: email, text: `${nameOf(email)} joined` });
        toast(`${(nameOf(email) || 'Member').split(' ')[0]} added`, 'success');
      })
      .catch(() => toast('Could not add the member.'));
  };

  const addToPortfolio = (pfId) => {
    const pf = portfolios.find((x) => x.id === pfId);
    if (!pf) return;
    updatePortfolio(pfId, { projectIds: [...(pf.projectIds || []), project.id] })
      .then(() => toast(`Added to "${pf.name}"`, 'success'))
      .catch(() => toast('Could not update the portfolio.'));
  };
  const removeFromPortfolio = (pfId) => {
    const pf = portfolios.find((x) => x.id === pfId);
    if (!pf) return;
    updatePortfolio(pfId, { projectIds: (pf.projectIds || []).filter((id) => id !== project.id) })
      .catch(() => toast('Could not update the portfolio.'));
  };

  const curStatus = meta.status !== 'none' ? PROJECT_STATUS_META[meta.status] : null;
  const heading = { fontSize: 17, fontWeight: 700, color: NX.ink, marginBottom: 12 };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
      {/* Left column */}
      <div style={{ flex: '1 1 420px', minWidth: 0 }}>
        <section style={{ marginBottom: 30 }}>
          <h2 style={{ ...heading, marginBottom: 8 }}>Project description</h2>
          <textarea
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            onBlur={saveDesc}
            placeholder="What's this project about?"
            rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT, lineHeight: 1.5 }}
          />
        </section>

        <section style={{ marginBottom: 30 }}>
          <h2 style={heading}>Project roles</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
            <AddMemberMenu people={people} exclude={memberEmails} onPick={addMember} />
            {memberEmails.map((email) => (
              <div key={email} style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <Avatar email={email} name={nameOf(email)} size={38} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(email)}</div>
                  <div style={{ fontSize: 12, color: NX.faint }}>{email === ownerId ? 'Project owner' : 'Member'}</div>
                </div>
              </div>
            ))}
          </div>
          {memberEmails.length === 0 && !dept && (
            <div style={{ fontSize: 13, color: NX.faint, marginTop: 10 }}>Assign this project to a department to add members.</div>
          )}
        </section>

        <section>
          <h2 style={heading}>Connected portfolios</h2>
          {connected.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {connected.map((pf) => (
                <div key={pf.id} style={{ display: 'flex', alignItems: 'center', gap: 10, ...card, padding: '10px 12px' }}>
                  <span style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${NX.purple}26`, color: NX.purple }}><Briefcase size={14} /></span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pf.name}</span>
                  <button onClick={() => removeFromPortfolio(pf.id)} title="Remove from portfolio" style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><X size={14} /></button>
                </div>
              ))}
              <AddPortfolioMenu otherPortfolios={otherPortfolios} onAdd={addToPortfolio} />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, border: `1px dashed ${NX.border}`, borderRadius: 14, padding: '28px 16px', textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: NX.dim, margin: 0 }}>Connect a portfolio to link this project to a larger body of work.</p>
              <AddPortfolioMenu otherPortfolios={otherPortfolios} onAdd={addToPortfolio} />
            </div>
          )}
        </section>
      </div>

      {/* Right: status panel */}
      <aside style={{ flex: '1 1 300px', maxWidth: 360, background: NX.surface2, borderRadius: 16, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: NX.ink, margin: 0 }}>What's the status?</h2>
          <Popover width={208} align="right" trigger={(toggle) => (
            <button onClick={toggle} style={{ ...btn('ghost'), padding: 5 }} title="More"><MoreHorizontal size={18} /></button>
          )}>
            {(close) => (
              <>
                <div onClick={() => { setStatus('complete', myEmail); close(); }} style={menuRow}>
                  <CheckCircle2 size={15} style={{ color: NX.blue }} />Complete project
                </div>
                <div onClick={() => { toast('Status update requested from members', 'success'); close(); }} style={menuRow}>
                  <CircleDot size={15} style={{ color: NX.faint }} />Request status update
                </div>
              </>
            )}
          </Popover>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {PROJECT_STATUS_ORDER.slice(0, 3).map((k) => {
            const m = PROJECT_STATUS_META[k];
            const active = meta.status === k;
            return (
              <button key={k} onClick={() => setStatus(active ? 'none' : k, myEmail)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 999,
                fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
                background: active ? m.color : NX.surface, color: active ? '#fff' : NX.ink,
                border: `1px solid ${active ? m.color : NX.border}`,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: active ? '#fff' : m.color }} />{m.label}
              </button>
            );
          })}
        </div>

        {curStatus && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13, fontWeight: 600, color: curStatus.color }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: curStatus.color }} />{curStatus.label}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 13, color: NX.dim }}>
          <Calendar size={15} style={{ color: NX.faint, flexShrink: 0 }} />
          <input
            type="date"
            value={project.dueOn || ''}
            onChange={(e) => updateProject(project.id, { dueOn: e.target.value || '' }).catch(() => toast('Could not save the due date.'))}
            aria-label="Project due date"
            style={{ ...inputStyle, width: 'auto', padding: '5px 8px', cursor: 'pointer' }}
          />
          {!project.dueOn && <span style={{ color: NX.faint }}>No due date</span>}
        </div>

        <button onClick={() => toast('Message sent to project members', 'success')} style={{ ...btn('ghost'), padding: 0, color: NX.blue, marginBottom: 16 }}>
          <MessageSquare size={15} />Send message to members
        </button>

        <div style={{ borderTop: `1px solid ${NX.border}`, paddingTop: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {meta.activity.length === 0 && <div style={{ fontSize: 12, color: NX.faint }}>No activity yet. Set a status or add members.</div>}
            {meta.activity.map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 10 }}>
                <span style={{ marginTop: 1, flexShrink: 0, color: NX.faint }}>{a.kind === 'member_joined' ? <UserPlus size={15} /> : <CircleDot size={15} />}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, color: NX.ink }}>{a.text}</div>
                  <div style={{ fontSize: 11, color: NX.faint }}>{(a.at || '').slice(0, 10)}</div>
                  {a.byId && <div style={{ marginTop: 5 }}><Avatar email={a.byId} name={nameOf(a.byId)} size={22} /></div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

const menuRow = {
  display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 7,
  fontSize: 13, cursor: 'pointer', color: NX.ink,
};

// Add-member dropdown: filterable directory list, excludes existing members.
function AddMemberMenu({ people, exclude, onPick }) {
  const [q, setQ] = useState('');
  const available = people.filter((p) => !exclude.includes(p.email));
  const filtered = q ? available.filter((p) => (p.name + p.email).toLowerCase().includes(q.toLowerCase())) : available;
  return (
    <Popover width={272} trigger={(toggle) => (
      <button onClick={toggle} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontFamily: FONT, textAlign: 'left' }}>
        <span style={{ width: 38, height: 38, borderRadius: '50%', border: `1px dashed ${NX.border}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: NX.dim }}><Plus size={16} /></span>
        <span style={{ fontSize: 14, fontWeight: 600, color: NX.dim }}>Add member</span>
      </button>
    )}>
      {(close) => (
        <>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add from directory…" style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '8px 10px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box' }} />
          {filtered.map((p) => (
            <div key={p.email} onClick={() => { onPick(p.email); close(); }} style={{ ...menuRow }}>
              <Avatar email={p.email} name={p.name} size={22} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </div>
          ))}
          {filtered.length === 0 && <div style={{ padding: 10, fontSize: 12, color: NX.faint }}>No people to add.</div>}
        </>
      )}
    </Popover>
  );
}

// Add-to-portfolio dropdown.
function AddPortfolioMenu({ otherPortfolios, onAdd }) {
  return (
    <Popover width={224} trigger={(toggle) => (
      <button onClick={toggle} style={{ ...btn('outline'), alignSelf: 'flex-start', padding: '7px 10px', fontSize: 12 }}>
        <FolderKanban size={13} />Add to portfolio
      </button>
    )}>
      {(close) => (
        otherPortfolios.length ? otherPortfolios.map((pf) => (
          <div key={pf.id} onClick={() => { onAdd(pf.id); close(); }} style={menuRow}>
            <Briefcase size={14} style={{ color: NX.purple }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pf.name}</span>
          </div>
        )) : <div style={{ padding: 10, fontSize: 12, color: NX.faint }}>No other portfolios.</div>
      )}
    </Popover>
  );
}

// ── Add / Edit modal ─────────────────────────────────────────────────────────
function ProjectModal({ form, setForm, people, departments, portfolios, onClose, onSave }) {
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const label = { fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
  const valid = form.name.trim().length > 0;

  return (
    <Modal
      title={form.id ? 'Edit project' : 'Add project'}
      onClose={onClose}
      footer={<>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: valid ? 1 : 0.5, pointerEvents: valid ? 'auto' : 'none' }} onClick={onSave}>{form.id ? 'Save changes' : 'Create project'}</button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={label}>Name</label>
          <input autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Project name" style={inputStyle} />
        </div>

        <div>
          <label style={label}>Description</label>
          <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="What's this project about?" rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
        </div>

        <div>
          <label style={label}>Colour</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {SWATCHES.map((c) => (
              <button key={c} type="button" onClick={() => set({ color: c })} aria-label={c} style={{
                width: 26, height: 26, borderRadius: 8, background: c, cursor: 'pointer',
                border: form.color === c ? `2px solid ${NX.ink}` : '2px solid transparent',
                boxShadow: form.color === c ? `0 0 0 2px ${NX.surface} inset` : 'none',
              }} />
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={label}>Owner</label>
            <PersonSelect value={form.ownerId} onChange={(email) => set({ ownerId: email })} people={people} placeholder="No owner" />
          </div>
          <div>
            <label style={label}>Status</label>
            <select value={form.status} onChange={(e) => set({ status: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }}>
              {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={label}>Department</label>
            <select value={form.departmentId} onChange={(e) => set({ departmentId: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="">None</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label style={label}>Portfolio</label>
            <select value={form.portfolioId} onChange={(e) => set({ portfolioId: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="">None</option>
              {portfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={label}>Start date</label>
            <input type="date" value={form.startOn || ''} onChange={(e) => set({ startOn: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }} />
          </div>
          <div>
            <label style={label}>Due date</label>
            <input type="date" value={form.dueOn || ''} onChange={(e) => set({ dueOn: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }} />
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: NX.ink, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.archived} onChange={(e) => set({ archived: e.target.checked })} style={{ cursor: 'pointer' }} />
          Archived
        </label>
      </div>
    </Modal>
  );
}
