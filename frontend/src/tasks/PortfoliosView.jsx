// Task Module — Portfolios. Grid of portfolio cards with a task rollup, plus a
// per-portfolio detail view (member projects + add/remove/reorder). Ported from
// the export's PortfoliosPage/PortfolioDetailPage into Nexus inline-style idiom.
import { useMemo, useState } from 'react';
import {
  Briefcase, Plus, Search, Pencil, Trash2, FolderKanban, ArrowLeft, ArrowRight,
  AlertTriangle, ArrowUp, ArrowDown, X, Archive, ArchiveRestore, Check,
} from 'lucide-react';
import { useTasks } from './TasksContext';
import { taskStats, topLevel } from './lib';
import { NX, FONT, btn, input as inputStyle, card, chip } from './theme';
import { Avatar, EmptyState, Modal, usePeople, PersonSelect } from './components';

const COLOR_CHOICES = [NX.purple, NX.blue, NX.green, NX.teal, NX.amber, NX.red, NX.pink, NX.dim];

// Progress bar (accent-coloured) used on cards and project rows.
function ProgressBar({ pct, color, height = 8 }) {
  return (
    <div style={{ flex: 1, height, borderRadius: 999, background: NX.border2, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, borderRadius: 999, background: color, transition: 'width 0.2s' }} />
    </div>
  );
}

export default function PortfoliosView({ onNavigate }) {
  const store = useTasks();
  const { portfolios, projects, tasks, projectById, nameOf, createPortfolio, updatePortfolio, deletePortfolio } = store;
  const people = usePeople();

  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);   // portfolio object, or {} for new, or null
  const [detailId, setDetailId] = useState(null);

  // Top-level, non-section tasks only — matches the workspace's rollup basis.
  const topTasks = useMemo(() => topLevel(tasks), [tasks]);
  const rollup = (projectIds = []) => taskStats(topTasks.filter((t) => t.projectId && projectIds.includes(t.projectId)));

  // ── Detail view ────────────────────────────────────────────────────────────
  if (detailId) {
    const pf = portfolios.find((p) => p.id === detailId);
    if (!pf) { setDetailId(null); return null; }
    return (
      <PortfolioDetail
        pf={pf} store={store} rollup={rollup} people={people}
        onBack={() => setDetailId(null)} onNavigate={onNavigate}
        onEdit={() => setEditing(pf)}
      />
    );
  }

  // ── Grid ─────────────────────────────────────────────────────────────────
  const q = search.trim().toLowerCase();
  const visible = portfolios
    .filter((p) => (showArchived ? true : !p.archived))
    .filter((p) => (q ? (p.name || '').toLowerCase().includes(q) : true));

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${NX.border}`, flexWrap: 'wrap', background: NX.surface }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Portfolios</div>
        <div style={{ position: 'relative', minWidth: 200, flex: '1 1 200px', maxWidth: 340 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search portfolios…" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: NX.dim, cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ cursor: 'pointer' }} />
          Show archived
        </label>
        <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={() => setEditing({})}><Plus size={15} />New portfolio</button>
      </div>

      {/* Body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, padding: 16 }}>
        {visible.length === 0 ? (
          <EmptyState icon={Briefcase} title="No portfolios yet" hint="Group projects into a portfolio to track their combined progress." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
            {visible.map((pf) => {
              const accent = pf.color || NX.purple;
              const r = rollup(pf.projectIds);
              const nProjects = (pf.projectIds || []).length;
              return (
                <div key={pf.id} onClick={() => setDetailId(pf.id)}
                  style={{ ...card, padding: 15, cursor: 'pointer', opacity: pf.archived ? 0.62 : 1, display: 'flex', flexDirection: 'column', gap: 12, position: 'relative', transition: 'box-shadow 0.13s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: `${accent}1a`, color: accent }}><Briefcase size={19} /></span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pf.name}</span>
                        {pf.archived && <span style={chip(NX.dim, NX.border2)}>Archived</span>}
                      </div>
                      {pf.description && <div style={{ fontSize: 12.5, color: NX.dim, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{pf.description}</div>}
                    </div>
                    <button title="Edit portfolio" onClick={(e) => { e.stopPropagation(); setEditing(pf); }} style={{ ...btn('ghost'), padding: 6 }}><Pencil size={15} /></button>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: NX.dim }}>
                    <FolderKanban size={14} style={{ color: NX.faint }} />
                    <span>{nProjects} {nProjects === 1 ? 'project' : 'projects'}</span>
                    <span style={{ color: NX.faint }}>·</span>
                    <span>{r.completed}/{r.total} tasks</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <ProgressBar pct={r.pct} color={accent} />
                    <span style={{ width: 34, textAlign: 'right', fontSize: 12, fontWeight: 700 }}>{r.pct}%</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderTop: `1px solid ${NX.border2}`, paddingTop: 10 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      {pf.ownerId
                        ? <><Avatar email={pf.ownerId} name={nameOf(pf.ownerId)} size={22} /><span style={{ fontSize: 12.5, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(pf.ownerId)}</span></>
                        : <span style={{ fontSize: 12.5, color: NX.faint }}>No owner</span>}
                    </span>
                    {r.overdue > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: NX.red }}><AlertTriangle size={12} />{r.overdue} overdue</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editing && (
        <PortfolioModal
          portfolio={editing.id ? editing : null} people={people}
          onClose={() => setEditing(null)}
          onCreate={createPortfolio} onUpdate={updatePortfolio} onDelete={deletePortfolio}
          afterDelete={() => { setEditing(null); setDetailId(null); }}
        />
      )}
    </div>
  );
}

// ── Add / edit modal ─────────────────────────────────────────────────────────
function PortfolioModal({ portfolio, people, onClose, onCreate, onUpdate, onDelete, afterDelete }) {
  const isEdit = !!portfolio;
  const [name, setName] = useState(portfolio?.name || '');
  const [description, setDescription] = useState(portfolio?.description || '');
  const [color, setColor] = useState(portfolio?.color || NX.purple);
  const [ownerId, setOwnerId] = useState(portfolio?.ownerId || null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const data = { name: name.trim(), description: description.trim(), color, ownerId: ownerId || '' };
    try {
      if (isEdit) await onUpdate(portfolio.id, data);
      else await onCreate(data);
      onClose();
    } catch (e) { setBusy(false); alert('Could not save portfolio.'); }
  };

  const toggleArchive = async () => {
    setBusy(true);
    try { await onUpdate(portfolio.id, { archived: !portfolio.archived }); onClose(); }
    catch (e) { setBusy(false); alert('Could not update portfolio.'); }
  };

  const remove = async () => {
    if (!confirm(`Delete portfolio “${portfolio.name}”? Projects are kept, only the grouping is removed.`)) return;
    setBusy(true);
    try { await onDelete(portfolio.id); afterDelete(); }
    catch (e) { setBusy(false); alert('Could not delete portfolio.'); }
  };

  const label = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };

  return (
    <Modal
      title={isEdit ? 'Edit portfolio' : 'New portfolio'}
      onClose={onClose}
      footer={
        <>
          {isEdit && <button onClick={remove} disabled={busy} style={{ ...btn('ghost'), color: NX.red, marginRight: 'auto' }}><Trash2 size={15} />Delete</button>}
          {isEdit && <button onClick={toggleArchive} disabled={busy} style={btn('outline')}>{portfolio.archived ? <><ArchiveRestore size={15} />Unarchive</> : <><Archive size={15} />Archive</>}</button>}
          <button onClick={onClose} style={btn('ghost')}>Cancel</button>
          <button onClick={save} disabled={!name.trim() || busy} style={{ ...btn('primary'), opacity: !name.trim() || busy ? 0.55 : 1 }}>{isEdit ? 'Save' : 'Create'}</button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
        <div>
          <label style={label}>Name</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Portfolio name" style={inputStyle} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
        <div>
          <label style={label}>Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this portfolio track?" rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        </div>
        <div>
          <label style={label}>Colour</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {COLOR_CHOICES.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} style={{
                width: 28, height: 28, borderRadius: 8, background: c, cursor: 'pointer',
                border: color === c ? `2px solid ${NX.ink}` : `2px solid transparent`,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>{color === c && <Check size={15} color="#fff" />}</button>
            ))}
          </div>
        </div>
        <div>
          <label style={label}>Owner</label>
          <PersonSelect value={ownerId} onChange={setOwnerId} people={people} />
        </div>
      </div>
    </Modal>
  );
}

// ── Detail view: member projects + add/remove/reorder ─────────────────────────
function PortfolioDetail({ pf, store, rollup, people, onBack, onNavigate, onEdit }) {
  const { projectById, updatePortfolio } = store;
  const accent = pf.color || NX.purple;
  const [search, setSearch] = useState('');
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);

  const ids = pf.projectIds || [];
  const agg = rollup(ids);

  const saveIds = async (nextIds) => {
    setBusy(true);
    try { await updatePortfolio(pf.id, { projectIds: nextIds }); }
    catch (e) { alert('Could not update projects.'); }
    finally { setBusy(false); }
  };

  const move = (idx, dir) => {
    const next = [...ids];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    saveIds(next);
  };
  const removeProject = (id) => saveIds(ids.filter((x) => x !== id));

  const q = search.trim().toLowerCase();
  const rows = ids
    .map((id) => projectById(id))
    .filter(Boolean)
    .filter((p) => (q ? (p.name || '').toLowerCase().includes(q) : true));

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <button onClick={onBack} style={{ ...btn('ghost'), alignSelf: 'flex-start', padding: '4px 6px', fontSize: 13, color: NX.dim }}><ArrowLeft size={15} />Back to portfolios</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 42, height: 42, borderRadius: 11, flexShrink: 0, background: `${accent}1a`, color: accent }}><Briefcase size={21} /></span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 19, fontWeight: 700 }}>{pf.name}</span>
              {pf.archived && <span style={chip(NX.dim, NX.border2)}>Archived</span>}
            </div>
            <div style={{ fontSize: 12.5, color: NX.dim, marginTop: 2 }}>{rows.length ? ids.length : 0} projects · {agg.total} tasks · {agg.pct}% complete</div>
          </div>
          <button onClick={onEdit} style={btn('outline')}><Pencil size={15} />Edit portfolio</button>
          <button onClick={() => setManaging(true)} style={btn('primary')}><FolderKanban size={15} />Manage projects</button>
        </div>
        {ids.length > 0 && (
          <div style={{ position: 'relative', maxWidth: 340 }}>
            <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects…" style={{ ...inputStyle, paddingLeft: 32 }} />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, padding: 16 }}>
        {ids.length === 0 ? (
          <div style={{ ...card, padding: 40, textAlign: 'center' }}>
            <FolderKanban size={30} style={{ color: NX.faint, marginBottom: 10 }} />
            <div style={{ fontSize: 14, fontWeight: 600 }}>No projects in this portfolio</div>
            <div style={{ fontSize: 13, color: NX.dim, marginTop: 4, marginBottom: 14 }}>Add projects to start rolling up their progress.</div>
            <button onClick={() => setManaging(true)} style={{ ...btn('primary'), display: 'inline-flex' }}><Plus size={15} />Add projects</button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={FolderKanban} title="No projects match your search" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((p) => {
              const idx = ids.indexOf(p.id);
              const pr = rollup([p.id]);
              const dept = store.deptById?.(p.departmentId);
              const deptColor = dept?.color || NX.blue;
              return (
                <div key={p.id} style={{ ...card, padding: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, flexShrink: 0, background: `${deptColor}1a`, color: deptColor }}><FolderKanban size={16} /></span>
                  <div
                    onClick={() => onNavigate && onNavigate({ view: 'tasks', projectId: p.id })}
                    style={{ minWidth: 0, flex: 1, cursor: onNavigate ? 'pointer' : 'default' }}
                    title={onNavigate ? 'Open project tasks' : undefined}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      {onNavigate && <ArrowRight size={14} style={{ color: NX.faint, flexShrink: 0 }} />}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                      <ProgressBar pct={pr.pct} color={NX.green} height={6} />
                      <span style={{ fontSize: 11.5, color: NX.dim, minWidth: 68, textAlign: 'right' }}>{pr.completed}/{pr.total} · {pr.pct}%</span>
                    </div>
                  </div>
                  {pr.overdue > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: NX.red, flexShrink: 0 }}><AlertTriangle size={12} />{pr.overdue}</span>}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    <button title="Move up" disabled={idx === 0 || busy} onClick={() => move(idx, -1)} style={{ ...btn('ghost'), padding: 5, opacity: idx === 0 ? 0.35 : 1 }}><ArrowUp size={15} /></button>
                    <button title="Move down" disabled={idx === ids.length - 1 || busy} onClick={() => move(idx, 1)} style={{ ...btn('ghost'), padding: 5, opacity: idx === ids.length - 1 ? 0.35 : 1 }}><ArrowDown size={15} /></button>
                    <button title="Remove from portfolio" disabled={busy} onClick={() => removeProject(p.id)} style={{ ...btn('ghost'), padding: 5, color: NX.red }}><X size={16} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {managing && (
        <ManageProjectsModal
          allProjects={store.projects} currentIds={ids}
          onClose={() => setManaging(false)}
          onSave={async (next) => { await saveIds(next); setManaging(false); }}
        />
      )}
    </div>
  );
}

// ── Add / remove projects (checkbox picker, preserves existing order) ──────────
function ManageProjectsModal({ allProjects, currentIds, onClose, onSave }) {
  const [picked, setPicked] = useState(new Set(currentIds));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const query = q.trim().toLowerCase();
  const list = allProjects
    .filter((p) => !p.archived || picked.has(p.id))
    .filter((p) => (query ? (p.name || '').toLowerCase().includes(query) : true));

  const save = async () => {
    setBusy(true);
    // Keep the current order for retained ids, then append newly-picked ones.
    const retained = currentIds.filter((id) => picked.has(id));
    const added = [...picked].filter((id) => !currentIds.includes(id));
    await onSave([...retained, ...added]);
  };

  return (
    <Modal
      title="Manage projects"
      onClose={onClose}
      footer={<>
        <button onClick={onClose} style={btn('ghost')}>Cancel</button>
        <button onClick={save} disabled={busy} style={{ ...btn('primary'), opacity: busy ? 0.55 : 1 }}>Save</button>
      </>}
    >
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…" style={{ ...inputStyle, paddingLeft: 32 }} />
      </div>
      {list.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 20 }}>No projects found.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '46vh', overflowY: 'auto' }}>
          {list.map((p) => {
            const on = picked.has(p.id);
            return (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 9, border: `1px solid ${on ? NX.ink : NX.border}`, cursor: 'pointer', background: on ? NX.hover : NX.surface }}>
                <input type="checkbox" checked={on} onChange={() => toggle(p.id)} style={{ cursor: 'pointer' }} />
                <FolderKanban size={15} style={{ color: NX.faint, flexShrink: 0 }} />
                <span style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {p.archived && <span style={{ ...chip(NX.dim, NX.border2), marginLeft: 'auto' }}>Archived</span>}
              </label>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
