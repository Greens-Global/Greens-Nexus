// Task Module — Projects. A card grid of projects with live task rollups, an
// add/edit modal, and a drill-in that reuses the Tasks workspace locked to one
// project. Ported from the export's ProjectsPage/ProjectOverview into the Nexus
// inline-style idiom.
import { useMemo, useState } from 'react';
import { Plus, Search, FolderKanban, AlertTriangle, Pencil, Trash2, Archive } from 'lucide-react';
import { useTasks } from './TasksContext';
import { taskStats } from './lib';
import { NX, FONT, btn, input as inputStyle, card, chip } from './theme';
import { Avatar, StatusChip, EmptyState, Modal, usePeople, PersonSelect, useIsMobile } from './components';
import TasksWorkspace from './TasksWorkspace';

const EMPTY_FORM = {
  name: '', description: '', color: NX.blue, ownerId: null,
  departmentId: '', portfolioId: '', status: 'not_started',
  startOn: '', dueOn: '', archived: false,
};

export default function ProjectsView({ onNavigate }) {
  const isMobile = useIsMobile();
  const store = useTasks();
  const { projects, portfolios, departments, tasks, deptName, nameOf, portfolioById,
    createProject, updateProject, deleteProject } = store;
  const people = usePeople();

  const [openId, setOpenId] = useState(null);      // drilled-into project
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);    // form object | null

  // Rollups per project: count / done / progress / overdue, from live tasks.
  const cards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects
      .filter((p) => showArchived || !p.archived)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || deptName(p.departmentId).toLowerCase().includes(q))
      .map((p) => {
        const own = tasks.filter((t) => t.projectId === p.id);
        return { project: p, stats: taskStats(own) };
      })
      .sort((a, b) => Number(a.project.archived) - Number(b.project.archived)
        || a.project.name.localeCompare(b.project.name));
  }, [projects, tasks, search, showArchived, deptName]);

  const openProject = openId ? projects.find((p) => p.id === openId) : null;

  // ── Drill-in: reuse the Tasks workspace locked to this project. Its own Row 1
  // header owns the back arrow (icon-only) + project name/team, so no separate
  // header wrapper here. ──────────────────────────────────────────────────────
  if (openProject) {
    return <TasksWorkspace lockedProjectId={openProject.id} title={openProject.name} onBack={() => setOpenId(null)} />;
  }

  const startCreate = () => setEditing({ ...EMPTY_FORM });
  const startEdit = (p) => setEditing({
    id: p.id, name: p.name || '', description: p.description || '', color: p.color || NX.blue,
    ownerId: p.ownerId || null, departmentId: p.departmentId || '', portfolioId: p.portfolioId || '',
    status: p.status || 'not_started', startOn: p.startOn || '', dueOn: p.dueOn || '', archived: !!p.archived,
  });

  const remove = async (p) => {
    if (!window.confirm(`Delete project "${p.name}"? Its tasks will be unlinked.`)) return;
    try { await deleteProject(p.id); } catch { window.alert('Could not delete the project.'); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: NX.canvas }}>
      {/* Header — title/subtitle left, New Project top-right, full-width search below */}
      <div style={{ padding: isMobile ? '12px 12px 10px' : '20px 24px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: isMobile ? 20 : 26, fontWeight: 800, letterSpacing: '-0.02em' }}>Projects</div>
            {!isMobile && <div style={{ fontSize: 13.5, color: NX.dim, marginTop: 4 }}>Every project in the workspace with live task rollups.</div>}
          </div>
          {/* Desktop keeps the labelled button; on mobile it joins the row below
              as an icon (and the floating + also creates a project here). */}
          {!isMobile && <button style={{ ...btn('primary'), padding: '10px 18px', fontSize: 13.5, borderRadius: 10 }} onClick={startCreate}><Plus size={16} />New Project</button>}
        </div>
        {/* New Project · Search · Show archived — one line on mobile */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14, marginTop: isMobile ? 10 : 16, flexWrap: isMobile ? 'nowrap' : 'wrap' }}>
          {isMobile && (
            <button title="New Project" onClick={startCreate} style={{ ...btn('primary'), padding: 9, borderRadius: 10, flexShrink: 0 }}><Plus size={16} /></button>
          )}
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 0, maxWidth: isMobile ? 'none' : 420 }}>
            <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects…"
              style={{ ...inputStyle, paddingLeft: 40, paddingTop: isMobile ? 8 : 10, paddingBottom: isMobile ? 8 : 10, borderRadius: 999 }} />
          </div>
          <label title="Show archived" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: isMobile ? 12 : 13, color: NX.dim, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ cursor: 'pointer' }} />
            {isMobile ? 'Archived' : 'Show archived'}
          </label>
        </div>
      </div>

      {/* Grid — grey body, white project cards */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas }}>
      {cards.length === 0 ? (
        <EmptyState icon={FolderKanban} title={search.trim() ? 'No projects match your search' : 'No projects yet'} hint={search.trim() ? undefined : 'Create your first project to group tasks and track progress.'} />
      ) : (
        <div className="nx-gutter" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: 14, padding: 16 }}>
          {cards.map(({ project: p, stats }) => {
            const pf = p.portfolioId ? portfolioById(p.portfolioId) : null;
            const dcolor = p.color || NX.blue;
            return (
              <div key={p.id} onClick={() => setOpenId(p.id)} style={{
                ...card, padding: 15, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 11,
                opacity: p.archived ? 0.62 : 1, position: 'relative',
              }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = NX.border; e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,0.06)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = NX.border; e.currentTarget.style.boxShadow = 'none'; }}>
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

                {/* Footer: owner + portfolio + status */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto', paddingTop: 3 }}>
                  {p.ownerId ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <Avatar email={p.ownerId} name={nameOf(p.ownerId)} size={22} />
                      <span style={{ fontSize: 12, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(p.ownerId)}</span>
                    </span>
                  ) : <span style={{ fontSize: 12, color: NX.faint }}>No owner</span>}
                  {pf && <span style={chip(NX.purple, `${NX.purple}1a`)}>{pf.name}</span>}
                  <span style={{ marginLeft: 'auto' }}><StatusChip status={p.status} /></span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>

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
            } catch { window.alert('Could not save the project.'); }
          }}
        />
      )}
    </div>
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
          <label style={label}>Owner</label>
          <PersonSelect value={form.ownerId} onChange={(email) => set({ ownerId: email })} people={people} placeholder="No owner" />
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

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: NX.ink, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.archived} onChange={(e) => set({ archived: e.target.checked })} style={{ cursor: 'pointer' }} />
          Archived
        </label>
      </div>
    </Modal>
  );
}
