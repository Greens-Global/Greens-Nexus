import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Check, X, ListPlus, Lock, Eye } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, Spinner } from './AsyncState';
import { DateField } from '../tasks/components';
import { changedValues, fieldError, formValue, formatFieldValue, VISIBILITY_LABEL } from '../lib/employeeCustomFields';

// More Details (Neil, Oct 27 2026): the custom fields HR defines in
// Settings > People & Access, on a person's People profile and in My HR.
// What arrives is already filtered by the server - an HR Only field never
// reaches anyone who is not HR for the person - so this only draws it.
// A save sends just the fields that changed.

const LBL = { fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase' };

export function FieldInput({ field, value, onChange, error, id }) {
  const common = { id, 'aria-label': field.label, 'aria-invalid': error ? true : undefined };
  if (field.fieldType === 'checkbox') {
    return (
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, cursor: 'pointer' }}>
        <input type="checkbox" {...common} checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {value ? 'Yes' : 'No'}
      </label>
    );
  }
  if (field.fieldType === 'date') {
    return (
      <div className="form-input" style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
        <DateField value={value} onChange={(x) => onChange(x || '')} placeholder="MM/DD/YYYY" title={field.label} style={{ width: '100%' }} />
      </div>
    );
  }
  if (field.fieldType === 'dropdown') {
    const opts = field.options || [];
    // A stored value no longer among the options stays selectable, so
    // opening the form never changes it.
    const extra = value && !opts.some((o) => o === value) ? [value] : [];
    return (
      <select className="form-input" {...common} value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%' }}>
        <option value="">{field.required ? 'Pick one' : 'None'}</option>
        {[...opts, ...extra].map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input className="form-input" {...common} value={value} onChange={(e) => onChange(e.target.value)}
      inputMode={field.fieldType === 'number' ? 'decimal' : undefined} style={{ width: '100%' }}
      maxLength={field.fieldType === 'text' ? 2000 : 40} />
  );
}

// The shared body: rows to read, an Edit that turns the editable ones into
// boxes. `load` / `save` are the two calls (People or My HR).
function MoreDetailsBody({ load, save, readOnly = false, showVisibility = false, emptyText, onEmpty, toastOk, toastErr, reloadKey }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    load()
      .then((d) => { if (live) { setErr(''); setData(d); } })
      .catch((e) => { if (live) { setData({ fields: [], values: {} }); setErr(e?.message || 'Could not load More Details.'); } });
    return () => { live = false; };
  }, [load, reloadKey]);

  const fields = useMemo(() => data?.fields || [], [data]);
  const values = useMemo(() => data?.values || {}, [data]);
  const canEdit = !readOnly && !!data?.canEdit;
  useEffect(() => { if (data && !fields.length) onEmpty?.(); }, [data, fields.length, onEmpty]);

  const startEdit = () => {
    setForm(Object.fromEntries(fields.map((f) => [f.fieldKey, formValue(f, values[f.fieldKey])])));
    setErrors({});
    setEditing(true);
  };
  const doSave = async () => {
    // Only what changed is checked (a value saved before a field's type
    // changed stays as it was), plus every required field left empty.
    const changes = changedValues(fields, values, form);
    const problems = {};
    for (const f of fields) {
      if (!f.editable || !(f.fieldKey in changes || f.required)) continue;
      const msg = fieldError(f, form[f.fieldKey]);
      if (msg && (f.fieldKey in changes || !String(form[f.fieldKey] ?? '').trim())) problems[f.fieldKey] = msg;
    }
    setErrors(problems);
    if (Object.keys(problems).length) return;
    if (!Object.keys(changes).length) { setEditing(false); return; }
    setSaving(true);
    try {
      const next = await save(changes);
      setData(next);
      setEditing(false);
      toastOk?.('More Details saved.');
    } catch (e) {
      toastErr?.(e?.message || 'Could not save More Details.');
    }
    setSaving(false);
  };

  if (!data) return <SkeletonBlocks count={3} height={34} />;
  if (err) return <div style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', padding: '8px 0' }}>{err}</div>;
  if (!fields.length) return emptyText ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '12px 0' }}>{emptyText}</div> : null;

  return (
    <div>
      {canEdit && !editing && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button className="secondary-btn" onClick={startEdit} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
            <Pencil size={12} /> Edit
          </button>
        </div>
      )}
      {fields.map((f) => {
        const id = `cf-${f.fieldKey}`;
        const shown = formatFieldValue(f, values[f.fieldKey]);
        const live = editing && f.editable;
        return (
          <div key={f.fieldKey} style={{ display: 'flex', alignItems: live ? 'flex-start' : 'center', gap: 10, padding: live ? '8px 0' : '9px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
            <label htmlFor={live ? id : undefined} style={{ ...LBL, width: 150, flexShrink: 0, paddingTop: live ? 8 : 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              {f.label}{f.required && <span aria-hidden="true" style={{ color: 'hsl(var(--color-red))' }}>*</span>}
              {showVisibility && f.visibility === 'hr_only' && <Lock size={10} aria-label="HR Only" title="HR Only - the employee and their manager never see it" />}
              {showVisibility && f.visibility !== 'hr_only' && <Eye size={10} aria-label={VISIBILITY_LABEL[f.visibility]} title={VISIBILITY_LABEL[f.visibility]} />}
            </label>
            {live ? (
              <div style={{ flex: 1, minWidth: 'min(100%, 220px)' }}>
                <FieldInput field={f} id={id} value={form[f.fieldKey]} error={errors[f.fieldKey]}
                  onChange={(v) => { setForm((m) => ({ ...m, [f.fieldKey]: v })); setErrors((m) => ({ ...m, [f.fieldKey]: '' })); }} />
                {errors[f.fieldKey] && <div role="alert" style={{ fontSize: 11.5, color: 'hsl(var(--color-red))', marginTop: 4 }}>{errors[f.fieldKey]}</div>}
              </div>
            ) : (
              <span style={{ fontSize: 13.5, color: shown ? 'var(--ink)' : 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0, whiteSpace: f.fieldType === 'text' ? 'pre-wrap' : 'nowrap' }}>
                {shown || '-'}
                {editing && !f.editable && <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 8 }}>(HR changes this)</span>}
              </span>
            )}
          </div>
        );
      })}
      {editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={() => setEditing(false)} disabled={saving}><X size={13} /> Cancel</button>
          <button className="primary-btn" onClick={doSave} disabled={saving}>
            {saving ? <><Spinner size={13} /> Saving…</> : <><Check size={13} /> Save</>}
          </button>
        </div>
      )}
    </div>
  );
}

// People profile tab. `readOnly` for the manager tier and removed people.
export function EmployeeMoreDetails({ employee, readOnly = false, toastOk, toastErr }) {
  const eid = employee?.id;
  const load = useCallback(() => api.hrEmployeeCustomFields(eid), [eid]);
  const save = useCallback((changes) => api.hrEmployeeCustomFieldsSave(eid, changes), [eid]);
  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 6 }}>
        The fields set up in Settings &gt; People &amp; Access for {employee?.firstName || 'this person'}&apos;s company.
      </div>
      <MoreDetailsBody load={load} save={save} readOnly={readOnly} showVisibility
        emptyText="Nothing to show here yet. HR sets up these fields in Settings > People & Access."
        toastOk={toastOk} toastErr={toastErr} />
    </div>
  );
}

// My HR card: renders nothing until HR has shared a field with employees.
export function MyMoreDetails() {
  const [empty, setEmpty] = useState(false);
  const [toast, setToast] = useState(null);
  const load = useCallback(() => api.myHrCustomFields(), []);
  const save = useCallback((changes) => api.myHrCustomFieldsSave(changes), []);
  const onEmpty = useCallback(() => setEmpty(true), []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), toast.ok ? 3500 : 9000);
    return () => clearTimeout(t);
  }, [toast]);
  if (empty) return null;
  return (
    <div className="dash-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <ListPlus size={15} style={{ color: 'var(--muted)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>More Details</span>
      </div>
      <MoreDetailsBody load={load} save={save} onEmpty={onEmpty}
        toastOk={(m) => setToast({ ok: true, m })} toastErr={(m) => setToast({ ok: false, m })} />
      {toast && (
        <div role={toast.ok ? 'status' : 'alert'} style={{ fontSize: 12, marginTop: 8, color: toast.ok ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))' }}>
          {toast.m}
        </div>
      )}
    </div>
  );
}
