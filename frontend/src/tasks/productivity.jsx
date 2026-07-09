// Task Module — productivity bar: Filters, Sort, Saved views, Templates, Intake.
// Ported from the export's productivity/* (FilterSortGroupBar, SavedViewsMenu,
// TemplatePicker, IntakeFormModal) into one inline-styled component wired to the
// TasksContext store. The export's store had applyTemplate/submitIntakeForm/
// saveView helpers; here those are expressed directly via createTask/createSavedView.
import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, ArrowUpDown, Bookmark, LayoutTemplate, Inbox, Plus, Trash2, X, ListChecks } from 'lucide-react';
import { useTasks } from './TasksContext';
import { Modal, PersonSelect, usePeople } from './components';
import { NX, FONT, btn, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER } from './theme';

const SORT_OPTIONS = [
  { key: 'manual', label: 'Manual' }, { key: 'dueOn', label: 'Due date' },
  { key: 'priority', label: 'Priority' }, { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status' }, { key: 'assignee', label: 'Assignee' },
];
const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

// Small popover anchored to its trigger.
function Popover({ label, icon: Icon, active, width = 240, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={{ ...btn('outline'), color: active ? NX.blue : NX.ink, borderColor: active || open ? NX.blue : NX.border }}>
        <Icon size={15} />{label}
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, width, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 60, padding: 12, maxHeight: '70vh', overflowY: 'auto' }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
const capWord = (s = '') => s.replace(/^\w/, (c) => c.toUpperCase());
const groupHead = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 6 };
const pill = (on, color, tint) => ({ borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none', background: on ? color : tint, color: on ? '#fff' : color });

export function ProductivityBar({ filters, setFilters, sort, setSort, lockedProjectId, current, onApplyView, onOpenTask }) {
  const store = useTasks();
  const { savedViews, createSavedView, deleteSavedView, templates, intakeForms, projects, projectName, createTask, myEmail } = store;
  const people = usePeople();

  const activeFilterCount = filters.assigneeIds.length + filters.statuses.length + filters.priorities.length
    + (lockedProjectId ? 0 : filters.projectIds.length);
  const dateActive = (filters.due && filters.due !== 'any') || filters.dueFrom || filters.dueTo;

  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontFamily: FONT }}>
      {/* Filters */}
      <Popover label={activeFilterCount ? `Filters · ${activeFilterCount}` : 'Filters'} icon={SlidersHorizontal} active={activeFilterCount > 0} width={260}>
        {() => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={groupHead}>Status</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {STATUS_ORDER.map((s) => { const on = filters.statuses.includes(s); const m = STATUS_META[s]; return <button key={s} onClick={() => setFilters({ ...filters, statuses: toggle(filters.statuses, s) })} style={pill(on, m.color, m.tint)}>{m.label}</button>; })}
              </div>
            </div>
            <div>
              <div style={groupHead}>Priority</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {PRIORITY_ORDER.map((p) => { const on = filters.priorities.includes(p); const m = PRIORITY_META[p]; return <button key={p} onClick={() => setFilters({ ...filters, priorities: toggle(filters.priorities, p) })} style={pill(on, m.color, m.tint)}>{m.label}</button>; })}
              </div>
            </div>
            <div>
              <div style={groupHead}>Assignee</div>
              <div style={{ maxHeight: 140, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8 }}>
                {people.map((u) => (
                  <label key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={filters.assigneeIds.includes(u.email)} onChange={() => setFilters({ ...filters, assigneeIds: toggle(filters.assigneeIds, u.email) })} />
                    {u.name}
                  </label>
                ))}
                {people.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>No people</div>}
              </div>
            </div>
            {!lockedProjectId && (
              <div>
                <div style={groupHead}>Project</div>
                <div style={{ maxHeight: 120, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8 }}>
                  {projects.map((p) => (
                    <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', fontSize: 13, cursor: 'pointer' }}>
                      <input type="checkbox" checked={filters.projectIds.includes(p.id)} onChange={() => setFilters({ ...filters, projectIds: toggle(filters.projectIds, p.id) })} />
                      {p.name}
                    </label>
                  ))}
                  {projects.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>No projects</div>}
                </div>
              </div>
            )}
            <div>
              <div style={groupHead}>Due</div>
              <select value={filters.due || 'any'} onChange={(e) => setFilters({ ...filters, due: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="any">Any time</option>
                <option value="overdue">Overdue</option>
                <option value="today">Due today</option>
                <option value="week">Due this week</option>
                <option value="none">No due date</option>
              </select>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                <input type="date" value={filters.dueFrom || ''} onChange={(e) => setFilters({ ...filters, dueFrom: e.target.value || null })} style={{ ...inputStyle, padding: '6px 8px', fontSize: 12 }} />
                <input type="date" value={filters.dueTo || ''} onChange={(e) => setFilters({ ...filters, dueTo: e.target.value || null })} style={{ ...inputStyle, padding: '6px 8px', fontSize: 12 }} />
              </div>
            </div>
            {(activeFilterCount > 0 || dateActive) && (
              <button onClick={() => setFilters({ ...filters, assigneeIds: [], statuses: [], priorities: [], projectIds: [], due: 'any', dueFrom: null, dueTo: null })} style={{ ...btn('outline'), justifyContent: 'center' }}>Clear filters</button>
            )}
          </div>
        )}
      </Popover>

      {/* Sort */}
      <Popover label="Sort" icon={ArrowUpDown} width={190}>
        {(close) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {SORT_OPTIONS.map((o) => (
              <button key={o.key} onClick={() => { setSort({ ...sort, key: o.key }); close(); }} style={{ ...btn('ghost'), justifyContent: 'flex-start', color: sort.key === o.key ? NX.blue : NX.ink, background: sort.key === o.key ? NX.hover : 'transparent' }}>{o.label}</button>
            ))}
            <div style={{ borderTop: `1px solid ${NX.border2}`, margin: '4px 0' }} />
            <button onClick={() => setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })} style={{ ...btn('ghost'), justifyContent: 'flex-start' }}>Direction: {sort.dir === 'asc' ? 'Ascending' : 'Descending'}</button>
          </div>
        )}
      </Popover>

      {/* Saved views */}
      <Popover label="Saved views" icon={Bookmark} width={260}>
        {(close) => <SavedViews {...{ savedViews, createSavedView, deleteSavedView, current, filters, sort, onApplyView, close }} />}
      </Popover>

      {templates.length > 0 && (
        <button onClick={() => setTemplatesOpen(true)} style={btn('outline')}><LayoutTemplate size={15} />Templates</button>
      )}
      {intakeForms.length > 0 && (
        <button onClick={() => setIntakeOpen(true)} style={btn('outline')}><Inbox size={15} />Intake</button>
      )}

      {templatesOpen && <TemplatesModal templates={templates} createTask={createTask} onOpenTask={onOpenTask} onClose={() => setTemplatesOpen(false)} />}
      {intakeOpen && <IntakeModal forms={intakeForms} projectName={projectName} createTask={createTask} myEmail={myEmail} onOpenTask={onOpenTask} onClose={() => setIntakeOpen(false)} />}
    </div>
  );
}

function SavedViews({ savedViews, createSavedView, deleteSavedView, current, filters, sort, onApplyView, close }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const save = async () => {
    const n = name.trim(); if (!n) return;
    await createSavedView({ name: n, view: current.view, group: current.group, filters, sort }).catch(() => {});
    setName(''); setNaming(false); close();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {savedViews.length === 0 && <div style={{ fontSize: 12, color: NX.faint, padding: '4px 6px' }}>No saved views yet.</div>}
      {savedViews.map((v) => (
        <div key={v.id} style={{ display: 'flex', alignItems: 'center' }}>
          <button onClick={() => { onApplyView(v); close(); }} style={{ ...btn('ghost'), justifyContent: 'flex-start', flex: 1 }}>{v.name}</button>
          <button onClick={() => { if (confirm(`Delete view "${v.name}"?`)) deleteSavedView(v.id); }} title="Delete view" style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><Trash2 size={13} /></button>
        </div>
      ))}
      <div style={{ borderTop: `1px solid ${NX.border2}`, margin: '4px 0' }} />
      {naming ? (
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} placeholder="View name…" style={{ ...inputStyle, fontSize: 13 }} />
      ) : (
        <button onClick={() => setNaming(true)} style={{ ...btn('ghost'), justifyContent: 'flex-start' }}><Plus size={15} />Save current view</button>
      )}
    </div>
  );
}

function TemplatesModal({ templates, createTask, onOpenTask, onClose }) {
  const [busy, setBusy] = useState(false);
  const apply = async (tpl) => {
    if (busy) return; setBusy(true);
    try {
      const patch = tpl.patch || {};
      const parent = await createTask({ title: tpl.name, type: 'task', status: 'not_started', priority: patch.priority || 'medium', ...patch });
      for (const st of (tpl.subtaskTitles || [])) {
        await createTask({ title: st, parentTaskId: parent.id, status: 'not_started', priority: 'medium', type: 'task' }).catch(() => {});
      }
      onClose(); onOpenTask?.(parent.id);
    } catch { /* store refetch surfaces errors */ } finally { setBusy(false); }
  };
  return (
    <Modal title="Task templates" onClose={onClose} width={560}>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: NX.dim }}>Start from a standardized checklist. Applying a template creates a parent task with its subtasks pre-filled.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {templates.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, border: `1px solid ${NX.border}`, borderRadius: 12, padding: 14 }}>
            <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: NX.hover, color: NX.purple }}><LayoutTemplate size={18} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: NX.ink }}>{t.name}</div>
              {t.description && <div style={{ fontSize: 12, color: NX.dim }}>{t.description}</div>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {(t.subtaskTitles || []).map((s) => <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: NX.surface2, borderRadius: 6, padding: '2px 6px', fontSize: 11, color: NX.dim }}><ListChecks size={10} />{s}</span>)}
              </div>
            </div>
            <button onClick={() => apply(t)} disabled={busy} style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }}>Use</button>
          </div>
        ))}
        {templates.length === 0 && <div style={{ fontSize: 13, color: NX.faint }}>No templates defined yet.</div>}
      </div>
    </Modal>
  );
}

function IntakeModal({ forms, projectName, createTask, myEmail, onOpenTask, onClose }) {
  const form = forms[0];
  const [summary, setSummary] = useState('');
  const [priority, setPriority] = useState('medium');
  const [neededBy, setNeededBy] = useState('');
  const [busy, setBusy] = useState(false);
  if (!form) return null;
  const submit = async () => {
    if (!summary.trim() || busy) return; setBusy(true);
    try {
      const t = await createTask({ title: summary.trim(), priority, projectId: form.targetProjectId || '', dueOn: neededBy || '', status: 'not_started', type: 'task', assigneeId: '' });
      onClose(); onOpenTask?.(t.id);
    } catch { /* surfaced by refetch */ } finally { setBusy(false); }
  };
  return (
    <Modal title={form.title || 'Submit a request'} onClose={onClose}
      footer={<>
        <button onClick={onClose} style={btn('outline')}>Cancel</button>
        <button onClick={submit} disabled={!summary.trim() || busy} style={{ ...btn('primary'), opacity: !summary.trim() || busy ? 0.6 : 1 }}>Submit request</button>
      </>}>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: NX.dim }}>Submit a structured request. On submit, a task is created{form.targetProjectId ? ` in ${projectName(form.targetProjectId)}` : ''}.</p>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>Summary</label>
        <input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Describe your request" style={inputStyle} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>Needed by</label>
          <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} style={inputStyle} />
        </div>
      </div>
    </Modal>
  );
}
