// Task Module - Projects. A card grid of projects with live task rollups, an
// add/edit modal, and a drill-in that reuses the Tasks workspace locked to one
// project. Ported from the export's ProjectsPage/ProjectOverview into the Nexus
// inline-style idiom.
import { useMemo, useState } from 'react';
import { Plus, Search, FolderKanban, AlertTriangle, Pencil, Trash2, Archive, Globe, Lock } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { taskStats, teamInProject, teamProjectIds } from './lib';
import { NX, FONT, btn, input as inputStyle, card, chip } from './theme';
import { Avatar, EmptyState, Modal, usePeople, PersonSelect, useIsMobile, MobileFab } from './components';
import TasksWorkspace from './TasksWorkspace';

const EMPTY_FORM = {
  name: '', description: '', color: NX.blue, ownerId: null,
  portfolioId: '', accessLevel: 'restricted', status: 'not_started',
  startOn: '', dueOn: '', archived: false,
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

/** Derive a project's status from its task rollup (see taskStats).
 *  `inProgress` counts too, not just `completed`: a project whose tasks are all
 *  underway but none finished sits at 0% and is still plainly not "Not Started". */
function projectStatusFor(stats) {
  if (!stats.total) return 'not_started';
  if (stats.completed >= stats.total) return 'completed';
  return (stats.completed > 0 || stats.inProgress > 0) ? 'in_progress' : 'not_started';
}

export default function ProjectsView({ onNavigate }) {
  const isMobile = useIsMobile();
  const store = useTasks();
  const { projects, portfolios, tasks, nameOf, portfolioById, teams,
    createProject, updateProject, deleteProject } = store;
  const people = usePeople();

  const [openId, setOpenId] = useState(null);      // drilled-into project
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);    // form object | null
  const [deleting, setDeleting] = useState(null);  // { project, mapped, alsoAsana, busy, err } | null

  // Rollups per project: count / done / progress / overdue, from live tasks.
  const cards = useMemo(() => {
    const q = search.trim().toLowerCase();
    // A team serves many projects, so this reads the team side of the link
    // rather than any single field on the project.
    const teamsOf = (pid) => (teams || []).filter((t) => teamInProject(t, pid));
    return projects
      .filter((p) => showArchived || !p.archived)
      .map((p) => ({ ...p, teams: teamsOf(p.id) }))
      // Team names are searchable too now that they are what the card shows.
      .filter((p) => !q || p.name.toLowerCase().includes(q)
        || (p.hrDepartmentName || '').toLowerCase().includes(q)
        || p.teams.some((t) => (t.name || '').toLowerCase().includes(q)))
      .map((p) => {
        const own = tasks.filter((t) => t.projectId === p.id);
        return { project: p, stats: taskStats(own) };
      })
      .sort((a, b) => Number(a.project.archived) - Number(b.project.archived)
        || a.project.name.localeCompare(b.project.name));
  }, [projects, tasks, teams, search, showArchived]);

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
    ownerId: p.ownerId || null, hrDepartmentName: p.hrDepartmentName || '', portfolioId: p.portfolioId || '',
    accessLevel: p.accessLevel || 'restricted',
    status: p.status || 'not_started', startOn: p.startOn || '', dueOn: p.dueOn || '', archived: !!p.archived,
  });

  // Deleting is permanent and takes the project's tasks and Asana sync state with
  // it, so it gets a real dialog - and for a synced project it must ask the one
  // question only the operator can answer: does the Asana project go too?
  const remove = async (p) => {
    let mapped = false;
    try { mapped = !!(await api.getTaskProjectAsanaLink(p.id)).mapped; } catch { /* unmapped or no access */ }
    setDeleting({ project: p, mapped, alsoAsana: false, busy: false, err: '' });
  };

  const confirmRemove = async () => {
    const { project, alsoAsana } = deleting;
    setDeleting((d) => ({ ...d, busy: true, err: '' }));
    try {
      await deleteProject(project.id, { deleteInAsana: alsoAsana });
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
          {/* Desktop keeps the labelled button; on mobile a floating + at the
              bottom of the screen creates a project instead (see MobileFab below). */}
          {!isMobile && <button style={{ ...btn('primary'), padding: '10px 18px', fontSize: 13.5, borderRadius: 10 }} onClick={startCreate}><Plus size={16} />New Project</button>}
        </div>
        {/* Search · Show archived - one line on mobile */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14, marginTop: isMobile ? 10 : 16, flexWrap: isMobile ? 'nowrap' : 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 0, maxWidth: isMobile ? 'none' : 420 }}>
            <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects…"
              style={{ ...inputStyle, paddingLeft: 40, paddingTop: isMobile ? 8 : 10, paddingBottom: isMobile ? 8 : 10, borderRadius: 999 }} />
          </div>
          <label title="Show Archived" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: isMobile ? 12 : 13, color: NX.dim, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ cursor: 'pointer' }} />
            {isMobile ? 'Archived' : 'Show archived'}
          </label>
        </div>
      </div>

      {/* Grid - grey body, white project cards */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas }}>
      {cards.length === 0 ? (
        <EmptyState icon={FolderKanban} title={search.trim() ? 'No Projects Match Your Search' : 'No Projects Yet'} hint={search.trim() ? undefined : 'Create your first project to group tasks and track progress.'} />
      ) : (
        <div className="nx-gutter" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: 14, padding: 16 }}>
          {cards.map(({ project: p, stats }) => {
            const pf = p.portfolioId ? portfolioById(p.portfolioId) : null;
            const dcolor = p.color || NX.blue;
            return (
              <div key={p.id} onClick={() => setOpenId(p.id)} style={{
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

      {deleting && (
        <DeleteProjectModal
          state={deleting}
          setState={setDeleting}
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
function DeleteProjectModal({ state, setState, onConfirm, onClose }) {
  const { project, mapped, alsoAsana, busy, err } = state;
  const set = (patch) => setState((d) => ({ ...d, ...patch }));

  return (
    <Modal
      title={`Delete "${project.name}"?`}
      onClose={busy ? () => {} : onClose}
      footer={(
        <>
          <button onClick={onClose} disabled={busy} style={btn('outline')}>Cancel</button>
          <button onClick={onConfirm} disabled={busy}
            style={{ ...btn('primary'), background: NX.red, borderColor: NX.red, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Deleting…' : (alsoAsana ? 'Delete in both' : 'Delete from Nexus')}
          </button>
        </>
      )}
    >
      <p style={{ fontSize: 13.5, color: NX.ink, marginBottom: 12 }}>
        This permanently deletes the project, <strong>all of its tasks</strong> (subtasks, comments and
        attachments included), and its teams. This can’t be undone.
      </p>

      {mapped ? (
        <>
          <p style={{ fontSize: 13, color: NX.dim, marginBottom: 10 }}>
            This project is synced with Asana. Its sync mapping and task links are cleared either way,
            so you can import it again from scratch and re-map it.
          </p>
          {[
            { key: false, label: 'Keep the Asana project', desc: 'Deletes the Nexus copy only. The Asana project stays exactly as it is - import it again whenever you want.' },
            { key: true, label: 'Delete it in Asana too', desc: 'Also deletes the Asana project. Asana keeps it in your trash for 30 days, but nothing will be left here to re-import.' },
          ].map((opt) => (
            <button key={String(opt.key)} type="button" onClick={() => set({ alsoAsana: opt.key })}
              style={{
                display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, cursor: 'pointer',
                padding: '10px 12px', borderRadius: 10, fontFamily: FONT,
                border: `1px solid ${alsoAsana === opt.key ? (opt.key ? NX.red : NX.primary) : NX.border}`,
                background: alsoAsana === opt.key ? (opt.key ? 'rgba(220,38,38,0.08)' : NX.hover) : 'transparent',
              }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: opt.key ? NX.red : NX.ink }}>{opt.label}</div>
              <div style={{ fontSize: 12, color: NX.dim, marginTop: 2 }}>{opt.desc}</div>
            </button>
          ))}
        </>
      ) : (
        <p style={{ fontSize: 12.5, color: NX.faint }}>This project isn’t synced with Asana.</p>
      )}

      {err && <div style={{ marginTop: 10, fontSize: 12.5, color: NX.red }}>{err}</div>}
    </Modal>
  );
}

// ── Add / Edit modal ─────────────────────────────────────────────────────────
// Owns the full save flow (project fields + team assignment diffs), since
// applying team assignments needs the project's id, which for a new project
// only exists after createProject resolves. Callers just get an onSaved(project)
// callback for their own post-save action (close, navigate, etc).
function ProjectModal({ form, setForm, people, portfolios, onClose, onSaved }) {
  const { teams, tasks, createProject, updateProject, updateTeam } = useTasks();
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  // Read-only: status is computed from this project's tasks, the same rollup the
  // card's progress bar draws. Shown rather than hidden so the modal answers
  // "why does it say that?" in place, instead of looking like a missing field.
  const stats = useMemo(() => taskStats(form.id ? tasks.filter((t) => t.projectId === form.id) : []), [tasks, form.id]);
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
  // Department instead (reported: fields "missing" in Chrome mobile, present
  // in Safari/Edge). Skipping autoFocus on mobile avoids triggering that
  // keyboard-open scroll entirely - desktop keeps the autofocus convenience.
  const isMobile = useIsMobile();

  // Teams currently assigned to this project (none yet for a brand-new one),
  // staged locally until Save so create and edit behave the same way.
  const [teamIds, setTeamIds] = useState(() => teams.filter((t) => teamInProject(t, form.id)).map((t) => t.id));
  const toggleTeam = (id) => setTeamIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const { id, ...data } = form;
      const project = id ? await updateProject(id, data) : await createProject(data);
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
    } catch {
      setSaving(false);
      window.alert('Could not save the project.');
    }
  };

  return (
    <Modal
      title={form.id ? 'Edit Project' : 'Create a Project'}
      onClose={onClose}
      footer={<>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: valid && !saving ? 1 : 0.5, pointerEvents: valid && !saving ? 'auto' : 'none' }} onClick={save}>{form.id ? 'Save Changes' : 'Create Project'}</button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={label}>Name</label>
          <input autoFocus={!isMobile} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Project Name" style={inputStyle} />
        </div>

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
              <div style={{ fontSize: 13, color: form.hrDepartmentName ? NX.ink : NX.faint, padding: '8px 0' }}>
                {form.hrDepartmentName || 'None - auto-populated from the creator’s People-module profile'}
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: NX.faint, padding: '8px 0' }}>
                Auto-populated from your own People-module profile once created.
              </div>
            )}
          </div>
          <div>
            <label style={label}>Portfolio</label>
            <select value={form.portfolioId} onChange={(e) => set({ portfolioId: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="">None</option>
              {portfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label style={label}>Teams</label>
          {teams.length === 0 ? (
            <div style={{ fontSize: 12.5, color: NX.faint }}>No teams yet - create one from the Manage tab, then assign it here.</div>
          ) : (
            <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {teams.map((t) => {
                const on = teamIds.includes(t.id);
                const elsewhere = t.projectId && t.projectId !== form.id;
                return (
                  <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={() => toggleTeam(t.id)} style={{ cursor: 'pointer' }} />
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: t.color || NX.purple, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                    {elsewhere && <span style={{ fontSize: 11, color: NX.faint, flexShrink: 0 }}>currently elsewhere</span>}
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

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: NX.ink, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.archived} onChange={(e) => set({ archived: e.target.checked })} style={{ cursor: 'pointer' }} />
          Archived
        </label>
      </div>
    </Modal>
  );
}

// Self-contained "create a project" modal that reuses the full ProjectModal form,
// so the navbar + Create menu matches the Projects tab exactly.
export function ProjectCreateModal({ onClose, onCreated, defaults }) {
  const { portfolios } = useTasks();
  const people = usePeople();
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, ...(defaults || {}) }));
  return (
    <ProjectModal
      form={form} setForm={setForm} people={people} portfolios={portfolios}
      onClose={onClose}
      onSaved={(p) => { onCreated && onCreated(p); onClose(); }}
    />
  );
}
