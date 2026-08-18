// Generic single-row Add/Edit modal shared by the two asset-record collections that live
// directly on the asset (not in the shared store) and use a loose [key, label, options?] tuple
// schema instead of a RECORD_TYPES config: Permits (dynamic columns, see permitColumns() in
// ../../lib/timelineFields.js) and the Development Timeline (fixed columns, see
// TIMELINE_FIELDS in the same file - status excluded, since status changes go through
// ../asset/TimelineStatusModal.jsx instead).
//
// Simpler than the generic RecordModal (used for RECORD_TYPES collections): no per-field type
// metadata beyond an optional select-options list, and textarea-like fields are detected by a
// label/key keyword heuristic rather than an explicit `type`.

import { useState } from 'react';
import { Modal } from './Modal.jsx';

/** Heuristic: fields whose key/label suggests free-text content get a full-width textarea. */
function isLongTextField(key) {
  return /note|submittal|description|comment|scope|condition/i.test(key);
}

/**
 * @param title     e.g. "Permit row" or "Timeline row" - used for the "Add "/"Edit " modal heading
 * @param fields    [key, label, options?][] - the row's editable columns
 * @param row       existing row object when editing, null/undefined when adding
 * @param onSave    (values) => void
 * @param onDelete  () => void, or falsy/omitted to hide the Delete action (e.g. when adding)
 * @param onClose   () => void
 */
export function SimpleRowModal({ title, fields, row, onSave, onDelete, onClose }) {
  const cols = fields || [];
  const [values, setValues] = useState(() => {
    const initial = {};
    cols.forEach(([key]) => { initial[key] = row ? row[key] ?? '' : ''; });
    return initial;
  });
  const [initialValues] = useState(values);
  const dirty = JSON.stringify(values) !== JSON.stringify(initialValues);

  const setField = (key, val) => setValues((prev) => ({ ...prev, [key]: val }));

  return (
    <Modal
      title={(row ? 'Edit ' : 'Add ') + title.toLowerCase()}
      wide
      onClose={onClose}
      isDirty={dirty}
      onSave={() => onSave(values)}
      footer={
        <>
          {row && onDelete && (
            <button
              className="secondary-btn"
              onClick={() => { if (window.confirm('Delete this row?')) onDelete(); }}
              style={{ marginRight: 'auto', color: 'hsl(var(--color-red))' }}
            >
              Delete
            </button>
          )}
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={() => onSave(values)}>Save</button>
        </>
      }
    >
      <div className="form-grid">
        {cols.map(([key, label, options]) => (
          <div key={key} className={isLongTextField(key) ? 'form-group form-group-full' : 'form-group'}>
            <label>{label || key}</label>
            {options ? (
              <select className="form-input" value={values[key]} onChange={(e) => setField(key, e.target.value)}>
                <option value="">Select…</option>
                {options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : isLongTextField(key) ? (
              <textarea className="form-input" rows={3} value={values[key]} onChange={(e) => setField(key, e.target.value)} />
            ) : (
              <input type="text" className="form-input" value={values[key]} onChange={(e) => setField(key, e.target.value)} />
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
