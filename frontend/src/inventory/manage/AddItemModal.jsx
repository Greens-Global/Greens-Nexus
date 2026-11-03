// Item Management - Add Item (also borrowed by Asset Management and Purchase Requests).
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { Plus, AlertCircle, ChevronDown, ArrowLeft } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { ITEM_TYPES, DEPARTMENTS } from '../model/status';
import { useEscapeKey } from '../ui/hooks';
import { FL } from '../ui/styles';
import { PhotoUpload } from '../ui/photos';

// ── Add Item Modal ─────────────────────────────────────────────────────────────
// lockedFields: keys carried over from another form (e.g. the Heavy Equipment wizard) that
// duplicate a value already captured there - shown read-only so the two records can't drift.
const LOCKED_FIELD_STYLE = { backgroundColor: 'var(--mist)', color: 'var(--muted)', cursor: 'not-allowed' };
export function AddItemModal({ onClose, onSave, initial = {}, types = ITEM_TYPES, lockedFields = [], onBack }) {
  const isLocked = (key) => lockedFields.includes(key);
  const [name,          setName]          = useState(initial.name || '');
  const [itemType,      setItemType]      = useState(initial.itemType || 'Tools');
  const [make,          setMake]          = useState(initial.make || '');
  const [model,         setModel]         = useState(initial.model || '');
  const [year,          setYear]          = useState(initial.year || '');
  const [department,    setDepartment]    = useState(initial.department || '');
  // Owner now defaults to the department (Neil: a free-text owner per item just
  // produced 100 unhelpful values - the department is the real owner).
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
  useEscapeKey(() => { if (!saving) onClose(); }); // don't close mid-save (P4)

  function handleTypeChange(t) {
    setItemType(t);
  }
  // Department drives the owner - keep them in sync as the department is picked.
  function handleDeptChange(d) {
    setDepartment(d);
    setDefaultOwner(d);
  }

  function submit() {
    if (!name.trim() || (!photoUrl && !skipPhoto) || saving) return;
    setSaving(true); setError('');
    Promise.resolve(onSave({
      name: name.trim(), item_type: itemType, make: make.trim(), model: model.trim(),
      year: year.trim(), department: department.trim(), default_owner: defaultOwner.trim(),
      ownership_type: ownershipType, location: location.trim(), photo_url: photoUrl,
      picture_required: pictureRequired, asset_value: parseFloat(assetValue) || 0,
    }, { assignNow: ownershipType === 'permanent' && assignNow, aiFill: !photoUrl && skipPhoto && aiFill }))
      .then(onClose)
      .catch(err => setError(err?.message || 'Could not add item - please try again.'))
      .finally(() => setSaving(false));
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:16, overflowY:'auto' }}
      onClick={e => e.target === e.currentTarget && !saving && onClose()}>
      {/* Wide enough that no label or select option ever truncates (e.g.
          "Temporary (check-out/return)" was getting cut off at 500px) */}
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:620, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', margin:'auto' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:20, display:'flex', alignItems:'center', gap:8 }}>
          {onBack && (
            <button type="button" onClick={onBack} disabled={saving} aria-label="Back to asset details"
              title="Back to asset details"
              style={{ background:'none', border:'none', cursor:'pointer', padding:2, display:'flex', color:'var(--muted)' }}>
              <ArrowLeft size={18} />
            </button>
          )}
          Add Item
        </h3>

        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <label style={FL}>NAME <span style={{ color:'hsl(var(--color-red))' }}>*</span>{isLocked('name') && <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'var(--muted)' }}> · from the asset details</span>}</label>
            <input className="form-input" style={{ width:'100%', ...(isLocked('name') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('name')} autoFocus={!isLocked('name')} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. DeWalt 20V Cordless Drill" />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={FL}>TYPE <span style={{ color:'hsl(var(--color-red))' }}>*</span>{isLocked('itemType') && <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'var(--muted)' }}> · from the asset details</span>}</label>
              <div style={{ position:'relative' }}>
                <select className="form-input" style={{ width:'100%', appearance:'none', paddingRight:32, ...(isLocked('itemType') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('itemType')} value={itemType} onChange={e => handleTypeChange(e.target.value)}>
                  {[...new Set([...types, itemType].filter(Boolean))].map(t => <option key={t}>{t}</option>)}
                </select>
                <ChevronDown size={14} style={{ position:'absolute', right:11, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', color:'var(--muted)' }} />
              </div>
            </div>
            <div>
              <label style={FL}>OWNERSHIP</label>
              <div style={{ position:'relative' }}>
                <select className="form-input" style={{ width:'100%', appearance:'none', paddingRight:32 }} value={ownershipType} onChange={e => setOwnershipType(e.target.value)}>
                  <option value="transient">Temporary (check-out/return)</option>
                  <option value="permanent">Permanent (stays assigned)</option>
                </select>
                <ChevronDown size={14} style={{ position:'absolute', right:11, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', color:'var(--muted)' }} />
              </div>
            </div>
          </div>

          {/* Permanent items start UNASSIGNED - adding one doesn't put it under
              the adder's name. Optionally jump straight into the assign flow. */}
          {ownershipType === 'permanent' && (
            <label style={{ display:'flex', alignItems:'flex-start', gap:8, fontSize:12.5, color:'var(--muted)', cursor:'pointer', marginTop:-4 }}>
              <input type="checkbox" checked={assignNow} onChange={e => setAssignNow(e.target.checked)}
                style={{ cursor:'pointer', accentColor:'var(--pine)', marginTop:2 }} />
              <span>
                <strong style={{ color:'var(--ink)' }}>Assign to a person right away</strong> - pick who after
                saving. Otherwise the item stays unassigned until you use Assign in the Manage tab.
              </span>
            </label>
          )}

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 80px', gap:12 }}>
            <div>
              <label style={FL}>MAKE{isLocked('make') && <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'var(--muted)' }}> · from the asset details</span>}</label>
              <input className="form-input" style={{ width:'100%', ...(isLocked('make') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('make')} value={make} onChange={e => setMake(e.target.value)} placeholder="e.g. DeWalt" />
            </div>
            <div>
              <label style={FL}>MODEL{isLocked('model') && <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'var(--muted)' }}> · from the asset details</span>}</label>
              <input className="form-input" style={{ width:'100%', ...(isLocked('model') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('model')} value={model} onChange={e => setModel(e.target.value)} placeholder="e.g. DCD777C2" />
            </div>
            <div>
              <label style={FL}>YEAR{isLocked('year') && <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'var(--muted)' }}> · locked</span>}</label>
              <input className="form-input" style={{ width:'100%', ...(isLocked('year') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('year')} value={year} onChange={e => setYear(e.target.value)} placeholder="2023" />
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={FL}>DEPARTMENT <span style={{ color:'hsl(var(--color-red))' }}>*</span>{isLocked('department') && <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'var(--muted)' }}> · from the asset details</span>}</label>
              <div style={{ position:'relative' }}>
                <input className="form-input datalist-input" style={{ width:'100%', paddingRight:32, ...(isLocked('department') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('department')} list="add-item-depts" value={department} onChange={e => handleDeptChange(e.target.value)} placeholder="e.g. Construction" />
                <ChevronDown size={14} style={{ position:'absolute', right:11, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', color:'var(--muted)' }} />
              </div>
              <datalist id="add-item-depts">{DEPARTMENTS.filter(d => d !== 'All').map(d => <option key={d} value={d} />)}</datalist>
            </div>
            <div>
              <label style={FL}>OWNER <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'var(--muted)' }}>· defaults to the department</span></label>
              <input className="form-input" style={{ width:'100%' }} value={defaultOwner} onChange={e => setDefaultOwner(e.target.value)} placeholder="Defaults to the department" />
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={FL}>LOCATION <span style={{ color:'hsl(var(--color-red))' }}>*</span>{isLocked('location') && <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'var(--muted)' }}> · from the asset details</span>}</label>
              <input className="form-input" style={{ width:'100%', ...(isLocked('location') ? LOCKED_FIELD_STYLE : {}) }} disabled={isLocked('location')} value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. GSVC, GSE, Site Office" />
            </div>
            <div>
              <label style={FL}>ASSET VALUE ($)</label>
              <input className="form-input" type="number" min="0" step="0.01" style={{ width:'100%' }} value={assetValue} onChange={e => setAssetValue(e.target.value)} placeholder="e.g. 1200" />
            </div>
          </div>

          {/* Per-item photo policy - keys etc. shouldn't demand pictures (Neil).
              Default yes; when off, every photo in this item's flows goes optional. */}
          <label style={{ display:'flex', alignItems:'flex-start', gap:8, fontSize:12.5, color:'var(--muted)', cursor:'pointer' }}>
            <input type="checkbox" checked={pictureRequired} onChange={e => setPictureRequired(e.target.checked)}
              style={{ cursor:'pointer', accentColor:'var(--pine)', marginTop:2 }} />
            <span>
              <strong style={{ color:'var(--ink)' }}>Require photos in workflows</strong> - handover, receipt and
              return photos are mandatory for this item. Untick for items like keys where photos add no value.
            </span>
          </label>

          <PhotoUpload value={photoUrl} onChange={setPhotoUrl} required={!skipPhoto} hint="Upload a clear photo that distinguishes this specific item." />
          {!photoUrl && (
            <label style={{ display:'flex', alignItems:'flex-start', gap:8, fontSize:12.5, color:'var(--muted)', cursor:'pointer', marginTop:-4 }}>
              <input type="checkbox" checked={skipPhoto} onChange={e => setSkipPhoto(e.target.checked)}
                style={{ cursor:'pointer', accentColor:'var(--pine)', marginTop:2 }} />
              <span>
                <strong style={{ color:'var(--ink)' }}>Add without a photo for now</strong> - the item will show
                under Missing photos; add one later via Batch update photos or AI photo fill.
              </span>
            </label>
          )}
          {/* Neil: offer AI fill at add time, not only afterwards from Manage */}
          {!photoUrl && skipPhoto && (
            <label style={{ display:'flex', alignItems:'flex-start', gap:8, fontSize:12.5, color:'var(--muted)', cursor:'pointer', marginTop:-4 }}>
              <input type="checkbox" checked={aiFill} onChange={e => setAiFill(e.target.checked)}
                style={{ cursor:'pointer', accentColor:'var(--pine)', marginTop:2 }} />
              <span>
                <strong style={{ color:'hsl(var(--color-purple))' }}>Let AI find a product photo after saving</strong> -
                uses the make/model to fetch a stock image. Replace it with a real unit photo when you can.
              </span>
            </label>
          )}
        </div>

        {error && <p style={{ display:'flex', alignItems:'center', gap:6, fontSize:12.5, color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', borderRadius:8, padding:'9px 12px', marginTop:14 }}><AlertCircle size={14} style={{ flexShrink:0 }} /> {error}</p>}

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:22 }}>
          <button className="secondary-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary-btn" disabled={!name.trim() || (!photoUrl && !skipPhoto) || !department.trim() || !location.trim() || saving}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:120, justifyContent:'center' }}
            onClick={submit}>
            {saving ? <><Spinner size={14} /> Saving…</> : <><Plus size={14} /> Add Item</>}
          </button>
        </div>
      </div>
    </div>
  );
}
