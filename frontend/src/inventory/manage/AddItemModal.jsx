// Item Management - Add Item (also borrowed by Asset Management and Purchase Requests).
// A sheet from the right (Items redesign, Neil 11/02/2026), with the unit's
// own Serial (blank = the next GG-#####) and, where the caller allows it,
// "Save and Add Another" - it keeps the type, department and location for the
// next unit. Many items at once: Import CSV. The AI photo finder shows only
// when AI is on for the server.
import { useState } from 'react';
import { Plus, ArrowLeft } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { ITEM_TYPES, DEPARTMENTS } from '../model/status';
import { useAiEnabled } from '../model/useAiEnabled';
import { PhotoUpload } from '../ui/photos';
import { ItemSheet, LABEL, HINT, ERROR } from '../ui/Sheet';

const LOCKED_FIELD_STYLE = { backgroundColor: 'var(--mist)', color: 'var(--muted)', cursor: 'not-allowed' };
const NOTE = { fontWeight: 500, color: 'var(--muted)' };
const CHECK = { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1.45 };

// lockedFields: keys carried over from another form (e.g. the Heavy Equipment wizard) that
// duplicate a value already captured there - shown read-only so the two records can't drift.
export function AddItemModal({ onClose, onSave, initial = {}, types = ITEM_TYPES, lockedFields = [], onBack, allowAddAnother = false, zIndex }) {
  const isLocked = (key) => lockedFields.includes(key);
  const aiOn = useAiEnabled();
  const [name,          setName]          = useState(initial.name || '');
  const [serial,        setSerial]        = useState(initial.serialNumber || '');
  const [itemType,      setItemType]      = useState(initial.itemType || 'Tools');
  const [make,          setMake]          = useState(initial.make || '');
  const [model,         setModel]         = useState(initial.model || '');
  const [year,          setYear]          = useState(initial.year || '');
  const [department,    setDepartment]    = useState(initial.department || '');
  // The owner defaults to the department (Neil).
  const [defaultOwner,  setDefaultOwner]  = useState(initial.department || '');
  const [ownershipType, setOwnershipType] = useState(initial.ownershipType || 'transient');
  const [location,      setLocation]      = useState(initial.location || '');
  const [photoUrl,      setPhotoUrl]      = useState('');
  const [skipPhoto,     setSkipPhoto]     = useState(false);
  const [pictureRequired, setPictureRequired] = useState(true);
  const [assetValue,    setAssetValue]    = useState(initial.assetValue != null ? String(initial.assetValue) : '');
  const [assignNow,     setAssignNow]     = useState(false);
  const [aiFill,        setAiFill]        = useState(true);
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState('');
  const [added,         setAdded]         = useState(0);

  function handleDeptChange(d) { setDepartment(d); setDefaultOwner(d); }

  const ready = !!name.trim() && (!!photoUrl || skipPhoto) && !!department.trim() && !!location.trim() && !saving;

  function submit(another = false) {
    if (!ready) return;
    setSaving(true); setError('');
    Promise.resolve(onSave({
      name: name.trim(), serial_number: serial.trim(), item_type: itemType, make: make.trim(), model: model.trim(),
      year: year.trim(), department: department.trim(), default_owner: defaultOwner.trim(),
      ownership_type: ownershipType, location: location.trim(), photo_url: photoUrl,
      picture_required: pictureRequired, asset_value: parseFloat(assetValue) || 0,
    }, { assignNow: !another && ownershipType === 'permanent' && assignNow, aiFill: aiOn && !photoUrl && skipPhoto && aiFill }))
      .then(() => {
        if (!another) { onClose(); return; }
        // The next unit: keep the type, department, owner and location.
        setAdded(n => n + 1);
        setName(''); setSerial(''); setMake(''); setModel(''); setYear(''); setPhotoUrl(''); setSkipPhoto(false); setAssetValue('');
        setSaving(false);
      })
      .catch(err => { setError(err?.message || 'Could not add the item - please try again.'); setSaving(false); });
  }

  const dirty = !!(name.trim() || serial.trim() || make.trim() || model.trim() || photoUrl);
  const lockNote = (k) => isLocked(k) ? <span style={NOTE}> · from the asset details</span> : null;

  return (
    <ItemSheet zIndex={zIndex} onClose={() => { if (!saving) onClose(); }} isDirty={dirty}
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {onBack && (
          <button type="button" onClick={onBack} disabled={saving} aria-label="Back to asset details" title="Back to asset details"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: 'var(--muted)' }}>
            <ArrowLeft size={18} />
          </button>
        )}
        Add Item
      </span>}
      footer={<>
        {added > 0 && <span style={{ marginRight: 'auto', fontSize: 13, color: 'var(--muted)' }}>{added} added so far</span>}
        <button className="secondary-btn" onClick={onClose} disabled={saving}>{added ? 'Done' : 'Cancel'}</button>
        {allowAddAnother && (
          <button className="secondary-btn" disabled={!ready} onClick={() => submit(true)}>Save and Add Another</button>
        )}
        <button className="primary-btn" disabled={!ready} onClick={() => submit(false)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {saving ? <><Spinner size={14} /> Saving…</> : <><Plus size={14} /> Add Item</>}
        </button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 12 }}>
          <div>
            <label style={LABEL} htmlFor="add-name">Name{lockNote('name')}</label>
            <input id="add-name" className="form-input" style={{ width: '100%', ...(isLocked('name') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('name')} autoFocus={!isLocked('name')} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. DeWalt 20V Cordless Drill" />
          </div>
          <div>
            <label style={LABEL} htmlFor="add-serial">Serial <span style={NOTE}>(optional)</span></label>
            <input id="add-serial" className="form-input" style={{ width: '100%' }} value={serial} onChange={e => setSerial(e.target.value)} placeholder="Blank = next GG number" />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <div>
            <label style={LABEL} htmlFor="add-type">Type{lockNote('itemType')}</label>
            <select id="add-type" className="form-input" style={{ width: '100%', ...(isLocked('itemType') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('itemType')} value={itemType} onChange={e => setItemType(e.target.value)}>
              {[...new Set([...types, itemType].filter(Boolean))].map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={LABEL} htmlFor="add-own">Ownership</label>
            <select id="add-own" className="form-input" style={{ width: '100%' }} value={ownershipType} onChange={e => setOwnershipType(e.target.value)}>
              <option value="transient">Temporary (borrowed and returned)</option>
              <option value="permanent">Permanent (stays assigned)</option>
            </select>
          </div>
        </div>

        {ownershipType === 'permanent' && (
          <label style={CHECK}>
            <input type="checkbox" checked={assignNow} onChange={e => setAssignNow(e.target.checked)} style={{ cursor: 'pointer', accentColor: 'var(--wk-brand)', marginTop: 2 }} />
            <span><strong style={{ color: 'var(--ink)' }}>Assign to a person right away</strong> - pick who after saving. Otherwise it stays unassigned until you assign it.</span>
          </label>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) 90px', gap: 12 }}>
          <div>
            <label style={LABEL} htmlFor="add-make">Make{lockNote('make')}</label>
            <input id="add-make" className="form-input" style={{ width: '100%', ...(isLocked('make') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('make')} value={make} onChange={e => setMake(e.target.value)} placeholder="e.g. DeWalt" />
          </div>
          <div>
            <label style={LABEL} htmlFor="add-model">Model{lockNote('model')}</label>
            <input id="add-model" className="form-input" style={{ width: '100%', ...(isLocked('model') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('model')} value={model} onChange={e => setModel(e.target.value)} placeholder="e.g. DCD777C2" />
          </div>
          <div>
            <label style={LABEL} htmlFor="add-year">Year</label>
            <input id="add-year" className="form-input" style={{ width: '100%', ...(isLocked('year') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('year')} value={year} onChange={e => setYear(e.target.value)} placeholder="2023" />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <div>
            <label style={LABEL} htmlFor="add-dept">Department{lockNote('department')}</label>
            <input id="add-dept" className="form-input datalist-input" style={{ width: '100%', ...(isLocked('department') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('department')} list="add-item-depts" value={department} onChange={e => handleDeptChange(e.target.value)} placeholder="e.g. Construction" />
            <datalist id="add-item-depts">{DEPARTMENTS.filter(d => d !== 'All').map(d => <option key={d} value={d} />)}</datalist>
          </div>
          <div>
            <label style={LABEL} htmlFor="add-owner">Owner <span style={NOTE}>· defaults to the department</span></label>
            <input id="add-owner" className="form-input" style={{ width: '100%' }} value={defaultOwner} onChange={e => setDefaultOwner(e.target.value)} placeholder="Defaults to the department" />
          </div>
          <div>
            <label style={LABEL} htmlFor="add-loc">Location{lockNote('location')}</label>
            <input id="add-loc" className="form-input" style={{ width: '100%', ...(isLocked('location') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('location')} value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Austin Yard" />
          </div>
          <div>
            <label style={LABEL} htmlFor="add-value">Asset Value ($)</label>
            <input id="add-value" className="form-input" type="number" min="0" step="0.01" style={{ width: '100%' }} value={assetValue} onChange={e => setAssetValue(e.target.value)} placeholder="e.g. 1200" />
          </div>
        </div>

        <label style={CHECK}>
          <input type="checkbox" checked={pictureRequired} onChange={e => setPictureRequired(e.target.checked)} style={{ cursor: 'pointer', accentColor: 'var(--wk-brand)', marginTop: 2 }} />
          <span><strong style={{ color: 'var(--ink)' }}>Require photos at handover and return</strong> - untick for items like keys, where a photo adds nothing.</span>
        </label>

        <PhotoUpload value={photoUrl} onChange={setPhotoUrl} required={!skipPhoto} hint="A clear photo of this exact unit." />
        {!photoUrl && (
          <label style={CHECK}>
            <input type="checkbox" checked={skipPhoto} onChange={e => setSkipPhoto(e.target.checked)} style={{ cursor: 'pointer', accentColor: 'var(--wk-brand)', marginTop: 2 }} />
            <span><strong style={{ color: 'var(--ink)' }}>Add without a photo for now</strong> - it shows under Missing Photo on Inventory until one is added.</span>
          </label>
        )}
        {aiOn && !photoUrl && skipPhoto && (
          <label style={CHECK}>
            <input type="checkbox" checked={aiFill} onChange={e => setAiFill(e.target.checked)} style={{ cursor: 'pointer', accentColor: 'var(--wk-brand)', marginTop: 2 }} />
            <span><strong style={{ color: 'var(--ink)' }}>Find a product photo after saving</strong> - uses the make and model; replace it with a real photo when you can.</span>
          </label>
        )}
        {allowAddAnother && <p style={HINT}>Adding a lot of items? Import CSV on Inventory takes a whole spreadsheet at once.</p>}
        {error && <p style={ERROR}>{error}</p>}
      </div>
    </ItemSheet>
  );
}
