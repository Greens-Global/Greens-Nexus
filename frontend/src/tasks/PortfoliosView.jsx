// Task Module - Portfolios. Grid of portfolio cards with a task rollup, plus a
// per-portfolio detail view (member projects + add/remove/reorder). Ported from
// the export's PortfoliosPage/PortfolioDetailPage into Nexus inline-style idiom.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Briefcase, Plus, Search, Pencil, Trash2, FolderKanban, ArrowLeft, ArrowRight,
  AlertTriangle, ArrowUp, ArrowDown, X, Archive, ArchiveRestore, ChevronRight, ArrowUpRight,
} from 'lucide-react';
import { useTasks } from './TasksContext';
import { taskStats, topLevel, portfolioRowTree, portfolioDeepProjectIds } from './lib';
import { NX, FONT, btn, input as inputStyle, card, chip } from './theme';
import { Avatar, EmptyState, Modal, usePeople, PersonSelect, useIsMobile, ChipMultiSelect, ViewToggle, ExportMenu } from './components';
import { useTableColumns, TableHead, ResetColumnsButton, useTableValue } from './tableCols';

// Columns in grid order, with the sort key each header drives. A portfolio's
// name is elastic; the rollup columns are fixed until someone drags one.
// Alphabetical A-Z by default. Stable identity: a fresh object each render
// would re-run consumers' memos.
const PF_DEFAULT_SORT = { key: 'name', dir: 'asc' };
// The synthetic "No Portfolio" group's id in the expanded set. A real
// portfolio id can never collide with it - they are uuids.
const LOOSE_KEY = '__no_portfolio__';
const PF_COLS = [
  { key: 'name',     label: 'Portfolio', sort: 'name',     template: 'minmax(0,2fr)' },
  { key: 'tasks',    label: 'Tasks',     sort: 'tasks',    width: 90 },
  { key: 'progress', label: 'Progress',  sort: 'progress', width: 200 },
  { key: 'projects', label: 'Projects',  sort: 'projects', template: 'minmax(0,2fr)' },
  { key: 'actions',  label: '',                            width: 76, fixed: true },
];

// Progress bar (accent-coloured) used on cards and project rows.
function ProgressBar({ pct, color, height = 8 }) {
  return (
    <div style={{ flex: 1, height, borderRadius: 999, background: NX.border2, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, borderRadius: 999, background: color }} />
    </div>
  );
}

// The COLLAPSED list row's Projects cell: one row, clipped to the Projects
// column's actual rendered width, with a "+N more projects" pill for
// whatever doesn't fit. Replaces a flex-wrap list, which let a portfolio with
// 20 projects (Accounting) stretch its row 4-5 lines tall while its
// neighbors stayed one line.
//
// Measured against the real DOM rather than estimated from the column's px
// value the way richlist.jsx's Person-cell overlap is (a shared-number
// estimate that deliberately skips per-row ResizeObservers because a task
// list can run to hundreds of rows) - project NAME lengths vary too much for
// one estimate to land within a pill or two, and a portfolio list is short
// enough (tens, not hundreds, of rows) that one observer per row doesn't
// cost what it would there.
//
// EXPANDED rows (below, in the parent) are untouched by this - full list,
// one project per row, same as before.
function ProjectOverflowRow({ projects }) {
  const containerRef = useRef(null);
  const itemRefs = useRef([]);
  const moreRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(projects.length);
  const [, bumpTick] = useState(0);   // re-render trigger for the ResizeObserver below

  // No dependency array on purpose: re-measures every render (this row's own
  // setVisibleCount included), and converges because the guard below skips
  // the state write once the computed count stops changing.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !projects.length) return;
    const gap = 5;
    const moreWidth = moreRef.current?.offsetWidth || 90;   // best guess before it's ever rendered
    let used = 0, fit = projects.length;
    for (let i = 0; i < projects.length; i++) {
      const w = itemRefs.current[i]?.offsetWidth || 0;
      const next = used + (i > 0 ? gap : 0) + w;
      const reserve = (projects.length - (i + 1)) > 0 ? gap + moreWidth : 0;
      if (next + reserve > container.clientWidth) { fit = i; break; }
      used = next;
    }
    const clamped = Math.max(1, fit);
    if (clamped !== visibleCount) setVisibleCount(clamped);
  });

  // Column resize / window resize changes the container's width with no prop
  // change, so nothing above would otherwise re-run.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => bumpTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const extra = projects.length - visibleCount;
  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: 5, minWidth: 0, overflow: 'hidden' }}>
      {projects.map((p, i) => (
        <span key={p.id} ref={(el) => { itemRefs.current[i] = el; }}
          style={{
            ...chip(NX.dim, NX.surface2), flexShrink: 0, whiteSpace: 'nowrap',
            ...(i >= visibleCount ? { position: 'absolute', top: 0, left: 0, visibility: 'hidden', pointerEvents: 'none' } : null),
          }}>
          {p.name}
        </span>
      ))}
      {extra > 0 && (
        <span ref={moreRef} style={{ fontSize: 11.5, fontWeight: 600, color: NX.faint, flexShrink: 0, whiteSpace: 'nowrap' }}>
          +{extra} more project{extra === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

export default function PortfoliosView({ onNavigate }) {
  const isMobile = useIsMobile();
  const store = useTasks();
  const { portfolios, projects, tasks, projectById, nameOf, createPortfolio, updatePortfolio, deletePortfolio, moveProjectsToPortfolio } = store;
  const people = usePeople();

  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);   // portfolio object, or {} for new, or null
  const [detailId, setDetailId] = useState(null);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [sort, setSort] = useTableValue('portfolios', 'sort', PF_DEFAULT_SORT);
  // List by default here and on Projects/Teams/Templates: comparing rollups
  // down a column is what this screen is for, and a card grid makes that a
  // scavenger hunt. Stored per user with the sort and column widths, so the
  // choice follows the person rather than the browser.
  const [view, setView] = useTableValue('portfolios', 'view', 'list');
  const { cols: pfCols, template, startResize, resetWidth, autofitWidth, widths, wrapRef, dragProps } =
    useTableColumns({ table: 'portfolios', cols: PF_COLS });
  const toggleExpanded = (id) => setExpandedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Projects picked for a batch move. Kept as ids, not rows: the store's
  // project objects are replaced wholesale on every refetch, so holding the
  // objects would keep a selection alive against rows that no longer exist.
  const [picked, setPicked] = useState(() => new Set());
  const togglePicked = (id) => setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Whole-group tick: add or remove a list of ids in one go, without disturbing
  // anything picked elsewhere - the selection is allowed to span groups.
  const setPickedMany = (ids, on) => setPicked((prev) => {
    const n = new Set(prev);
    ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
    return n;
  });
  const openProject = (id) => onNavigate && onNavigate({ projectId: id });
  // Stored per user like the view and sort, so someone who works out of the
  // unassigned pile does not re-tick it every visit.
  const [showLoose, setShowLoose] = useTableValue('portfolios', 'showUnassigned', false);
  const [moving, setMoving] = useState(false);

  // Top-level, non-section tasks only - matches the workspace's rollup basis.
  const topTasks = useMemo(() => topLevel(tasks), [tasks]);
  const rollup = (projectIds = []) => taskStats(topTasks.filter((t) => t.projectId && projectIds.includes(t.projectId)));
  const statsFor = (projectId) => taskStats(topTasks.filter((t) => t.projectId === projectId));

  // Rows for the table. Computed BEFORE the detail-view early return below -
  // a hook after a conditional return runs in a different order on the render
  // that opens a portfolio, which React treats as a fatal mismatch.
  const q = search.trim().toLowerCase();
  const filtered = portfolios
    .filter((p) => (showArchived ? true : !p.archived))
    .filter((p) => (q ? (p.name || '').toLowerCase().includes(q) : true));
  // Projects in no portfolio at all. They are invisible on this screen
  // otherwise - the only place they show is the Projects list, with a blank
  // portfolio badge - so a project quietly left out of the rollups stays left
  // out (Neil, Sept 7). portfolioId is the source of truth here, the same field
  // the Projects list badges from.
  const looseProjects = useMemo(
    () => (projects || []).filter((p) => !p.portfolioId && (showArchived ? true : !p.archived))
      .filter((p) => (q ? (p.name || '').toLowerCase().includes(q) : true))
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, showArchived, q],
  );
  const looseAgg = rollup(looseProjects.map((p) => p.id));
  // Header sort. `null` is the unsorted state - whatever order the store hands
  // back - which is where a third click returns to.
  const visible = useMemo(() => {
    if (!sort?.key) return filtered;
    const val = (pf) => {
      const r = rollup(pf.projectIds);
      switch (sort.key) {
        case 'tasks':    return r.total;
        case 'progress': return r.pct;
        case 'projects': return (pf.projectIds || []).length;
        default:         return (pf.name || '').toLowerCase();
      }
    };
    const dir = sort.dir === 'desc' ? -1 : 1;
    return filtered.slice().sort((a, b) => {
      // Archived stays at the bottom whatever the sort, same as Projects.
      if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
      const x = val(a), y = val(b);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y), 'en', { sensitivity: 'base' }) * dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sort, topTasks]);

  // A parent's numbers include everything underneath it - see
  // portfolioDeepProjectIds for why that is walked rather than stored.
  const rollupDeep = (pf) => rollup(portfolioDeepProjectIds(pf, portfolios));

  // The tree, flattened to rows in display order with each row's depth. The
  // rules it encodes (a child shows only under an EXPANDED parent; a child
  // whose parent is filtered away is lifted rather than lost) live in lib.js
  // with their tests.
  const rowTree = useMemo(
    () => portfolioRowTree(visible, portfolios, expandedIds),
    [visible, portfolios, expandedIds],
  );

  // The EXPORT walks the same tree with everything expanded. Collapsing a
  // portfolio hides its children on screen, but that is a viewing convenience,
  // not a filter - exporting a collapsed list handed back three top-level rows
  // and silently dropped every sub-portfolio (Neil, Sept 8). Search and the
  // archived toggle still apply, because those ARE filters: `visible` is what
  // they produced.
  const exportRowsAll = useMemo(
    () => portfolioRowTree(visible, portfolios, new Set((portfolios || []).map((p) => p.id))),
    [visible, portfolios],
  );

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

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header - title left, New Portfolio top-right, full-width search below */}
      <div style={{ padding: isMobile ? '12px 12px 10px' : '20px 24px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: isMobile ? 20 : 26, fontWeight: 800, letterSpacing: '-0.02em' }}>Portfolios</div>
            {!isMobile && <div style={{ fontSize: 13.5, color: NX.dim, marginTop: 4 }}>Group projects to track their combined progress.</div>}
          </div>
        </div>
        {/* Search · Show archived - one line on mobile */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14, marginTop: isMobile ? 10 : 16, flexWrap: isMobile ? 'nowrap' : 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 0, maxWidth: isMobile ? 'none' : 420 }}>
            <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search portfolios…"
              style={{ ...inputStyle, paddingLeft: 40, paddingTop: isMobile ? 8 : 10, paddingBottom: isMobile ? 8 : 10, borderRadius: 999 }} />
          </div>
          <label title="Show Archived" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: isMobile ? 12 : 13, color: NX.dim, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <input type="checkbox" className="nx-check" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ cursor: 'pointer' }} />
            {isMobile ? 'Archived' : 'Show archived'}
          </label>
          {/* The list view only: the loose pile renders as a group row in the
              table, which the card grid has no equivalent of. */}
          {view === 'list' && (
            <label title="Show projects that are not in any portfolio" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: isMobile ? 12 : 13, color: NX.dim, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}>
              <input type="checkbox" className="nx-check" checked={!!showLoose} onChange={(e) => setShowLoose(e.target.checked)} style={{ cursor: 'pointer' }} />
              {isMobile ? 'Unassigned' : 'Show unassigned'}
              {looseProjects.length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: NX.dim, background: NX.border2, borderRadius: 999, padding: '1px 7px' }}>{looseProjects.length}</span>
              )}
            </label>
          )}
          {/* Right-hand cluster - see ProjectsView for why the group, and not
              ResetColumnsButton, carries the auto margin. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14, marginLeft: 'auto', flexShrink: 0 }}>
            {/* rowTree, not `portfolios`: the export matches the tree on
                screen, in its order, with nesting shown by indent and by an
                explicit Parent column (a spreadsheet loses the indent the
                moment anyone sorts it). */}
            <ExportMenu
              title="Portfolios" subtitle={`${exportRowsAll.length} portfolios, including sub-portfolios`}
              filenameBase="portfolios" rows={exportRowsAll}
              columns={[
                { header: 'Portfolio', width: 28, get: (r) => `${'    '.repeat(r.depth)}${r.pf.name}` },
                { header: 'Parent', width: 20, get: (r) => (r.pf.parentId ? (portfolios.find((x) => x.id === r.pf.parentId)?.name || '') : '') },
                { header: 'Projects', width: 10, get: (r) => portfolioDeepProjectIds(r.pf, portfolios).length },
                { header: 'Tasks Done', width: 11, get: (r) => rollupDeep(r.pf).completed },
                { header: 'Tasks Total', width: 11, get: (r) => rollupDeep(r.pf).total },
                { header: 'Complete %', width: 11, get: (r) => rollupDeep(r.pf).pct },
                { header: 'Archived', width: 10, get: (r) => (r.pf.archived ? 'Yes' : 'No') },
              ]}
            />
            {!isMobile && view === 'list' && <ResetColumnsButton />}
            <ViewToggle view={view} onChange={setView} isMobile={isMobile} />
          </div>
        </div>
      </div>

      {/* Body - list of expandable rows (Portfolio | Tasks | Progress | Projects), or the card grid */}
      <div className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, padding: '16px 16px 76px' }}>
        {visible.length === 0 ? (
          <EmptyState icon={Briefcase} title="No Portfolios Yet" hint="Group projects into a portfolio to track their combined progress." />
        ) : view === 'grid' ? (
          <div style={{ display: 'grid', gap: 14, alignItems: 'start', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))' }}>
            {visible.map((pf) => (
              <PortfolioCard
                key={pf.id} portfolio={pf} rollup={rollup(pf.projectIds)}
                memberProjects={(pf.projectIds || []).map((id) => projectById(id)).filter(Boolean)}
                onOpen={() => setDetailId(pf.id)} onEdit={() => setEditing(pf)}
              />
            ))}
          </div>
        ) : (
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, overflow: 'hidden' }}>
            <div className="nx-scroll" style={{ overflowX: 'auto' }}>
              <div ref={wrapRef} style={{ minWidth: 900, '--nx-grid': template }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'center', gap: 12, padding: '9px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface2, fontSize: 12.5, fontWeight: 600, color: NX.dim }}>
                  {pfCols.map((c) => (
                    <TableHead key={c.key} label={c.label} sortKey={c.sort} sort={sort} setSort={setSort}
                      drag={dragProps(c.key, !c.fixed)}
                      onResizeStart={startResize(c.key, widths[c.key] ?? c.width ?? 200)}
                      onResizeReset={() => resetWidth(c.key)}
              onResizeAutofit={() => autofitWidth(c.key)} />
                  ))}
                </div>
                {/* Roots first, each followed by its own subtree - see
                    PortfolioRow. Ordering and zebra banding are handled by the
                    flattened walk so a sub-portfolio bands with the rest of the
                    table rather than restarting at its parent. */}
                {rowTree.map(({ pf, depth }, idx) => (
                  <PortfolioRow
                    key={pf.id} pf={pf} depth={depth} idx={idx} cols={pfCols}
                    rollup={rollupDeep} memberProjects={(pf.projectIds || []).map((id) => projectById(id)).filter(Boolean)}
                    deepIds={portfolioDeepProjectIds(pf, portfolios)}
                    isOpen={expandedIds.has(pf.id)} onToggleOpen={() => toggleExpanded(pf.id)}
                    statsFor={statsFor} picked={picked} onTogglePicked={togglePicked} onSetPicked={setPickedMany}
                    onOpenProject={openProject}
                    onOpenDetail={() => setDetailId(pf.id)} onEdit={() => setEditing(pf)}
                    onAddSub={() => setEditing({ parentId: pf.id })}
                  />
                ))}

                {/* The loose pile, as its own group at the BOTTOM of the table.
                    Not a portfolio - it has no rollup worth comparing and
                    nothing to open or edit - but it shares the row shape so a
                    project can be ticked here and moved into a real portfolio
                    with the bar below. */}
                {showLoose && (
                  <div style={{ borderTop: `2px solid ${NX.border}` }}>
                    <div onClick={() => toggleExpanded(LOOSE_KEY)}
                      style={{ display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'center', gap: 12, padding: '11px 16px', cursor: 'pointer', background: 'transparent' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                      {pfCols.map((c) => <Fragment key={c.key}>{({
                        name: (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        <ChevronRight size={14} style={{ color: NX.faint, flexShrink: 0, transform: expandedIds.has(LOOSE_KEY) ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }} />
                        <GroupCheckbox ids={looseProjects.map((p) => p.id)} selected={picked}
                          onSet={setPickedMany} title="Select every project with no portfolio" />
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, flexShrink: 0, background: NX.border2, color: NX.faint }}><FolderKanban size={16} /></span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: NX.dim }}>No Portfolio</span>
                        <span style={{ fontSize: 12, color: NX.faint }}>{looseProjects.length} project{looseProjects.length === 1 ? '' : 's'}</span>
                      </div>
                        ),
                        tasks: <span style={{ fontSize: 13, color: NX.dim }}>{looseAgg.completed}/{looseAgg.total}</span>,
                        progress: (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <ProgressBar pct={looseAgg.pct} color={NX.faint} />
                        <span style={{ width: 32, flexShrink: 0, textAlign: 'right', fontSize: 12, fontWeight: 700 }}>{looseAgg.pct}%</span>
                      </div>
                        ),
                        projects: <ProjectOverflowRow projects={looseProjects} />,
                        actions: <div />,
                      })[c.key]}</Fragment>)}
                    </div>
                    {expandedIds.has(LOOSE_KEY) && (
                      <ProjectRows
                        cols={pfCols} projects={looseProjects} statsFor={statsFor}
                        empty="Every project is in a portfolio."
                        selected={picked} onToggle={togglePicked} onOpen={openProject}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Batch move. Anchored to the bottom of the screen rather than the table
          so it stays reachable while scrolling a long list - the selection can
          span groups, which is the point: tick three loose projects and two
          from the wrong portfolio and send them all to the right one. */}
      {picked.size > 0 && (
        <MoveSelectionBar
          count={picked.size} portfolios={portfolios} busy={moving}
          onClear={() => setPicked(new Set())}
          onMove={async (portfolioId) => {
            setMoving(true);
            try {
              await moveProjectsToPortfolio([...picked], portfolioId);
              setPicked(new Set());
            } catch (e) {
              alert('Could not move those projects.');
            } finally { setMoving(false); }
          }}
        />
      )}


      {editing && (
        <PortfolioModal
          portfolio={editing.id ? editing : null} defaultParentId={editing.id ? '' : (editing.parentId || '')}
          people={people} projects={projects}
          onClose={() => setEditing(null)}
          onCreate={createPortfolio} onUpdate={updatePortfolio} onDelete={deletePortfolio}
          afterDelete={() => { setEditing(null); setDetailId(null); }}
        />
      )}
    </div>
  );
}

// One portfolio's row. Split out of the list when portfolios gained a parent:
// the same row now renders at any depth, and depth is the only thing that
// changes about it - the indent, and the fact that a nested row's chevron opens
// its OWN projects, not its children (children are rows in their own right, in
// the flattened walk above).
function PortfolioRow({
  pf, depth, idx, cols, rollup, memberProjects, deepIds, isOpen, onToggleOpen,
  statsFor, picked, onTogglePicked, onSetPicked, onOpenProject, onOpenDetail, onEdit, onAddSub,
}) {
  const accent = pf.color || NX.purple;
  const r = rollup(pf);
  // Alternating row shading, same as the Task List and Projects list - banding
  // is what lets the eye ride a row out to its Tasks/Progress/Projects columns.
  const rowBg = idx % 2 === 1 ? NX.zebra : 'transparent';
  // Indent the NAME cell only. Padding the whole row would drag every other
  // column right with it and break the alignment the columns exist for.
  const indent = depth * 22;
  return (
    <div style={{ borderBottom: `1px solid ${NX.border2}`, opacity: pf.archived ? 0.62 : 1 }}>
      <div onClick={onToggleOpen} style={{ display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'center', gap: 12, padding: '11px 16px', cursor: 'pointer', background: rowBg }}
        onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }} onMouseLeave={(e) => { e.currentTarget.style.background = rowBg; }}>
        {/* Keyed and rendered in the header's order - a row that renders cells
            in a fixed sequence puts every value under the wrong heading once
            columns can be dragged. */}
        {cols.map((c) => <Fragment key={c.key}>{({
          name: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, paddingLeft: indent }}>
          <ChevronRight size={14} style={{ color: NX.faint, flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }} />
          <GroupCheckbox ids={deepIds} selected={picked} onSet={onSetPicked}
            title={`Select every project under ${pf.name}`} />
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: depth ? 26 : 32, height: depth ? 26 : 32, borderRadius: 9, flexShrink: 0, background: `${accent}1a`, color: accent }}><Briefcase size={depth ? 14 : 16} /></span>
          <span style={{ fontSize: depth ? 13.5 : 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pf.name}</span>
          {pf.archived && <span style={chip(NX.dim, NX.border2)}>Archived</span>}
        </div>
          ),
          tasks: <span style={{ fontSize: 13, color: NX.dim }}>{r.completed}/{r.total}</span>,
          progress: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ProgressBar pct={r.pct} color={accent} />
          <span style={{ width: 32, flexShrink: 0, textAlign: 'right', fontSize: 12, fontWeight: 700 }}>{r.pct}%</span>
        </div>
          ),
          projects: <ProjectOverflowRow projects={memberProjects} />,
          actions: (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }} onClick={(e) => e.stopPropagation()}>
          {/* Nesting was only reachable from the child's own Edit screen (its
              Parent Portfolio field), which asks you to create a portfolio and
              then go find it to say where it lives. This starts a new one
              already inside this row. */}
          <button title="Add Sub-portfolio" onClick={onAddSub} style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><Plus size={14} /></button>
          <button title="Open Portfolio" onClick={onOpenDetail} style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><ArrowUpRight size={14} /></button>
          <button title="Edit Portfolio" onClick={onEdit} style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><Pencil size={14} /></button>
        </div>
          ),
        })[c.key]}</Fragment>)}
      </div>

      {isOpen && (
        <ProjectRows
          cols={cols} projects={memberProjects} statsFor={statsFor}
          empty="No projects in this portfolio."
          selected={picked} onToggle={onTogglePicked} onOpen={onOpenProject}
          startBand={idx + 1}
        />
      )}
    </div>
  );
}

// Select-everything-under-this-row. Tri-state, because "some of this group is
// picked" is a real state and a plain checkbox would lie about it - and
// `indeterminate` is a DOM property with no JSX attribute, so it is set on the
// node itself.
//
// Scope is the SUBTREE, not the row's own projects: on a parent, "select the
// projects under this" is how the row reads, and stopping at the direct
// children would silently leave a sub-portfolio's projects behind in a batch
// somebody believed was complete.
function GroupCheckbox({ ids, selected, onSet, title }) {
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const some = !all && ids.some((id) => selected.has(id));
  if (ids.length === 0) return <span style={{ width: 13, flexShrink: 0 }} />;
  return (
    <input
      type="checkbox" className="nx-check" checked={all} title={title}
      ref={(el) => { if (el) el.indeterminate = some; }}
      onClick={(e) => e.stopPropagation()}
      onChange={() => onSet(ids, !all)}
      style={{ cursor: 'pointer', flexShrink: 0 }}
    />
  );
}

// Batch move bar. Appears only with a selection, and its only action is the
// destination - "move these N somewhere" is the whole interaction, so a
// dropdown of portfolios plus "No portfolio" is the entire control.
function MoveSelectionBar({ count, portfolios, busy, onClear, onMove }) {
  const [dest, setDest] = useState('');
  const live = (portfolios || []).filter((p) => !p.archived)
    .slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }));
  return (
    <div style={{
      position: 'sticky', bottom: 0, zIndex: 5, margin: '0 16px 16px', padding: '10px 14px',
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12,
      boxShadow: '0 8px 28px rgba(0,0,0,0.16)',
    }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{count} project{count === 1 ? '' : 's'} selected</span>
      <select value={dest} onChange={(e) => setDest(e.target.value)} disabled={busy}
        style={{ ...inputStyle, width: 'auto', minWidth: 200, padding: '6px 10px', fontSize: 13 }}>
        <option value="">Move to…</option>
        {live.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        {/* Taking projects OUT is the other half of the same job - without it
            the loose group can only ever shrink. */}
        <option value="__none__">No portfolio</option>
      </select>
      <button disabled={!dest || busy} onClick={() => onMove(dest === '__none__' ? '' : dest)}
        style={{ ...btn('primary'), opacity: (!dest || busy) ? 0.55 : 1 }}>
        {busy ? 'Moving…' : 'Move'}
      </button>
      <button onClick={onClear} disabled={busy} style={{ ...btn('ghost'), marginLeft: 'auto', color: NX.dim }}>Clear</button>
    </div>
  );
}

// The rows under an expanded group - a portfolio's members, or the projects in
// no portfolio at all. One component for both so the two lists cannot drift
// apart, and so a project is selectable wherever it appears.
//
// The checkbox lives INSIDE the name cell rather than in a column of its own:
// column widths are stored per user (useTableColumns), and a new column would
// shift everyone's saved layout for a control that only shows on child rows.
function ProjectRows({ cols, projects, statsFor, empty, selected, onToggle, onOpen, startBand = 0 }) {
  if (projects.length === 0) {
    return (
      <div style={{ background: NX.surface2, borderTop: `1px solid ${NX.border2}` }}>
        <div style={{ padding: '12px 16px 12px 54px', fontSize: 13, color: NX.faint }}>{empty}</div>
      </div>
    );
  }
  return (
    <div style={{ background: NX.surface2, borderTop: `1px solid ${NX.border2}` }}>
      {projects.map((p, i) => {
        const pr = statsFor(p.id);
        const isPicked = selected.has(p.id);
        // Banding CONTINUES from the parent row rather than restarting at 0, so
        // the stripe runs unbroken down the table instead of resetting at every
        // group and making two adjacent rows share a shade.
        const band = (startBand + i) % 2 === 1;
        const bg = isPicked ? `${NX.primary}12` : band ? NX.zebra : 'transparent';
        return (
          <div key={p.id} onClick={() => onOpen(p.id)}
            style={{ display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'center', gap: 12, padding: '9px 16px 9px 54px', borderTop: `1px solid ${NX.border2}`, cursor: 'pointer', background: bg }}
            onMouseEnter={(e) => { if (!isPicked) e.currentTarget.style.background = NX.hover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = bg; }}>
            {/* Same keying as the portfolio row above, so an expanded project
                stays aligned with it. */}
            {cols.map((c) => <Fragment key={c.key}>{({
              name: (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <input type="checkbox" className="nx-check" checked={isPicked} onClick={(e) => e.stopPropagation()}
                onChange={() => onToggle(p.id)} title="Select for a batch move"
                style={{ cursor: 'pointer', flexShrink: 0 }} />
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 7, flexShrink: 0, background: `${NX.blue}1a`, color: NX.blue }}><FolderKanban size={13} /></span>
              <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </div>
              ),
              tasks: <span style={{ fontSize: 12, color: NX.dim }}>{pr.completed}/{pr.total}</span>,
              progress: (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ProgressBar pct={pr.pct} color={NX.blue} height={6} />
              <span style={{ width: 32, flexShrink: 0, textAlign: 'right', fontSize: 11, fontWeight: 700 }}>{pr.pct}%</span>
            </div>
              ),
              projects: (
            <div>
              {pr.overdue > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 4, width: 'fit-content', fontSize: 11, fontWeight: 600, color: NX.red }}><AlertTriangle size={11} />{pr.overdue} overdue</span>}
            </div>
              ),
              actions: <div />,
            })[c.key]}</Fragment>)}
          </div>
        );
      })}
    </div>
  );
}

// ── Grid card ────────────────────────────────────────────────────────────────
// The grid's answer to a list row: same four facts (name, task rollup,
// progress, member projects) in the card idiom Teams and Templates use, so
// switching views changes the shape without changing what is on screen. The
// projects list is capped for the reason TeamCard caps its own - one portfolio
// with 20 projects otherwise sets the height of every card in its row.
function PortfolioCard({ portfolio: pf, rollup: r, memberProjects, onOpen, onEdit }) {
  const accent = pf.color || NX.purple;
  const shown = memberProjects.slice(0, 6);
  const extra = memberProjects.length - shown.length;
  return (
    <div onClick={onOpen} style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 14, padding: 16, cursor: 'pointer', transition: 'border-color 0.13s', opacity: pf.archived ? 0.62 : 1 }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = NX.primary; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = NX.border; }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${accent}1a`, color: accent }}>
          <Briefcase size={21} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span title={pf.name} style={{ minWidth: 0, fontSize: 15.5, fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pf.name}</span>
            {pf.archived && <span style={{ ...chip(NX.dim, NX.border2), flexShrink: 0 }}>Archived</span>}
          </div>
          <div style={{ fontSize: 12, color: NX.faint, marginTop: 2 }}>
            {memberProjects.length} project{memberProjects.length === 1 ? '' : 's'}
            {' · '}{r.completed}/{r.total} task{r.total === 1 ? '' : 's'} done
          </div>
        </div>
        {/* Edit stays a button rather than riding the card's own click, which
            opens the portfolio - two different destinations from one target. */}
        <button title="Edit Portfolio" onClick={(e) => { e.stopPropagation(); onEdit(); }}
          style={{ ...btn('ghost'), padding: 5, color: NX.faint, flexShrink: 0 }}><Pencil size={14} /></button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
        <ProgressBar pct={r.pct} color={accent} />
        <span style={{ width: 32, flexShrink: 0, textAlign: 'right', fontSize: 12, fontWeight: 700 }}>{r.pct}%</span>
      </div>
      {r.overdue > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 7, fontSize: 11.5, fontWeight: 600, color: NX.red }}>
          <AlertTriangle size={12} />{r.overdue} overdue
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 7 }}>Projects</div>
        {memberProjects.length === 0 ? (
          <div style={{ fontSize: 12.5, color: NX.faint }}>No projects yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
            {shown.map((p) => (
              <span key={p.id} title={p.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', fontSize: 11, fontWeight: 600, color: NX.dim, background: NX.surface2, borderRadius: 999, padding: '2px 8px' }}>
                <FolderKanban size={11} style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              </span>
            ))}
            {extra > 0 && (
              <span style={{ display: 'inline-flex', fontSize: 11, fontWeight: 600, color: NX.faint, padding: '2px 8px' }}>
                +{extra} more project{extra === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Add / edit modal ─────────────────────────────────────────────────────────
function PortfolioModal({ portfolio, defaultParentId = '', people, projects, onClose, onCreate, onUpdate, onDelete, afterDelete }) {
  const { myEmail, portfolios: allPortfolios } = useTasks();
  const isEdit = !!portfolio;
  const [name, setName] = useState(portfolio?.name || '');
  const [description, setDescription] = useState(portfolio?.description || '');
  const [color] = useState(portfolio?.color || NX.purple);
  // New portfolios default the owner to whoever's creating it - same
  // reasoning as CreateTaskModal's task owner default - still freely
  // changeable below.
  const [ownerId, setOwnerId] = useState(portfolio?.ownerId || (isEdit ? null : myEmail) || null);
  const [projectIds, setProjectIds] = useState(portfolio?.projectIds || []);
  const [parentId, setParentId] = useState(portfolio?.parentId || defaultParentId || '');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  // See ProjectsView.jsx's ProjectModal for why: autoFocus + this Modal's
  // vh-based sizing + mobile Chrome's keyboard-open scroll behavior combine
  // to scroll Name/Description/Owner out of view on phones.
  const isMobile = useIsMobile();

  // Every portfolio this one may sit under: the tree, in display order, minus
  // itself and everything already beneath it.
  const parentOptions = useMemo(() => {
    const banned = new Set(portfolio ? [portfolio.id] : []);
    if (portfolio) {
      const stack = [portfolio.id];
      while (stack.length) {
        const at = stack.pop();
        (allPortfolios || []).forEach((p) => {
          if ((p.parentId || '') === at && !banned.has(p.id)) { banned.add(p.id); stack.push(p.id); }
        });
      }
    }
    const out = [];
    const walk = (parent, depth) => {
      (allPortfolios || [])
        .filter((p) => (p.parentId || '') === parent && !banned.has(p.id) && !p.archived)
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
        .forEach((p) => { out.push({ id: p.id, name: p.name, depth }); walk(p.id, depth + 1); });
    };
    walk('', 0);
    return out;
  }, [allPortfolios, portfolio]);


  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const data = { name: name.trim(), description: description.trim(), color, ownerId: ownerId || '', parentId, projectIds };
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
          <label style={label}>Parent Portfolio</label>
          {/* Nesting is set from the CHILD, which is the direction people think
              in ("this belongs under Nexus"), and it keeps the whole move to one
              field on one row rather than a list to drag things into. Self and
              descendants are excluded rather than offered-and-rejected: the
              server refuses a cycle, but a dropdown that lists an option it will
              reject is a worse way to learn the rule. */}
          <select value={parentId} onChange={(e) => { setParentId(e.target.value); setDirty(true); }} style={inputStyle}>
            <option value="">None - top level</option>
            {parentOptions.map((p) => (
              <option key={p.id} value={p.id}>{'- '.repeat(p.depth)}{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={label}>Projects</label>
          {/* A portfolio is picked FROM the whole workspace, so this list is as
              long as the workspace is - searchable, with what you picked shown
              as chips instead of a grid you scroll hunting for ticks. */}
          <ChipMultiSelect value={projectIds} onChange={(ids) => { setProjectIds(ids); setDirty(true); }}
            placeholder="Add projects…" searchPlaceholder="Search projects…"
            emptyText="No projects yet - create one first, then add it here."
            options={(projects || []).slice()
              .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
              .map((p) => ({ id: p.id, label: p.name }))} />
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
                <input type="checkbox" className="nx-check" checked={on} onChange={() => toggle(p.id)} style={{ cursor: 'pointer' }} />
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
