// Floating bar for acting on several selected tasks at once - status, priority,
// assignee, move to project, duplicate, delete. Shared by the project workspace
// (TasksWorkspace) and My Tasks so the two lists batch-edit the same way.
// Renders nothing when the selection is empty; the parent owns `selected`.
import { useRef, useState } from 'react';
import { CalendarDays, Copy, Trash2, X } from 'lucide-react';
import { bulkFieldsFor, duplicateTaskData, deleteSelectedTasks } from './lib';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { SearchSelect } from './components';
import BulkDatesPanel from './BulkDatesPanel';
import { CustomFieldInput } from './TaskDetailDrawer';
import AnchoredMenu from '../components/AnchoredMenu';

const emptyFor = (f) => (f?.type === 'people' || f?.type === 'multiselect' ? [] : f?.type === 'checkbox' ? false : '');
const isBlank = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

export default function BulkActionBar({ selected, clearSel, store, people, lockedProjectId = '', isMobile = false, sections = null }) {
  // The field being set, and the value typed for it, in a small panel over
  // the bar - the value widget is the task drawer's own, so every field type
  // is set the way it is on one task.
  const [fieldId, setFieldId] = useState('');
  const [draft, setDraft] = useState('');
  const fieldRef = useRef(null);
  const [datesOpen, setDatesOpen] = useState(false);
  const datesRef = useRef(null);
  if (!selected.size) return null;
  const { tasks, bulkUpdate } = store;
  const fields = bulkFieldsFor(store.customFields, tasks, selected);
  const field = fields.find((f) => f.id === fieldId) || null;
  const closeField = () => { setFieldId(''); setDraft(''); };
  // Merged into each task's own values server-side (bulk_update), so setting
  // one field leaves the others alone; '' clears just this one.
  const applyField = (value) => {
    if (!field) return;
    bulkUpdate([...selected], { customFieldValues: { [field.id]: value } }).catch(() => {});
    closeField();
    clearSel();
  };
  // SearchSelect's wrapper is minWidth:0 (so it can ellipsize in a table
  // cell); in this row that let it shrink to nothing once the bar ran out of
  // room, and Assign / Move To / Duplicate painted on top of each other
  // (phone, Oct 13 2026). Each picker sits in one of these instead.
  const keep = { display: 'inline-flex', flexShrink: 0 };
  const selStyle = { ...inputStyle, width: 'auto', padding: '5px 8px', background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', flexShrink: 0 };
  const duplicate = async () => {
    const picked = tasks.filter((t) => selected.has(t.id));
    // A copy can be refused - say a project now requires a field the
    // original never had (Oct 13 2026) - and that used to vanish silently.
    const failed = [];
    for (const t of picked) {
      await store.createTask(duplicateTaskData(t)).catch((e) => { failed.push(`"${t.title}": ${e?.message || 'could not be copied'}`); });
    }
    if (failed.length) alert(`${failed.length} of ${picked.length} could not be duplicated:\n${failed.slice(0, 5).join('\n')}`);
    clearSel();
  };
  // Phones: the bar takes the floating MobileTaskBar's slot (the parent hides
  // that bar while anything is selected) - same offset above the module nav,
  // one row that swipes sideways. It used to wrap into a three-row block
  // pinned to the list's bottom with the task bar's "+" sitting on top of it.
  const place = isMobile
    ? { position: 'fixed', left: 12, right: 12, bottom: 'calc(64px + env(safe-area-inset-bottom) + 18px)', zIndex: 2500, padding: '8px 10px' }
    : { position: 'absolute', left: '50%', bottom: 22, transform: 'translateX(-50%)', zIndex: 30, padding: '10px 14px', maxWidth: 'min(96vw, 1180px)' };
  return (
    /* One row: the controls grew when Assign/Move To became searchable
       pickers and the bar wrapped Delete onto a second line, which reads as
       two bars. It scrolls sideways rather than wrapping when it runs out
       of room. */
    <div className="nx-scroll" style={{ ...place, background: NX.primary, color: '#fff', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.28)', flexWrap: 'nowrap', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>{selected.size} selected</span>
      <select onChange={(e) => { if (e.target.value) { bulkUpdate([...selected], { status: e.target.value }); clearSel(); } }} defaultValue="" style={selStyle}>
        <option value="" disabled>Status…</option>
        {/* Scoped to the project in view - see richlist's groupCtx note. */}
        {(store.statusOrderFor ? store.statusOrderFor(lockedProjectId) : store.statusOrder).map((s) => <option key={s} value={s} style={{ color: NX.ink }}>{store.statusMeta[s]?.label || s}</option>)}
      </select>
      <select onChange={(e) => { if (e.target.value) { bulkUpdate([...selected], { priority: e.target.value }); clearSel(); } }} defaultValue="" style={selStyle}>
        <option value="" disabled>Priority…</option>
        {['urgent', 'high', 'medium', 'low'].map((p) => <option key={p} value={p} style={{ color: NX.ink }}>{p[0].toUpperCase() + p.slice(1)}</option>)}
      </select>
      {/* Bulk assign REPLACES the assignee list with the one person picked -
          the same thing it has always meant, and the only unambiguous
          reading when the selection holds tasks with different people on
          them. Adding somebody alongside is a per-task action, done in the
          drawer. */}
      <span style={keep}>
        <SearchSelect placeholder="Assign…" searchPlaceholder="Search people…"
          buttonStyle={{ ...selStyle, minWidth: 132 }} emptyText="No people in the directory."
          options={[{ id: '-', label: 'Unassigned' },
                    ...people.map((p) => ({ id: p.email, label: p.name, keywords: p.email }))]}
          onPick={(id) => { bulkUpdate([...selected], { assigneeIds: id === '-' ? [] : [id] }); clearSel(); }} />
      </span>
      {/* Move to another project. The server drops the old project's
          section and team on the way (see bulk_update) - both are
          project-scoped, so carrying them over would file the task under a
          group the destination does not have. Archived projects are left
          out: moving work INTO one is nobody's intent. */}
      <span style={keep}>
        <SearchSelect placeholder="Move To…" searchPlaceholder="Search projects…"
          buttonStyle={{ ...selStyle, minWidth: 140 }} menuMinWidth={300}
          emptyText="No other projects to move into."
          options={[{ id: '-', label: 'No project' },
                    ...(store.projects || []).filter((p) => !p.archived && p.id !== lockedProjectId)
                      .slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
                      .map((p) => ({ id: p.id, label: p.name }))]}
          onPick={(id) => { bulkUpdate([...selected], { projectId: id === '-' ? '' : id }); clearSel(); }} />
      </span>
      {fields.length > 0 && (
        <span ref={fieldRef} style={keep}>
          <SearchSelect placeholder="Set Field…" searchPlaceholder="Search fields…"
            buttonStyle={{ ...selStyle, minWidth: 124 }} emptyText="No fields to set."
            options={fields.map((f) => ({ id: f.id, label: f.name }))}
            onPick={(id) => { setFieldId(id); setDraft(emptyFor(fields.find((f) => f.id === id))); }} />
        </span>
      )}
      <AnchoredMenu anchorRef={fieldRef} open={!!field} onClose={closeField} role="dialog"
        style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.2)', padding: 14, minWidth: 280, fontFamily: FONT, color: NX.ink }}>
        {field && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              Set {field.name} on {selected.size} {selected.size === 1 ? 'Task' : 'Tasks'}
            </div>
            <CustomFieldInput field={field} value={draft} onChange={setDraft} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => applyField('')} title={`Clear ${field.name} on the selected tasks`}
                style={{ ...btn('ghost'), fontSize: 12.5 }}>Clear Value</button>
              <button type="button" onClick={() => applyField(draft)} disabled={isBlank(draft)}
                style={{ ...btn('primary'), fontSize: 12.5, opacity: isBlank(draft) ? 0.6 : 1 }}>Apply</button>
            </div>
          </div>
        )}
      </AnchoredMenu>
      {/* Dates (Oct 22 2026): shift, set or clear dates on the selection. */}
      {store.bulkDates && (
        <span ref={datesRef} style={keep}>
          <button type="button" onClick={() => setDatesOpen((o) => !o)} aria-expanded={datesOpen}
            style={{ ...selStyle, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: FONT }}>
            <CalendarDays size={14} />Dates…
          </button>
        </span>
      )}
      <AnchoredMenu anchorRef={datesRef} open={datesOpen} onClose={() => setDatesOpen(false)} role="dialog" aria-label="Change Dates"
        style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.2)', padding: 14, minWidth: 300, maxWidth: 380, fontFamily: FONT, color: NX.ink }}>
        {datesOpen && (
          <BulkDatesPanel ids={[...selected]} tasks={tasks} store={store}
            onDone={() => { setDatesOpen(false); clearSel(); }} />
        )}
      </AnchoredMenu>
      {/* Custom grouping's sections (Oct 13 2026): file the selection under
          one at once - "these are the annual ones". */}
      {sections?.sections?.length > 0 && (
        <span style={keep}>
          <SearchSelect placeholder="Move to Section…" searchPlaceholder="Search sections…"
            buttonStyle={{ ...selStyle, minWidth: 150 }} emptyText="No sections yet."
            options={[{ id: '-', label: 'No Section' }, ...sections.sections.map((x) => ({ id: x.id, label: x.name }))]}
            onPick={(id) => { sections.move([...selected], id).catch((e) => alert(e?.message || 'Could not move the tasks.')); clearSel(); }} />
        </span>
      )}
      <button onClick={duplicate} title="Duplicate the selected tasks" style={{ ...btn('ghost'), color: '#fff', flexShrink: 0 }}><Copy size={14} />Duplicate</button>
      <button onClick={() => { if (confirm(`Delete ${selected.size} task(s)?`)) { const ids = [...selected]; clearSel(); deleteSelectedTasks(store, ids).catch(() => {}); } }} style={{ ...btn('ghost'), color: '#fff', flexShrink: 0 }}><Trash2 size={15} />Delete</button>
      <button onClick={clearSel} title="Clear Selection" aria-label="Clear Selection" style={{ ...btn('ghost'), color: '#fff', padding: 5, flexShrink: 0 }}><X size={16} /></button>
    </div>
  );
}
