// Documents > Forms > Build (Neil, 11/02/2026). A form IS a DocTemplate with
// docType 'form' - no second template engine - and this is its field list:
// sections, typed fields (the shared types plus photo / location stamp / QR
// scan / rating / yes-no, and a drawn signature), the form-only keys (Show
// Only When, a Formula, a Repeat group) through the ONE field editor
// (DefineMergeFieldModal in form mode), the order, who may fill it (the
// Announcements audience rule: everyone at the company, one department, one
// work site; Show On Shift Cards), Preview, and the existing template Publish.
// Opens in place of the Forms list, the way DocumentBuilder replaces Templates.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowDown, ArrowUp, Pencil, Plus, Trash2, GripVertical } from 'lucide-react';
import { api } from '../api';
import DefineMergeFieldModal from '../components/DefineMergeFieldModal';
import { Switch } from '../components/settings/SettingsUI';
import { StatusWord } from '../components/DocumentSidePanel';
import { ModalLoading, Spinner } from '../components/AsyncState';
import { templateStatus } from '../lib/documentLibrary';
import { dialog } from '../ui/dialog';
import { AUDIENCES, FORM_CATEGORIES, groupBySection, isForm, sectionsOf, showIfSummary, typeLabel } from './formsModel';

// The real fill screen, loaded when Preview opens. It is its own sheet, so
// Preview renders it directly - no wrapper Modal around it.
const FillForm = lazy(() => import('./FillForm'));

/** The form as GET /forms/{tid} hands it to the fill screen, from the template row. */
export const fillPayloadOf = (t, workSites = []) => ({
  id: t.id, title: t.name, category: t.category, description: '', version: t.version,
  fieldDefs: t.fieldDefs || [], sections: sectionsOf(t.fieldDefs || []), workSites,
});

/** Preview opens the real fill screen in preview mode - a sheet from the right, nothing sent. */
export function FormPreview({ template, workSites = [], onClose }) {
  return (
    <Suspense fallback={<ModalLoading zIndex={4100} />}>
      <FillForm template={fillPayloadOf(template, workSites)} preview onClose={onClose} zIndex={4100} />
    </Suspense>
  );
}

const chip = { fontSize: 10.5, fontWeight: 600, padding: '2px 7px', borderRadius: 999, color: 'var(--muted)', background: 'var(--mist)', whiteSpace: 'nowrap' };
const iconBtn = { background: 'none', border: '1px solid var(--line)', borderRadius: 7, padding: 5, cursor: 'pointer', display: 'flex', color: 'var(--muted)' };
const label = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 };

const pick = (t) => ({
  name: t.name || '', category: t.category || 'other', department: t.department || '', audience: t.audience || 'company',
  workSiteId: t.workSiteId || '', showOnShifts: t.showOnShifts ? 1 : 0, fieldDefs: t.fieldDefs || [],
});

export default function FormBuilder({ templateId, onClose, toastOk, toastErr }) {
  const [template, setTemplate] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [sites, setSites] = useState([]);
  const [editor, setEditor] = useState(null);       // { existingDef } | { }  - the field editor
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState('');
  const [dragToken, setDragToken] = useState('');

  const take = (t) => { setTemplate(t); const d = pick(t); setDraft(d); setSaved(d); };
  useEffect(() => {
    let live = true;
    api.getDocTemplate(templateId).then((t) => { if (live) take(t); }).catch((e) => { if (live) setLoadError(e?.message || 'Could not open the form.'); });
    api.getWorkSites().then((r) => { if (live) setSites(Array.isArray(r) ? r : []); }).catch(() => {});
    return () => { live = false; };
  }, [templateId]);

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const setDefs = (fn) => setDraft((d) => ({ ...d, fieldDefs: fn(d.fieldDefs) }));
  const sections = useMemo(() => groupBySection(draft?.fieldDefs || []), [draft]);
  // Unsaved edits are never lost by a stray click: Back To Forms asks, and
  // closing or reloading the browser tab gets the browser's own question.
  useEffect(() => {
    if (!dirty) return undefined;
    const onUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);
  const leave = async () => {
    if (dirty && !(await dialog.confirm('Leave without saving this form?', { confirmText: 'Discard Changes' }))) return;
    onClose();
  };

  const save = async () => {
    if (!draft) return null;
    const patch = { ...draft, name: draft.name.trim() || template.name, department: draft.audience === 'department' ? draft.department.trim() : draft.department.trim(),
      workSiteId: draft.audience === 'site' ? draft.workSiteId : '' };
    const next = await api.updateDocTemplate(templateId, patch);
    const merged = { ...template, ...(next || {}), ...patch };
    take(merged);
    return merged;
  };
  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); if (ok) toastOk?.(ok); } catch (e) { toastErr?.(e?.message || 'That did not work.'); }
    setBusy('');
  };
  const onSave = () => run('save', save, 'Form saved');
  const publish = () => run('publish', async () => {
    if (dirty) await save();
    const next = await api.publishDocTemplate(templateId);
    if (next && typeof next === 'object' && next.id) take({ ...template, ...next });
    else await api.getDocTemplate(templateId).then(take).catch(() => {});
  }, 'Published');

  // One field editor: a new field, or an existing one edited in place.
  const saveDef = (def) => {
    setDefs((defs) => {
      const i = defs.findIndex((f) => f.token === (editor.existingDef?.token || def.token));
      if (i < 0) return [...defs, def];
      const out = [...defs]; out[i] = def; return out;
    });
    setEditor(null);
  };
  const move = (token, dir) => setDefs((defs) => {
    const i = defs.findIndex((f) => f.token === token);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= defs.length) return defs;
    const out = [...defs]; [out[i], out[j]] = [out[j], out[i]]; return out;
  });
  const remove = (token) => setDefs((defs) => defs.filter((f) => f.token !== token));
  const dropOn = (token) => {
    if (!dragToken || dragToken === token) return;
    setDefs((defs) => {
      const from = defs.findIndex((f) => f.token === dragToken);
      const to = defs.findIndex((f) => f.token === token);
      if (from < 0 || to < 0) return defs;
      const out = [...defs]; const [m] = out.splice(from, 1); out.splice(to, 0, m); return out;
    });
    setDragToken('');
  };

  if (loadError) return <div className="nx-dl-empty"><p>{loadError}</p><button type="button" className="secondary-btn" onClick={onClose}>Back To Forms</button></div>;
  if (!template || !draft) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="section" /></div>;
  if (!isForm(template)) {
    return (
      <div className="nx-dl-empty">
        <p>This template is a document, not a form. Open it under Templates.</p>
        <button type="button" className="secondary-btn" onClick={onClose}>Back To Forms</button>
      </div>
    );
  }

  const state = templateStatus(template);
  const publishLabel = template.state === 'changes' ? 'Publish Changes' : 'Publish';
  const canPublish = template.state !== 'archived' && (template.state !== 'published' || dirty);

  return (
    <div className="nx-form-build" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="secondary-btn" onClick={leave} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ArrowLeft size={14} /> Back To Forms</button>
        <input className="form-input" aria-label="Form name" value={draft.name} onChange={(e) => set('name', e.target.value)}
          style={{ flex: '1 1 240px', fontSize: 15, fontWeight: 700 }} placeholder="Form name" />
        <StatusWord status={state} />
        <span style={{ flex: 1 }} />
        <button type="button" className="secondary-btn" onClick={() => setPreview(true)}>Preview</button>
        <button type="button" className="secondary-btn" disabled={!dirty || busy === 'save'} onClick={onSave}>{busy === 'save' ? 'Saving...' : 'Save Form'}</button>
        {canPublish && <button type="button" className="primary-btn" disabled={busy === 'publish'} onClick={publish}>{busy === 'publish' ? 'Publishing...' : publishLabel}</button>}
      </div>
      {template.state === 'draft' && <div className="nx-dl-muted">Nobody can fill a draft. Publishing it puts it in front of the people it is for.</div>}
      {template.state === 'changes' && <div className="nx-dl-muted">People fill version {template.publishedVersion} until these edits are published.</div>}

      <section style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }} aria-label="Form settings">
        <div>
          <label style={label} htmlFor="form-category">Category</label>
          <select id="form-category" className="form-input" style={{ width: '100%' }} value={draft.category} onChange={(e) => set('category', e.target.value)}>
            {FORM_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label style={label} htmlFor="form-audience">Who Fills It</label>
          <select id="form-audience" className="form-input" style={{ width: '100%' }} aria-label="Who fills it" value={draft.audience} onChange={(e) => set('audience', e.target.value)}>
            {AUDIENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {draft.audience === 'department' && (
          <div>
            <label style={label} htmlFor="form-department">Department</label>
            <input id="form-department" className="form-input" style={{ width: '100%' }} value={draft.department} placeholder="e.g. Construction" onChange={(e) => set('department', e.target.value)} />
            <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>Its people fill the form and its managers maintain it.</p>
          </div>
        )}
        {draft.audience === 'site' && (
          <div>
            <label style={label} htmlFor="form-site">Work Site</label>
            <select id="form-site" className="form-input" style={{ width: '100%' }} aria-label="Work site" value={draft.workSiteId} onChange={(e) => set('workSiteId', e.target.value)}>
              <option value="">- Pick a site -</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {!sites.length && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>Work sites are set under Settings &gt; Locations.</p>}
          </div>
        )}
        <div>
          <label style={label} htmlFor="form-on-shifts">Show On Shift Cards</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Switch id="form-on-shifts" label="Show On Shift Cards" checked={!!draft.showOnShifts} onChange={(v) => set('showOnShifts', v ? 1 : 0)} />
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>A Fill button on the shift card of anyone scheduled at the form's site.</span>
          </div>
        </div>
      </section>

      <section aria-label="Fields" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Fields</h3>
          <span className="nx-dl-muted">Drag a row, or use the arrows, to set the order. A field's Section is the heading it sits under.</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="primary-btn" onClick={() => setEditor({})} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add Field</button>
        </div>
        {!draft.fieldDefs.length && (
          <div className="nx-dl-empty"><p>No fields yet. Add the first question - a photo, a yes / no, a rating, a location stamp, or any typed answer.</p></div>
        )}
        {sections.map(({ section, fields }) => (
          <div key={section} style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
            <h4 style={{ margin: 0, padding: '9px 14px', fontSize: 11.5, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)', background: 'var(--mist)' }}>{section}</h4>
            {fields.map((f) => {
              const name = f.label || f.token;
              return (
                <div key={f.token} draggable onDragStart={() => setDragToken(f.token)} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOn(f.token)} onDragEnd={() => setDragToken('')}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderTop: '1px solid var(--line)', opacity: dragToken === f.token ? 0.5 : 1, background: 'var(--card)' }}>
                  <GripVertical size={14} style={{ color: 'var(--muted)', cursor: 'grab', flexShrink: 0 }} aria-hidden="true" />
                  <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>{f.token}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flex: '2 1 260px' }}>
                    <span style={{ fontSize: 12.5, color: 'var(--ink)' }}>{typeLabel(f.type)}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{f.required ? 'Required' : 'Optional'}</span>
                    {f.showIf?.token && <span style={chip}>{showIfSummary(f, draft.fieldDefs)}</span>}
                    {f.repeat?.group && <span style={chip}>Repeats: {f.repeat.group} (up to {f.repeat.max || 10})</span>}
                    {f.formula && <span style={chip} title={f.formula}>Formula</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button type="button" style={iconBtn} aria-label={`Move ${name} up`} title="Move up" onClick={() => move(f.token, -1)}><ArrowUp size={13} /></button>
                    <button type="button" style={iconBtn} aria-label={`Move ${name} down`} title="Move down" onClick={() => move(f.token, 1)}><ArrowDown size={13} /></button>
                    <button type="button" style={iconBtn} aria-label={`Edit ${name}`} title="Edit" onClick={() => setEditor({ existingDef: f })}><Pencil size={13} /></button>
                    <button type="button" style={{ ...iconBtn, color: 'hsl(var(--color-red))' }} aria-label={`Remove ${name}`} title="Remove" onClick={() => remove(f.token)}><Trash2 size={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </section>

      {editor && (
        <DefineMergeFieldModal form existingDef={editor.existingDef || null} siblings={draft.fieldDefs} sections={sections.map((s) => s.section)}
          existingTokens={draft.fieldDefs.map((f) => f.token)} onSave={saveDef} onCancel={() => setEditor(null)} />
      )}
      {preview && <FormPreview template={{ ...template, ...draft }} workSites={sites} onClose={() => setPreview(false)} />}
    </div>
  );
}
