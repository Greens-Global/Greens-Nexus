import { RESERVED_TYPES, placeholderLabel } from '../lib/mergeFieldTypes';

// Template Builder (Phase 13) - one control per merge-field type, shared by
// DefineMergeFieldModal (editing a field's Default Value) and
// DocumentsBrowser's Generate-Document fill form (entering a real value).
// `def` is a field_defs entry: {token, label, type, required, options, validation}.
export default function TypedFieldInput({ def, value, onChange, error }) {
  const inputStyle = { width: '100%', ...(error ? { borderColor: 'hsl(var(--color-red))' } : {}) };

  if (RESERVED_TYPES.includes(def.type)) {
    return (
      <div style={{ fontSize: 11.5, color: 'var(--muted)', fontStyle: 'italic', padding: '7px 0' }}>
        {def.type === 'signature' || def.type === 'initials'
          ? `Placed when sent for signature - shown as "${placeholderLabel(def)}" until then.`
          : `Not attached here yet - shown as "${placeholderLabel(def)}" in the generated document.`}
      </div>
    );
  }

  switch (def.type) {
    case 'multiline':
      return <textarea className="form-input" style={inputStyle} rows={3} value={value ?? ''} maxLength={def.validation?.maxLength || undefined}
        onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <input type="number" className="form-input" style={inputStyle} value={value ?? ''}
        min={def.validation?.min} max={def.validation?.max} onChange={(e) => onChange(e.target.value)} />;
    case 'currency':
      return (
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', fontSize: 12.5 }}>$</span>
          <input type="number" step="0.01" className="form-input" style={{ ...inputStyle, paddingLeft: 22 }} value={value ?? ''}
            min={def.validation?.min} max={def.validation?.max} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case 'date':
      return <input type="date" className="form-input" style={inputStyle} value={value ?? ''}
        min={def.validation?.minDate || undefined} max={def.validation?.maxDate || undefined}
        onChange={(e) => onChange(e.target.value)} />;
    case 'time':
      return <input type="time" className="form-input" style={inputStyle} value={value ?? ''}
        onChange={(e) => onChange(e.target.value)} />;
    // Requirement 5's email/address/person types. The right keyboard and
    // autocomplete on a phone, and the browser's own email check as a first
    // pass - validateFieldValue and the server both check again.
    case 'email':
      return <input type="email" inputMode="email" autoComplete="email" className="form-input" style={inputStyle}
        value={value ?? ''} placeholder="name@company.com" onChange={(e) => onChange(e.target.value)} />;
    case 'address':
      return <textarea className="form-input" style={inputStyle} rows={2} value={value ?? ''}
        autoComplete="street-address" maxLength={def.validation?.maxLength || undefined}
        placeholder="Street, city, state, postal code" onChange={(e) => onChange(e.target.value)} />;
    case 'person':
      return <input type="text" autoComplete="name" className="form-input" style={inputStyle} value={value ?? ''}
        maxLength={def.validation?.maxLength || undefined} placeholder="Full name"
        onChange={(e) => onChange(e.target.value)} />;
    case 'dropdown':
      return (
        <select className="form-input" style={inputStyle} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">- Select -</option>
          {(def.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'radio':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {(def.options || []).map((o) => (
            <label key={o} style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="radio" name={`radio-${def.token}`} checked={value === o} onChange={() => onChange(o)} /> {o}
            </label>
          ))}
        </div>
      );
    case 'checkbox':
      return (
        <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
          <input type="checkbox" checked={value === true || value === 'true' || value === 'Yes'}
            onChange={(e) => onChange(e.target.checked)} /> {def.label}
        </label>
      );
    default:
      return <input type="text" className="form-input" style={inputStyle} value={value ?? ''}
        maxLength={def.validation?.maxLength || undefined} onChange={(e) => onChange(e.target.value)} />;
  }
}
