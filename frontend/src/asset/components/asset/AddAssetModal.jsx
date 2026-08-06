// Guided "Add Asset" wizard: a 2-step modal for creating a new property, vehicle, or equipment
// asset (or editing an existing one, in which case it skips straight to step 1's field form).
//
//   Step 0 (new assets only): pick the asset class (Property / Vehicle / Heavy Equipment), with
//     an optional "Import from a spreadsheet" bulk-CSV path that bypasses the form entirely.
//   Step 1: the full field form for the chosen class (PROPERTY_WIZARD_FIELDS /
//     VEHICLE_FIELDS / EQUIPMENT_FIELDS), plus an image uploader.
//
// Editing an existing property additionally guards address changes: if any of
// address/city/state/zip/county differ from the original, a reason is required before saving
// (recorded in the activity log).

import { useState, useRef } from 'react';
import { Modal } from '../shared/Modal.jsx';
import { FieldInput } from '../shared/FieldInput.jsx';
import { PROPERTY_WIZARD_FIELDS } from '../../lib/propertyFields.js';
import { VEHICLE_FIELDS, EQUIPMENT_FIELDS, ASSET_SCHEMAS, inferAssetKind, buildAssetSnapshot } from '../../lib/vehicleFields.js';
import { nexusCsvEsc, nexusCsvParse } from '../../lib/csvExport.js';
import { normLabel, resizeImageToDataUrl } from '../../lib/format.js';

// Full ASSET_SCHEMAS lookup including the property wizard schema - vehicleFields.js's
// ASSET_SCHEMAS only covers vehicle/equipment since property has no single "the" schema outside
// this wizard (PT is a different, grouped shape used for display/inline-edit elsewhere).
const WIZARD_SCHEMAS = { ...ASSET_SCHEMAS, property: PROPERTY_WIZARD_FIELDS };

const ASSET_CLASSES = [
  ['property', 'Property / Real Estate'],
  ['vehicle', 'Vehicle'],
  ['equipment', 'Heavy Equipment'],
];

// Address-related fields checked for changes when editing a property (see addressFieldsChanged
// below) - mirrors PT's Project Details address fields.
const ADDRESS_FIELDS = [
  ['address', 'Street address'],
  ['city', 'City'],
  ['state', 'State'],
  ['zip', 'ZIP'],
  ['county', 'County'],
];

const SECTION_LABEL_STYLE = { fontSize: '0.64rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' };

/** Which address fields differ between the original row and the current draft values. */
function addressFieldsChanged(row, values) {
  if (!row) return [];
  return ADDRESS_FIELDS.filter(([key]) => String(row[key] ?? '') !== String(values[key] ?? ''));
}

/**
 * @param row          existing asset when editing, null/undefined when adding
 * @param draft        staged values when RE-opening a new (row-less) add wizard, e.g. after
 *                     backing out of the paired Item Management popup for a Heavy Equipment
 *                     asset - unlike `row`, this keeps `isAdding` true (Create Asset/CSV import
 *                     stay available) but still seeds the class + field values and skips to step 1.
 * @param properties   the full asset list (used for the parent-link picker, excluding self)
 * @param onSave       (payload, addressChangeReason?, linkInfo?, meta?) => void - meta.guided is
 *                     true only for the single-asset wizard save, not the CSV bulk-import loop
 * @param onDelete     () => void (only offered when editing)
 * @param onClose      () => void
 */
export function AddAssetModal({ row, draft, properties, onSave, onDelete, onClose }) {
  const [kind, setKind] = useState(() => draft?.kind || inferAssetKind(row));
  const [step, setStep] = useState(row || draft ? 1 : 0);
  const importInputRef = useRef(null);
  const imageInputRef = useRef(null);

  const schema = WIZARD_SCHEMAS[kind] || PROPERTY_WIZARD_FIELDS;
  const isNonPropertyAsset = kind !== 'property';
  const requiredFields = schema.filter((f) => !f.sec);
  const otherAssets = (properties || []).filter((p) => !row || p.id !== row.id);

  // Form values, seeded from `row` (or `draft`, when returning to an in-progress add) across
  // every schema's keys at once (not just the current kind's) so switching the asset-class
  // picker before saving doesn't silently drop values already typed under a different class.
  const [values, setValues] = useState(() => {
    const source = row || draft;
    const initial = { image: source?.image || '' };
    PROPERTY_WIZARD_FIELDS.concat(VEHICLE_FIELDS, EQUIPMENT_FIELDS).forEach((f) => {
      if (!f.sec) initial[f.k] = source ? source[f.k] ?? '' : '';
    });
    return initial;
  });

  const [addressChangeReason, setAddressChangeReason] = useState('');
  const [linkTargetId, setLinkTargetId] = useState(row?.parentId || '');
  const [linkRole, setLinkRole] = useState('secondary');
  const linkTargetName = otherAssets.find((p) => p.id === linkTargetId)?.name || '';

  const setField = (key, val) =>
    setValues((prev) => {
      const next = { ...prev, [key]: val };
      // Storage unit-mix fields auto-sum into unitsTotal as they're edited.
      const unitKeys = ['unitsClimate', 'unitsNonClimate', 'unitsRV'];
      if (unitKeys.includes(key)) {
        const sum = unitKeys.reduce((total, k) => total + (parseInt(String(next[k] ?? '').replace(/[^0-9]/g, ''), 10) || 0), 0);
        next.unitsTotal = String(sum);
      }
      return next;
    });

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      try {
        setField('image', await resizeImageToDataUrl(file));
      } catch {
        // unreadable image - leave field unchanged
      }
    }
    e.target.value = '';
  };

  const handleImagePaste = (e) => {
    const list = e.clipboardData?.items || [];
    for (const it of list) {
      if (it.type && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          const file = blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' });
          resizeImageToDataUrl(file)
            .then((url) => setField('image', url))
            .catch(() => {
              // unreadable image - leave field unchanged
            });
          return;
        }
      }
    }
  };

  const changedAddressFields = addressFieldsChanged(row, values);
  const needsAddressReason = kind === 'property' && changedAddressFields.length > 0;

  const save = () => {
    for (const f of requiredFields) {
      if (f.req && !String(values[f.k] || '').trim()) {
        alert('Please fill: ' + f.label);
        return;
      }
    }
    if (needsAddressReason && !addressChangeReason.trim()) {
      alert('Please give a reason for the address change.');
      return;
    }

    const payload = { image: values.image, kind };
    schema.forEach((f) => { if (!f.sec) payload[f.k] = values[f.k] ?? ''; });
    if (isNonPropertyAsset) {
      payload.assetType = kind === 'vehicle' ? 'Vehicle' : 'Heavy Equipment';
    }
    // Build the grouped snapshot for EVERY asset class, properties included. The
    // detail view reads any KEYLESS field only from asset.snapshot, so a property
    // created without one showed its keyless fields (Legal Description, Notes,
    // Construction Type, Placed-in-service/CO dates, etc.) blank even though the
    // flat values saved fine - it looked like the wizard "didn't persist." This
    // mirrors what the edit-details flow rebuilds every save (App.jsx saveDetail).
    payload.snapshot = buildAssetSnapshot(schema, values);

    // Link info is only meaningful when creating a brand-new PROPERTY (existing assets keep
    // their current parent/child relationship, managed instead through ParcelManager).
    const linkInfo = row || isNonPropertyAsset ? undefined : linkTargetId ? { targetId: linkTargetId, role: linkRole } : { role: 'none' };

    // 4th arg marks this as the guided single-add wizard (vs. the CSV bulk-import loop below,
    // which calls onSave per row without it) - callers use it to gate flows that only make sense
    // for one asset at a time, e.g. Heavy Equipment's paired Item Management popup.
    onSave(payload, needsAddressReason ? addressChangeReason.trim() : undefined, linkInfo, { guided: true });
  };

  // ---- CSV bulk-import (step 0 only) -----------------------------------------------------

  const downloadTemplate = () => {
    const fields = schema.filter((f) => !f.sec);
    const csv = fields.map((f) => nexusCsvEsc(f.label)).join(',') + '\r\n';
    // Leading BOM so Excel opens the template as UTF-8 instead of guessing a legacy codepage.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-${kind}-template.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const importCsv = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = nexusCsvParse(String(reader.result || ''));
        if (rows.length < 2) {
          alert('No data rows found. Put one asset per row under the header line.');
          return;
        }
        const headerLabels = rows[0].map((h) => normLabel(h));
        const fields = schema.filter((f) => !f.sec);
        // Map each field's key to the CSV column index whose header matches its label.
        const fieldToColumn = {};
        fields.forEach((f) => {
          const idx = headerLabels.indexOf(normLabel(f.label));
          if (idx >= 0) fieldToColumn[f.k] = idx;
        });

        let created = 0;
        let skipped = 0;
        for (let r = 1; r < rows.length; r++) {
          const row = rows[r];
          const rowValues = { image: '' };
          fields.forEach((f) => {
            const ci = fieldToColumn[f.k];
            rowValues[f.k] = ci != null && row[ci] != null ? String(row[ci]).trim() : '';
          });
          if (!String(rowValues.name || '').trim()) { skipped++; continue; }

          const payload = { ...rowValues, kind };
          if (isNonPropertyAsset) {
            payload.assetType = kind === 'vehicle' ? 'Vehicle' : 'Heavy Equipment';
            payload.snapshot = buildAssetSnapshot(schema, rowValues);
          }
          onSave(payload, undefined, undefined);
          created++;
        }

        e.target.value = '';
        alert(
          `${created} asset${created === 1 ? '' : 's'} imported` +
          (skipped ? `, ${skipped} row(s) skipped (missing name)` : '') + '.'
        );
        onClose();
      } catch {
        e.target.value = '';
        alert('Could not read that file. Use the downloaded template and keep the header row.');
      }
    };
    reader.readAsText(file);
  };

  // ---- render -----------------------------------------------------------------------------

  const isAdding = !row;
  const showLinking = isAdding && step === 1 && kind === 'property';
  const showFieldForm = row || step === 1;
  const classLabel = kind === 'property' ? 'property' : kind === 'vehicle' ? 'vehicle' : 'equipment';

  return (
    <Modal
      title={row ? `Edit ${classLabel}` : 'Add Asset'}
      wide
      onClose={onClose}
      footer={
        <>
          {row && onDelete && (
            <button
              className="secondary-btn"
              onClick={() => {
                if (window.confirm(`Delete "${row.name}"? It moves to "Recover Deleted" and can be restored later.`)) onDelete();
              }}
              style={{ marginRight: 'auto', color: 'hsl(var(--color-red))' }}
            >
              Delete
            </button>
          )}
          <button className="secondary-btn" onClick={isAdding && step === 1 ? () => setStep(0) : onClose}>
            {isAdding && step === 1 ? 'Back' : 'Cancel'}
          </button>
          <button className="primary-btn" onClick={isAdding && step === 0 ? () => setStep(1) : save}>
            {isAdding && step === 0 ? 'Continue' : row ? 'Save' : 'Create Asset'}
          </button>
        </>
      }
    >
      {/* Asset class picker - always visible, even while editing (though changing it mid-edit
          is unusual; the original leaves this enabled rather than disabling it for edits). */}
      <div style={{ marginBottom: 18, paddingBottom: 16, borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ ...SECTION_LABEL_STYLE, color: 'var(--pine)', fontSize: '0.7rem', marginBottom: 10 }}>Asset class</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {ASSET_CLASSES.map(([classKey, label]) => {
            const active = kind === classKey;
            return (
              <button
                key={classKey}
                type="button"
                onClick={() => setKind(classKey)}
                style={{
                  flex: '1 1 150px',
                  padding: '10px 12px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  border: `1.5px solid ${active ? 'var(--pine)' : 'var(--border-color)'}`,
                  backgroundColor: active ? 'var(--bg-secondary)' : 'var(--bg-card)',
                  color: active ? 'var(--pine)' : 'var(--text-secondary)',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Address-change reason banner (editing a property only). */}
      {needsAddressReason && (
        <div
          style={{
            marginBottom: 14,
            padding: '12px 14px',
            borderRadius: 10,
            border: '1px solid hsla(var(--color-gold), 0.5)',
            backgroundColor: 'hsla(var(--color-gold), 0.1)',
          }}
        >
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'hsl(var(--color-gold))', marginBottom: 6 }}>
            ⚠ You changed the address - reason required
          </div>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Changing: <strong style={{ color: 'var(--text-primary)' }}>{changedAddressFields.map(([, label]) => label).join(', ')}</strong>. A reason is recorded in the activity log.
          </div>
          <input
            className="form-input"
            autoFocus
            value={addressChangeReason}
            onChange={(e) => setAddressChangeReason(e.target.value)}
            placeholder="Why is the address being changed? (required)"
            style={{ fontSize: '0.85rem' }}
          />
        </div>
      )}

      {/* Step 1, new property only: optional link to another property (primary/secondary). */}
      {showLinking && (
        <div style={{ marginBottom: 18, paddingBottom: 16, borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ ...SECTION_LABEL_STYLE, color: 'var(--pine)', fontSize: '0.7rem', marginBottom: 10 }}>
            Linking <span style={{ textTransform: 'none', fontWeight: 400, color: 'var(--text-secondary)' }}>(optional)</span>
          </div>
          <div className="form-group">
            <label>Link this property to another</label>
            <select className="form-input" value={linkTargetId} onChange={(e) => setLinkTargetId(e.target.value)}>
              <option value="">- Standalone (not linked) -</option>
              {otherAssets.filter((p) => inferAssetKind(p) === 'property').map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          {linkTargetId && (
            <div style={{ marginTop: 12 }}>
              <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                Make this property the…
              </label>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {[
                  ['secondary', 'Secondary', `linked under "${linkTargetName}"`],
                  ['primary', 'Primary', `"${linkTargetName}" links under this`],
                ].map(([roleKey, label, desc]) => {
                  const active = linkRole === roleKey;
                  const accentColor = roleKey === 'primary' ? 'var(--pine)' : 'hsl(var(--color-purple))';
                  return (
                    <button
                      key={roleKey}
                      type="button"
                      onClick={() => setLinkRole(roleKey)}
                      style={{
                        flex: '1 1 200px',
                        textAlign: 'left',
                        padding: '11px 13px',
                        borderRadius: 10,
                        cursor: 'pointer',
                        border: `1.5px solid ${active ? accentColor : 'var(--border-color)'}`,
                        backgroundColor: active ? (roleKey === 'primary' ? 'var(--bg-secondary)' : 'hsla(var(--color-purple), 0.08)') : 'var(--bg-card)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span
                          style={{
                            width: 15,
                            height: 15,
                            borderRadius: '50%',
                            border: `2px solid ${active ? accentColor : 'var(--border-color)'}`,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {active && <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: accentColor }} />}
                        </span>
                        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: active ? accentColor : 'var(--text-primary)' }}>{label}</span>
                      </div>
                      <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 4, marginLeft: 22 }}>{desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 0: intro copy + bulk CSV import (new assets only). */}
      {isAdding && step === 0 && (
        <div style={{ padding: '14px 2px 4px' }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
            You are adding a {kind === 'property' ? 'Real Estate asset' : kind === 'vehicle' ? 'Vehicle' : 'Heavy Equipment asset'}.
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            Confirm the asset class above, then tap Continue. We ask only what matters for this type - just a Name{kind === 'property' ? ' and Address are' : ' is'} required to start.
          </div>
        </div>
      )}
      {isAdding && step === 0 && (
        <div style={{ marginTop: 4, marginBottom: 18, padding: '13px 14px', borderRadius: 10, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 3 }}>
            Have several? Import from a spreadsheet
          </div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 10 }}>
            Download the template for this asset class, fill one row per asset, then import it.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" onClick={downloadTemplate} style={{ fontSize: '0.8rem', padding: '7px 13px' }}>
              Download CSV Template
            </button>
            <button type="button" className="secondary-btn" onClick={() => importInputRef.current && importInputRef.current.click()} style={{ fontSize: '0.8rem', padding: '7px 13px' }}>
              Import CSV
            </button>
            <input ref={importInputRef} type="file" accept=".csv,text/csv" onChange={importCsv} style={{ display: 'none' }} />
          </div>
        </div>
      )}

      {/* Step 1 (or editing): the full field form for the selected asset class. */}
      {showFieldForm && (
        <div className="form-grid">
          {schema.filter((f) => f.k !== 'parentId').map((f, i) =>
            f.sec ? (
              <div key={'sec' + i} style={{ ...SECTION_LABEL_STYLE, gridColumn: '1 / -1', marginTop: i ? 8 : 0, color: 'var(--pine)', fontSize: '0.7rem' }}>
                {f.sec}
              </div>
            ) : (
              <FieldInput key={f.k} f={f} value={values[f.k]} onChange={setField} />
            )
          )}
        </div>
      )}

      {/* Step 1 (or editing): image uploader. */}
      {showFieldForm && (
        <div onPaste={handleImagePaste} tabIndex={0} style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-color)', outline: 'none' }}>
          <div style={{ ...SECTION_LABEL_STYLE, color: 'var(--pine)', fontSize: '0.7rem', marginBottom: 10 }}>Image</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {values.image ? (
              <img
                src={values.image}
                alt=""
                style={{ width: 120, height: 78, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border-color)', flexShrink: 0 }}
              />
            ) : (
              <div
                style={{
                  width: 120,
                  height: 78,
                  borderRadius: 8,
                  border: '1px dashed var(--border-color)',
                  backgroundColor: 'var(--bg-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: '0.72rem',
                  flexShrink: 0,
                }}
              >
                No image
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <button className="secondary-btn" onClick={() => imageInputRef.current?.click()} style={{ fontSize: '0.78rem', padding: '7px 14px' }}>
                {values.image ? 'Change Image' : 'Upload Image'}
              </button>
              {values.image && (
                <button className="secondary-btn" onClick={() => setField('image', '')} style={{ fontSize: '0.78rem', padding: '7px 14px', color: 'hsl(var(--color-red))' }}>
                  Remove
                </button>
              )}
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>or press Ctrl+V to paste a screenshot</span>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Shown on the asset card and detail.</span>
            </div>
            <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImageUpload} style={{ display: 'none' }} />
          </div>
        </div>
      )}
    </Modal>
  );
}
