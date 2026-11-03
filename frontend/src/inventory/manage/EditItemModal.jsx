// Item Management - Edit an item.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { AlertCircle, Wand2 } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { ITEM_TYPES, OP_STATUSES, OP_STATUS_META, OP_STATUS_PERSON, DEPARTMENTS } from '../model/status';
import { FL } from '../ui/styles';
import { PhotoUpload } from '../ui/photos';
import { PersonTypeahead } from '../ui/PersonTypeahead';

export function EditItemModal({ item, onClose, onSave, types = ITEM_TYPES }) {
  const [name,          setName]          = useState(item.name);
  const [itemType,      setItemType]      = useState(item.itemType || 'Other');
  const [make,          setMake]          = useState(item.make || '');
  const [model,         setModel]         = useState(item.model || '');
  const [year,          setYear]          = useState(item.year || '');
  const [department,    setDepartment]    = useState(item.department || '');
  const [defaultOwner,  setDefaultOwner]  = useState(item.defaultOwner || '');
  const [ownershipType, setOwnershipType] = useState(item.ownershipType || 'transient');
  const [status,        setStatus]        = useState(item.status || 'available');
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
      ownership_type: ownershipType, status, op_status: opStatus, location: location.trim(), photo_url: photoUrl,
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
    || status !== (item.status || 'available') || opStatus !== (item.opStatus || '')
    || opPersonEmail !== (item.opStatusPersonEmail || '') || opPersonName !== (item.opStatusPersonName || '')
    || location !== (item.location || '') || photoUrl !== (item.photoUrl || '')
    || pictureRequired !== (item.pictureRequired !== false)
    || assetValue !== (item.assetValue ? String(item.assetValue) : '');
  const guard = useUnsavedGuard(dirty, onClose, name.trim() ? submit : undefined);

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:16, overflowY:'auto' }}
      onClick={e => e.target === e.currentTarget && !saving && guard.requestClose()}>
      {/* Wide enough that no label or select option ever truncates (e.g.
          "Temporary (check-out/return)" was getting cut off at 500px) */}
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:620, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', margin:'auto' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:20 }}>Edit Item</h3>

        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <label style={FL}>NAME <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
            <input className="form-input" style={{ width:'100%' }} value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={FL}>TYPE</label>
              <select className="form-input" style={{ width:'100%' }} value={itemType} onChange={e => setItemType(e.target.value)}>
                {/* include the item's current type even if it's a custom imported one, so editing doesn't silently reset it */}
                {[...new Set([...types, itemType].filter(Boolean))].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={FL}>OWNERSHIP</label>
              <select className="form-input" style={{ width:'100%' }} value={ownershipType} onChange={e => setOwnershipType(e.target.value)}>
                <option value="transient">Temporary</option>
                <option value="permanent">Permanent</option>
              </select>
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 80px', gap:12 }}>
            <div>
              <label style={FL}>MAKE</label>
              <input className="form-input" style={{ width:'100%' }} value={make} onChange={e => setMake(e.target.value)} />
            </div>
            <div>
              <label style={FL}>MODEL</label>
              <input className="form-input" style={{ width:'100%' }} value={model} onChange={e => setModel(e.target.value)} />
            </div>
            <div>
              <label style={FL}>YEAR</label>
              <input className="form-input" style={{ width:'100%' }} value={year} onChange={e => setYear(e.target.value)} />
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={FL}>DEPARTMENT</label>
              <input className="form-input" style={{ width:'100%' }} list="edit-item-depts" value={department}
                onChange={e => { const d = e.target.value; setDepartment(d); if (!defaultOwner || defaultOwner === department) setDefaultOwner(d); }} />
              <datalist id="edit-item-depts">{DEPARTMENTS.filter(d => d !== 'All').map(d => <option key={d} value={d} />)}</datalist>
            </div>
            <div>
              <label style={FL}>OWNER <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'var(--muted)' }}>· defaults to the department</span></label>
              <input className="form-input" style={{ width:'100%' }} value={defaultOwner} onChange={e => setDefaultOwner(e.target.value)} />
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={FL}>LOCATION</label>
              <input className="form-input" style={{ width:'100%' }} value={location} onChange={e => setLocation(e.target.value)} />
            </div>
            <div>
              <label style={FL}>LIFECYCLE</label>
              <select className="form-input" style={{ width:'100%' }} value={status} onChange={e => setStatus(e.target.value)}>
                <option value="available">Available</option>
                <option value="checked_out">Checked Out</option>
                <option value="permanently_assigned">Permanently Assigned</option>
                <option value="retired">Retired</option>
              </select>
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={FL}>STATUS <span style={{ fontWeight:400, textTransform:'none' }}>(deployed, in repair…)</span></label>
              <select className="form-input" style={{ width:'100%' }} value={opStatus} onChange={e => setOpStatus(e.target.value)}>
                <option value="">- not set -</option>
                {OP_STATUSES.map(s => <option key={s} value={s}>{OP_STATUS_META[s]?.label || s}</option>)}
              </select>
            </div>
            <div>
              {OP_STATUS_PERSON.has(opStatus) && (
                <>
                  <label style={FL}>DECLARED BY <span style={{ fontWeight:400, textTransform:'none' }}>({OP_STATUS_META[opStatus]?.label || opStatus})</span></label>
                  <PersonTypeahead valueName={opPersonName} placeholder="Type a name…"
                    onPick={({ email, name }) => { setOpPersonEmail(email); setOpPersonName(name); }} />
                </>
              )}
            </div>
          </div>
          <div>
            <label style={FL}>ASSET VALUE ($)</label>
            <input className="form-input" type="number" min="0" step="0.01" style={{ width:'100%' }} value={assetValue} onChange={e => setAssetValue(e.target.value)} placeholder="e.g. 1200" />
          </div>
          <label style={{ display:'flex', alignItems:'flex-start', gap:8, fontSize:12.5, color:'var(--muted)', cursor:'pointer' }}>
            <input type="checkbox" checked={pictureRequired} onChange={e => setPictureRequired(e.target.checked)}
              style={{ cursor:'pointer', accentColor:'var(--pine)', marginTop:2 }} />
            <span>
              <strong style={{ color:'var(--ink)' }}>Require photos in workflows</strong> - handover, receipt and
              return photos are mandatory for this item. Untick for items like keys where photos add no value.
            </span>
          </label>
          <PhotoUpload value={photoUrl} onChange={setPhotoUrl} hint="Replace photo if needed - must clearly identify this specific unit." />
          <button type="button" onClick={aiFindPhoto} disabled={aiFilling}
            style={{ marginTop:8, display:'inline-flex', alignItems:'center', gap:6, height:34, padding:'0 14px', fontSize:12.5, fontWeight:700, background:'hsla(var(--color-purple),0.1)', color:'hsl(var(--color-purple))', border:'1px solid hsla(var(--color-purple),0.35)', borderRadius:8, cursor: aiFilling ? 'default' : 'pointer', fontFamily:'Inter,sans-serif' }}>
            {aiFilling ? <><Spinner size={13} /> Finding…</> : <><Wand2 size={13} /> Let AI find a photo</>}
          </button>
        </div>

        {error && <p style={{ display:'flex', alignItems:'center', gap:6, fontSize:12.5, color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', borderRadius:8, padding:'9px 12px', marginTop:14 }}><AlertCircle size={14} style={{ flexShrink:0 }} /> {error}</p>}

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:22 }}>
          <button className="secondary-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary-btn" disabled={!name.trim() || saving}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:120, justifyContent:'center' }} onClick={submit}>
            {saving ? <><Spinner size={14} /> Saving…</> : 'Save changes'}
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={name.trim() ? guard.saveAndClose : undefined} saving={guard.saving || saving} />
      )}
    </div>
  );
}
