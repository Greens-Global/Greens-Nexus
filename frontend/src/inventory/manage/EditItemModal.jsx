// Item Management - Edit an item. A sheet from the right (Items redesign,
// Neil 11/02/2026). The lifecycle (Available / Checked Out / Assigned) is not
// hand-edited any more - it follows the checkouts and assignments, and a
// stuck checkout is fixed with Reconcile on the item record. The AI photo
// finder shows only when AI is on for the server.
import { useState } from 'react';
import { Wand2 } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { ITEM_TYPES, OP_STATUSES, OP_STATUS_META, OP_STATUS_PERSON, DEPARTMENTS } from '../model/status';
import { useAiEnabled } from '../model/useAiEnabled';
import { PhotoUpload } from '../ui/photos';
import { PersonTypeahead } from '../ui/PersonTypeahead';
import { ItemSheet, LABEL, ERROR } from '../ui/Sheet';

const NOTE = { fontWeight: 500, color: 'var(--muted)' };

export function EditItemModal({ item, onClose, onSave, types = ITEM_TYPES, zIndex }) {
  const aiOn = useAiEnabled();
  const [name,          setName]          = useState(item.name);
  const [itemType,      setItemType]      = useState(item.itemType || 'Other');
  const [make,          setMake]          = useState(item.make || '');
  const [model,         setModel]         = useState(item.model || '');
  const [year,          setYear]          = useState(item.year || '');
  const [department,    setDepartment]    = useState(item.department || '');
  const [defaultOwner,  setDefaultOwner]  = useState(item.defaultOwner || '');
  const [ownershipType, setOwnershipType] = useState(item.ownershipType || 'transient');
  const [opStatus,      setOpStatus]      = useState(item.opStatus || '');
  const [opPersonEmail, setOpPersonEmail] = useState(item.opStatusPersonEmail || '');
  const [opPersonName,  setOpPersonName]  = useState(item.opStatusPersonName  || '');
  const [location,      setLocation]      = useState(item.location || '');
  const [photoUrl,      setPhotoUrl]      = useState(item.photoUrl || '');
  const [pictureRequired, setPictureRequired] = useState(item.pictureRequired !== false);
  const [assetValue,    setAssetValue]    = useState(item.assetValue ? String(item.assetValue) : '');
  const [saving,        setSaving]        = useState(false);
  const [aiFilling,     setAiFilling]     = useState(false);
  const [error,         setError]         = useState('');

  async function aiFindPhoto() {
    setAiFilling(true); setError('');
    try {
      const { results } = await api.autoFillItemPhotos([item.id], true);  // replace allowed when editing
      const r = (results || [])[0];
      if (r?.status === 'ok' && r.photo_url) setPhotoUrl(r.photo_url);
      else setError('No product photo found - upload one manually.');
    } catch {
      setError('AI photo search failed - try again or upload manually.');
    } finally {
      setAiFilling(false);
    }
  }

  function submit() {
    if (!name.trim() || saving) return;
    setSaving(true); setError('');
    Promise.resolve(onSave({
      name: name.trim(), item_type: itemType, make: make.trim(), model: model.trim(),
      year: year.trim(), department: department.trim(), default_owner: defaultOwner.trim(),
      ownership_type: ownershipType, op_status: opStatus, location: location.trim(), photo_url: photoUrl,
      op_status_person_email: opPersonEmail, op_status_person_name: opPersonName,
      picture_required: pictureRequired, asset_value: parseFloat(assetValue) || 0,
    }))
      .then(onClose)
      .catch(err => setError(err?.message || 'Could not save changes.'))
      .finally(() => setSaving(false));
  }

  const dirty = name !== item.name || itemType !== (item.itemType || 'Other') || make !== (item.make || '')
    || model !== (item.model || '') || year !== (item.year || '') || department !== (item.department || '')
    || defaultOwner !== (item.defaultOwner || '') || ownershipType !== (item.ownershipType || 'transient')
    || opStatus !== (item.opStatus || '')
    || opPersonEmail !== (item.opStatusPersonEmail || '') || opPersonName !== (item.opStatusPersonName || '')
    || location !== (item.location || '') || photoUrl !== (item.photoUrl || '')
    || pictureRequired !== (item.pictureRequired !== false)
    || assetValue !== (item.assetValue ? String(item.assetValue) : '');

  return (
    <ItemSheet title={`Edit ${item.name}`} onClose={() => { if (!saving) onClose(); }} isDirty={dirty} onSave={name.trim() ? submit : undefined} zIndex={zIndex}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="primary-btn" disabled={!name.trim() || saving} onClick={submit} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {saving ? <><Spinner size={14} /> Saving…</> : 'Save Changes'}
        </button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={LABEL} htmlFor="edit-name">Name</label>
          <input id="edit-name" className="form-input" style={{ width: '100%' }} value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <div>
            <label style={LABEL} htmlFor="edit-type">Type</label>
            <select id="edit-type" className="form-input" style={{ width: '100%' }} value={itemType} onChange={e => setItemType(e.target.value)}>
              {/* keep the item's own type even if it is a custom imported one */}
              {[...new Set([...types, itemType].filter(Boolean))].map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={LABEL} htmlFor="edit-own">Ownership</label>
            <select id="edit-own" className="form-input" style={{ width: '100%' }} value={ownershipType} onChange={e => setOwnershipType(e.target.value)}>
              <option value="transient">Temporary</option>
              <option value="permanent">Permanent</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) 90px', gap: 12 }}>
          <div>
            <label style={LABEL} htmlFor="edit-make">Make</label>
            <input id="edit-make" className="form-input" style={{ width: '100%' }} value={make} onChange={e => setMake(e.target.value)} />
          </div>
          <div>
            <label style={LABEL} htmlFor="edit-model">Model</label>
            <input id="edit-model" className="form-input" style={{ width: '100%' }} value={model} onChange={e => setModel(e.target.value)} />
          </div>
          <div>
            <label style={LABEL} htmlFor="edit-year">Year</label>
            <input id="edit-year" className="form-input" style={{ width: '100%' }} value={year} onChange={e => setYear(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <div>
            <label style={LABEL} htmlFor="edit-dept">Department</label>
            <input id="edit-dept" className="form-input" style={{ width: '100%' }} list="edit-item-depts" value={department}
              onChange={e => { const d = e.target.value; setDepartment(d); if (!defaultOwner || defaultOwner === department) setDefaultOwner(d); }} />
            <datalist id="edit-item-depts">{DEPARTMENTS.filter(d => d !== 'All').map(d => <option key={d} value={d} />)}</datalist>
          </div>
          <div>
            <label style={LABEL} htmlFor="edit-owner">Owner <span style={NOTE}>· defaults to the department</span></label>
            <input id="edit-owner" className="form-input" style={{ width: '100%' }} value={defaultOwner} onChange={e => setDefaultOwner(e.target.value)} />
          </div>
          <div>
            <label style={LABEL} htmlFor="edit-loc">Location</label>
            <input id="edit-loc" className="form-input" style={{ width: '100%' }} value={location} onChange={e => setLocation(e.target.value)} />
          </div>
          <div>
            <label style={LABEL} htmlFor="edit-value">Asset Value ($)</label>
            <input id="edit-value" className="form-input" type="number" min="0" step="0.01" style={{ width: '100%' }} value={assetValue} onChange={e => setAssetValue(e.target.value)} placeholder="e.g. 1200" />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <div>
            <label style={LABEL} htmlFor="edit-op">Condition <span style={NOTE}>(deployed, in repair…)</span></label>
            <select id="edit-op" className="form-input" style={{ width: '100%' }} value={opStatus} onChange={e => setOpStatus(e.target.value)}>
              <option value="">Not set</option>
              {OP_STATUSES.map(s => <option key={s} value={s}>{OP_STATUS_META[s]?.label || s}</option>)}
            </select>
          </div>
          {OP_STATUS_PERSON.has(opStatus) && (
            <div>
              <span style={LABEL}>Declared By <span style={NOTE}>({OP_STATUS_META[opStatus]?.label || opStatus})</span></span>
              <PersonTypeahead valueName={opPersonName} placeholder="Type a name…"
                onPick={({ email, name: nm }) => { setOpPersonEmail(email); setOpPersonName(nm); }} />
            </div>
          )}
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>
          Available, In Use and Assigned follow the item's checkouts and assignments. A checkout stuck waiting on a receipt is fixed with Reconcile on the item.
        </p>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1.45 }}>
          <input type="checkbox" checked={pictureRequired} onChange={e => setPictureRequired(e.target.checked)} style={{ cursor: 'pointer', accentColor: 'var(--wk-brand)', marginTop: 2 }} />
          <span><strong style={{ color: 'var(--ink)' }}>Require photos at handover and return</strong> - untick for items like keys, where a photo adds nothing.</span>
        </label>
        <PhotoUpload value={photoUrl} onChange={setPhotoUrl} hint="Replace the photo if needed - it should show this exact unit." />
        {aiOn && (
          <button type="button" className="secondary-btn" onClick={aiFindPhoto} disabled={aiFilling} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {aiFilling ? <><Spinner size={13} /> Finding…</> : <><Wand2 size={13} /> Find a Product Photo</>}
          </button>
        )}
        {error && <p style={ERROR}>{error}</p>}
      </div>
    </ItemSheet>
  );
}
