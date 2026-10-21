import { useState, useEffect, useId } from 'react';
import { Upload, FileText, Plus, X } from 'lucide-react';
import { storeAssetDocument } from '../../lib/upload.js';

// Format free typing into mm/dd/yyyy as the user goes; validate the final shape.
// A native <input type="date"> was rejected here: its displayed format follows the
// browser LOCALE (e.g. en-IN shows dd-mm-yyyy), but the requirement is an explicit
// mm/dd/yyyy field for everyone - so this is a masked text input, locale-independent.
const fmtMdy = (raw) => {
  const d = String(raw).replace(/\D/g, '').slice(0, 8);   // digits only, MMDDYYYY
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
};
const isValidMdy = (s) => /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/.test(String(s).trim());

/**
 * Multi-date field (`type: 'dates'`) - one or more dates, each typed in explicit
 * mm/dd/yyyy (auto-slashing as you go, validated on the spot). Stored as a
 * comma-separated string ("11/01/2025, 02/01/2026"), keeping existing values
 * readable. Property taxes fall due in installments, so a single input would drop
 * the second date - hence the add/remove rows.
 */
export function MultiDateInput({ value, onChange, readOnly }) {
  const parse = (v) => {
    const parts = String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : [''];
  };
  const [rows, setRows] = useState(() => parse(value));
  useEffect(() => { setRows(parse(value)); }, [value]);   // sync when the record switches

  const commit = (next) => {
    setRows(next);
    onChange(next.map((s) => s.trim()).filter(Boolean).join(', '));
  };
  const setRow = (i, mdy) => commit(rows.map((r, j) => (j === i ? mdy : r)));
  const addRow = () => setRows((r) => [...r, '']);
  const removeRow = (i) => commit(rows.filter((_, j) => j !== i));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r, i) => {
        const invalid = r.trim() && !isValidMdy(r);
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="text"
              inputMode="numeric"
              placeholder="mm/dd/yyyy"
              maxLength={10}
              className="form-input"
              value={r}
              readOnly={readOnly}
              onChange={(e) => setRow(i, fmtMdy(e.target.value))}
              style={{ fontSize: '0.85rem', flex: 1, ...(invalid ? { borderColor: 'hsl(var(--color-red))' } : {}) }}
            />
            {!readOnly && (rows.length > 1 || r) && (
              <button type="button" className="secondary-btn" onClick={() => removeRow(i)}
                title="Remove this date" style={{ padding: '5px 8px', lineHeight: 0 }}>
                <X size={13} />
              </button>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <button type="button" className="secondary-btn" onClick={addRow}
          style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', fontSize: '0.78rem' }}>
          <Plus size={13} /> Add Date
        </button>
      )}
    </div>
  );
}

/**
 * Renders a single form field inside the Add/Edit record modal, generically, from a
 * record-type field definition `{ k, label, type, options, req, full, readOnly, nameKey }`.
 * Supported `type`s: file, select, textarea, date, dates, number, and plain text (default).
 *
 * `value` is the current value for this field; `onChange(key, newValue)` commits it.
 */
/** One form field. `error` (a short string) marks the control invalid and prints under it;
 *  `propertyId` files an uploaded document under its asset. */
export function FieldInput({ f, value, onChange, error, propertyId = '' }) {
  const id = useId();
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const baseProps = {
    id,
    'data-field': f.k,
    className: 'form-input',
    value: value ?? '',
    onChange: (e) => onChange(f.k, e.target.value),
    readOnly: f.readOnly,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? id + '-err' : undefined,
    style: {
      fontSize: '0.85rem',
      ...(error ? { borderColor: 'hsl(var(--color-red))' } : {}),
      ...(f.readOnly ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: 'not-allowed' } : {}),
    },
  };

  const label = (
    <label htmlFor={id}>
      {f.label}
      {f.req ? <span style={{ color: 'hsl(var(--color-red))' }}> *</span> : ''}
    </label>
  );
  const errorLine = error ? <div id={id + '-err'} role="alert" style={{ fontSize: '0.76rem', fontWeight: 600, color: 'hsl(var(--color-red))', marginTop: 4 }}>{error}</div> : null;

  // File upload: the file goes to the private asset-files bucket and the record
  // keeps its URL (f.k), plus the original filename on a sibling key (f.nameKey)
  // so the table/summary can show a name without fetching anything.
  if (f.type === 'file') {
    const applyFile = async (file) => {
      setUploadError('');
      setUploading(true);
      const { url, error } = await storeAssetDocument(file, propertyId);
      setUploading(false);
      if (error) { setUploadError(error); return; }
      onChange(f.k, url);
      if (f.nameKey) onChange(f.nameKey, file.name);
    };
    // Image on the clipboard → store it exactly like a chosen file; anything else
    // (text etc.) falls through to the browser's default paste behaviour.
    const handlePaste = (e) => {
      const list = e.clipboardData?.items || [];
      for (const it of list) {
        if (it.type && it.type.startsWith('image/')) {
          const blob = it.getAsFile();
          if (blob) {
            e.preventDefault();
            applyFile(blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' }));
            return;
          }
        }
      }
    };
    return (
      <div className={f.full ? 'form-group form-group-full' : 'form-group'}>
        {label}
        <div id={id} data-field={f.k} onPaste={handlePaste} tabIndex={0} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', outline: 'none' }}>
          <label className="secondary-btn" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
            <Upload size={14} /> {uploading ? 'Uploading…' : value ? 'Replace File' : 'Upload File'}
            <input
              type="file"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                  await applyFile(file);
                  e.target.value = '';
                }
              }}
            />
          </label>
          <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>or press Ctrl+V to paste a screenshot</span>
          {value && (
            <a
              href={value}
              target="_blank"
              rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.82rem', color: 'hsl(var(--color-blue))', fontWeight: 600 }}
            >
              <FileText size={14} /> View Document
            </a>
          )}
          {value && (
            <button type="button" className="secondary-btn" onClick={() => onChange(f.k, '')} style={{ padding: '5px 11px', fontSize: '0.76rem' }}>
              Clear
            </button>
          )}
        </div>
        {uploadError && <div role="alert" style={{ fontSize: '0.76rem', fontWeight: 600, color: 'hsl(var(--color-red))', marginTop: 4 }}>{uploadError}</div>}
        {errorLine}
      </div>
    );
  }

  let control;
  if (f.type === 'select') {
    // Options can be plain strings or {v, l} value/label pairs. If none of them is the empty
    // string, inject a blank "Select…" placeholder option at the top.
    const opts = (f.options || []).map((o) => (typeof o === 'string' ? { v: o, l: o } : o));
    control = (
      <select {...baseProps}>
        {!opts.some((o) => o.v === '') && <option value="">Select…</option>}
        {opts.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
    );
  } else if (f.type === 'textarea') {
    control = <textarea {...baseProps} rows={2} />;
  } else if (f.type === 'date') {
    control = <input type="date" {...baseProps} />;
  } else if (f.type === 'dates') {
    control = <MultiDateInput value={value} readOnly={f.readOnly} onChange={(v) => onChange(f.k, v)} />;
  } else if (f.type === 'number') {
    // Intentionally type="text" with inputMode="decimal", not a native <input type="number">,
    // so the field can hold formatted values (e.g. "1,234") without the browser rejecting them.
    control = <input type="text" inputMode="decimal" {...baseProps} />;
  } else {
    control = <input type="text" {...baseProps} />;
  }

  return (
    <div className={f.full ? 'form-group form-group-full' : 'form-group'}>
      {label}
      {control}
      {errorLine}
    </div>
  );
}

/** Which required fields are empty - { key: 'Required' } - and focuses the first one. */
export function requiredErrors(fields, values) {
  const errors = {};
  for (const f of fields) {
    if (f.req && !f.sec && !String(values[f.k] ?? '').trim()) errors[f.k] = 'Required';
  }
  const first = Object.keys(errors)[0];
  if (first) setTimeout(() => document.querySelector(`[data-field="${first}"]`)?.focus?.(), 0);
  return errors;
}
