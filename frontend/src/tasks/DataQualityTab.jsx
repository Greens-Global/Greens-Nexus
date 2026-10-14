// Task Module - Manage: Data Quality (Aug 2026, per Neil).
//
// "As a company owner, I want to see every single task in one list, regardless
// of who it's assigned to, and be able to tell which ones are missing a due
// date, a project, a priority, or a team - and fix them right there." One
// combined list, not four separate filters someone has to remember to run -
// a task with two gaps shows up once, with both flagged.
//
// Lives under Tasks -> Manage, which Tasks.jsx already gates to `can('manager')`
// (see TasksWorkspace.jsx's `canManage`) - no separate permission check needed
// here. Every open (non-completed) task is in scope, company-wide: managers
// already see every task from `useTasks()`, unscoped by project or assignee.
import { Fragment, useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { AlertTriangle, CheckCircle2, Trash2, X } from 'lucide-react';
import { NX, FONT, btn, chip, input as inputStyle, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { Avatar, DateField, EmptyState, SearchSelect, usePeople } from './components';
import { teamInProject, taskAssignees, fieldsForTask, requiredByProjectsOf, isBlankValue } from './lib';
import TaskDetailDrawer from './TaskDetailDrawer';
import { PillSelect } from './views/richlist';
import { useTableColumns, TableHead, ResetColumnsButton } from './tableCols';

// The Task List's table, cell for cell (Sagar, Oct 14 2026: "make this table
// as the whole task module"): a rounded card, a hairline border on every
// cell, centered Title Case headers, Priority as the list's priority signal
// and Team as a colored pill - the same PillSelect the list uses. What a row is
// missing is in its Missing column: grey labels, red for a required field.
// Columns move, resize and auto-fit exactly as the Task List's do - the
// same kit (tableCols.jsx), saved to the person's profile as 'dataquality'.
const COLUMNS = [
  { key: 'check', width: 40, fixed: true },
  { key: 'task', label: 'Task', width: 320, minWidth: 160 },
  { key: 'missing', label: 'Missing', width: 170 },
  { key: 'due', label: 'Due Date', width: 130 },
  { key: 'project', label: 'Project', width: 200 },
  { key: 'priority', label: 'Priority', width: 116 },
  { key: 'team', label: 'Team', width: 150 },
];
// Header click sorts, as in the list: unsorted -> ascending -> descending -> back.
const PRI_RANK = Object.fromEntries(PRIORITY_ORDER.map((p, i) => [p, i]));
const SORTERS = {
  task: (r) => String(r.t.title || '').toLowerCase(),
  missing: (r) => r.gaps.length,
  due: (r) => r.t.dueOn || '9999',
  priority: (r) => (r.t.priority in PRI_RANK ? PRI_RANK[r.t.priority] : 99),
};
const ROW_H = 38;
const cell = { minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '2px 8px', borderRight: `1px solid ${NX.border2}`, boxSizing: 'border-box' };

// Each row's "missing X" test, in the order they read as columns. A task
// missing more than one shows every gap chip that applies - nothing here
// picks just the first. `chipText` overrides the default "N missing <label>"
// filter-chip wording for a gap that doesn't read naturally that way
// (Pranshu, Sep 4: an "Unassigned" chip, same style as the others, to find
// tasks nobody owns) - "missing Assignee" would be the mechanically-generated
// text, but "unassigned" is what everyone actually calls this.
const GAP_DEFS = [
  { key: 'dueOn', label: 'Due Date', test: (t) => !t.dueOn },
  { key: 'projectId', label: 'Project', test: (t) => !t.projectId },
  { key: 'priority', label: 'Priority', test: (t) => !t.priority },
  { key: 'teamId', label: 'Team', test: (t) => !t.teamId },
  { key: 'assignee', label: 'Assignee', test: (t) => taskAssignees(t).length === 0, chipText: (n) => `${n} unassigned` },
];

function projectOptions(projects) {
  return [{ id: '', label: 'No project' },
    ...(projects || []).filter((p) => !p.archived).slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
      .map((p) => ({ id: p.id, label: p.name }))];
}

// A required field left empty is an ALERT (red); the everyday gaps are
// plain grey labels - they are what the filter is for, not a warning
// (Sagar, Oct 14 2026: "1916 missing Team" on every task was noise).
const gapChip = (g) => (
  <span key={g.key} title={g.mandatory ? `${g.label} is required in this task's project` : undefined}
    style={g.mandatory ? chip(NX.red, 'rgba(220,38,38,0.12)') : chip(NX.dim, NX.border2)}>{g.label}</span>
);

/** The fields a task's own projects REQUIRE (Oct 13 2026) that it has left
 *  empty - its mandatory gaps, keyed `cf:<id>`. */
function mandatoryGaps(customFields, t) {
  const values = t.customFieldValues || {};
  return fieldsForTask(customFields, t)
    .filter((f) => requiredByProjectsOf(f, t).length > 0 && isBlankValue(values[f.id]))
    .map((f) => ({ key: `cf:${f.id}`, label: f.name, mandatory: true }));
}

function GapRow({ t, gaps, store, onOpen, selected, toggleSel, cols }) {
  const { projects, teams, nameOf } = store;
  const projOpts = useMemo(() => projectOptions(projects), [projects]);
  const projectTeams = (teams || []).filter((tm) => teamInProject(tm, t.projectId));
  const team = projectTeams.find((tm) => tm.id === t.teamId) || (teams || []).find((tm) => tm.id === t.teamId);
  const assignees = taskAssignees(t);
  const isSel = selected.has(t.id);
  const pm = PRIORITY_META[t.priority];
  const stop = (e) => e.stopPropagation();

  const cells = {
    check: (
      <div style={cell}>
        <input type="checkbox" checked={isSel} onClick={stop} onChange={() => toggleSel(t.id)} style={{ cursor: 'pointer' }} />
      </div>
    ),
    task: (
      <div style={{ ...cell, justifyContent: 'flex-start', gap: 8 }}>
        {assignees.length ? (
          <span title={assignees.map((e) => nameOf?.(e) || e).join(', ')} style={{ display: 'flex', flexShrink: 0 }}>
            {assignees.slice(0, 2).map((e, i) => <span key={e} style={{ marginLeft: i ? -6 : 0 }}><Avatar email={e} size={20} /></span>)}
          </span>
        ) : (
          <span title="Unassigned" style={{ width: 20, height: 20, borderRadius: '50%', border: `1.5px dashed ${NX.border}`, flexShrink: 0 }} />
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, color: NX.ink }}>{t.title}</span>
      </div>
    ),
    missing: (
      <div style={{ ...cell, gap: 4, overflow: 'hidden' }}>
        {gaps.map(gapChip)}
      </div>
    ),
    due: (
      <div style={cell} onClick={stop}>
        <DateField value={t.dueOn || ''} onChange={(v) => store.updateTask(t.id, { dueOn: v })} noPast
          title="Due Date" compact style={{ fontSize: 12 }} />
      </div>
    ),
    project: (
      <div style={cell} onClick={stop}>
        <SearchSelect value={t.projectId || ''} placeholder="No project" searchPlaceholder="Search projects…"
          emptyText="No projects yet." options={projOpts}
          buttonStyle={{ border: 'none', borderRadius: 6, padding: '3px 6px', fontSize: 13, color: t.projectId ? NX.dim : NX.faint, background: 'transparent', fontFamily: FONT, width: '100%', height: 'auto', minHeight: 0, cursor: 'pointer', fontWeight: 400, justifyContent: 'center' }}
          onPick={(id) => store.updateTask(t.id, { projectId: id || null })} />
      </div>
    ),
    // The list's priority signal (soft labels, Oct 14 2026).
    priority: (
      <div style={cell} onClick={stop}>
        <PillSelect variant="priority" center label={pm ? pm.label : '-'} color={pm ? pm.color : NX.faint} tint={pm ? pm.tint : 'transparent'}
          currentKey={t.priority || ''}
          options={PRIORITY_ORDER.map((p) => ({ key: p, label: PRIORITY_META[p].label, color: PRIORITY_META[p].color }))}
          onSelect={(k) => store.updateTask(t.id, { priority: k || null })} />
      </div>
    ),
    team: (
      <div style={cell} onClick={stop}>
        <PillSelect center
          label={team ? team.name : 'No Team'} color={team ? team.color : NX.faint} tint={team ? `${team.color}1a` : 'transparent'}
          icon={team ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: team.color, flexShrink: 0 }} /> : null}
          currentKey={t.teamId || ''}
          options={[{ key: '', label: 'No Team', color: NX.faint }, ...projectTeams.map((tm) => ({ key: tm.id, label: tm.name, color: tm.color }))]}
          onSelect={(k) => store.updateTask(t.id, { teamId: k || null })} />
      </div>
    ),
  };

  return (
    // Hover: .nx-row-hover (style.css) - the whole-row highlight every list shares (Neil, 10/10).
    <div onClick={() => onOpen(t.id)} className="nx-row-hover" data-selected={isSel ? 'true' : undefined} style={{
      display: 'grid', gridTemplateColumns: 'var(--nx-grid)', height: ROW_H, alignItems: 'stretch', borderBottom: `1px solid ${NX.border2}`,
      fontSize: 13, cursor: 'pointer', background: isSel ? 'rgba(37,99,235,0.08)' : 'transparent',
    }}>
      {cols.map((c) => <Fragment key={c.key}>{cells[c.key]}</Fragment>)}
    </div>
  );
}

// A chip that's a live filter, not a label - the base pill styling stays the
// same shape whether it's the neutral "N tasks with gaps" one or one of the
// amber "N missing X" ones; only the selected state and pointer feedback move.
function FilterChip({ label, active, color, tint, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{
      ...chip(active ? '#fff' : color, active ? color : tint),
      border: 'none', cursor: 'pointer', fontFamily: FONT,
      boxShadow: active ? `0 0 0 2px ${color}55` : 'none',
    }}>{label}</button>
  );
}

export default function DataQualityTab({ store }) {
  const { tasks, bulkUpdate, deleteTask } = store;
  const people = usePeople();
  const [openId, setOpenId] = useState(null);
  // null = every gap type (the default, "N tasks with gaps" chip). Set to a
  // GAP_DEFS key to narrow the list to just that gap - Neil's original ask
  // ("filter by all tasks with no due date") for each field, from one screen
  // instead of four separate saved filters.
  const [filterKey, setFilterKey] = useState(null);

  // Batch edit (Pranshu, Sep 4: "select multiple tasks so we can delete, add
  // due date, and so on") - same checkbox + floating bulk-bar pattern
  // TasksWorkspace's Task List view already uses, so it reads as one
  // convention across the module rather than a second one invented here.
  // Team is deliberately left out of the bulk bar: a team only makes sense
  // within the project that has it (see teamInProject below), and a batch
  // can span tasks from several different projects - a single bulk pick
  // could silently not apply, or apply to the wrong team. Per-row Team stays
  // the way to fix that gap.
  const [selected, setSelected] = useState(new Set());
  const toggleSel = useCallback((id) => setSelected((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  }), []);
  const clearSel = useCallback(() => setSelected(new Set()), []);

  // Completed work is done - a finished task missing a due date isn't a
  // process gap anyone needs to chase down.
  const rows = useMemo(() => {
    const out = [];
    for (const t of tasks) {
      if (t.completed) continue;
      const gaps = [...mandatoryGaps(store.customFields, t), ...GAP_DEFS.filter((g) => g.test(t))];
      if (gaps.length) out.push({ t, gaps });
    }
    return out.sort((a, b) => String(a.t.title || '').localeCompare(String(b.t.title || ''), 'en', { sensitivity: 'base' }));
  }, [tasks, store.customFields]);

  // Every required field some task is missing, for its alert chip and the
  // filter - in the order first met.
  const mandatoryKinds = useMemo(() => {
    const seen = new Map();
    for (const r of rows) for (const g of r.gaps) if (g.mandatory && !seen.has(g.key)) seen.set(g.key, g);
    return [...seen.values()];
  }, [rows]);

  // Counts always reflect the FULL gap set, not the current filter - so every
  // chip's number stays put while you click between them, instead of the row
  // you just filtered to reading "0 missing X" everywhere else.
  const countFor = (key) => rows.reduce((n, r) => n + (r.gaps.some((g) => g.key === key) ? 1 : 0), 0);
  const { projectName, teams } = store;
  const [sort, setSort] = useState({ key: '', dir: 'asc' });
  const filteredRows = useMemo(() => {
    const list = filterKey ? rows.filter((r) => r.gaps.some((g) => g.key === filterKey)) : rows;
    const teamName = (id) => (teams || []).find((tm) => tm.id === id)?.name || '';
    const by = SORTERS[sort.key]
      || (sort.key === 'project' ? (r) => (projectName?.(r.t.projectId) || '').toLowerCase() : null)
      || (sort.key === 'team' ? (r) => teamName(r.t.teamId).toLowerCase() : null);
    if (!by) return list;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => { const x = by(a); const y = by(b); return x < y ? -dir : x > y ? dir : 0; });
  }, [rows, filterKey, sort, projectName, teams]);
  const { cols, widths, template, startResize, resetWidth, autofitWidth, wrapRef, dragProps } = useTableColumns({
    table: 'dataquality', cols: COLUMNS,
  });

  // ── Row virtualization ──────────────────────────────────────────────────────
  // Opening this tab with ~2000 gap rows used to freeze the tab switch for a
  // few seconds before it "suddenly" appeared (Pranshu, Sep 4) - every row
  // mounts three live SearchSelect pickers + a DateField, so a full list is
  // several thousand interactive components committed to the DOM at once.
  // Same fixed-row-height + spacer-padding approach InventoryManagement.jsx's
  // catalog table already uses: render only the rows near the viewport (+
  // overscan) inside the bounded scroll box.
  const OVERSCAN = 8;
  const scrollRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(640);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight || 640);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  // A new filter (or the task list itself changing) can land the old scroll
  // position past the end of a now-shorter list - snap back to the top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [filterKey, tasks, sort]);
  const onScroll = useCallback((e) => setScrollTop(e.currentTarget.scrollTop), []);
  const vStart = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const vEnd = Math.min(filteredRows.length, vStart + Math.ceil(viewportH / ROW_H) + OVERSCAN * 2);
  const vSlice = filteredRows.slice(vStart, vEnd);
  const padTop = vStart * ROW_H;
  const padBot = Math.max(0, (filteredRows.length - vEnd) * ROW_H);

  // Selects/clears every row under the CURRENT filter, not the whole
  // company-wide set - "select all" on "1031 unassigned" should pick those
  // 1031, not silently rope in the other ~900 rows the filter is hiding.
  const allFilteredSelected = filteredRows.length > 0 && filteredRows.every((r) => selected.has(r.t.id));
  const toggleSelectAll = () => setSelected(allFilteredSelected ? new Set() : new Set(filteredRows.map((r) => r.t.id)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '16px 16px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <AlertTriangle size={18} style={{ color: NX.amber }} />
          <div style={{ fontSize: 18, fontWeight: 700 }}>Data Quality</div>
        </div>
        <div style={{ fontSize: 13, color: NX.dim, marginBottom: 12 }}>
          Every open task, company-wide, with a gap - a required field left empty, or a missing Due Date, Project,
          Priority, Team or Assignee. Fix any of them right here without opening the task.
        </div>
        {rows.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            {/* Every kind of gap is one pick away here (Sagar, Oct 14 2026);
                only the REQUIRED ones get an alert chip beside it. */}
            <div style={{ minWidth: 230 }}>
              <SearchSelect value={filterKey || ''} searchPlaceholder="Search gaps…" emptyText="No gaps."
                options={[
                  { id: '', label: `All Gaps (${rows.length})` },
                  ...mandatoryKinds.map((g) => ({ id: g.key, label: `${g.label} - Required (${countFor(g.key)})` })),
                  ...GAP_DEFS.filter((g) => countFor(g.key) > 0).map((g) => ({
                    id: g.key, label: g.key === 'assignee' ? `Unassigned (${countFor(g.key)})` : `Missing ${g.label} (${countFor(g.key)})`,
                  })),
                ]}
                buttonStyle={{ ...inputStyle, width: '100%', padding: '6px 10px', fontSize: 13, height: 'auto', fontWeight: 400 }}
                onPick={(id) => setFilterKey(id || null)} />
            </div>
            {mandatoryKinds.map((g) => (
              <FilterChip key={g.key} label={`${countFor(g.key)} missing ${g.label}`}
                active={filterKey === g.key} color={NX.red} tint="rgba(220,38,38,0.12)"
                onClick={() => setFilterKey((k) => (k === g.key ? null : g.key))} />
            ))}
            <span style={{ marginLeft: 'auto' }}><ResetColumnsButton /></span>
          </div>
        )}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {rows.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="Nothing missing" hint="Every open task has a due date, project, priority, team, and assignee." />
        ) : (
          <div ref={wrapRef} style={{ margin: '0 16px 16px', border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, width: 'fit-content', minWidth: 'calc(100% - 32px)', '--nx-grid': template }}>
            {/* Sticky, like the list's: the titles stay put while you scroll.
                Drag a title to move its column, its right edge to resize
                (double-click to fit), click it to sort. */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'var(--nx-grid)', minHeight: 36, alignItems: 'stretch',
              borderBottom: `1px solid ${NX.border2}`, background: NX.surface, borderRadius: '12px 12px 0 0',
              fontSize: 13, fontWeight: 400, color: NX.dim, position: 'sticky', top: 0, zIndex: 9,
            }}>
              {cols.map((c) => (c.key === 'check' ? (
                <div key={c.key} style={cell}>
                  <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAll}
                    title="Select all" style={{ cursor: 'pointer' }} />
                </div>
              ) : (
                <TableHead key={c.key} label={c.label} sortKey={c.key} sort={sort} setSort={setSort}
                  sortReset={{ key: '', dir: 'asc' }} align={c.key === 'task' ? 'flex-start' : 'center'}
                  drag={dragProps(c.key, !c.fixed)}
                  onResizeStart={startResize(c.key, widths[c.key] ?? c.width)}
                  onResizeReset={() => resetWidth(c.key)} onResizeAutofit={() => autofitWidth(c.key)}
                  style={cell} />
              )))}
            </div>
            {padTop > 0 && <div style={{ height: padTop }} />}
            {vSlice.map(({ t, gaps }) => <GapRow key={t.id} t={t} gaps={gaps} store={store} onOpen={setOpenId} selected={selected} toggleSel={toggleSel} cols={cols} />)}
            {padBot > 0 && <div style={{ height: padBot }} />}
          </div>
        )}
      </div>

      {/* Batch edit bar - same floating pill TasksWorkspace's Task List uses. */}
      {selected.size > 0 && (() => {
        const selStyle = { ...inputStyle, width: 'auto', padding: '5px 8px', background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', flexShrink: 0 };
        const apply = (patch) => { bulkUpdate([...selected], patch); clearSel(); };
        const remove = () => {
          if (!confirm(`Delete ${selected.size} task(s)? This can't be undone from here.`)) return;
          [...selected].forEach(deleteTask);
          clearSel();
        };
        return (
          <div className="nx-scroll" style={{ position: 'absolute', left: '50%', bottom: 22, transform: 'translateX(-50%)', background: NX.primary, color: '#fff', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.28)', zIndex: 30, maxWidth: 'min(96vw, 1180px)', overflowX: 'auto' }}>
            <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>{selected.size} selected</span>
            <DateField value="" onChange={(v) => apply({ dueOn: v })} noPast placeholder="Due date…" color="#fff"
              style={{ ...selStyle, minWidth: 118 }} />
            <select onChange={(e) => { if (e.target.value) apply({ priority: e.target.value }); }} defaultValue="" style={selStyle}>
              <option value="" disabled>Priority…</option>
              {PRIORITY_ORDER.map((p) => <option key={p} value={p} style={{ color: NX.ink }}>{PRIORITY_META[p].label}</option>)}
            </select>
            <SearchSelect placeholder="Assign…" searchPlaceholder="Search people…"
              buttonStyle={{ ...selStyle, minWidth: 132 }} emptyText="No people in the directory."
              options={[{ id: '-', label: 'Unassigned' }, ...people.map((p) => ({ id: p.email, label: p.name, keywords: p.email }))]}
              onPick={(id) => apply({ assigneeIds: id === '-' ? [] : [id] })} />
            <SearchSelect placeholder="Move To…" searchPlaceholder="Search projects…"
              buttonStyle={{ ...selStyle, minWidth: 140 }} menuMinWidth={300}
              emptyText="No projects yet." options={projectOptions(store.projects)}
              onPick={(id) => apply({ projectId: id || '' })} />
            <button onClick={remove} style={{ ...btn('ghost'), color: '#fff', flexShrink: 0 }}><Trash2 size={15} />Delete</button>
            <button onClick={clearSel} style={{ ...btn('ghost'), color: '#fff', padding: 5, flexShrink: 0 }}><X size={16} /></button>
          </div>
        );
      })()}

      {openId && <TaskDetailDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
