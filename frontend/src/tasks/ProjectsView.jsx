// Task Module — Projects. A card grid of projects with live task rollups, an
// add/edit modal, and a drill-in that reuses the Tasks workspace locked to one
// project. Ported from the export's ProjectsPage/ProjectOverview into the Nexus
// inline-style idiom.
import { useMemo, useState } from 'react';
import { Plus, Search, FolderKanban, ArrowLeft, AlertTriangle, Pencil, Trash2, Archive } from 'lucide-react';
import { useTasks } from './TasksContext';
import { taskStats } from './lib';
import { NX, FONT, btn, input as inputStyle, card, chip, STATUS_ORDER, STATUS_META } from './theme';
import { Avatar, StatusChip, EmptyState, Modal, usePeople, PersonSelect } from './components';
import TasksWorkspace from './TasksWorkspace';

// A small palette of NX-ish swatches for the project colour picker.
const SWATCHES = [NX.blue, NX.purple, NX.teal, NX.green, NX.amber, NX.red, NX.pink, NX.dim];

const EMPTY_FORM = {
  name: '', description: '', color: NX.blue, ownerId: null,
  departmentId: '', portfolioId: '', status: 'not_started',
  startOn: '', dueOn: '', archived: false,
};

export default function ProjectsView({ onNavigate }) {
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

  // ── Drill-in: reuse the Tasks workspace locked to this project ──────────────
  if (openProject) {
    return (
      <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface }}>
          <button onClick={() => setOpenId(null)} style={{ ...btn('outline'), padding: '6px 10px' }}><ArrowLeft size={15} />Projects</button>
          <span style={{ width: 12, height: 12, borderRadius: 4, background: openProject.color || NX.blue, flexShrink: 0 }} />
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TasksWorkspace lockedProjectId={openProject.id} title={openProject.name} />
        </div>
      </div>
    );
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
