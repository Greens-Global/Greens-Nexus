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
import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { AlertTriangle, CheckCircle2, Trash2, X } from 'lucide-react';
import { NX, FONT, btn, chip, input as inputStyle, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { Avatar, DateField, EmptyState, SearchSelect, usePeople } from './components';
import { teamInProject, taskAssignees } from './lib';
import TaskDetailDrawer from './TaskDetailDrawer';

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

const gapChip = (label) => <span key={label} style={chip(NX.amber, 'rgba(217,119,6,0.14)')}>{label}</span>;

function GapRow({ t, gaps, store, onOpen, selected, toggleSel }) {
  const { projects, teams, nameOf } = store;
  const projOpts = useMemo(() => projectOptions(projects), [projects]);
  const teamOpts = [{ id: '', label: 'No team' },
    ...(teams || []).filter((tm) => teamInProject(tm, t.projectId)).map((tm) => ({ id: tm.id, label: tm.name }))];
  const has = (key) => gaps.some((g) => g.key === key);
  const assignees = taskAssignees(t);
  const isSel = selected.has(t.id);

  return (
    <div onClick={() => onOpen(t.id)} style={{
      display: 'grid', gridTemplateColumns: '24px minmax(220px,1.6fr) minmax(180px,1fr) 130px 200px 130px 160px',
      alignItems: 'center', gap: 10, padding: '9px 16px', borderBottom: `1px solid ${NX.border2}`,
      fontSize: 13, cursor: 'pointer', background: isSel ? 'rgba(37,99,235,0.08)' : 'transparent',
    }}
      onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = NX.hover; }}
      onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}>
      <input type="checkbox" checked={isSel} onClick={(e) => e.stopPropagation()} onChange={() => toggleSel(t.id)} style={{ cursor: 'pointer' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {assignees.length ? (
          <span title={assignees.map((e) => nameOf?.(e) || e).join(', ')} style={{ display: 'flex', flexShrink: 0 }}>
            {assignees.slice(0, 2).map((e, i) => <span key={e} style={{ marginLeft: i ? -6 : 0 }}><Avatar email={e} size={20} /></span>)}
          </span>
        ) : (
          <span title="Unassigned" style={{ width: 20, height: 20, borderRadius: '50%', border: `1.5px dashed ${NX.border}`, flexShrink: 0 }} />
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, color: NX.ink }}>{t.title}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {gaps.map((g) => gapChip(g.label))}
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <DateField value={t.dueOn || ''} onChange={(v) => store.updateTask(t.id, { dueOn: v })}
          title="Due Date" compact
          style={{ fontSize: 12.5, padding: '3px 6px', background: has('dueOn') ? 'rgba(217,119,6,0.08)' : 'transparent', borderRadius: 6 }} />
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <SearchSelect value={t.projectId || ''} placeholder="No project" searchPlaceholder="Search projects…"
          emptyText="No projects yet." options={projOpts}
          buttonStyle={{ border: 'none', borderRadius: 6, padding: '3px 6px', fontSize: 12.5, color: t.projectId ? NX.dim : NX.faint, background: has('projectId') ? 'rgba(217,119,6,0.08)' : 'transparent', fontFamily: FONT, width: '100%', height: 'auto', minHeight: 0, cursor: 'pointer', fontWeight: 400, justifyContent: 'flex-start' }}
          onPick={(id) => store.updateTask(t.id, { projectId: id || null })} />
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <SearchSelect value={t.priority || ''} placeholder="No priority" searchPlaceholder="Search…"
          emptyText="No options." options={PRIORITY_ORDER.map((p) => ({ id: p, label: PRIORITY_META[p].label }))}
          buttonStyle={{ border: 'none', borderRadius: 6, padding: '3px 6px', fontSize: 12.5, color: t.priority ? NX.dim : NX.faint, background: has('priority') ? 'rgba(217,119,6,0.08)' : 'transparent', fontFamily: FONT, width: '100%', height: 'auto', minHeight: 0, cursor: 'pointer', fontWeight: 400, justifyContent: 'flex-start' }}
          onPick={(id) => store.updateTask(t.id, { priority: id || null })} />
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <SearchSelect value={t.teamId || ''} placeholder="No team" searchPlaceholder="Search…"
          emptyText="No teams for this project." options={teamOpts}
          buttonStyle={{ border: 'none', borderRadius: 6, padding: '3px 6px', fontSize: 12.5, color: t.teamId ? NX.dim : NX.faint, background: has('teamId') ? 'rgba(217,119,6,0.08)' : 'transparent', fontFamily: FONT, width: '100%', height: 'auto', minHeight: 0, cursor: 'pointer', fontWeight: 400, justifyContent: 'flex-start' }}
          onPick={(id) => store.updateTask(t.id, { teamId: id || null })} />
      </div>
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
      const gaps = GAP_DEFS.filter((g) => g.test(t));
      if (gaps.length) out.push({ t, gaps });
    }
    return out.sort((a, b) => String(a.t.title || '').localeCompare(String(b.t.title || ''), 'en', { sensitivity: 'base' }));
  }, [tasks]);

  // Counts always reflect the FULL gap set, not the current filter - so every
  // chip's number stays put while you click between them, instead of the row
  // you just filtered to reading "0 missing X" everywhere else.
  const countFor = (key) => rows.reduce((n, r) => n + (r.gaps.some((g) => g.key === key) ? 1 : 0), 0);
  const filteredRows = filterKey ? rows.filter((r) => r.gaps.some((g) => g.key === filterKey)) : rows;

  // ── Row virtualization ──────────────────────────────────────────────────────
  // Opening this tab with ~2000 gap rows used to freeze the tab switch for a
  // few seconds before it "suddenly" appeared (Pranshu, Sep 4) - every row
  // mounts three live SearchSelect pickers + a DateField, so a full list is
  // several thousand interactive components committed to the DOM at once.
  // Same fixed-row-height + spacer-padding approach InventoryManagement.jsx's
  // catalog table already uses: render only the rows near the viewport (+
  // overscan) inside the bounded scroll box.
  const ROW_H = 46;
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
  }, [filterKey, tasks]);
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
          Every open task, company-wide, missing a Due Date, Project, Priority, Team, or Assignee - fix any
          of them right here without opening the task. Click a count below to narrow the list to just that gap.
        </div>
        {rows.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            <FilterChip label={`${rows.length} task${rows.length === 1 ? '' : 's'} with gaps`}
              active={!filterKey} color={NX.dim} tint={NX.border2} onClick={() => setFilterKey(null)} />
            {GAP_DEFS.map((g) => countFor(g.key) > 0 && (
              <FilterChip key={g.key} label={g.chipText ? g.chipText(countFor(g.key)) : `${countFor(g.key)} missing ${g.label}`}
                active={filterKey === g.key} color={NX.amber} tint="rgba(217,119,6,0.12)"
                onClick={() => setFilterKey((k) => (k === g.key ? null : g.key))} />
            ))}
          </div>
        )}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {rows.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="Nothing missing" hint="Every open task has a due date, project, priority, team, and assignee." />
        ) : (
          <>
            <div style={{
              display: 'grid', gridTemplateColumns: '24px minmax(220px,1.6fr) minmax(180px,1fr) 130px 200px 130px 160px',
              gap: 10, padding: '8px 16px', borderTop: `1px solid ${NX.border}`, borderBottom: `1px solid ${NX.border}`,
              background: NX.surface2, fontSize: 11.5, fontWeight: 700, color: NX.dim, textTransform: 'uppercase',
              position: 'sticky', top: 0, zIndex: 1,
            }}>
              <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAll}
                title="Select all" style={{ cursor: 'pointer' }} />
              <span>Task</span><span>Missing</span><span>Due Date</span><span>Project</span><span>Priority</span><span>Team</span>
            </div>
            {padTop > 0 && <div style={{ height: padTop }} />}
            {vSlice.map(({ t, gaps }) => <GapRow key={t.id} t={t} gaps={gaps} store={store} onOpen={setOpenId} selected={selected} toggleSel={toggleSel} />)}
            {padBot > 0 && <div style={{ height: padBot }} />}
          </>
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
            <DateField value="" onChange={(v) => apply({ dueOn: v })} placeholder="Due date…" color="#fff"
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
