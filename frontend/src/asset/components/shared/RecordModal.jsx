import { useState } from 'react';
import { Modal } from './Modal.jsx';
import { FieldInput, requiredErrors } from './FieldInput.jsx';
import { RECORD_TYPES } from '../../lib/recordTypes.jsx';
import { warrantyTermMonths } from '../../lib/warrantyTerm.js';

/** Builds the initial form-state object for a record-type's field list: one entry per
 *  non-section field, seeded from `row` when editing or blank when adding. */
function useInitialFormState(fields, row) {
  const initial = {};
  fields.forEach((f) => {
    if (!f.sec) initial[f.k] = row ? row[f.k] ?? '' : '';
  });
  return useState(initial);
}

/**
 * Generic Add/Edit modal for any RECORD_TYPES collection (maintenance, vservice, warranties,
 * inspections, documents, ahj, utilities, vendors, odometer, vdocs). Renders one FieldInput per
 * configured field in a 2-column grid, validates `req` fields on save, and offers a Remove
 * action (with an optional required-reason step) when editing an existing row.
 *
 * `active` is the asset (property/vehicle/equipment) this record belongs to - only used for the
 * maintenance multi-tenant Unit/Suite injection below.
 */
export function RecordModal({ coll, row, canDelete = true, requireReason = false, onSave, onDelete, onClose, active }) {
  const recordType = RECORD_TYPES[coll];

  // Multi-tenant support: when logging MAINTENANCE against a property that has named
  // tenant units/suites (active.tenantUnits), inject a synthetic "Unit / Suite" select field
  // right after Date and System/Area (i.e. as fields[2]), so each maintenance entry can be
  // attributed to a specific unit or left as a shared "Common Area / Whole Property" item.
  // This is NOT stored in the record-type config itself because it's conditional on the
  // specific property, not the collection in general - plain properties/vehicles/equipment
  // never see this field.
  const fields =
    coll === 'maintenance' && active && (active.tenantUnits || []).length
      ? [
          recordType.fields[0],
          recordType.fields[1],
          {
            k: 'unit',
            label: 'Unit / Suite',
            type: 'select',
            options: ['Common Area / Whole Property', ...active.tenantUnits.map((u) => u.label)],
          },
          ...recordType.fields.slice(2),
        ]
      : recordType.fields;

  const [values, setValues] = useInitialFormState(fields, row);
  const [initialValues] = useState(values);
  const dirty = JSON.stringify(values) !== JSON.stringify(initialValues);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removeReason, setRemoveReason] = useState('');
  const isWarranty = coll === 'warranties';

  const handleChange = (key, val) =>
    setValues((prev) => {
      const next = { ...prev, [key]: val };
      // Warranties auto-derive their term length from start/expiration whenever either changes.
      if (isWarranty && (key === 'startDate' || key === 'expiration')) {
        next.termMonths = warrantyTermMonths(next.startDate, next.expiration);
      }
      return next;
    });

  const [errors, setErrors] = useState({});
  const [removeError, setRemoveError] = useState('');
  const missing = Object.keys(errors).length;
  const handleSave = () => {
    const next = requiredErrors(fields, values);
    setErrors(next);
    if (Object.keys(next).length) return;
    onSave(isWarranty ? { ...values, termMonths: warrantyTermMonths(values.startDate, values.expiration) } : values);
  };

  const footer = confirmingRemove ? (
    <>
      <button
        className="secondary-btn"
        onClick={() => {
          setConfirmingRemove(false);
          setRemoveReason('');
        }}
      >
        Cancel
      </button>
      <button
        className="primary-btn"
        onClick={() => {
          if (requireReason && !removeReason.trim()) {
            setRemoveError('A reason is required.');
            return;
          }
          onDelete(removeReason.trim());
        }}
        style={{ backgroundColor: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}
      >
        Confirm Remove
      </button>
    </>
  ) : (
    <>
      {row && canDelete && (
        <button
          className="secondary-btn"
          onClick={() => {
            setConfirmingRemove(true);
          }}
          style={{ marginRight: 'auto', color: 'hsl(var(--color-red))' }}
        >
          Remove
        </button>
      )}
      {missing > 0 && (
        <span role="status" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'hsl(var(--color-red))', marginRight: 'auto' }}>
          {missing} required {missing === 1 ? 'field' : 'fields'} missing
        </span>
      )}
      <button className="secondary-btn" onClick={onClose}>
        Cancel
      </button>
      <button className="primary-btn" onClick={handleSave}>
        Save
      </button>
    </>
  );

  return (
    <Modal title={(row ? 'Edit ' : 'Add ') + recordType.title} onClose={onClose} footer={footer}
      isDirty={dirty && !confirmingRemove} onSave={handleSave}>
      {confirmingRemove && (
        <div
          style={{
            marginBottom: 14,
            padding: '12px 14px',
            borderRadius: 10,
            border: '1px solid hsla(var(--color-red), 0.4)',
            backgroundColor: 'hsla(var(--color-red), 0.08)',
          }}
        >
          <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: requireReason ? 8 : 0 }}>
            Remove this {recordType.title.toLowerCase()}?{requireReason ? '' : ' It leaves the record for good.'}
          </div>
          {requireReason && (
            <>
              <label htmlFor="record-remove-reason" style={{ fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                Reason for removing this {recordType.title.toLowerCase()} <span style={{ color: 'hsl(var(--color-red))' }}>*</span>
              </label>
              <textarea
                id="record-remove-reason"
                className="form-input"
                rows={2}
                autoFocus
                value={removeReason}
                onChange={(e) => { setRemoveReason(e.target.value); if (removeError) setRemoveError(''); }}
                placeholder={`Why is this ${recordType.title.toLowerCase()} being removed?`}
                aria-invalid={removeError ? true : undefined}
                style={{ fontSize: '0.85rem', ...(removeError ? { borderColor: 'hsl(var(--color-red))' } : {}) }}
              />
              {removeError && <div role="alert" style={{ fontSize: '0.76rem', fontWeight: 600, color: 'hsl(var(--color-red))', marginTop: 4 }}>{removeError}</div>}
            </>
          )}
        </div>
      )}
      <div className="form-grid">
        {fields.map((f) => (
          <FieldInput
            key={f.k}
            f={f}
            value={isWarranty && f.k === 'termMonths' ? warrantyTermMonths(values.startDate, values.expiration) : values[f.k]}
            onChange={(k, v) => { handleChange(k, v); if (errors[k]) setErrors((e) => { const n = { ...e }; delete n[k]; return n; }); }}
            error={errors[f.k]}
          />
        ))}
      </div>
    </Modal>
  );
}
