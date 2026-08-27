// Task Module - Project Templates. A card grid of saved project blueprints,
// the "Use Template" flow that builds a real project from one, and the two
// modals the Projects screen reuses: Save as Template and Duplicate Project.
//
// A template is a BLUEPRINT: structure only. It carries sections, tasks,
// subtasks, dependencies, tags, priorities, task custom-field values, and the
// DEFINITIONS of the custom fields and custom statuses the source project used.
// It carries no people and no settings at all - no owner, members, teams,
// portfolio, department or visibility, and its tasks hold no assignees. Those
// are asked for when the template is USED, on the ordinary create-a-project
// form (ProjectModal in template mode), because they belong to the new project
// rather than to whichever project happened to be captured.
//
// It is also a SNAPSHOT, not a live link (see backend
// models.TaskProjectTemplate). Editing the source project afterwards never
// changes the template, deleting the source leaves the template usable, and
// deleting a template never touches the projects already built from it. The
// screen says so out loud rather than leaving people to find out.
//
// Dates ride as day OFFSETS from the template's anchor day, so the create form
// asks for one start date and every task re-anchors to it.
import { useEffect, useMemo, useState } from 'react';
import {
  LayoutTemplate, Plus, Search, Copy, Trash2, Pencil, Archive, Globe, Lock,
  FolderKanban, CalendarDays, ListChecks, Users, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { useTasks } from './TasksContext';
import { NX, FONT, btn, input as inputStyle, card, chip } from './theme';
import { Avatar, EmptyState, Modal, usePeople, useIsMobile, MobileFab, SearchSelect } from './components';
import { formatDate } from '../lib/datetime';

const VISIBILITY_OPTS = [
  { key: 'org', icon: Globe, label: 'Everyone', desc: 'Anyone in the Task module can find and use this template.' },
  { key: 'restricted', icon: Lock, label: 'Only Me', desc: 'Only you (and managers) can see or use this template.' },
];

const label = { fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };

// Today as yyyy-mm-dd in the LOCAL day, not UTC. toISOString() is UTC, so
// anywhere behind it that reads as yesterday and every task lands a day early.
// Exported for the New-project chooser, which seeds the same anchor.
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A labelled checkbox row - the option lists in all three modals are the same
 *  shape, and three hand-rolled copies would drift apart. */
function OptionRow({ checked, onChange, title, hint, disabled }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 9, padding: '6px 2px',
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    }}>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, cursor: disabled ? 'default' : 'pointer', flexShrink: 0 }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, color: NX.ink }}>{title}</span>
        {hint && <span style={{ display: 'block', fontSize: 11.5, color: NX.faint, marginTop: 1 }}>{hint}</span>}
      </span>
    </label>
  );
}

/** "24 tasks · 4 sections · 3 people" for whatever a capture would carry.
 *  Fetched from the server rather than counted client-side: the browser's task
 *  list is filtered by what the viewer can see, so counting here would quietly
 *  under-report a project they only partly have access to. */
function usePreview(projectId, opts, blueprint = true) {
  const { previewProjectTemplate } = useTasks();
  const key = `${projectId}|${opts.includeSubtasks}|${opts.includeCompleted}|${blueprint}`;
  // Keyed by `key`, so a change of options invalidates the previous counts
  // without an effect having to null them out first (which React flags as a
  // cascading render). A stale result for an older key is ignored below.
  const [preview, setPreview] = useState(null);
  const [forKey, setForKey] = useState('');
  useEffect(() => {
    if (!projectId) return undefined;
    let alive = true;
    previewProjectTemplate(projectId, {
      include_subtasks: opts.includeSubtasks ? 'true' : 'false',
      include_completed: opts.includeCompleted ? 'true' : 'false',
      blueprint: blueprint ? 'true' : 'false',
    }).then((r) => { if (!alive) return; setPreview(r); setForKey(key); })
      .catch(() => { if (alive) { setPreview(null); setForKey(key); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return forKey === key ? preview : null;
}

function PreviewLine({ preview, projectId, blueprint = true }) {
  if (!projectId) return null;
  if (!preview) return <div style={{ fontSize: 12, color: NX.faint }}>Counting what this would carry…</div>;
  const bits = [
    `${preview.taskCount} task${preview.taskCount === 1 ? '' : 's'}`,
    preview.subtaskCount ? `${preview.subtaskCount} subtask${preview.subtaskCount === 1 ? '' : 's'}` : null,
    preview.sectionCount ? `${preview.sectionCount} section${preview.sectionCount === 1 ? '' : 's'}` : null,
    preview.fieldCount ? `${preview.fieldCount} custom field${preview.fieldCount === 1 ? '' : 's'}` : null,
    preview.statusCount ? `${preview.statusCount} custom status${preview.statusCount === 1 ? '' : 'es'}` : null,
    (!blueprint && preview.assigneeCount) ? `${preview.assigneeCount} assignee${preview.assigneeCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return (
    <div style={{ fontSize: 12, color: NX.dim, lineHeight: 1.5 }}>
      Captures {bits.join(' · ')}.
      {preview.fieldNames?.length ? ` Fields: ${preview.fieldNames.join(', ')}.` : ''}
      {preview.statusLabels?.length ? ` Statuses: ${preview.statusLabels.join(', ')}.` : ''}
      {preview.hasDates && preview.anchor
        ? ` Dates are stored relative to ${formatDate(preview.anchor)}, so they re-anchor to whatever start date is picked when the template is used.`
        : ' No dates to carry.'}
    </div>
  );
}

// ── Save as Template ─────────────────────────────────────────────────────────
// Exported so the Projects grid and a project's own header can open the exact
// same dialog rather than each growing their own.
export function SaveTemplateModal({ projectId: fixedProjectId = '', onClose, onSaved }) {
  const { projects, createProjectTemplate } = useTasks();
  const isMobile = useIsMobile();
  const [projectId, setProjectId] = useState(fixedProjectId || '');
  const project = projects.find((p) => p.id === projectId) || null;
  // The name follows the picked project until somebody types their own.
  const [nameTouched, setNameTouched] = useState(false);
  const [form, setForm] = useState({
    name: '', description: '', category: '', accessLevel: 'org',
    includeTasks: true, includeSubtasks: true, includeCompleted: false,
    includeDates: true,
  });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const preview = usePreview(projectId, form);

  const name = (form.name || '').trim();
  const valid = !!name && !saving;

  const save = async () => {
    if (!valid) return;
    setSaving(true); setErr('');
    try {
      const t = await createProjectTemplate({ ...form, name, projectId: projectId || '' });
      onSaved?.(t);
      onClose();
    } catch (e) {
      setSaving(false);
      setErr(e?.message || 'Could not save this template.');
    }
  };

  return (
    <Modal
      title="Save as Template" onClose={onClose} isDirty={!!name && !saving} onSave={valid ? save : undefined}
      footer={<>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: valid ? 1 : 0.5, pointerEvents: valid ? 'auto' : 'none' }}
          onClick={save}>{saving ? 'Saving…' : 'Save Template'}</button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
        <div style={{ fontSize: 12.5, color: NX.dim, lineHeight: 1.5 }}>
          A template captures the project's <strong style={{ color: NX.ink }}>structure only</strong> - its sections,
          tasks, custom fields and custom statuses. No owner, members, teams, portfolio, department or visibility
          comes across, and the tasks arrive unassigned. Whoever uses the template is asked for all of that.
          It is a snapshot taken right now: later edits to the project will not change it.
        </div>

        {!fixedProjectId && (
          <div>
            <label style={label}>Project To Capture</label>
            <SearchSelect value={projectId} placeholder="Empty template (no tasks)"
              searchPlaceholder="Search projects…" emptyText="No projects yet."
              buttonStyle={{ ...inputStyle, cursor: 'pointer', justifyContent: 'space-between' }}
              options={[{ id: '', label: 'Empty template (no tasks)' },
                        ...projects.filter((p) => !p.archived).slice()
                          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
                          .map((p) => ({ id: p.id, label: p.name }))]}
              onPick={(id) => {
                setProjectId(id);
                if (!nameTouched) set({ name: projects.find((x) => x.id === id)?.name || '' });
              }} />
          </div>
        )}

        <div>
          <label style={label}>Template Name</label>
          <input autoFocus={!isMobile} value={form.name}
            onChange={(e) => { setNameTouched(true); set({ name: e.target.value }); }}
            placeholder="e.g. Unit Turnover" style={inputStyle} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          <div>
            <label style={label}>Category</label>
            <input value={form.category} onChange={(e) => set({ category: e.target.value })}
              placeholder="Optional, e.g. Property" style={inputStyle} />
          </div>
          <div>
            <label style={label}>Color</label>
            <input type="color" value={form.color || project?.color || NX.blue}
              onChange={(e) => set({ color: e.target.value })}
              style={{ ...inputStyle, padding: 3, height: 38, cursor: 'pointer' }} />
          </div>
        </div>

        <div>
          <label style={label}>Description</label>
          <textarea value={form.description} onChange={(e) => set({ description: e.target.value })}
            rows={2} placeholder="When should someone reach for this template?"
            style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
        </div>

        {projectId && (
          <div>
            <label style={label}>What To Capture</label>
            <div style={{ border: `1px solid ${NX.border2}`, borderRadius: 8, padding: '6px 10px 8px' }}>
              <OptionRow checked={form.includeTasks} onChange={(v) => set({ includeTasks: v })}
                title="Tasks and sections" hint="Uncheck for a settings-only blueprint." />
              <OptionRow checked={form.includeSubtasks} disabled={!form.includeTasks}
                onChange={(v) => set({ includeSubtasks: v })} title="Subtasks" />
              <OptionRow checked={form.includeCompleted} disabled={!form.includeTasks}
                onChange={(v) => set({ includeCompleted: v })}
                title="Tasks already completed"
                hint="Off by default - a blueprint usually wants the work, not the history." />
              <OptionRow checked={form.includeDates} disabled={!form.includeTasks}
                onChange={(v) => set({ includeDates: v })}
                title="Dates, as day offsets" hint="Re-anchored to the start date picked when the template is used." />
            </div>
            <div style={{ marginTop: 8 }}><PreviewLine preview={preview} projectId={projectId} /></div>
          </div>
        )}

        <div>
          <label style={label}>Who Can Use It</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {VISIBILITY_OPTS.map((o) => (
              <button key={o.key} type="button" onClick={() => set({ accessLevel: o.key })}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', padding: 10,
                  borderRadius: 10, cursor: 'pointer', fontFamily: FONT,
                  border: `1px solid ${form.accessLevel === o.key ? NX.blue : NX.border}`,
                  background: form.accessLevel === o.key ? 'rgba(37,99,235,0.10)' : NX.surface,
                }}>
                <o.icon size={15} style={{ color: NX.dim, marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{o.label}</div>
                  <div style={{ fontSize: 11.5, color: NX.dim, marginTop: 1 }}>{o.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {err && <div style={{ fontSize: 12.5, color: NX.red }}>{err}</div>}
      </div>
    </Modal>
  );
}

// ── Use Template ─────────────────────────────────────────────────────────────
// Opens the ORDINARY create-a-project form with the template attached, rather
// than a form of its own. That is the whole point of a blueprint carrying no
// settings: name, owner, members, teams, portfolio, department, visibility and
// the project's own custom fields all still have to be asked, and ProjectModal
// is already the screen that asks them.
//
// ProjectsView is pulled in on click instead of imported at the top, because it
// imports THIS module for the Save-as-Template and Duplicate dialogs - a static
// import back would be a cycle. Same lazy-import pattern TasksWorkspace uses to
// reach ProjectModal for its Edit button.
export function UseTemplateModal({ template, onClose, onCreated }) {
  const { portfolios } = useTasks();
  const people = usePeople();
  const [mod, setMod] = useState(null);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState(() => ({
    name: template.defaults?.name || template.name || '',
    description: template.defaults?.description || '',
    color: template.defaults?.color || template.color || NX.blue,
    ownerId: null, portfolioId: '', accessLevel: 'restricted',
    status: 'not_started', startOn: todayIso(), dueOn: '',
    archived: false, customFieldValues: {},
    includeTasks: true, resetStatus: true,
  }));

  useEffect(() => {
    let alive = true;
    import('./ProjectsView')
      .then((m) => { if (alive) setMod(m); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed) {
    return (
      <Modal title="Use Template" onClose={onClose}
        footer={<button style={btn('primary')} onClick={onClose}>Close</button>}>
        <p style={{ fontSize: 13, color: NX.dim }}>
          The project form could not be loaded. Reload the page and try again, or create the project from the
          Projects tab.
        </p>
      </Modal>
    );
  }

  if (!mod) {
    return (
      <Modal title="Use Template" onClose={onClose} footer={null}>
        <div style={{ fontSize: 13, color: NX.faint, padding: '18px 2px' }}>Opening the project form…</div>
      </Modal>
    );
  }

  return (
    <mod.ProjectModal
      form={form} setForm={setForm} people={people} portfolios={portfolios}
      template={template}
      onClose={onClose}
      onSaved={(p) => { onCreated?.(p); onClose(); }}
    />
  );
}


// ── Duplicate a project ──────────────────────────────────────────────────────
// Same engine as templates on the server (snapshot then build), so a copy
// carries exactly what a template carries.
export function DuplicateProjectModal({ project, onClose, onCreated }) {
  const { duplicateProject } = useTasks();
  const isMobile = useIsMobile();
  const [form, setForm] = useState({
    name: `${project.name} (copy)`,
    // Blank means "keep the original's own dates". Rescheduling is a choice,
    // not what "duplicate" implies.
    startOn: '',
    includeTasks: true, includeSubtasks: true, includeCompleted: false,
    includeAssignees: true, includeMembers: true, includeTeams: true,
    includeDates: true, resetStatus: true,
  });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const preview = usePreview(project.id, form, false);
  const name = (form.name || '').trim();
  const valid = !!name && !busy;

  const go = async () => {
    if (!valid) return;
    setBusy(true); setErr('');
    try {
      const made = await duplicateProject(project.id, { ...form, name });
      onCreated?.(made);
      onClose();
    } catch (e) {
      setBusy(false);
      setErr(e?.message || 'Could not duplicate this project.');
    }
  };

  return (
    <Modal
      title={`Duplicate "${project.name}"`} onClose={busy ? () => {} : onClose}
      footer={<>
        <button style={btn('ghost')} onClick={onClose} disabled={busy}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: valid ? 1 : 0.5, pointerEvents: valid ? 'auto' : 'none' }}
          onClick={go}>{busy ? 'Duplicating…' : 'Duplicate Project'}</button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
        <div style={{ fontSize: 12.5, color: NX.dim, lineHeight: 1.5 }}>
          The original is left exactly as it is. The copy is a fresh project and is not linked to Asana,
          even when the original is.
        </div>

        <div>
          <label style={label}>New Project Name</label>
          <input autoFocus={!isMobile} value={form.name} onChange={(e) => set({ name: e.target.value })}
            style={inputStyle} />
        </div>

        <div>
          <label style={label}>Start Date</label>
          <input type="date" value={form.startOn} onChange={(e) => set({ startOn: e.target.value })}
            style={{ ...inputStyle, cursor: 'pointer' }} />
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
            Leave blank to keep the original's dates. Set one to shift the whole plan onto it.
          </div>
        </div>

        <div>
          <label style={label}>What To Copy</label>
          <div style={{ border: `1px solid ${NX.border2}`, borderRadius: 8, padding: '6px 10px 8px' }}>
            <OptionRow checked={form.includeTasks} onChange={(v) => set({ includeTasks: v })} title="Tasks and sections" />
            <OptionRow checked={form.includeSubtasks} disabled={!form.includeTasks}
              onChange={(v) => set({ includeSubtasks: v })} title="Subtasks" />
            <OptionRow checked={form.includeCompleted} disabled={!form.includeTasks}
              onChange={(v) => set({ includeCompleted: v })} title="Tasks already completed" />
            <OptionRow checked={form.includeDates} disabled={!form.includeTasks}
              onChange={(v) => set({ includeDates: v })} title="Dates" />
            <OptionRow checked={form.includeAssignees} disabled={!form.includeTasks}
              onChange={(v) => set({ includeAssignees: v })} title="Assignees and followers" />
            <OptionRow checked={form.resetStatus} disabled={!form.includeTasks}
              onChange={(v) => set({ resetStatus: v })} title="Start every task at Not Started" />
            <OptionRow checked={form.includeMembers} onChange={(v) => set({ includeMembers: v })} title="Project members" />
            <OptionRow checked={form.includeTeams} onChange={(v) => set({ includeTeams: v })} title="Teams" />
          </div>
          <div style={{ marginTop: 8 }}><PreviewLine preview={preview} projectId={project.id} blueprint={false} /></div>
        </div>

        {err && <div style={{ fontSize: 12.5, color: NX.red }}>{err}</div>}
      </div>
    </Modal>
  );
}

// ── Edit a template's own card (never its payload) ───────────────────────────
function EditTemplateModal({ template, onClose }) {
  const { updateProjectTemplate } = useTasks();
  const [form, setForm] = useState({
    name: template.name || '', description: template.description || '',
    category: template.category || '', color: template.color || NX.blue,
    accessLevel: template.accessLevel || 'org', archived: !!template.archived,
  });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const name = (form.name || '').trim();
  const valid = !!name && !busy;

  const save = async (override) => {
    if (!valid) return;
    setBusy(true); setErr('');
    try {
      await updateProjectTemplate(template.id, { ...form, name, ...(override || {}) });
      onClose();
    } catch (e) {
      setBusy(false);
      setErr(e?.message || 'Could not save this template.');
    }
  };

  return (
    <Modal
      title="Edit Template" onClose={onClose} isDirty onSave={valid ? () => save() : undefined}
      footer={<>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={{ ...btn('outline'), color: form.archived ? NX.green : NX.dim }}
          title={form.archived ? 'Bring this template back into the active list' : 'Keep the template but hide it from the active list'}
          onClick={() => save({ archived: !form.archived })}>
          <Archive size={15} />{form.archived ? 'Unarchive' : 'Archive'}
        </button>
        <button style={{ ...btn('primary'), opacity: valid ? 1 : 0.5, pointerEvents: valid ? 'auto' : 'none' }}
          onClick={() => save()}>{busy ? 'Saving…' : 'Save Changes'}</button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
        <div style={{ fontSize: 12.5, color: NX.faint }}>
          This edits the template's card. To re-capture what it contains, save the project as a template again.
        </div>
        <div>
          <label style={label}>Name</label>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} style={inputStyle} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={label}>Category</label>
            <input value={form.category} onChange={(e) => set({ category: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={label}>Color</label>
            <input type="color" value={form.color || NX.blue} onChange={(e) => set({ color: e.target.value })}
              style={{ ...inputStyle, padding: 3, height: 38, cursor: 'pointer' }} />
          </div>
        </div>
        <div>
          <label style={label}>Description</label>
          <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
        </div>
        <div>
          <label style={label}>Who Can Use It</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {VISIBILITY_OPTS.map((o) => (
              <button key={o.key} type="button" onClick={() => set({ accessLevel: o.key })}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', padding: 10,
                  borderRadius: 10, cursor: 'pointer', fontFamily: FONT,
                  border: `1px solid ${form.accessLevel === o.key ? NX.blue : NX.border}`,
                  background: form.accessLevel === o.key ? 'rgba(37,99,235,0.10)' : NX.surface,
                }}>
                <o.icon size={15} style={{ color: NX.dim, marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{o.label}</div>
                  <div style={{ fontSize: 11.5, color: NX.dim, marginTop: 1 }}>{o.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
        {err && <div style={{ fontSize: 12.5, color: NX.red }}>{err}</div>}
      </div>
    </Modal>
  );
}

function DeleteTemplateModal({ template, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await onConfirm(); onClose(); } catch (e) { setBusy(false); setErr(e?.message || 'Could not delete this template.'); }
  };
  return (
    <Modal
      title={`Delete "${template.name}"?`} onClose={busy ? () => {} : onClose}
      footer={<>
        <button style={btn('outline')} onClick={onClose} disabled={busy}>Cancel</button>
        <button style={{ ...btn('primary'), background: NX.red, borderColor: NX.red, opacity: busy ? 0.6 : 1 }}
          onClick={go}>{busy ? 'Deleting…' : 'Delete Template'}</button>
      </>}
    >
      <p style={{ fontSize: 13.5, color: NX.ink, marginBottom: 8 }}>
        This removes the blueprint only.
      </p>
      <p style={{ fontSize: 12.5, color: NX.dim }}>
        {template.useCount
          ? `The ${template.useCount} project${template.useCount === 1 ? '' : 's'} already built from it are ordinary projects and are not touched.`
          : 'Nothing has been built from it yet, and no project is affected.'}
        {' '}If you want it out of the way but recoverable, archive it instead.
      </p>
      {err && <div style={{ marginTop: 10, fontSize: 12.5, color: NX.red }}>{err}</div>}
    </Modal>
  );
}

// ── The Templates screen ─────────────────────────────────────────────────────
export default function TemplatesView({ onNavigate }) {
  const isMobile = useIsMobile();
  const { projectTemplates, nameOf, deleteProjectTemplate, recaptureProjectTemplate } = useTasks();
  // id of the template currently being re-read from its source project
  const [recapturing, setRecapturing] = useState('');
  const [recaptureErr, setRecaptureErr] = useState('');
  const recapture = async (t) => {
    setRecapturing(t.id); setRecaptureErr('');
    try { await recaptureProjectTemplate(t.id, {}); }
    catch (e) { setRecaptureErr(e?.message || 'Could not re-read that project.'); }
    finally { setRecapturing(''); }
  };
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [archiveFilter, setArchiveFilter] = useState('active');
  const [saving, setSaving] = useState(false);       // Save as Template modal
  const [using, setUsing] = useState(null);          // template being used
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const categories = useMemo(
    () => [...new Set((projectTemplates || []).map((t) => t.category).filter(Boolean))].sort(),
    [projectTemplates],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (projectTemplates || [])
      .filter((t) => (archiveFilter === 'all' ? true : archiveFilter === 'archived' ? !!t.archived : !t.archived))
      .filter((t) => !category || t.category === category)
      .filter((t) => !q || (t.name || '').toLowerCase().includes(q)
        || (t.description || '').toLowerCase().includes(q)
        || (t.category || '').toLowerCase().includes(q)
        || (t.sourceProjectName || '').toLowerCase().includes(q))
      .sort((a, b) => Number(a.archived) - Number(b.archived)
        || String(a.name || '').localeCompare(String(b.name || '')));
  }, [projectTemplates, search, category, archiveFilter]);

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: NX.canvas }}>
      <div style={{ padding: isMobile ? '12px 12px 10px' : '20px 24px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: isMobile ? 20 : 26, fontWeight: 800, letterSpacing: '-0.02em' }}>Templates</div>
            {!isMobile && (
              <div style={{ fontSize: 13.5, color: NX.dim, marginTop: 4 }}>
                Reusable project blueprints. Save a project once, then stamp out the next one from it.
              </div>
            )}
          </div>
          {!isMobile && (
            <button style={{ ...btn('primary'), padding: '10px 18px', fontSize: 13.5, borderRadius: 10 }}
              onClick={() => setSaving(true)}><Plus size={16} />New Template</button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14, marginTop: isMobile ? 10 : 16, flexWrap: isMobile ? 'nowrap' : 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 0, maxWidth: isMobile ? 'none' : 420 }}>
            <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates…"
              style={{ ...inputStyle, paddingLeft: 40, paddingTop: isMobile ? 8 : 10, paddingBottom: isMobile ? 8 : 10, borderRadius: 999 }} />
          </div>
          {categories.length > 0 && (
            <select value={category} onChange={(e) => setCategory(e.target.value)} title="Category"
              style={{ ...inputStyle, width: 'auto', flexShrink: 0, padding: isMobile ? '7px 9px' : '9px 10px', borderRadius: 999, fontSize: isMobile ? 12 : 13, cursor: 'pointer' }}>
              <option value="">All Categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <select value={archiveFilter} onChange={(e) => setArchiveFilter(e.target.value)} title="Archive filter"
            style={{ ...inputStyle, width: 'auto', flexShrink: 0, padding: isMobile ? '7px 9px' : '9px 10px', borderRadius: 999, fontSize: isMobile ? 12 : 13, cursor: 'pointer' }}>
            <option value="active">Active Templates</option>
            <option value="archived">Archived Templates</option>
            <option value="all">All Templates</option>
          </select>
        </div>
      </div>

      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas }}>
        {rows.length === 0 ? (
          <EmptyState
            icon={LayoutTemplate}
            title={search.trim() || category ? 'No Templates Match Your Search' : 'No Templates Yet'}
            hint={search.trim() || category ? undefined : 'Save a project as a template and it will show up here, ready to build the next one from.'}
          />
        ) : (
          <div className="nx-gutter" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 14, padding: '16px 16px 76px' }}>
            {rows.map((t) => {
              const dcolor = t.color || NX.purple;
              return (
                <div key={t.id} style={{ ...card, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', opacity: t.archived ? 0.62 : 1 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px 14px', flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span style={{
                        width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        background: `${dcolor}1f`, color: dcolor,
                      }}><LayoutTemplate size={15} /></span>
                      <div title={t.name} style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                      <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                        {t.sourceProjectId && (
                          <button
                            title={`Re-read "${t.sourceProjectName || 'the source project'}" and replace what this template contains`}
                            disabled={recapturing === t.id}
                            onClick={() => recapture(t)}
                            style={{ ...btn('ghost'), padding: 5, borderRadius: 7, opacity: recapturing === t.id ? 0.5 : 1 }}>
                            <RefreshCw size={13} />
                          </button>
                        )}
                        <button title="Edit Template" onClick={() => setEditing(t)} style={{ ...btn('ghost'), padding: 5, borderRadius: 7 }}><Pencil size={13} /></button>
                        <button title="Delete Template" onClick={() => setDeleting(t)} style={{ ...btn('ghost'), padding: 5, color: NX.red, borderRadius: 7 }}><Trash2 size={13} /></button>
                      </div>
                    </div>

                    {/* A template captured before custom fields and statuses were
                        part of the snapshot builds projects that are missing their
                        columns. Say so on the card, with the one-click fix, rather
                        than letting it be discovered project by project. */}
                    {t.outdated && (
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: '8px 10px', borderRadius: 8, background: 'rgba(217,119,6,0.10)', border: '1px solid rgba(217,119,6,0.28)' }}>
                        <AlertTriangle size={14} style={{ color: NX.amber, marginTop: 1, flexShrink: 0 }} />
                        <div style={{ fontSize: 11.5, color: NX.dim, lineHeight: 1.45 }}>
                          Saved in an older format, so it carries no custom fields or statuses.
                          {t.sourceProjectId ? (
                            <button onClick={() => recapture(t)} disabled={recapturing === t.id}
                              style={{ border: 'none', background: 'none', padding: 0, marginLeft: 4, color: NX.blue, fontWeight: 700, fontSize: 11.5, cursor: 'pointer', fontFamily: FONT }}>
                              {recapturing === t.id ? 'Re-capturing…' : 'Re-capture it'}
                            </button>
                          ) : ' Save the project as a template again to refresh it.'}
                        </div>
                      </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {t.category && <span style={chip(dcolor, `${dcolor}1a`)}>{t.category}</span>}
                      {t.accessLevel === 'restricted' && <span style={chip(NX.dim, NX.border2)}><Lock size={11} />Only Me</span>}
                      {t.archived && <span style={chip(NX.faint, NX.border2)}><Archive size={11} />Archived</span>}
                    </div>

                    {t.description && (
                      <div style={{ fontSize: 12.5, color: NX.dim, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.description}</div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12, color: NX.dim }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ListChecks size={13} />{t.taskCount} task{t.taskCount === 1 ? '' : 's'}
                      </span>
                      {t.sectionCount > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <FolderKanban size={13} />{t.sectionCount} section{t.sectionCount === 1 ? '' : 's'}
                        </span>
                      )}
                      {t.fieldCount > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <ListChecks size={13} />{t.fieldCount} field{t.fieldCount === 1 ? '' : 's'}
                        </span>
                      )}
                      {t.hasDates && (
                        <span title="Dates are stored as day offsets and re-anchor to the start date you pick"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <CalendarDays size={13} />Dated
                        </span>
                      )}
                      {t.useCount > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Users size={13} />Used {t.useCount}x
                        </span>
                      )}
                    </div>

                    {t.sourceProjectName && (
                      <div style={{ fontSize: 11.5, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        Saved from {t.sourceProjectName}
                        {t.createdAt ? ` on ${formatDate(t.createdAt)}` : ''}
                      </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto', paddingTop: 4 }}>
                      {t.ownerId ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <Avatar email={t.ownerId} name={nameOf(t.ownerId)} size={22} />
                          <span style={{ fontSize: 12, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(t.ownerId)}</span>
                        </span>
                      ) : <span style={{ fontSize: 12, color: NX.faint }}>No owner</span>}
                      <button style={{ ...btn('primary'), marginLeft: 'auto', padding: '7px 12px', fontSize: 12.5 }}
                        onClick={() => setUsing(t)}><Copy size={14} />Use Template</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {recaptureErr && (
        <div style={{ position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 5000, background: NX.red, color: '#fff', borderRadius: 10, padding: '10px 15px', fontSize: 12.5, maxWidth: 'min(92vw, 480px)' }}
          onClick={() => setRecaptureErr('')} role="alert">{recaptureErr}</div>
      )}

      {isMobile && <MobileFab title="New Template" onClick={() => setSaving(true)} />}

      {saving && <SaveTemplateModal onClose={() => setSaving(false)} />}
      {using && (
        <UseTemplateModal
          template={using} onClose={() => setUsing(null)}
          onCreated={(p) => onNavigate?.({ projectId: p.id })}
        />
      )}
      {editing && <EditTemplateModal template={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <DeleteTemplateModal
          template={deleting} onClose={() => setDeleting(null)}
          onConfirm={() => deleteProjectTemplate(deleting.id)}
        />
      )}
    </div>
  );
}
