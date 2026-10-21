// "Add Asset" - one screen (Oct 2026): pick the class, give the asset a name and an
// address, choose its type and stage, Create. Everything else is filled on the
// asset itself (the Overview's Data Gaps card lists what is still empty), so the
// old two-step wizard with the full forty-field form is gone. Linking a new
// property under another one is behind "Advanced".
//
// `mode="import"` (the portfolio's "Import From a Spreadsheet") is the bulk CSV
// path: the class picker, the template download and the file picker, no form.
//
// Editing an existing asset no longer goes through this modal - the spec sheet
// and the Overview edit in place.

import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Modal } from '../shared/Modal.jsx';
import { FieldInput, requiredErrors } from '../shared/FieldInput.jsx';
import { pushToast } from '../shared/ToastHost.jsx';
import { PROPERTY_WIZARD_FIELDS, ASSET_TYPE_OPTIONS, DEV_STAGE_OPTIONS } from '../../lib/propertyFields.js';
import { VEHICLE_FIELDS, EQUIPMENT_FIELDS, ASSET_SCHEMAS, inferAssetKind, buildAssetSnapshot } from '../../lib/vehicleFields.js';
import { nexusCsvEsc, nexusCsvParse } from '../../lib/csvExport.js';
import { normLabel } from '../../lib/format.js';
import { splitAddress } from '../../lib/dataNormalization.js';

// Full ASSET_SCHEMAS lookup including the property wizard schema - vehicleFields.js's
// ASSET_SCHEMAS only covers vehicle/equipment since property has no single "the" schema outside
// this wizard (PT is a different, grouped shape used for display/inline-edit elsewhere).
const WIZARD_SCHEMAS = { ...ASSET_SCHEMAS, property: PROPERTY_WIZARD_FIELDS };

const ASSET_CLASSES = [
  ['property', 'Property / Real Estate'],
  ['vehicle', 'Vehicle'],
  ['equipment', 'Heavy Equipment'],
];

// The type list is filtered by class: a property is never a Vehicle or Heavy Equipment.
const PROPERTY_TYPES = ASSET_TYPE_OPTIONS.filter((t) => t !== 'Vehicle' && t !== 'Heavy Equipment');

// The fields asked on the one screen, per class. The address is ONE field here
// ("Street, City, ST ZIP"); splitAddress peels the tail into city / state / zip.
const CREATE_FIELDS = {
  property: [
    { k: 'name', label: 'Name', req: true, full: true },
    { k: 'address', label: 'Address', req: true, full: true, placeholder: 'Street, City, ST ZIP' },
    { k: 'assetType', label: 'Asset Type', type: 'select', options: PROPERTY_TYPES },
    { k: 'devStage', label: 'Development Stage', type: 'select', options: DEV_STAGE_OPTIONS },
  ],
  vehicle: [
    { k: 'name', label: 'Asset Name / Unit #', req: true, full: true },
    { k: 'make', label: 'Make' },
    { k: 'model', label: 'Model' },
    { k: 'address', label: 'Home Base / Location', full: true },
  ],
  equipment: [
    { k: 'name', label: 'Asset Name / Unit #', req: true, full: true },
    { k: 'make', label: 'Make' },
    { k: 'model', label: 'Model' },
    { k: 'address', label: 'Home Base / Location', full: true },
  ],
};

const SECTION_LABEL_STYLE = { fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--pine)' };

/**
 * @param draft        staged values when RE-opening the add screen, e.g. after backing out
 *                     of the paired Item Management popup for a Heavy Equipment asset -
 *                     seeds the class + field values.
 * @param properties   the full asset list (used for the parent-link picker)
 * @param mode         'add' (default) or 'import' (CSV bulk import only)
 * @param onSave       (payload, addressChangeReason?, linkInfo?, meta?) => void - meta.guided is
 *                     true only for the single-asset create, not the CSV bulk-import loop
 * @param onClose      () => void
 */
export function AddAssetModal({ draft, properties, mode = 'add', onSave, onClose }) {
  const importing = mode === 'import';
  const [kind, setKind] = useState(() => draft?.kind || inferAssetKind(draft) || 'property');
  const importInputRef = useRef(null);

  const schema = WIZARD_SCHEMAS[kind] || PROPERTY_WIZARD_FIELDS;
  const isNonPropertyAsset = kind !== 'property';
  const createFields = CREATE_FIELDS[kind] || CREATE_FIELDS.property;
  const otherProperties = (properties || []).filter((p) => inferAssetKind(p) === 'property');

  // Form values across every schema's keys at once so switching the class before
  // saving does not drop what was typed under another class.
  const [values, setValues] = useState(() => {
    const initial = { image: draft?.image || '' };
    PROPERTY_WIZARD_FIELDS.concat(VEHICLE_FIELDS, EQUIPMENT_FIELDS).forEach((f) => {
      if (!f.sec) initial[f.k] = draft ? draft[f.k] ?? '' : '';
    });
    return initial;
  });
  const [initialValues] = useState(values);
  const [errors, setErrors] = useState({});
  const [advanced, setAdvanced] = useState(!!draft?.parentId);
  const [linkTargetId, setLinkTargetId] = useState(draft?.parentId || '');
  const [linkRole, setLinkRole] = useState('secondary');
  const linkTargetName = otherProperties.find((p) => p.id === linkTargetId)?.name || '';

  const setField = (key, val) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    if (errors[key]) setErrors((e) => { const n = { ...e }; delete n[key]; return n; });
  };

  const dirty = !importing && (JSON.stringify(values) !== JSON.stringify(initialValues) || linkTargetId !== (draft?.parentId || ''));

  const save = () => {
    const next = requiredErrors(createFields, values);
    setErrors(next);
    if (Object.keys(next).length) return;

    const payload = { image: values.image, kind };
    schema.forEach((f) => { if (!f.sec) payload[f.k] = values[f.k] ?? ''; });
    if (isNonPropertyAsset) payload.assetType = kind === 'vehicle' ? 'Vehicle' : 'Heavy Equipment';
    // The detail view reads any KEYLESS field only from asset.snapshot, so every
    // class gets one (empty fields included) - mirrors App.jsx saveDetail.
    const row = kind === 'property' ? splitAddress(payload) : payload;
    row.snapshot = buildAssetSnapshot(schema, { ...values, address: row.address, city: row.city, state: row.state, zip: row.zip, county: row.county });

    // Link info only means something for a brand-new PROPERTY (vehicles and equipment
    // never link; existing assets manage links through ParcelManager).
    const linkInfo = isNonPropertyAsset ? undefined : linkTargetId ? { targetId: linkTargetId, role: linkRole } : { role: 'none' };
    onSave(row, undefined, linkInfo, { guided: true });
  };

  // ---- CSV bulk import (mode="import") ----------------------------------------------------

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
          pushToast?.('No data rows found. Put one asset per row under the header line.', 'bad');
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
          if (isNonPropertyAsset) payload.assetType = kind === 'vehicle' ? 'Vehicle' : 'Heavy Equipment';
          payload.snapshot = buildAssetSnapshot(schema, rowValues);
          onSave(kind === 'property' ? splitAddress(payload) : payload, undefined, undefined);
          created++;
        }

        e.target.value = '';
        pushToast?.(
          `${created} asset${created === 1 ? '' : 's'} imported` +
          (skipped ? `, ${skipped} row(s) skipped (missing name)` : '') + '.', 'ok'
        );
        onClose();
      } catch {
        e.target.value = '';
        pushToast?.('Could not read that file. Use the downloaded template and keep the header row.', 'bad');
      }
    };
    reader.readAsText(file);
  };

  // ---- render -----------------------------------------------------------------------------

  const classPicker = (
    <div style={{ marginBottom: 18 }}>
      <div style={{ ...SECTION_LABEL_STYLE, marginBottom: 10 }}>Asset Class</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {ASSET_CLASSES.map(([classKey, label]) => {
          const active = kind === classKey;
          return (
            <button
              key={classKey}
              type="button"
              onClick={() => setKind(classKey)}
              aria-pressed={active}
              style={{
                flex: '1 1 150px',
                padding: '10px 12px',
                borderRadius: 10,
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: 700,
                fontFamily: 'inherit',
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
  );

  if (importing) {
    return (
      <Modal
        title="Import From a Spreadsheet"
        onClose={onClose}
        footer={<button className="secondary-btn" onClick={onClose}>Close</button>}
      >
        {classPicker}
        <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 14 }}>
          Download the template for this asset class, fill one row per asset, then import it. Rows without a name are skipped.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="secondary-btn" onClick={downloadTemplate}>Download CSV Template</button>
          <button type="button" className="primary-btn" onClick={() => importInputRef.current && importInputRef.current.click()}>Import CSV</button>
          <input ref={importInputRef} type="file" accept=".csv,text/csv" onChange={importCsv} style={{ display: 'none' }} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Add Asset"
      onClose={onClose}
      isDirty={dirty}
      onSave={save}
      footer={
        <>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={save}>Create Asset</button>
        </>
      }
    >
      {classPicker}

      <div className="form-grid">
        {createFields.map((f) => (
          <FieldInput key={f.k} f={f} value={values[f.k]} error={errors[f.k]} onChange={setField} />
        ))}
      </div>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 10, lineHeight: 1.5 }}>
        Everything else - ownership, size, financials, insurance, photos - is filled on the asset. Its Overview lists what is still empty.
      </div>

      {!isNonPropertyAsset && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-color)' }}>
          <button
            type="button"
            onClick={() => setAdvanced((a) => !a)}
            aria-expanded={advanced}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', ...SECTION_LABEL_STYLE }}
          >
            {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Advanced
            <span style={{ textTransform: 'none', fontWeight: 400, letterSpacing: 0, color: 'var(--text-secondary)' }}>- link this property to another</span>
          </button>
          {advanced && (
            <div style={{ marginTop: 12 }}>
              <div className="form-group">
                <label htmlFor="add-asset-link">Link this property to another</label>
                <select id="add-asset-link" className="form-input" value={linkTargetId} onChange={(e) => setLinkTargetId(e.target.value)}>
                  <option value="">- Standalone (not linked) -</option>
                  {otherProperties.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              {linkTargetId && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>Make this property the…</div>
                  <div role="radiogroup" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
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
                          role="radio"
                          aria-checked={active}
                          onClick={() => setLinkRole(roleKey)}
                          style={{
                            flex: '1 1 200px',
                            textAlign: 'left',
                            padding: '11px 13px',
                            borderRadius: 10,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            border: `1.5px solid ${active ? accentColor : 'var(--border-color)'}`,
                            backgroundColor: active ? (roleKey === 'primary' ? 'var(--bg-secondary)' : 'hsla(var(--color-purple), 0.08)') : 'var(--bg-card)',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                            <span style={{ width: 15, height: 15, borderRadius: '50%', border: `2px solid ${active ? accentColor : 'var(--border-color)'}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
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
        </div>
      )}
    </Modal>
  );
}
