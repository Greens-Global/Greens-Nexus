// Task Module - Portfolios. Grid of portfolio cards with a task rollup, plus a
// per-portfolio detail view (member projects + add/remove/reorder). Ported from
// the export's PortfoliosPage/PortfolioDetailPage into Nexus inline-style idiom.
import { useMemo, useState } from 'react';
import {
  Briefcase, Plus, Search, Pencil, Trash2, FolderKanban, ArrowLeft, ArrowRight,
  AlertTriangle, ArrowUp, ArrowDown, X, Archive, ArchiveRestore, ChevronRight, ArrowUpRight,
} from 'lucide-react';
import { useTasks } from './TasksContext';
import { taskStats, topLevel } from './lib';
import { NX, FONT, btn, input as inputStyle, card, chip } from './theme';
import { Avatar, EmptyState, Modal, usePeople, PersonSelect, useIsMobile, MobileFab } from './components';

// Progress bar (accent-coloured) used on cards and project rows.
function ProgressBar({ pct, color, height = 8 }) {
  return (
    <div style={{ flex: 1, height, borderRadius: 999, background: NX.border2, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, borderRadius: 999, background: color }} />
    </div>
  );
}

export default function PortfoliosView({ onNavigate }) {
  const isMobile = useIsMobile();
  const store = useTasks();
  const { portfolios, projects, tasks, projectById, nameOf, createPortfolio, updatePortfolio, deletePortfolio } = store;
  const people = usePeople();

  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);   // portfolio object, or {} for new, or null
  const [detailId, setDetailId] = useState(null);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const toggleExpanded = (id) => setExpandedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Top-level, non-section tasks only - matches the workspace's rollup basis.
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
      {/* Header - title left, New Portfolio top-right, full-width search below */}
      <div style={{ padding: isMobile ? '12px 12px 10px' : '20px 24px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: isMobile ? 20 : 26, fontWeight: 800, letterSpacing: '-0.02em' }}>Portfolios</div>
            {!isMobile && <div style={{ fontSize: 13.5, color: NX.dim, marginTop: 4 }}>Group projects to track their combined progress.</div>}
          </div>
          {!isMobile && <button style={{ ...btn('primary'), padding: '10px 18px', fontSize: 13.5, borderRadius: 10 }} onClick={() => setEditing({})}><Plus size={16} />New Portfolio</button>}
        </div>
        {/* Search · Show archived - one line on mobile */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14, marginTop: isMobile ? 10 : 16, flexWrap: isMobile ? 'nowrap' : 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 0, maxWidth: isMobile ? 'none' : 420 }}>
            <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search portfolios…"
              style={{ ...inputStyle, paddingLeft: 40, paddingTop: isMobile ? 8 : 10, paddingBottom: isMobile ? 8 : 10, borderRadius: 999 }} />
          </div>
          <label title="Show Archived" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: isMobile ? 12 : 13, color: NX.dim, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ cursor: 'pointer' }} />
            {isMobile ? 'Archived' : 'Show archived'}
          </label>
        </div>
      </div>

      {/* Body - table with expandable rows (Portfolio | Tasks | Progress | Projects) */}
      <div className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, padding: '16px 16px 76px' }}>
        {visible.length === 0 ? (
          <EmptyState icon={Briefcase} title="No Portfolios Yet" hint="Group projects into a portfolio to track their combined progress." />
        ) : (
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, overflow: 'hidden' }}>
            <div className="nx-scroll" style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 900 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) 90px 200px minmax(0,2fr) 76px', alignItems: 'center', gap: 12, padding: '9px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface2, fontSize: 12.5, fontWeight: 600, color: NX.dim }}>
                  <span>Portfolio</span><span>Tasks</span><span>Progress</span><span>Projects</span><span />
                </div>
                {visible.map((pf) => {
                  const accent = pf.color || NX.purple;
                  const r = rollup(pf.projectIds);
                  const isOpen = expandedIds.has(pf.id);
                  const memberProjects = (pf.projectIds || []).map((id) => projectById(id)).filter(Boolean);
                  return (
                    <div key={pf.id} style={{ borderBottom: `1px solid ${NX.border2}`, opacity: pf.archived ? 0.62 : 1 }}>
                      <div onClick={() => toggleExpanded(pf.id)} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) 90px 200px minmax(0,2fr) 76px', alignItems: 'center', gap: 12, padding: '11px 16px', cursor: 'pointer' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                          <ChevronRight size={14} style={{ color: NX.faint, flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }} />
                          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, flexShrink: 0, background: `${accent}1a`, color: accent }}><Briefcase size={16} /></span>
                          <span style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pf.name}</span>
                          {pf.archived && <span style={chip(NX.dim, NX.border2)}>Archived</span>}
                        </div>
                        <span style={{ fontSize: 13, color: NX.dim }}>{r.completed}/{r.total}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <ProgressBar pct={r.pct} color={accent} />
                          <span style={{ width: 32, flexShrink: 0, textAlign: 'right', fontSize: 12, fontWeight: 700 }}>{r.pct}%</span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, minWidth: 0 }}>
                          {memberProjects.map((p) => <span key={p.id} style={chip(NX.dim, NX.surface2)}>{p.name}</span>)}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }} onClick={(e) => e.stopPropagation()}>
                          <button title="Open Portfolio" onClick={() => setDetailId(pf.id)} style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><ArrowUpRight size={14} /></button>
                          <button title="Edit Portfolio" onClick={() => setEditing(pf)} style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><Pencil size={14} /></button>
                        </div>
                      </div>

                      {isOpen && (
                        <div style={{ background: NX.surface2, borderTop: `1px solid ${NX.border2}` }}>
                          {memberProjects.length === 0 ? (
                            <div style={{ padding: '12px 16px 12px 54px', fontSize: 13, color: NX.faint }}>No projects in this portfolio.</div>
                          ) : (
                            memberProjects.map((p) => {
                              const pr = taskStats(topTasks.filter((t) => t.projectId === p.id));
                              return (
                                <div key={p.id} onClick={() => onNavigate && onNavigate({ projectId: p.id })}
                                  style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) 90px 200px minmax(0,2fr) 76px', alignItems: 'center', gap: 12, padding: '9px 16px 9px 54px', borderTop: `1px solid ${NX.border2}`, cursor: 'pointer' }}
                                  onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 7, flexShrink: 0, background: `${NX.blue}1a`, color: NX.blue }}><FolderKanban size={13} /></span>
                                    <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                                  </div>
                                  <span style={{ fontSize: 12, color: NX.dim }}>{pr.completed}/{pr.total}</span>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <ProgressBar pct={pr.pct} color={NX.blue} height={6} />
                                    <span style={{ width: 32, flexShrink: 0, textAlign: 'right', fontSize: 11, fontWeight: 700 }}>{pr.pct}%</span>
                                  </div>
                                  <div>
                                    {pr.overdue > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 4, width: 'fit-content', fontSize: 11, fontWeight: 600, color: NX.red }}><AlertTriangle size={11} />{pr.overdue} overdue</span>}
                                  </div>
                                  <div />
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {isMobile && <MobileFab title="New Portfolio" onClick={() => setEditing({})} />}

      {editing && (
        <PortfolioModal
          portfolio={editing.id ? editing : null} people={people} projects={projects}
          onClose={() => setEditing(null)}
          onCreate={createPortfolio} onUpdate={updatePortfolio} onDelete={deletePortfolio}
          afterDelete={() => { setEditing(null); setDetailId(null); }}
        />
      )}
    </div>
  );
}

// ── Add / edit modal ─────────────────────────────────────────────────────────
function PortfolioModal({ portfolio, people, projects, onClose, onCreate, onUpdate, onDelete, afterDelete }) {
  const isEdit = !!portfolio;
  const [name, setName] = useState(portfolio?.name || '');
  const [description, setDescription] = useState(portfolio?.description || '');
  const [color] = useState(portfolio?.color || NX.purple);
  const [ownerId, setOwnerId] = useState(portfolio?.ownerId || null);
  const [projectIds, setProjectIds] = useState(portfolio?.projectIds || []);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  // See ProjectsView.jsx's ProjectModal for why: autoFocus + this Modal's
  // vh-based sizing + mobile Chrome's keyboard-open scroll behavior combine
  // to scroll Name/Description/Owner out of view on phones.
  const isMobile = useIsMobile();

  const toggleProject = (id) => { setProjectIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])); setDirty(true); };

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const data = { name: name.trim(), description: description.trim(), color, ownerId: ownerId || '', projectIds };
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
      title={isEdit ? 'Edit Portfolio' : 'Create a Portfolio'}
      onClose={onClose}
      isDirty={dirty}
      onSave={name.trim() ? save : undefined}
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
          <input autoFocus={!isMobile} value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder="Portfolio Name" style={inputStyle} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
        <div>
          <label style={label}>Description</label>
          <textarea value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} placeholder="What does this portfolio track?" rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        </div>
        <div>
          <label style={label}>Owner</label>
          <PersonSelect value={ownerId} onChange={(v) => { setOwnerId(v); setDirty(true); }} people={people} />
        </div>
        <div>
          <label style={label}>Projects</label>
          {projects.length === 0 ? (
            <div style={{ fontSize: 12.5, color: NX.faint }}>No projects yet - create one first, then add it here.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, maxHeight: 220, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8, padding: 8 }}>
              {projects.map((p) => (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, padding: '4px 6px', borderRadius: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={projectIds.includes(p.id)} onChange={() => toggleProject(p.id)} style={{ cursor: 'pointer' }} />
                  <FolderKanban size={13} style={{ color: NX.faint, flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Self-contained "create a portfolio" modal that reuses the full PortfolioModal
// form, so the navbar + Create menu matches the Portfolios tab exactly.
export function PortfolioCreateModal({ onClose, onCreated }) {
  const { projects, createPortfolio } = useTasks();
  const people = usePeople();
  return (
    <PortfolioModal
      portfolio={null} people={people} projects={projects}
      onClose={onClose}
      onCreate={async (data) => { const p = await createPortfolio(data); onCreated && onCreated(p); return p; }}
      onUpdate={() => {}} onDelete={() => {}} afterDelete={() => {}}
    />
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
        <button onClick={onBack} style={{ ...btn('ghost'), alignSelf: 'flex-start', padding: '4px 6px', fontSize: 13, color: NX.dim }}><ArrowLeft size={15} />Back to Portfolios</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 42, height: 42, borderRadius: 11, flexShrink: 0, background: `${accent}1a`, color: accent }}><Briefcase size={21} /></span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 19, fontWeight: 700 }}>{pf.name}</span>
              {pf.archived && <span style={chip(NX.dim, NX.border2)}>Archived</span>}
            </div>
            <div style={{ fontSize: 12.5, color: NX.dim, marginTop: 2 }}>{rows.length ? ids.length : 0} projects · {agg.total} tasks · {agg.pct}% complete</div>
          </div>
          <button onClick={onEdit} style={btn('outline')}><Pencil size={15} />Edit Portfolio</button>
          <button onClick={() => setManaging(true)} style={btn('primary')}><FolderKanban size={15} />Manage Projects</button>
        </div>
        {ids.length > 0 && (
          <div style={{ position: 'relative', maxWidth: 340 }}>
            <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects…" style={{ ...inputStyle, paddingLeft: 32 }} />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, padding: '16px 16px 76px' }}>
        {ids.length === 0 ? (
          <div style={{ ...card, padding: 40, textAlign: 'center' }}>
            <FolderKanban size={30} style={{ color: NX.faint, marginBottom: 10 }} />
            <div style={{ fontSize: 14, fontWeight: 600 }}>No Projects in This Portfolio</div>
            <div style={{ fontSize: 13, color: NX.dim, marginTop: 4, marginBottom: 14 }}>Add projects to start rolling up their progress.</div>
            <button onClick={() => setManaging(true)} style={{ ...btn('primary'), display: 'inline-flex' }}><Plus size={15} />Add Projects</button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={FolderKanban} title="No Projects Match Your Search" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((p) => {
              const idx = ids.indexOf(p.id);
              const pr = rollup([p.id]);
              const deptColor = p.color || NX.blue;
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
                    <button title="Move Up" disabled={idx === 0 || busy} onClick={() => move(idx, -1)} style={{ ...btn('ghost'), padding: 5, opacity: idx === 0 ? 0.35 : 1 }}><ArrowUp size={15} /></button>
                    <button title="Move Down" disabled={idx === ids.length - 1 || busy} onClick={() => move(idx, 1)} style={{ ...btn('ghost'), padding: 5, opacity: idx === ids.length - 1 ? 0.35 : 1 }}><ArrowDown size={15} /></button>
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
  const [dirty, setDirty] = useState(false);
  const toggle = (id) => { setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); setDirty(true); };

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
      title="Manage Projects"
      onClose={onClose}
      isDirty={dirty}
      onSave={save}
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
