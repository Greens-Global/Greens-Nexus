// Floating bar for acting on several selected tasks at once - status, priority,
// assignee, move to project, duplicate, delete. Shared by the project workspace
// (TasksWorkspace) and My Tasks so the two lists batch-edit the same way.
// Renders nothing when the selection is empty; the parent owns `selected`.
import { useRef, useState } from 'react';
import { Copy, Trash2, X } from 'lucide-react';
import { taskAssignees, bulkFieldsFor } from './lib';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { SearchSelect } from './components';
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
  if (!selected.size) return null;
  const { tasks, bulkUpdate, deleteTask } = store;
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
  const selStyle = { ...inputStyle, width: 'auto', padding: '5px 8px', background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', flexShrink: 0 };
  const duplicate = async () => {
    const picked = tasks.filter((t) => selected.has(t.id));
    // A copy can be refused - say a project now requires a field the
    // original never had (Oct 13 2026) - and that used to vanish silently.
    const failed = [];
    for (const t of picked) {
      await store.createTask({
        title: `${t.title} (copy)`, type: t.type || 'task', description: t.description || '',
        status: t.status || 'not_started', priority: t.priority || 'medium',
        projectId: t.projectId || '', teamId: t.teamId || '', assigneeIds: taskAssignees(t),
        followerIds: t.followerIds || [], dueOn: t.dueOn || '', startOn: t.startOn || '',
        tags: t.tags || [], estimateHours: t.estimateHours ?? null, isMilestone: !!t.isMilestone,
        customFieldValues: t.customFieldValues || {},
      }).catch((e) => { failed.push(`"${t.title}": ${e?.message || 'could not be copied'}`); });
    }
    if (failed.length) alert(`${failed.length} of ${picked.length} could not be duplicated:\n${failed.slice(0, 5).join('\n')}`);
    clearSel();
  };
  return (
    /* One row on desktop: the controls grew when Assign/Move To became
       searchable pickers and the bar wrapped Delete onto a second line,
       which reads as two bars. It scrolls sideways rather than wrapping if
       it ever does run out of room, and still wraps on mobile where a
       single row genuinely cannot fit. */
    <div className="nx-scroll" style={{ position: 'absolute', left: '50%', bottom: 22, transform: 'translateX(-50%)', background: NX.primary, color: '#fff', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.28)', zIndex: 30, flexWrap: isMobile ? 'wrap' : 'nowrap', overflowX: isMobile ? 'visible' : 'auto', maxWidth: 'min(96vw, 1180px)' }}>
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
      <SearchSelect placeholder="Assign…" searchPlaceholder="Search people…"
        buttonStyle={{ ...selStyle, minWidth: 132 }} emptyText="No people in the directory."
        options={[{ id: '-', label: 'Unassigned' },
                  ...people.map((p) => ({ id: p.email, label: p.name, keywords: p.email }))]}
        onPick={(id) => { bulkUpdate([...selected], { assigneeIds: id === '-' ? [] : [id] }); clearSel(); }} />
      {/* Move to another project. The server drops the old project's
          section and team on the way (see bulk_update) - both are
          project-scoped, so carrying them over would file the task under a
          group the destination does not have. Archived projects are left
          out: moving work INTO one is nobody's intent. */}
      <SearchSelect placeholder="Move To…" searchPlaceholder="Search projects…"
        buttonStyle={{ ...selStyle, minWidth: 140 }} menuMinWidth={300}
        emptyText="No other projects to move into."
        options={[{ id: '-', label: 'No project' },
                  ...(store.projects || []).filter((p) => !p.archived && p.id !== lockedProjectId)
                    .slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
                    .map((p) => ({ id: p.id, label: p.name }))]}
        onPick={(id) => { bulkUpdate([...selected], { projectId: id === '-' ? '' : id }); clearSel(); }} />
      {fields.length > 0 && (
        <span ref={fieldRef} style={{ display: 'inline-flex', flexShrink: 0 }}>
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
      {/* Custom grouping's sections (Oct 13 2026): file the selection under
          one at once - "these are the annual ones". */}
      {sections?.sections?.length > 0 && (
        <SearchSelect placeholder="Move to Section…" searchPlaceholder="Search sections…"
          buttonStyle={{ ...selStyle, minWidth: 150 }} emptyText="No sections yet."
          options={[{ id: '-', label: 'No Section' }, ...sections.sections.map((x) => ({ id: x.id, label: x.name }))]}
          onPick={(id) => { sections.move([...selected], id).catch((e) => alert(e?.message || 'Could not move the tasks.')); clearSel(); }} />
      )}
      <button onClick={duplicate} title="Duplicate the selected tasks" style={{ ...btn('ghost'), color: '#fff', flexShrink: 0 }}><Copy size={14} />Duplicate</button>
      <button onClick={() => { if (confirm(`Delete ${selected.size} task(s)?`)) { [...selected].forEach(deleteTask); clearSel(); } }} style={{ ...btn('ghost'), color: '#fff', flexShrink: 0 }}><Trash2 size={15} />Delete</button>
      <button onClick={clearSel} title="Clear Selection" style={{ ...btn('ghost'), color: '#fff', padding: 5, flexShrink: 0 }}><X size={16} /></button>
    </div>
  );
}
