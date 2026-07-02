import { Upload, FileText } from 'lucide-react';
import { fileToDataUrl } from '../../lib/format.js';

/**
 * Renders a single form field inside the Add/Edit record modal, generically, from a
 * record-type field definition `{ k, label, type, options, req, full, readOnly, nameKey }`.
 * Supported `type`s: file, select, textarea, date, number, and plain text (default).
 *
 * `value` is the current value for this field; `onChange(key, newValue)` commits it.
 */
export function FieldInput({ f, value, onChange }) {
  const baseProps = {
    className: 'form-input',
    value: value ?? '',
    onChange: (e) => onChange(f.k, e.target.value),
    readOnly: f.readOnly,
    style: {
      fontSize: '0.85rem',
      ...(f.readOnly ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: 'not-allowed' } : {}),
    },
  };

  const label = (
    <label>
      {f.label}
      {f.req ? <span style={{ color: 'hsl(var(--color-red))' }}> *</span> : ''}
    </label>
  );

  // File upload: stores the file as a base64 data URL directly on the record (f.k), plus the
  // original filename on a sibling key (f.nameKey) so the table/summary can show a filename
  // without decoding the data URL.
  if (f.type === 'file') {
    return (
      <div className={f.full ? 'form-group form-group-full' : 'form-group'}>
        {label}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label className="secondary-btn" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
            <Upload size={14} /> {value ? 'Replace file' : 'Upload file'}
            <input
              type="file"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                  try {
                    const dataUrl = await fileToDataUrl(file);
                    onChange(f.k, dataUrl);
                    if (f.nameKey) onChange(f.nameKey, file.name);
                  } catch {
                    // unreadable file — silently ignore, field stays unchanged
                  }
                  e.target.value = '';
                }
              }}
            />
          </label>
          {value && (
            <a
              href={value}
              target="_blank"
              rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.82rem', color: 'hsl(var(--color-blue))', fontWeight: 600 }}
            >
              <FileText size={14} /> View document
            </a>
          )}
          {value && (
            <button type="button" className="secondary-btn" onClick={() => onChange(f.k, '')} style={{ padding: '5px 11px', fontSize: '0.76rem' }}>
              Clear
            </button>
          )}
        </div>
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
    </div>
  );
}
