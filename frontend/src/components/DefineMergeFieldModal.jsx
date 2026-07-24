import { useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import TypedFieldInput from './TypedFieldInput';
import { FIELD_TYPES, VALIDATION_KEYS, OPTION_TYPES, slugifyToken } from '../lib/mergeFieldTypes';

const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const cardStyle = { background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 440, maxHeight: '86vh', overflowY: 'auto', boxShadow: 'var(--shadow-lg)' };
const label = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 };
const field = { marginBottom: 14 };

// Template Builder (Phase 13) — "select text → Convert to Merge Field" opens
// this modal (new field, existingDef=null) or double-clicking an existing
// chip reopens it pre-filled (existingDef set) to edit type/required/default/
// validation without moving the chip. Saving here writes ONE field_defs
// entry; DocumentBuilder is responsible for also updating the mergeField
// node's `token` attr for a brand-new field.
export default function DefineMergeFieldModal({ initialLabel = '', existingDef = null, existingTokens = [], onSave, onCancel }) {
  const isEdit = !!existingDef;
  const [labelText, setLabelText] = useState(existingDef?.label || initialLabel);
  const [token, setToken] = useState(existingDef?.token || slugifyToken(initialLabel));
  const [tokenTouched, setTokenTouched] = useState(false);
  const [type, setType] = useState(existingDef?.type || 'text');
  const [required, setRequired] = useState(existingDef?.required ?? false);
  const [defaultValue, setDefaultValue] = useState(existingDef?.default ?? '');
  const [options, setOptions] = useState(existingDef?.options || []);
  const [optionDraft, setOptionDraft] = useState('');
  const [validation, setValidation] = useState(existingDef?.validation || {});

  const onLabelChange = (v) => {
    setLabelText(v);
    if (!tokenTouched && !isEdit) setToken(slugifyToken(v));
  };

  const tokenValid = /^[a-z0-9_]+$/.test(token);
  const tokenTaken = existingTokens.includes(token) && token !== existingDef?.token;
  const canSave = labelText.trim() && tokenValid && !tokenTaken;

  const addOption = () => {
    const v = optionDraft.trim();
    if (v && !options.includes(v)) setOptions([...options, v]);
    setOptionDraft('');
  };

  const setV = (key, val) => setValidation((v) => ({ ...v, [key]: val }));
  const vKeys = VALIDATION_KEYS[type] || [];

  const save = () => {
    if (!canSave) return;
    onSave({
      token, label: labelText.trim(), type, required, default: defaultValue,
      options: OPTION_TYPES.includes(type) ? options : undefined,
      validation: Object.fromEntries(vKeys.map((k) => [k, validation[k]]).filter(([, v]) => v !== undefined && v !== '')),
    });
  };

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {isEdit ? 'Edit Merge Field' : 'Convert to Merge Field'}
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}><X size={18} /></button>
        </div>
        <div style={{ padding: 20 }}>
          <div style={field}>
            <label style={label}>Field Name</label>
            <input className="form-input" style={{ width: '100%' }} autoFocus value={labelText}
              onChange={(e) => onLabelChange(e.target.value)} placeholder="e.g. Contractor Name" />
          </div>
          <div style={field}>
            <label style={label}>Merge Token — {'{{' + (token || '…') + '}}'}</label>
            {isEdit ? (
              <input className="form-input" style={{ width: '100%', opacity: 0.65 }} value={token} disabled />
            ) : (
              <input className="form-input" style={{ width: '100%', ...(!tokenValid || tokenTaken ? { borderColor: 'hsl(var(--color-red))' } : {}) }}
                value={token} onChange={(e) => { setTokenTouched(true); setToken(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')); }} />
            )}
            {!isEdit && !tokenValid && <p style={{ fontSize: 11, color: 'hsl(var(--color-red))', margin: '4px 0 0' }}>Lowercase letters, numbers, underscores only.</p>}
            {!isEdit && tokenTaken && <p style={{ fontSize: 11, color: 'hsl(var(--color-red))', margin: '4px 0 0' }}>Another field already uses this token.</p>}
            {isEdit && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>The token can't change once the field is in use — it would break every chip already placed.</p>}
          </div>
          <div style={field}>
            <label style={label}>Field Type</label>
            <select className="form-input" style={{ width: '100%' }} value={type} onChange={(e) => setType(e.target.value)}>
              {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', marginBottom: 14 }}>
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
          </label>

          {OPTION_TYPES.includes(type) && (
            <div style={field}>
              <label style={label}>Options</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                {options.map((o) => (
                  <div key={o} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ flex: 1, fontSize: 12.5, border: '1px solid var(--line)', borderRadius: 7, padding: '5px 9px' }}>{o}</span>
                    <button onClick={() => setOptions(options.filter((x) => x !== o))} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', display: 'flex' }}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="form-input" style={{ flex: 1, fontSize: 12.5 }} placeholder="Add option…" value={optionDraft}
                  onChange={(e) => setOptionDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } }} />
                <button onClick={addOption} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600 }}><Plus size={13} /> Add</button>
              </div>
            </div>
          )}

          {!OPTION_TYPES.includes(type) && (
            <div style={field}>
              <label style={label}>Default Value</label>
              <TypedFieldInput def={{ token, label: labelText, type, options, validation, required: false }}
                value={defaultValue} onChange={setDefaultValue} />
            </div>
          )}

          {vKeys.length > 0 && (
            <div style={field}>
              <label style={label}>Validation</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {vKeys.includes('maxLength') && (
                  <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    Character limit
                    <input type="number" className="form-input" style={{ width: 90 }} value={validation.maxLength ?? ''} onChange={(e) => setV('maxLength', e.target.value)} />
                  </label>
                )}
                {vKeys.includes('regex') && (
                  <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    Regex validation (optional)
                    <input className="form-input" placeholder="e.g. ^[A-Za-z ]+$" value={validation.regex ?? ''} onChange={(e) => setV('regex', e.target.value)} />
                  </label>
                )}
                {vKeys.includes('min') && vKeys.includes('max') && (
                  <div style={{ display: 'flex', gap: 10 }}>
                    <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                      Min value
                      <input type="number" className="form-input" value={validation.min ?? ''} onChange={(e) => setV('min', e.target.value)} />
                    </label>
                    <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                      Max value
                      <input type="number" className="form-input" value={validation.max ?? ''} onChange={(e) => setV('max', e.target.value)} />
                    </label>
                  </div>
                )}
                {vKeys.includes('minDate') && vKeys.includes('maxDate') && (
                  <div style={{ display: 'flex', gap: 10 }}>
                    <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                      Earliest
                      <input type="date" className="form-input" value={validation.minDate ?? ''} onChange={(e) => setV('minDate', e.target.value)} />
                    </label>
                    <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                      Latest
                      <input type="date" className="form-input" value={validation.maxDate ?? ''} onChange={(e) => setV('maxDate', e.target.value)} />
                    </label>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onCancel} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button className="primary-btn" disabled={!canSave} onClick={save} style={{ opacity: canSave ? 1 : 0.6 }}>Save</button>
        </div>
      </div>
    </div>
  );
}
