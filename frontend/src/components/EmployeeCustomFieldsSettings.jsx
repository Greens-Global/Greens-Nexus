import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, Pencil, Archive, RotateCcw, Plus } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { SkeletonBlocks } from './AsyncState';
import { SettingRow, SwitchRow } from './settings/SettingsUI';
import { FIELD_TYPES, TYPE_LABEL, VISIBILITY, VISIBILITY_LABEL } from '../lib/employeeCustomFields';

// Settings > People & Access > More Details Fields (Neil, Oct 27 2026): the
// custom fields on employee records. At "Every company" the fields every
// company's people carry; with a company picked, that company's own (the
// every-company ones are named above them, since its people carry those
// too). A field is archived, never deleted: archiving hides it and keeps
// every value, Restore brings it back with them.

const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.04em' };

function describe(f) {
  const bits = [TYPE_LABEL[f.fieldType] || f.fieldType, VISIBILITY_LABEL[f.visibility] || f.visibility];
  if (f.required) bits.push('Required');
  if (f.fieldType === 'dropdown' && f.options?.length) bits.push(f.options.slice(0, 4).join(', ') + (f.options.length > 4 ? ` +${f.options.length - 4} more` : ''));
  return `${bits.join(' · ')} · {{${f.token}}}`;
}

function FieldEditor({ field, company, companyName, onClose, onSaved, toastErr }) {
  const start = useMemo(() => ({
    label: field?.label || '',
    field_type: field?.fieldType || 'text',
    options: (field?.options || []).join('\n'),
    visibility: field?.visibility || 'hr_only',
    required: !!field?.required,
  }), [field]);
  const [f, setF] = useState(start);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((m) => ({ ...m, [k]: v }));
  const dirty = JSON.stringify(f) !== JSON.stringify(start);
  const options = f.options.split('\n').map((o) => o.trim()).filter(Boolean);
  const problem = !f.label.trim() ? 'Give the field a label.'
    : f.field_type === 'dropdown' && !options.length ? 'A dropdown needs at least one option.' : '';

  async function save() {
    if (problem) { toastErr?.(problem); return; }
    setBusy(true);
    const body = { label: f.label.trim(), field_type: f.field_type, options, visibility: f.visibility,
      required: f.field_type !== 'checkbox' && f.required };
    try {
      const saved = field ? await api.hrCustomFieldUpdate(field.id, body)
        : await api.hrCustomFieldCreate({ ...body, company_id: company || '' });
      onSaved(saved, !field);
    } catch (e) { toastErr?.(e?.message || 'Could not save the field.'); }
    setBusy(false);
  }

  const footer = (
    <>
      {problem && <span style={{ fontSize: 12, color: 'var(--muted)', marginRight: 'auto' }}>{problem}</span>}
      <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button className="primary-btn" onClick={save} disabled={busy || !!problem || (field && !dirty)}>{busy ? 'Saving…' : field ? 'Save Field' : 'Add Field'}</button>
    </>
  );
  return (
    <Modal title={field ? `Edit ${field.label}` : 'Add Field'} onClose={onClose} footer={footer} isDirty={dirty} onSave={save}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {field
            ? <>Its values stay as they are when you change it. Documents use it as <code>{`{{${field.token}}}`}</code>.</>
            : <>On the records of {company ? `${companyName || 'this company'}'s people` : 'everyone in every company'}.</>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <div>
            <label style={FL} htmlFor="cfx-label">Label</label>
            <input id="cfx-label" className="form-input" style={{ width: '100%' }} value={f.label} maxLength={80}
              onChange={(e) => set('label', e.target.value)} placeholder="e.g. Shirt Size" autoFocus />
          </div>
          <div>
            <label style={FL} htmlFor="cfx-type">Type</label>
            <select id="cfx-type" className="form-input" style={{ width: '100%' }} value={f.field_type} onChange={(e) => set('field_type', e.target.value)}>
              {FIELD_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {field && f.field_type !== field.fieldType && (
              <div style={{ fontSize: 11.5, color: 'hsl(var(--color-orange))', marginTop: 4 }}>Values saved before stay as they were; a value that no longer fits is fixed the next time someone edits it.</div>
            )}
          </div>
        </div>
        <div>
          <span style={FL}>Who Sees It</span>
          <div role="radiogroup" aria-label="Who sees it" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {VISIBILITY.map(([k, l, hint]) => (
              <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" name="cfx-vis" value={k} checked={f.visibility === k} onChange={() => set('visibility', k)} style={{ marginTop: 3 }} />
                <span><strong>{l}</strong><span style={{ color: 'var(--muted)', display: 'block', fontSize: 12 }}>{hint}</span></span>
              </label>
            ))}
          </div>
        </div>
        {f.field_type !== 'checkbox' && (
          <div className="nx-set-card">
            <SwitchRow id="cfx-required" title="Required" desc="A More Details save is refused until it is filled in."
              checked={f.required} onChange={(v) => set('required', v)} />
          </div>
        )}
        {f.field_type === 'dropdown' && (
          <div className="nx-fill">
            <label style={FL} htmlFor="cfx-options">Options (one per line)</label>
            <textarea id="cfx-options" className="form-input" style={{ width: '100%', fontFamily: 'Inter,sans-serif' }}
              value={f.options} onChange={(e) => set('options', e.target.value)} placeholder={'Small\nMedium\nLarge'} />
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function EmployeeCustomFieldsSettings({ company = '', toastOk, toastErr }) {
  const [fields, setFields] = useState(null);
  const [entities, setEntities] = useState([]);
  const [editing, setEditing] = useState(null);   // null | 'new' | a field
  const [busyId, setBusyId] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => api.hrCustomFields(true)
    .then((r) => { setErr(''); setFields(r); })
    .catch((e) => { setFields((m) => m || []); setErr(e?.message || 'Could not load the fields.'); }), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.getEntities().then(setEntities).catch(() => setEntities([])); }, []);

  const companyName = entities.find((e) => e.id === company)?.name || '';
  const mine = useMemo(() => (fields || []).filter((f) => (f.companyId || '') === (company || '')), [fields, company]);
  const live = mine.filter((f) => !f.archived);
  const archived = mine.filter((f) => f.archived);
  const inherited = company ? (fields || []).filter((f) => !f.companyId && !f.archived) : [];

  async function patch(f, body, done) {
    setBusyId(f.id);
    try { await api.hrCustomFieldUpdate(f.id, body); toastOk?.(done); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not save the field.'); }
    setBusyId('');
  }
  async function move(i, dir) {
    const ids = live.map((f) => f.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { setFields(await api.hrCustomFieldsReorder(ids)); }
    catch (e) { toastErr?.(e?.message || 'Could not reorder the fields.'); }
  }

  if (!fields) return <div style={{ padding: 16 }}><SkeletonBlocks count={3} height={44} /></div>;
  const iconBtn = { padding: '4px 7px', display: 'inline-flex', alignItems: 'center' };
  return (
    <div>
      {err && <div role="alert" style={{ padding: '12px 18px', fontSize: 12.5, color: 'hsl(var(--color-red))' }}>{err}</div>}
      {company && (
        <div style={{ padding: '12px 18px', fontSize: 12.5, color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>
          {inherited.length
            ? <>Every company&apos;s fields are on these people too: {inherited.map((f) => f.label).join(', ')}. They are set up with Applies To on Every company.</>
            : <>These fields are {companyName ? `${companyName}'s` : "this company's"} alone. Fields for every company are set up with Applies To on Every company.</>}
        </div>
      )}
      {live.length === 0 && (
        <div style={{ padding: '16px 18px', fontSize: 12.5, color: 'var(--muted)' }}>
          No fields yet. Add one to keep something about people that the profile does not have - a shirt size, a badge number, a union local.
        </div>
      )}
      {live.map((f, i) => (
        <SettingRow key={f.id} title={f.label} desc={describe(f)} control={(
          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" className="secondary-btn" style={iconBtn} aria-label={`Move ${f.label} up`} title="Move Up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
            <button type="button" className="secondary-btn" style={iconBtn} aria-label={`Move ${f.label} down`} title="Move Down" disabled={i === live.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
            <button type="button" className="secondary-btn" style={{ ...iconBtn, gap: 5, fontSize: 12 }} onClick={() => setEditing(f)}><Pencil size={12} /> Edit</button>
            <button type="button" className="secondary-btn" style={{ ...iconBtn, gap: 5, fontSize: 12 }} disabled={busyId === f.id}
              title="Hide it everywhere - every value is kept and comes back on Restore"
              onClick={() => patch(f, { archived: true }, `${f.label} archived - its values are kept.`)}><Archive size={12} /> Archive</button>
          </span>
        )} />
      ))}
      <div style={{ padding: '12px 18px', borderTop: live.length ? '1px solid var(--line)' : undefined }}>
        <button type="button" className="secondary-btn" onClick={() => setEditing('new')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <Plus size={13} /> Add Field
        </button>
      </div>
      {archived.length > 0 && (
        <>
          <div style={{ padding: '10px 18px 0', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', borderTop: '1px solid var(--line)' }}>Archived</div>
          {archived.map((f) => (
            <SettingRow key={f.id} muted title={f.label} desc={`${describe(f)} · hidden, values kept`} control={(
              <button type="button" className="secondary-btn" style={{ ...iconBtn, gap: 5, fontSize: 12 }} disabled={busyId === f.id}
                onClick={() => patch(f, { archived: false }, `${f.label} restored with its values.`)}><RotateCcw size={12} /> Restore</button>
            )} />
          ))}
        </>
      )}
      {editing && (
        <FieldEditor field={editing === 'new' ? null : editing} company={company} companyName={companyName}
          onClose={() => setEditing(null)} toastErr={toastErr}
          onSaved={(saved, isNew) => { setEditing(null); toastOk?.(isNew ? `${saved.label} added.` : `${saved.label} saved.`); load(); }} />
      )}
    </div>
  );
}
