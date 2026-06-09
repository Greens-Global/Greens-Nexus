import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Package, Plus, Search, CheckCircle, Clock, XCircle, RotateCcw, Camera,
  AlertCircle, X, Loader2, ChevronDown, UploadCloud, FileSpreadsheet,
  Download, Pencil, Trash2, MapPin, ClipboardList, History, FileBarChart,
  ShoppingCart, Filter, ZoomIn, Car, Wrench, Key, Monitor, Box,
} from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { useInventory }     from '../contexts/InventoryContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useRole }          from '../contexts/RoleContext';
import { api }              from '../api';
import { supabase }         from '../lib/supabase';
import { useMsal }          from '@azure/msal-react';

// ── Constants ─────────────────────────────────────────────────────────────────
const ITEM_TYPES = ['Devices', 'Tools', 'Vehicles', 'Equipment', 'Keys', 'Other'];

const TYPE_DEFAULT_OWNER = {
  Devices:   'IT',
  Tools:     'Construction (MCD)',
  Vehicles:  'Fleet / Operations',
  Equipment: '',
  Keys:      'Operations (Oversite)',
  Other:     '',
};

const TYPE_META = {
  Devices:   { Icon: Monitor,  color: 'hsl(var(--color-blue))',   bg: 'hsla(var(--color-blue),0.12)'   },
  Tools:     { Icon: Wrench,   color: 'hsl(var(--color-orange))', bg: 'hsla(var(--color-orange),0.12)' },
  Vehicles:  { Icon: Car,      color: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)'  },
  Equipment: { Icon: Box,      color: 'hsl(var(--color-purple))', bg: 'hsla(var(--color-purple),0.12)' },
  Keys:      { Icon: Key,      color: 'hsl(var(--color-red))',    bg: 'hsla(var(--color-red),0.12)'    },
  Other:     { Icon: Package,  color: 'var(--muted)',             bg: 'var(--mist)'                    },
};

const STATUS_META = {
  available:            { label: 'Available',          bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))'  },
  checked_out:          { label: 'Checked Out',        bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  permanently_assigned: { label: 'Perm. Assigned',    bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))'   },
  retired:              { label: 'Retired',             bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))'    },
};

const CHECKOUT_STATUS_META = {
  pending:   { label: 'Pending',          bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))', Icon: Clock },
  approved:  { label: 'To Be Allocated',  bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: Package },
  allocated: { label: 'In Use',           bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))',  Icon: CheckCircle },
  rejected:  { label: 'Rejected',         bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))',    Icon: XCircle },
  returned:  { label: 'Returned',         bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: RotateCcw },
  cancelled: { label: 'Cancelled',        bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))',    Icon: XCircle },
};

const DEPARTMENTS = ['All', 'IT', 'Construction', 'Operations', 'Accounting', 'Fleet', 'Facilities', 'Marketing', 'HR'];
const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.04em' };

// ── Shared helpers ─────────────────────────────────────────────────────────────
function useEscapeKey(fn) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') fn(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [fn]);
}

function ImageLightbox({ src, alt, onClose }) {
  useEscapeKey(onClose);
  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.85)', zIndex:1300, display:'flex', alignItems:'center', justifyContent:'center', padding:32 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <img src={src} alt={alt || 'Photo'} style={{ maxWidth:'100%', maxHeight:'100%', borderRadius:10, boxShadow:'0 20px 80px rgba(0,0,0,0.5)' }} />
      <button onClick={onClose} style={{ position:'absolute', top:20, right:24, background:'rgba(255,255,255,0.12)', border:'none', borderRadius:8, padding:8, color:'#fff', cursor:'pointer', display:'flex' }}>
        <X size={20} />
      </button>
    </div>
  );
}

function Toast({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div style={{ position:'fixed', bottom:24, right:24, zIndex:1200, display:'flex', flexDirection:'column', gap:8, maxWidth:340 }}>
      {toasts.map(t => (
        <div key={t.id} role="status" style={{
          display:'flex', alignItems:'flex-start', gap:10, padding:'12px 14px', borderRadius:10,
          background:'var(--card)', border:`1px solid ${t.kind === 'error' ? 'hsla(var(--color-red),0.35)' : 'hsla(var(--color-green),0.35)'}`,
          boxShadow:'0 8px 28px rgba(0,0,0,0.18)',
        }}>
          {t.kind === 'error'
            ? <XCircle size={16} color="hsl(var(--color-red))" style={{ flexShrink:0, marginTop:1 }} />
            : <CheckCircle size={16} color="hsl(var(--color-green))" style={{ flexShrink:0, marginTop:1 }} />}
          <span style={{ fontSize:13, color:'var(--ink)', lineHeight:1.4, flex:1 }}>{t.message}</span>
          <button onClick={() => onDismiss(t.id)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', flexShrink:0 }}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function TypeBadge({ type }) {
  const m = TYPE_META[type] || TYPE_META.Other;
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:20, fontSize:'11px', fontWeight:600, background:m.bg, color:m.color, whiteSpace:'nowrap' }}>
      <m.Icon size={10} /> {type}
    </span>
  );
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || { label: status, bg:'var(--mist)', fg:'var(--muted)' };
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:20, fontSize:'11px', fontWeight:600, background:m.bg, color:m.fg, whiteSpace:'nowrap' }}>
      {m.label}
    </span>
  );
}

function PhotoThumb({ url, name, onPreview, size = 44 }) {
  if (!url) return (
    <div style={{ width:size, height:size, borderRadius:8, background:'hsla(var(--color-red),0.08)', border:'1px dashed hsla(var(--color-red),0.4)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}
      title="No photo — required">
      <Camera size={size * 0.38} color="hsl(var(--color-red))" />
    </div>
  );
  return (
    <div onClick={onPreview ? () => onPreview(url, name) : undefined}
      style={{ width:size, height:size, borderRadius:8, overflow:'hidden', cursor:onPreview ? 'pointer' : 'default', flexShrink:0, border:'1px solid var(--line)' }}>
      <img src={url} alt={name || 'Item photo'} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
    </div>
  );
}

async function uploadToSupabase(file, bucket, path) {
  if (!supabase) return { url: '', error: 'Supabase not configured' };
  const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!ALLOWED.includes(file.type)) return { url: '', error: 'Only JPEG, PNG, GIF, or WebP images allowed' };
  if (file.size > 10 * 1024 * 1024) return { url: '', error: 'Photo must be under 10 MB' };
  const { data: uploaded, error } = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false });
  if (error || !uploaded) return { url: '', error: error?.message || 'Upload failed' };
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(uploaded.path);
  return { url: urlData.publicUrl, error: null };
}

// ── Photo upload widget ────────────────────────────────────────────────────────
function PhotoUpload({ value, onChange, label = 'PHOTO', required = false, hint }) {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(value || null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { setPreview(value || null); }, [value]);

  async function handleFile(file) {
    if (!file) return;
    setUploading(true); setErr('');
    const path = `item-photos/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { url, error } = await uploadToSupabase(file, 'item-photos', path);
    if (error) { setErr(error); setUploading(false); return; }
    setPreview(url);
    onChange(url);
    setUploading(false);
  }

  return (
    <div>
      <label style={FL}>{label}{required && <span style={{ color:'hsl(var(--color-red))' }}> *</span>}</label>
      {hint && <p style={{ fontSize:11.5, color:'var(--muted)', marginBottom:8, marginTop:-2 }}>{hint}</p>}
      <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }}
        onChange={e => handleFile(e.target.files?.[0])} />
      {preview ? (
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <img src={preview} alt="Preview" style={{ width:72, height:72, objectFit:'cover', borderRadius:8, border:'1px solid var(--line)' }} />
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            <button type="button" className="secondary-btn" style={{ fontSize:12, padding:'5px 12px' }}
              onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Replace Photo'}
            </button>
            <button type="button" style={{ background:'none', border:'none', cursor:'pointer', fontSize:11.5, color:'hsl(var(--color-red))' }}
              onClick={() => { setPreview(null); onChange(''); }}>Remove</button>
          </div>
        </div>
      ) : (
        <button type="button"
          onClick={() => fileRef.current?.click()} disabled={uploading}
          style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 16px', borderRadius:9, border:`2px dashed ${required ? 'hsla(var(--color-red),0.4)' : 'var(--line)'}`, background: required ? 'hsla(var(--color-red),0.04)' : 'var(--mist)', cursor:'pointer', fontSize:13, color:'var(--muted)', width:'100%', justifyContent:'center' }}>
          {uploading ? <><Loader2 size={15} style={{ animation:'spin 1s linear infinite' }} /> Uploading…</> : <><Camera size={15} /> {required ? 'Upload Photo (required)' : 'Upload Photo'}</>}
        </button>
      )}
      {err && <p style={{ fontSize:11.5, color:'hsl(var(--color-red))', marginTop:5 }}>{err}</p>}
    </div>
  );
}

// ── Add Item Modal ─────────────────────────────────────────────────────────────
function AddItemModal({ onClose, onSave }) {
  const [name,          setName]          = useState('');
  const [itemType,      setItemType]      = useState('Tools');
  const [make,          setMake]          = useState('');
  const [model,         setModel]         = useState('');
  const [year,          setYear]          = useState('');
  const [department,    setDepartment]    = useState('');
  const [defaultOwner,  setDefaultOwner]  = useState(TYPE_DEFAULT_OWNER['Tools']);
  const [ownershipType, setOwnershipType] = useState('transient');
  const [location,      setLocation]      = useState('');
  const [photoUrl,      setPhotoUrl]      = useState('');
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState('');
  useEscapeKey(onClose);

  function handleTypeChange(t) {
    setItemType(t);
    setDefaultOwner(TYPE_DEFAULT_OWNER[t] || '');
  }

  function submit() {
    if (!name.trim() || !photoUrl || saving) return;
    setSaving(true); setError('');
    Promise.resolve(onSave({
      name: name.trim(), item_type: itemType, make: make.trim(), model: model.trim(),
      year: year.trim(), department: department.trim(), default_owner: defaultOwner.trim(),
      ownership_type: ownershipType, location: location.trim(), photo_url: photoUrl,
    }))
      .then(onClose)
      .catch(err => setError(err?.message || 'Could not add item — please try again.'))
      .finally(() => setSaving(false));
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:16, overflowY:'auto' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:500, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', margin:'auto' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:20 }}>Add Item</h3>

        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <label style={FL}>NAME <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
            <input className="form-input" style={{ width:'100%' }} autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. DeWalt 20V Cordless Drill" />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={FL}>TYPE <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
              <select className="form-input" style={{ width:'100%' }} value={itemType} onChange={e => handleTypeChange(e.target.value)}>
                {ITEM_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={FL}>OWNERSHIP</label>
              <select className="form-input" style={{ width:'100%' }} value={ownershipType} onChange={e => setOwnershipType(e.target.value)}>
                <option value="transient">Transient (check-out/return)</option>
                <option value="permanent">Permanent (stays assigned)</option>
              </select>
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 80px', gap:12 }}>
            <div>
              <label style={FL}>MAKE</label>
              <input className="form-input" style={{ width:'100%' }} value={make} onChange={e => setMake(e.target.value)} placeholder="e.g. DeWalt" />
            </div>
            <div>
              <label style={FL}>MODEL</label>
              <input className="form-input" style={{ width:'100%' }} value={model} onChange={e => setModel(e.target.value)} placeholder="e.g. DCD777C2" />
            </div>
            <div>
              <label style={FL}>YEAR</label>
              <input className="form-input" style={{ width:'100%' }} value={year} onChange={e => setYear(e.target.value)} placeholder="2023" />
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={FL}>DEPARTMENT <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
              <input className="form-input" style={{ width:'100%' }} list="add-item-depts" value={department} onChange={e => setDepartment(e.target.value)} placeholder="e.g. Construction" />
              <datalist id="add-item-depts">{DEPARTMENTS.filter(d => d !== 'All').map(d => <option key={d} value={d} />)}</datalist>
            </div>
            <div>
              <label style={FL}>DEFAULT OWNER</label>
              <input className="form-input" style={{ width:'100%' }} value={defaultOwner} onChange={e => setDefaultOwner(e.target.value)} placeholder="e.g. Tool Crib" />
            </div>
          </div>

          <div>
            <label style={FL}>LOCATION <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
            <input className="form-input" style={{ width:'100%' }} value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. GSVC, GSE, Site Office" />
          </div>

          <PhotoUpload value={photoUrl} onChange={setPhotoUrl} required hint="Required — upload a clear photo that distinguishes this specific item." />
        </div>

        {error && <p style={{ display:'flex', alignItems:'center', gap:6, fontSize:12.5, color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', borderRadius:8, padding:'9px 12px', marginTop:14 }}><AlertCircle size={14} style={{ flexShrink:0 }} /> {error}</p>}

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:22 }}>
          <button className="secondary-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary-btn" disabled={!name.trim() || !photoUrl || !department.trim() || !location.trim() || saving}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:120, justifyContent:'center' }}
            onClick={submit}>
            {saving ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Saving…</> : <><Plus size={14} /> Add Item</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Item Modal ────────────────────────────────────────────────────────────
function EditItemModal({ item, onClose, onSave }) {
  const [name,          setName]          = useState(item.name);
  const [itemType,      setItemType]      = useState(item.itemType || 'Other');
  const [make,          setMake]          = useState(item.make || '');
  const [model,         setModel]         = useState(item.model || '');
  const [year,          setYear]          = useState(item.year || '');
  const [department,    setDepartment]    = useState(item.department || '');
  const [defaultOwner,  setDefaultOwner]  = useState(item.defaultOwner || '');
  const [ownershipType, setOwnershipType] = useState(item.ownershipType || 'transient');
  const [status,        setStatus]        = useState(item.status || 'available');
  const [location,      setLocation]      = useState(item.location || '');
  const [photoUrl,      setPhotoUrl]      = useState(item.photoUrl || '');
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState('');
  useEscapeKey(onClose);

  function submit() {
    if (!name.trim() || saving) return;
    setSaving(true); setError('');
    Promise.resolve(onSave({
      name: name.trim(), item_type: itemType, make: make.trim(), model: model.trim(),
      year: year.trim(), department: department.trim(), default_owner: defaultOwner.trim(),
      ownership_type: ownershipType, status, location: location.trim(), photo_url: photoUrl,
    }))
      .then(onClose)
      .catch(err => setError(err?.message || 'Could not save changes.'))
      .finally(() => setSaving(false));
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:16, overflowY:'auto' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:500, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', margin:'auto' }}>
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
                {ITEM_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={FL}>OWNERSHIP</label>
              <select className="form-input" style={{ width:'100%' }} value={ownershipType} onChange={e => setOwnershipType(e.target.value)}>
                <option value="transient">Transient</option>
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
              <input className="form-input" style={{ width:'100%' }} list="edit-item-depts" value={department} onChange={e => setDepartment(e.target.value)} />
              <datalist id="edit-item-depts">{DEPARTMENTS.filter(d => d !== 'All').map(d => <option key={d} value={d} />)}</datalist>
            </div>
            <div>
              <label style={FL}>DEFAULT OWNER</label>
              <input className="form-input" style={{ width:'100%' }} value={defaultOwner} onChange={e => setDefaultOwner(e.target.value)} />
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={FL}>LOCATION</label>
              <input className="form-input" style={{ width:'100%' }} value={location} onChange={e => setLocation(e.target.value)} />
            </div>
            <div>
              <label style={FL}>STATUS</label>
              <select className="form-input" style={{ width:'100%' }} value={status} onChange={e => setStatus(e.target.value)}>
                <option value="available">Available</option>
                <option value="checked_out">Checked Out</option>
                <option value="permanently_assigned">Permanently Assigned</option>
                <option value="retired">Retired</option>
              </select>
            </div>
          </div>
          <PhotoUpload value={photoUrl} onChange={setPhotoUrl} hint="Replace photo if needed — must clearly identify this specific unit." />
        </div>

        {error && <p style={{ display:'flex', alignItems:'center', gap:6, fontSize:12.5, color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', borderRadius:8, padding:'9px 12px', marginTop:14 }}><AlertCircle size={14} style={{ flexShrink:0 }} /> {error}</p>}

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:22 }}>
          <button className="secondary-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary-btn" disabled={!name.trim() || saving}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:120, justifyContent:'center' }} onClick={submit}>
            {saving ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Saving…</> : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete Confirm Modal ───────────────────────────────────────────────────────
function DeleteItemModal({ item, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  useEscapeKey(onClose);
  function confirm() {
    setBusy(true);
    Promise.resolve(onConfirm()).catch(() => {}).finally(() => setBusy(false));
  }
  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:380, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:8 }}>Delete Item?</h3>
        <p style={{ fontSize:13.5, color:'var(--muted)', marginBottom:20 }}>
          Permanently remove <strong>{item.name}</strong>? This cannot be undone and will fail if the item has an active checkout.
        </p>
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button onClick={confirm} disabled={busy}
            style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'8px 18px', borderRadius:8, border:'none', background:'hsl(var(--color-red))', color:'#fff', fontWeight:700, fontSize:13.5, cursor:'pointer' }}>
            {busy ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Deleting…</> : <><Trash2 size={14} /> Delete</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── CSV helpers ────────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}

function parseItemsCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { rows: [], error: 'File looks empty — needs a header row plus at least one item.' };
  const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const idx = {
    name:          header.findIndex(h => ['name','item','item name'].includes(h)),
    item_type:     header.findIndex(h => ['type','item_type','item type'].includes(h)),
    make:          header.findIndex(h => h === 'make'),
    model:         header.findIndex(h => h === 'model'),
    year:          header.findIndex(h => h === 'year'),
    department:    header.findIndex(h => ['department','dept'].includes(h)),
    default_owner: header.findIndex(h => ['owner','default_owner','default owner'].includes(h)),
    ownership_type:header.findIndex(h => ['ownership','ownership_type','ownership type'].includes(h)),
    location:      header.findIndex(h => ['location','site'].includes(h)),
  };
  if (idx.name === -1) return { rows: [], error: 'Could not find a "Name" column in the header.' };
  const rows = lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const get = i => (i > -1 ? (cells[i] || '').trim() : '');
    const name = get(idx.name);
    const item_type = get(idx.item_type) || 'Other';
    const ownership_type = get(idx.ownership_type) || 'transient';
    return {
      name, item_type, make: get(idx.make), model: get(idx.model), year: get(idx.year),
      department: get(idx.department), default_owner: get(idx.default_owner),
      ownership_type: ownership_type.toLowerCase(),
      location: get(idx.location),
      _valid: !!name,
      _unknownType: !!item_type && !ITEM_TYPES.includes(item_type),
    };
  });
  return { rows, error: null };
}

function csvField(v) { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function downloadItemsCsv(items) {
  const lines = ['Name,Type,Make,Model,Year,Department,Owner,Ownership,Location,Status'];
  for (const i of items)
    lines.push([i.name,i.itemType,i.make,i.model,i.year,i.department,i.defaultOwner,i.ownershipType,i.location,i.status].map(csvField).join(','));
  triggerDownload(`items-catalog-${new Date().toISOString().slice(0,10)}.csv`, new Blob([lines.join('\r\n')], { type:'text/csv;charset=utf-8;' }));
}

function downloadImportTemplate() {
  triggerDownload('items-import-template.csv', new Blob([[
    'Name,Type,Make,Model,Year,Department,Owner,Ownership,Location',
    'Dell XPS 15 Laptop,Devices,Dell,XPS 15,2023,IT,IT Department,permanent,GSE',
    'DeWalt Cordless Drill,Tools,DeWalt,DCD777C2,,Construction,Tool Crib,transient,GSVC',
    'Ford F-150 Pickup,Vehicles,Ford,F-150,2022,Fleet,Fleet Team,permanent,Yard',
  ].join('\r\n')], { type:'text/csv;charset=utf-8;' }));
}

// ── Import Modal ───────────────────────────────────────────────────────────────
function ImportItemsModal({ onClose, onImport }) {
  const [rows,      setRows]      = useState(null);
  const [parseErr,  setParseErr]  = useState('');
  const [importing, setImporting] = useState(false);
  const [done,      setDone]      = useState(null);
  const fileRef = useRef(null);
  useEscapeKey(onClose);

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const { rows, error } = parseItemsCsv(e.target.result);
      if (error) { setParseErr(error); setRows(null); }
      else { setRows(rows); setParseErr(''); }
    };
    reader.readAsText(file);
  }

  function doImport() {
    const valid = rows.filter(r => r._valid);
    if (!valid.length || importing) return;
    setImporting(true);
    Promise.resolve(onImport(valid))
      .then(res => setDone(res))
      .finally(() => setImporting(false));
  }

  const valid   = rows?.filter(r => r._valid) ?? [];
  const invalid = rows?.filter(r => !r._valid) ?? [];
  const warned  = rows?.filter(r => r._unknownType) ?? [];

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:520, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', maxHeight:'90vh', overflowY:'auto' }}>
        {done ? (
          <>
            <h3 style={{ fontSize:16, fontWeight:700, marginBottom:10 }}>Import Complete</h3>
            <p style={{ fontSize:13.5, color:'var(--muted)', marginBottom:20 }}>
              <strong>{done.created}</strong> items added. <strong>{done.skipped}</strong> rows skipped.
              Photos must be added manually in the Manage tab — one item at a time.
            </p>
            <div style={{ display:'flex', justifyContent:'flex-end' }}><button className="primary-btn" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16 }}>
              <h3 style={{ fontSize:16, fontWeight:700 }}>Import Items from CSV</h3>
              <button onClick={() => downloadImportTemplate()} className="secondary-btn" style={{ fontSize:12, padding:'5px 12px', display:'inline-flex', alignItems:'center', gap:5 }}>
                <Download size={13} /> Template
              </button>
            </div>
            <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:16 }}>
              Each row = one physical item. Photos are always added manually after import. Required columns: <strong>Name</strong>.
            </p>

            <input ref={fileRef} type="file" accept=".csv" style={{ display:'none' }} onChange={e => handleFile(e.target.files?.[0])} />
            <button onClick={() => fileRef.current?.click()} className="secondary-btn" style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'12px', marginBottom:14 }}>
              <UploadCloud size={16} /> Choose CSV file
            </button>

            {parseErr && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginBottom:12 }}>{parseErr}</p>}

            {rows && (
              <>
                <div style={{ fontSize:12.5, color:'var(--muted)', marginBottom:10 }}>
                  <strong style={{ color:'hsl(var(--color-green))' }}>{valid.length} valid</strong>
                  {invalid.length > 0 && <>, <strong style={{ color:'hsl(var(--color-red))' }}>{invalid.length} missing name (skipped)</strong></>}
                  {warned.length > 0 && <>, <strong style={{ color:'hsl(var(--color-orange))' }}>{warned.length} unknown type (will save as-is)</strong></>}
                </div>
                <div style={{ border:'1px solid var(--line)', borderRadius:8, overflow:'auto', maxHeight:200, marginBottom:16 }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                    <thead>
                      <tr style={{ background:'var(--mist)' }}>
                        {['Name','Type','Make','Model','Dept','Ownership','Location'].map(h =>
                          <th key={h} style={{ padding:'7px 10px', textAlign:'left', fontWeight:700, color:'var(--muted)', whiteSpace:'nowrap' }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0,50).map((r, i) => (
                        <tr key={i} style={{ borderTop:'1px solid var(--line)', background: !r._valid ? 'hsla(var(--color-red),0.04)' : 'transparent' }}>
                          <td style={{ padding:'6px 10px', fontWeight:600 }}>{r.name || <em style={{ color:'hsl(var(--color-red))' }}>missing</em>}</td>
                          <td style={{ padding:'6px 10px', color: r._unknownType ? 'hsl(var(--color-orange))' : 'var(--muted)' }}>{r.item_type}</td>
                          <td style={{ padding:'6px 10px', color:'var(--muted)' }}>{r.make}</td>
                          <td style={{ padding:'6px 10px', color:'var(--muted)' }}>{r.model}</td>
                          <td style={{ padding:'6px 10px', color:'var(--muted)' }}>{r.department}</td>
                          <td style={{ padding:'6px 10px', color:'var(--muted)' }}>{r.ownership_type}</td>
                          <td style={{ padding:'6px 10px', color:'var(--muted)' }}>{r.location}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                  <button className="secondary-btn" onClick={onClose}>Cancel</button>
                  <button className="primary-btn" disabled={!valid.length || importing}
                    style={{ display:'inline-flex', alignItems:'center', gap:7 }} onClick={doImport}>
                    {importing ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Importing…</> : `Import ${valid.length} Items`}
                  </button>
                </div>
              </>
            )}
            {!rows && <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}><button className="secondary-btn" onClick={onClose}>Cancel</button></div>}
          </>
        )}
      </div>
    </div>
  );
}

// ── Report Modal ───────────────────────────────────────────────────────────────
function ReportModal({ onClose }) {
  const [dept,      setDept]      = useState('All');
  const [itemType,  setItemType]  = useState('All');
  const [status,    setStatus]    = useState('All');
  const [exporting, setExporting] = useState(null);
  const [error,     setError]     = useState('');
  useEscapeKey(onClose);

  function exportAs(format) {
    if (exporting) return;
    setExporting(format); setError('');
    const params = { format };
    if (dept !== 'All')     params.department = dept;
    if (itemType !== 'All') params.item_type  = itemType;
    if (status !== 'All')   params.status     = status;
    api.getItemsReport(params)
      .then(({ blob, filename }) => triggerDownload(filename, blob))
      .then(onClose)
      .catch(err => setError(err?.message || 'Could not generate report.'))
      .finally(() => setExporting(null));
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:420, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:16 }}>Export Checkout Report</h3>
        <div style={{ display:'flex', flexDirection:'column', gap:14, marginBottom:20 }}>
          <div>
            <label style={FL}>DEPARTMENT</label>
            <select className="form-input" style={{ width:'100%' }} value={dept} onChange={e => setDept(e.target.value)}>
              {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={FL}>ITEM TYPE</label>
            <select className="form-input" style={{ width:'100%' }} value={itemType} onChange={e => setItemType(e.target.value)}>
              <option>All</option>
              {ITEM_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={FL}>STATUS</label>
            <select className="form-input" style={{ width:'100%' }} value={status} onChange={e => setStatus(e.target.value)}>
              {['All','pending','approved','allocated','returned','rejected','cancelled'].map(s =>
                <option key={s} value={s}>{s === 'All' ? 'All statuses' : CHECKOUT_STATUS_META[s]?.label || s}</option>)}
            </select>
          </div>
        </div>
        {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginBottom:12 }}>{error}</p>}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={!!exporting}>Cancel</button>
          <button className="secondary-btn" disabled={!!exporting} style={{ display:'inline-flex', alignItems:'center', gap:6 }}
            onClick={() => exportAs('pdf')}>
            {exporting === 'pdf' ? <Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> : <FileBarChart size={14} />} PDF
          </button>
          <button className="primary-btn" disabled={!!exporting} style={{ display:'inline-flex', alignItems:'center', gap:6 }}
            onClick={() => exportAs('excel')}>
            {exporting === 'excel' ? <Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> : <FileSpreadsheet size={14} />} Excel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Return Modal ───────────────────────────────────────────────────────────────
function ReturnModal({ checkout, onClose, onSubmit }) {
  const [file,          setFile]          = useState(null);
  const [preview,       setPreview]       = useState('');
  const [conditionNote, setConditionNote] = useState('');
  const [submitting,    setSubmitting]    = useState(false);
  const fileRef = useRef(null);
  useEscapeKey(onClose);

  function handleFile(f) {
    if (!f) return;
    setFile(f);
    const reader = new FileReader();
    reader.onload = e => setPreview(e.target.result);
    reader.readAsDataURL(f);
  }

  function submit() {
    if (!file || submitting) return;
    setSubmitting(true);
    Promise.resolve(onSubmit({ file, photoName: file.name, conditionNote }))
      .catch(() => {})
      .finally(() => setSubmitting(false));
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:420, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Return Item</h3>
        <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:20 }}>
          Returning <strong>{checkout.itemName}</strong>. A photo of the item is required.
        </p>

        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <label style={FL}>RETURN PHOTO <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
            <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }} onChange={e => handleFile(e.target.files?.[0])} />
            {preview ? (
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <img src={preview} alt="Return photo" style={{ width:72, height:72, objectFit:'cover', borderRadius:8, border:'1px solid var(--line)' }} />
                <button type="button" className="secondary-btn" style={{ fontSize:12 }} onClick={() => fileRef.current?.click()}>Replace</button>
              </div>
            ) : (
              <button type="button" onClick={() => fileRef.current?.click()}
                style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'12px', borderRadius:9, border:'2px dashed hsla(var(--color-red),0.4)', background:'hsla(var(--color-red),0.04)', cursor:'pointer', fontSize:13, color:'var(--muted)' }}>
                <Camera size={15} /> Take / Upload Photo
              </button>
            )}
          </div>
          <div>
            <label style={FL}>CONDITION NOTES <span style={{ fontSize:11, fontWeight:400 }}>(optional — note any damage)</span></label>
            <textarea rows={3} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13 }}
              placeholder="e.g. Minor scuff on handle, otherwise good condition"
              value={conditionNote} onChange={e => setConditionNote(e.target.value)} />
          </div>
        </div>

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button className="secondary-btn" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="primary-btn" disabled={!file || submitting}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:130, justifyContent:'center' }} onClick={submit}>
            {submitting ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Returning…</> : <><RotateCcw size={14} /> Confirm Return</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Audit Log Panel ───────────────────────────────────────────────────────────
function AuditLogPanel() {
  const [query,   setQuery]   = useState('');
  const [logs,    setLogs]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const params = { limit: 200 };
    if (query.trim()) params.q = query.trim();
    api.getItemsAuditLog(params)
      .then(res => { setLogs(res.rows || []); setError(''); })
      .catch(() => setError('Could not load audit log.'))
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => { const t = setTimeout(load, query ? 350 : 0); return () => clearTimeout(t); }, [load, query]);

  return (
    <div>
      <div style={{ display:'flex', gap:10, marginBottom:18, flexWrap:'wrap', alignItems:'center' }}>
        <div className="search-bar" style={{ width:300 }}>
          <Search size={14} style={{ flexShrink:0 }} />
          <input placeholder="Search by item, user, or action…" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <span style={{ fontSize:13, color:'var(--muted)' }}>{logs.length} entr{logs.length !== 1 ? 'ies' : 'y'}</span>
      </div>
      {error ? (
        <ErrorBanner message="Could not load the audit log." onRetry={load} />
      ) : loading ? (
        <SkeletonBlocks count={5} height={44} borderRadius={8} />
      ) : logs.length === 0 ? (
        <div style={{ textAlign:'center', padding:'48px 0', color:'var(--muted)', fontSize:13 }}>
          <History size={28} style={{ opacity:.3, display:'block', margin:'0 auto 8px' }} />
          {query ? 'No entries match your search.' : 'No audit entries yet.'}
        </div>
      ) : (
        <div style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12.5 }}>
            <thead>
              <tr style={{ background:'var(--mist)' }}>
                {['Timestamp','User','Action','Details'].map(h =>
                  <th key={h} style={{ textAlign:'left', padding:'9px 14px', fontWeight:700, color:'var(--muted)' }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} style={{ borderTop:'1px solid var(--line)' }}>
                  <td style={{ padding:'9px 14px', color:'var(--muted)', whiteSpace:'nowrap' }}>{new Date(log.timestamp).toLocaleString()}</td>
                  <td style={{ padding:'9px 14px' }}>{log.user_email}</td>
                  <td style={{ padding:'9px 14px', fontWeight:600 }}>{log.action}</td>
                  <td style={{ padding:'9px 14px', color:'var(--muted)' }}>{log.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Stage Tracker ─────────────────────────────────────────────────────────────
const STAGES = [
  { key:'pending',   label:'Submitted' },
  { key:'approved',  label:'Approved'  },
  { key:'allocated', label:'In Use'    },
  { key:'returned',  label:'Returned'  },
];
function StageTracker({ checkout, onViewPhoto }) {
  const ORDER = ['pending','approved','allocated','returned'];
  const idx   = ORDER.indexOf(checkout.status);
  const isDone = ['returned','rejected','cancelled'].includes(checkout.status);
  return (
    <div style={{ display:'flex', alignItems:'center', gap:0, margin:'12px 0 4px', flexWrap:'wrap' }}>
      {STAGES.map((stage, i) => {
        const active  = i <= idx && !['rejected','cancelled'].includes(checkout.status);
        const current = ORDER[idx] === stage.key;
        return (
          <div key={stage.key} style={{ display:'flex', alignItems:'center', flex: i < STAGES.length - 1 ? '1 1 auto' : undefined }}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
              <div style={{ width:22, height:22, borderRadius:'50%', border:`2px solid ${active ? 'hsl(var(--color-green))' : 'var(--line)'}`, background: active ? 'hsl(var(--color-green))' : 'transparent', display:'flex', alignItems:'center', justifyContent:'center' }}>
                {active && <CheckCircle size={12} color="#fff" />}
              </div>
              <span style={{ fontSize:10, fontWeight: current ? 700 : 500, color: active ? 'hsl(var(--color-green))' : 'var(--muted)', whiteSpace:'nowrap' }}>{stage.label}</span>
            </div>
            {i < STAGES.length - 1 && (
              <div style={{ flex:1, height:2, background: i < idx && !['rejected','cancelled'].includes(checkout.status) ? 'hsl(var(--color-green))' : 'var(--line)', margin:'0 4px', marginBottom:16 }} />
            )}
          </div>
        );
      })}
      {checkout.status === 'rejected' && (
        <div style={{ marginLeft:8, padding:'2px 8px', borderRadius:20, background:'hsla(var(--color-red),0.1)', color:'hsl(var(--color-red))', fontSize:11, fontWeight:700 }}>Rejected{checkout.rejectReason ? ` — "${checkout.rejectReason}"` : ''}</div>
      )}
      {checkout.status === 'cancelled' && (
        <div style={{ marginLeft:8, padding:'2px 8px', borderRadius:20, background:'hsla(var(--color-red),0.1)', color:'hsl(var(--color-red))', fontSize:11, fontWeight:700 }}>Cancelled</div>
      )}
    </div>
  );
}

// ── Cart Drawer ────────────────────────────────────────────────────────────────
function CartDrawer({ open, cart, onClose, onRemove, onSubmit, submitting }) {
  const [days,   setDays]   = useState(1);
  const [reason, setReason] = useState('');
  useEffect(() => { if (!open) return; const h = e => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open, onClose]);
  useEffect(() => { document.body.style.overflow = open ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [open]);

  const canSubmit = cart.length > 0 && reason.trim() && !submitting;

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1100, opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none', transition:'opacity 0.25s ease' }} />
      <div style={{ position:'fixed', top:0, right:0, height:'100vh', width:'min(460px,96vw)', background:'var(--card)', boxShadow:'-12px 0 48px rgba(0,0,0,0.22)', zIndex:1101, display:'flex', flexDirection:'column', transform: open ? 'translateX(0)' : 'translateX(100%)', transition:'transform 0.28s cubic-bezier(0.4,0,0.2,1)' }}>
        <div style={{ display:'flex', alignItems:'center', padding:'18px 22px', borderBottom:'1px solid var(--line)', gap:12, flexShrink:0 }}>
          <div style={{ width:34, height:34, borderRadius:10, background:'hsla(var(--color-green),0.12)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <ShoppingCart size={17} color="hsl(var(--color-green))" />
          </div>
          <div>
            <div style={{ fontWeight:700, fontSize:15 }}>Checkout Cart</div>
            <div style={{ fontSize:12, color:'var(--muted)', marginTop:1 }}>{cart.length} item{cart.length !== 1 ? 's' : ''}</div>
          </div>
          <button onClick={onClose} style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', color:'var(--muted)', padding:6, borderRadius:8, display:'flex' }}><X size={18} /></button>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'20px 22px' }}>
          {cart.length === 0 ? (
            <div style={{ textAlign:'center', padding:'48px 0', color:'var(--muted)' }}>
              <ShoppingCart size={32} style={{ opacity:.2, display:'block', margin:'0 auto 10px' }} />
              Your cart is empty. Add items from the list.
            </div>
          ) : (
            <>
              <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:20 }}>
                {cart.map(cartItem => {
                  const tm = TYPE_META[cartItem.item.itemType] || TYPE_META.Other;
                  return (
                    <div key={cartItem.id} style={{ border:'1px solid var(--line)', borderRadius:12, padding:'12px 14px', background:'var(--card)', display:'flex', alignItems:'center', gap:12 }}>
                      <div style={{ width:40, height:40, borderRadius:8, overflow:'hidden', flexShrink:0, border:'1px solid var(--line)', background: cartItem.item.photoUrl ? 'transparent' : tm.bg, display:'flex', alignItems:'center', justifyContent:'center' }}>
                        {cartItem.item.photoUrl
                          ? <img src={cartItem.item.photoUrl} alt={cartItem.item.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                          : <tm.Icon size={18} color={tm.color} />}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontWeight:700, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{cartItem.item.name}</div>
                        <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:3, flexWrap:'wrap' }}>
                          <TypeBadge type={cartItem.item.itemType} />
                          {cartItem.item.location && (
                            <span style={{ display:'inline-flex', alignItems:'center', gap:3, fontSize:11, color:'var(--muted)' }}>
                              <MapPin size={10} /> {cartItem.item.location}
                            </span>
                          )}
                        </div>
                      </div>
                      <button onClick={() => onRemove(cartItem.id)}
                        style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', padding:4, borderRadius:6, display:'flex', flexShrink:0 }}>
                        <X size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>

              <div style={{ background:'hsla(var(--color-blue),0.06)', border:'1px solid hsla(var(--color-blue),0.2)', borderRadius:9, padding:'10px 14px', marginBottom:16, display:'flex', alignItems:'flex-start', gap:8 }}>
                <AlertCircle size={14} color="hsl(var(--color-blue))" style={{ flexShrink:0, marginTop:1 }} />
                <span style={{ fontSize:12.5, color:'hsl(var(--color-blue))', lineHeight:1.4 }}>
                  A checkout photo will be taken by the allocator when they hand over the item to you.
                </span>
              </div>

              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                <div>
                  <label style={FL}>DAYS NEEDED</label>
                  <input type="number" min={1} max={90} className="form-input" style={{ width:'100%' }}
                    value={days} onChange={e => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))} />
                </div>
                <div>
                  <label style={FL}>REASON FOR CHECKOUT <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
                  <textarea rows={3} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13 }}
                    placeholder="Briefly explain why you need these items…"
                    value={reason} onChange={e => setReason(e.target.value)} />
                </div>
              </div>
            </>
          )}
        </div>

        {cart.length > 0 && (
          <div style={{ padding:'16px 22px', borderTop:'1px solid var(--line)', flexShrink:0 }}>
            <button className="primary-btn" disabled={!canSubmit}
              style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}
              onClick={() => onSubmit({ days, reason })}>
              {submitting ? <><Loader2 size={15} style={{ animation:'spin 1s linear infinite' }} /> Submitting…</> : <><CheckCircle size={15} /> Submit {cart.length} Checkout{cart.length !== 1 ? 's' : ''}</>}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ── My Checkouts Panel ────────────────────────────────────────────────────────
function MyCheckoutsPanel({ checkouts, userEmail, userName, onReturn, onCancel }) {
  const mine = checkouts.filter(c =>
    (c.requestedByEmail && c.requestedByEmail.toLowerCase() === userEmail) ||
    c.requestedBy === userName
  );
  const active    = mine.filter(c => ['pending','approved','allocated'].includes(c.status));
  const completed = mine.filter(c => ['returned','rejected','cancelled'].includes(c.status));
  const [histOpen, setHistOpen] = useState(false);
  const [cancelId, setCancelId] = useState(null);
  const [cancelBusy, setCancelBusy] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });

  if (!mine.length) return null;

  return (
    <div style={{ marginTop:32 }}>
      <h3 style={{ fontSize:14, fontWeight:700, marginBottom:14, display:'flex', alignItems:'center', gap:8 }}>
        <Clock size={15} color="hsl(var(--color-blue))" /> My Active Checkouts
        {active.length > 0 && <span style={{ padding:'1px 8px', borderRadius:20, fontSize:11, fontWeight:700, background:'hsla(var(--color-blue),0.12)', color:'hsl(var(--color-blue))' }}>{active.length}</span>}
      </h3>

      {active.map(c => {
        const sm = CHECKOUT_STATUS_META[c.status];
        return (
          <div key={c.id} style={{ border:'1px solid var(--line)', borderRadius:12, padding:'16px 18px', marginBottom:12, background:'var(--card)', boxShadow:'var(--shadow-sm)' }}>
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10, flexWrap:'wrap', marginBottom:8 }}>
              <div>
                <div style={{ fontWeight:700, fontSize:14 }}>{c.itemName}</div>
                <div style={{ fontSize:12, color:'var(--muted)', marginTop:2 }}>
                  {c.itemType} · {c.department} · {c.days} day{c.days !== 1 ? 's' : ''}
                  {c.raisedBy && c.raisedBy !== c.requestedBy && <span style={{ color:'hsl(var(--color-blue))', marginLeft:6 }}>via {c.raisedBy}</span>}
                </div>
              </div>
              <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:sm.bg, color:sm.fg }}>
                <sm.Icon size={11} /> {sm.label}
              </span>
            </div>
            {c.reason && (
              <div style={{ fontSize:12, color:'var(--muted)', background:'var(--mist)', borderRadius:7, padding:'6px 10px', marginBottom:4 }}>"{c.reason}"</div>
            )}
            <StageTracker checkout={c} onViewPhoto={url => setPhotoPreview(url)} />
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', flexWrap:'wrap', marginTop:8 }}>
              {c.status === 'allocated' && (
                <button className="secondary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5 }}
                  onClick={() => onReturn(c)}>
                  <RotateCcw size={13} /> Return Item
                </button>
              )}
              {['pending','approved'].includes(c.status) && cancelId !== c.id && (
                <button onClick={() => setCancelId(c.id)}
                  style={{ background:'none', border:'1px solid hsla(var(--color-red),0.4)', borderRadius:8, padding:'5px 12px', fontSize:12, cursor:'pointer', color:'hsl(var(--color-red))', display:'inline-flex', alignItems:'center', gap:5, fontFamily:'Inter,sans-serif', fontWeight:600 }}>
                  <XCircle size={13} /> Cancel
                </button>
              )}
              {cancelId === c.id && (
                <div style={{ display:'flex', alignItems:'center', gap:8, background:'hsla(var(--color-red),0.05)', border:'1px solid hsla(var(--color-red),0.2)', borderRadius:8, padding:'8px 12px', flex:1 }}>
                  <span style={{ fontSize:12.5, flex:1 }}>Cancel this checkout?</span>
                  <button onClick={() => setCancelId(null)} className="secondary-btn" style={{ fontSize:12, padding:'4px 10px' }}>Keep</button>
                  <button disabled={cancelBusy === c.id}
                    style={{ background:'hsl(var(--color-red))', color:'#fff', border:'none', borderRadius:7, padding:'4px 12px', fontSize:12, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:5, fontWeight:700 }}
                    onClick={() => {
                      setCancelBusy(c.id);
                      onCancel(c).finally(() => { setCancelBusy(null); setCancelId(null); });
                    }}>
                    {cancelBusy === c.id ? <Loader2 size={12} style={{ animation:'spin 1s linear infinite' }} /> : null} Yes, Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {completed.length > 0 && (
        <div style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'hidden', marginTop:4 }}>
          <button onClick={() => setHistOpen(o => !o)}
            style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'11px 16px', background:'var(--mist)', border:'none', cursor:'pointer', fontFamily:'Inter,sans-serif', fontWeight:600, fontSize:13, color:'var(--muted)' }}>
            <History size={13} /> Past Checkouts ({completed.length}) <ChevronDown size={13} style={{ marginLeft:'auto', transform: histOpen ? 'rotate(180deg)' : 'none', transition:'transform 0.2s' }} />
          </button>
          {histOpen && completed.slice(0, 20).map(c => {
            const sm = CHECKOUT_STATUS_META[c.status];
            return (
              <div key={c.id} style={{ borderTop:'1px solid var(--line)', padding:'10px 16px', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:600, fontSize:13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.itemName}</div>
                  <div style={{ fontSize:11.5, color:'var(--muted)' }}>{fmtDate(c.createdAt)}</div>
                </div>
                <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700, background:sm.bg, color:sm.fg }}>
                  <sm.Icon size={10} /> {sm.label}
                </span>
                {c.returnPhotoUrl && (
                  <button onClick={() => setPhotoPreview(c.returnPhotoUrl)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }} title="View return photo">
                    <ZoomIn size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {photoPreview && <ImageLightbox src={photoPreview} onClose={() => setPhotoPreview(null)} />}
    </div>
  );
}

// ── Employee View ─────────────────────────────────────────────────────────────
function EmployeeView({ items, checkouts, userName, userEmail, itemsLoading, itemsError, checkoutsError, onReturn, refreshItems, submitCartCheckouts, cancelRequest, addNotification, toast }) {
  const [search,      setSearch]      = useState('');
  const [typeFilter,  setTypeFilter]  = useState('All');
  const [cartOpen,    setCartOpen]    = useState(false);
  const [cart,        setCart]        = useState([]);
  const [returningCo, setReturningCo] = useState(null);
  const [submitting,  setSubmitting]  = useState(false);

  const availableItems = items.filter(i => i.ownershipType === 'transient' && i.status === 'available');
  const filtered = availableItems.filter(i => {
    const matchSearch = !search || i.name.toLowerCase().includes(search.toLowerCase()) ||
      (i.make || '').toLowerCase().includes(search.toLowerCase()) ||
      (i.model || '').toLowerCase().includes(search.toLowerCase());
    const matchType = typeFilter === 'All' || i.itemType === typeFilter;
    return matchSearch && matchType;
  });

  const inCart = new Set(cart.map(c => c.item.id));

  function addToCart(item) {
    if (inCart.has(item.id)) return;
    setCart(prev => [...prev, { id: `cart-${Date.now()}`, item }]);
    setCartOpen(true);
  }

  function removeFromCart(cartId) {
    setCart(prev => prev.filter(c => c.id !== cartId));
  }

  async function handleSubmitCart({ days, reason }) {
    setSubmitting(true);
    const results = await submitCartCheckouts(cart, { days, reason, raisedBy: userName, raisedByEmail: userEmail });
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed    = results.filter(r => r.status === 'rejected').length;
    setSubmitting(false);
    setCartOpen(false);
    setCart([]);
    if (succeeded > 0) toast(`${succeeded} checkout${succeeded !== 1 ? 's' : ''} submitted successfully.`);
    if (failed > 0) toast(`${failed} item${failed !== 1 ? 's' : ''} could not be checked out — please try again.`, 'error');
  }

  function handleReturn(co) { setReturningCo(co); }

  function handleReturnSubmit(data) {
    return onReturn(returningCo.id, data).then(() => {
      toast(`Return confirmed — ${returningCo.itemName}`);
      setReturningCo(null);
    }).catch(() => toast(`Could not confirm return — please try again.`, 'error'));
  }

  function handleCancel(co) {
    return cancelRequest(co.id, userName).then(() => toast(`Checkout cancelled.`)).catch(() => toast('Could not cancel.', 'error'));
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, marginBottom:20, flexWrap:'wrap' }}>
        <div>
          <h2 style={{ fontSize:18, fontWeight:700, margin:0 }}>Items</h2>
          <p style={{ fontSize:13, color:'var(--muted)', margin:'2px 0 0' }}>Browse available items and check them out for a job or shift.</p>
        </div>
        <button className={cart.length ? 'primary-btn' : 'secondary-btn'}
          style={{ display:'inline-flex', alignItems:'center', gap:8, position:'relative' }}
          onClick={() => setCartOpen(true)}>
          <ShoppingCart size={15} /> Cart
          {cart.length > 0 && (
            <span style={{ position:'absolute', top:-7, right:-7, background:'hsl(var(--color-red))', color:'#fff', borderRadius:'50%', width:18, height:18, fontSize:11, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center' }}>
              {cart.length}
            </span>
          )}
        </button>
      </div>

      {/* Search + filter */}
      <div style={{ display:'flex', gap:10, marginBottom:18, flexWrap:'wrap', alignItems:'center' }}>
        <div className="search-bar" style={{ flex:'1 1 220px', minWidth:180 }}>
          <Search size={14} style={{ flexShrink:0 }} />
          <input placeholder="Search by name, make, or model…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <Filter size={13} style={{ color:'var(--muted)' }} />
          <select className="form-input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ padding:'6px 10px', fontSize:13, height:34 }}>
            <option value="All">All types</option>
            {ITEM_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <span style={{ fontSize:13, color:'var(--muted)' }}>{filtered.length} available</span>
      </div>

      {/* Item list */}
      {itemsError ? (
        <ErrorBanner message="Could not load items right now." onRetry={refreshItems} />
      ) : itemsLoading && !filtered.length ? (
        <SkeletonBlocks count={8} height={64} borderRadius={10} />
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
          <Package size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
          {search || typeFilter !== 'All' ? 'No items match your search.' : 'No items available right now.'}
        </div>
      ) : (
        <div style={{ border:'1px solid var(--line)', borderRadius:12, overflow:'hidden' }}>
          {filtered.map((item, i) => {
            const tm = TYPE_META[item.itemType] || TYPE_META.Other;
            const alreadyInCart = inCart.has(item.id);
            return (
              <div key={item.id} style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 16px', borderTop: i > 0 ? '1px solid var(--line)' : 'none', background:'var(--card)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--card)'}>
                {/* Photo */}
                <div style={{ width:44, height:44, borderRadius:8, overflow:'hidden', flexShrink:0, border:'1px solid var(--line)', background: item.photoUrl ? 'transparent' : tm.bg, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  {item.photoUrl
                    ? <img src={item.photoUrl} alt={item.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                    : <tm.Icon size={20} color={tm.color} />}
                </div>
                {/* Info */}
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:700, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.name}</div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:3, flexWrap:'wrap' }}>
                    <TypeBadge type={item.itemType} />
                    {(item.make || item.model) && (
                      <span style={{ fontSize:11.5, color:'var(--muted)' }}>{[item.make, item.model, item.year].filter(Boolean).join(' ')}</span>
                    )}
                    {item.location && (
                      <span style={{ display:'inline-flex', alignItems:'center', gap:3, fontSize:11.5, color:'var(--muted)' }}>
                        <MapPin size={10} /> {item.location}
                      </span>
                    )}
                  </div>
                </div>
                {/* Dept */}
                <span style={{ fontSize:12, color:'var(--muted)', flexShrink:0, display:'none' }}>{item.department}</span>
                {/* Action */}
                <button
                  onClick={() => addToCart(item)}
                  disabled={alreadyInCart}
                  className={alreadyInCart ? 'secondary-btn' : 'primary-btn'}
                  style={{ fontSize:12.5, padding:'6px 14px', display:'inline-flex', alignItems:'center', gap:6, flexShrink:0 }}>
                  {alreadyInCart ? <><CheckCircle size={13} /> In Cart</> : <><Plus size={13} /> Add to Cart</>}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* My checkouts */}
      <MyCheckoutsPanel
        checkouts={checkouts}
        userEmail={userEmail}
        userName={userName}
        onReturn={handleReturn}
        onCancel={handleCancel}
      />

      <CartDrawer
        open={cartOpen}
        cart={cart}
        onClose={() => setCartOpen(false)}
        onRemove={removeFromCart}
        onSubmit={handleSubmitCart}
        submitting={submitting}
      />

      {returningCo && (
        <ReturnModal checkout={returningCo} onClose={() => setReturningCo(null)} onSubmit={handleReturnSubmit} />
      )}
    </div>
  );
}

// ── Manager Catalog Tab ───────────────────────────────────────────────────────
function ManagerCatalogTab({ items, itemsLoading, itemsError, deptFilter, typeFilter, search, refreshItems, onAddToCart, inCart }) {
  const filtered = items.filter(i => {
    const mS = !search || i.name.toLowerCase().includes(search.toLowerCase()) || (i.make||'').toLowerCase().includes(search.toLowerCase()) || (i.model||'').toLowerCase().includes(search.toLowerCase());
    const mD = deptFilter === 'All' || i.department === deptFilter;
    const mT = typeFilter === 'All' || i.itemType === typeFilter;
    return mS && mD && mT;
  });

  if (itemsError) return <ErrorBanner message="Could not load items." onRetry={refreshItems} />;
  if (itemsLoading && !items.length) return <SkeletonBlocks count={8} height={64} borderRadius={10} />;
  if (!filtered.length) return (
    <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
      <Package size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
      No items match your filters.
    </div>
  );

  return (
    <>
      <div style={{ border:'1px solid var(--line)', borderRadius:12, overflow:'hidden' }}>
        {filtered.map((item, i) => {
          const tm = TYPE_META[item.itemType] || TYPE_META.Other;
          const canRequest = item.ownershipType === 'transient' && item.status === 'available' && onAddToCart;
          const alreadyInCart = inCart?.has(item.id);
          return (
            <div key={item.id}
              style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 16px', borderTop: i > 0 ? '1px solid var(--line)' : 'none', background:'var(--card)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--card)'}>
              {/* Photo */}
              <div style={{ width:44, height:44, borderRadius:8, overflow:'hidden', flexShrink:0, border:'1px solid var(--line)', background: item.photoUrl ? 'transparent' : tm.bg, display:'flex', alignItems:'center', justifyContent:'center' }}>
                {item.photoUrl
                  ? <img src={item.photoUrl} alt={item.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                  : <tm.Icon size={20} color={tm.color} />}
              </div>
              {/* Info */}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.name}</div>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:3, flexWrap:'wrap' }}>
                  <TypeBadge type={item.itemType} />
                  {(item.make || item.model) && (
                    <span style={{ fontSize:11.5, color:'var(--muted)' }}>{[item.make, item.model, item.year].filter(Boolean).join(' ')}</span>
                  )}
                  {item.location && (
                    <span style={{ display:'inline-flex', alignItems:'center', gap:3, fontSize:11.5, color:'var(--muted)' }}>
                      <MapPin size={10} /> {item.location}
                    </span>
                  )}
                  {item.department && (
                    <span style={{ fontSize:11.5, color:'var(--muted)', opacity:.7 }}>{item.department}</span>
                  )}
                </div>
              </div>
              {/* Status for non-requestable items */}
              {!canRequest && <StatusBadge status={item.status} />}
              {/* Add to Cart */}
              {canRequest && (
                <button
                  onClick={() => onAddToCart(item)}
                  disabled={alreadyInCart}
                  className={alreadyInCart ? 'secondary-btn' : 'primary-btn'}
                  style={{ fontSize:12.5, padding:'6px 14px', display:'inline-flex', alignItems:'center', gap:6, flexShrink:0 }}>
                  {alreadyInCart ? <><CheckCircle size={13} /> In Cart</> : <><Plus size={13} /> Add to Cart</>}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ fontSize:12, color:'var(--muted)', marginTop:10 }}>{filtered.length} item{filtered.length !== 1 ? 's' : ''}</p>
    </>
  );
}

// ── Manager Manage Tab ────────────────────────────────────────────────────────
function ManagerManageTab({ items, itemsLoading, itemsError, deptFilter, typeFilter, search, refreshItems, canDelete, onAdd, onEdit, onDelete, onImport, onExport, onReport }) {
  const [photoPreview, setPhotoPreview] = useState(null);
  const filtered = items.filter(i => {
    const mS = !search || i.name.toLowerCase().includes(search.toLowerCase()) || (i.make||'').toLowerCase().includes(search.toLowerCase());
    const mD = deptFilter === 'All' || i.department === deptFilter;
    const mT = typeFilter === 'All' || i.itemType === typeFilter;
    return mS && mD && mT;
  });

  const missingPhotos = items.filter(i => !i.photoUrl).length;

  if (itemsError) return <ErrorBanner message="Could not load items." onRetry={refreshItems} />;

  return (
    <>
      {/* Action bar */}
      <div style={{ display:'flex', gap:10, marginBottom:18, flexWrap:'wrap', alignItems:'center' }}>
        <button className="primary-btn" style={{ display:'inline-flex', alignItems:'center', gap:7 }} onClick={onAdd}>
          <Plus size={14} /> Add Item
        </button>
        <button className="secondary-btn" style={{ display:'inline-flex', alignItems:'center', gap:7 }} onClick={onImport}>
          <UploadCloud size={14} /> Import CSV
        </button>
        <button className="secondary-btn" style={{ display:'inline-flex', alignItems:'center', gap:7 }} onClick={onExport} disabled={!items.length}>
          <Download size={14} /> Export CSV
        </button>
        <button className="secondary-btn" style={{ display:'inline-flex', alignItems:'center', gap:7 }} onClick={onReport}>
          <FileBarChart size={14} /> Export Report
        </button>
        {missingPhotos > 0 && (
          <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6, fontSize:12.5, color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', borderRadius:8, padding:'6px 12px', border:'1px solid hsla(var(--color-red),0.25)' }}>
            <AlertCircle size={14} /> {missingPhotos} item{missingPhotos !== 1 ? 's' : ''} missing photo
          </div>
        )}
      </div>

      {itemsLoading && !items.length ? (
        <SkeletonBlocks count={8} height={52} borderRadius={8} />
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
          <Package size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
          {items.length ? 'No items match your filters.' : 'No items yet. Add one above or import a CSV.'}
        </div>
      ) : (
        <div style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'var(--mist)' }}>
                {['Photo','Name','Type','Make / Model','Dept','Location','Ownership','Status',''].map(h =>
                  <th key={h} style={{ textAlign:'left', padding:'10px 14px', fontWeight:700, color:'var(--muted)', whiteSpace:'nowrap', fontSize:11.5 }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => (
                <tr key={item.id} style={{ borderTop:'1px solid var(--line)' }}>
                  <td style={{ padding:'10px 14px' }}>
                    {item.photoUrl
                      ? <PhotoThumb url={item.photoUrl} size={40} onPreview={url => setPhotoPreview(url)} />
                      : (
                        <div style={{ width:40, height:40, borderRadius:8, background:'hsla(var(--color-red),0.08)', border:'1px dashed hsla(var(--color-red),0.4)', display:'flex', alignItems:'center', justifyContent:'center' }} title="Missing photo — required">
                          <Camera size={16} color="hsl(var(--color-red))" />
                        </div>
                      )
                    }
                  </td>
                  <td style={{ padding:'10px 14px', fontWeight:600 }}>{item.name}</td>
                  <td style={{ padding:'10px 14px' }}><TypeBadge type={item.itemType} /></td>
                  <td style={{ padding:'10px 14px', color:'var(--muted)', fontSize:12 }}>{[item.make, item.model, item.year].filter(Boolean).join(' ') || '—'}</td>
                  <td style={{ padding:'10px 14px', color:'var(--muted)', fontSize:12 }}>{item.department || '—'}</td>
                  <td style={{ padding:'10px 14px', color:'var(--muted)', fontSize:12 }}>{item.location || '—'}</td>
                  <td style={{ padding:'10px 14px' }}>
                    <span style={{ fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:20, background: item.ownershipType === 'permanent' ? 'hsla(var(--color-purple),0.1)' : 'hsla(var(--color-blue),0.1)', color: item.ownershipType === 'permanent' ? 'hsl(var(--color-purple))' : 'hsl(var(--color-blue))' }}>
                      {item.ownershipType === 'permanent' ? 'Permanent' : 'Transient'}
                    </span>
                  </td>
                  <td style={{ padding:'10px 14px' }}><StatusBadge status={item.status} /></td>
                  <td style={{ padding:'10px 14px' }}>
                    <div style={{ display:'flex', gap:6 }}>
                      <button onClick={() => onEdit(item)} title={`Edit ${item.name}`}
                        style={{ display:'inline-flex', alignItems:'center', gap:4, background:'none', border:'1px solid var(--line)', borderRadius:7, padding:'5px 10px', color:'var(--muted)', fontSize:11.5, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                        <Pencil size={12} /> Edit
                      </button>
                      {canDelete && (
                        <button onClick={() => onDelete(item)} title={`Delete ${item.name}`}
                          style={{ display:'inline-flex', alignItems:'center', gap:4, background:'none', border:'1px solid hsla(var(--color-red),0.35)', borderRadius:7, padding:'5px 10px', color:'hsl(var(--color-red))', fontSize:11.5, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                          <Trash2 size={12} /> Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ fontSize:12, color:'var(--muted)', marginTop:10 }}>{filtered.length} item{filtered.length !== 1 ? 's' : ''} shown · {items.length} total</p>
      {photoPreview && <ImageLightbox src={photoPreview} onClose={() => setPhotoPreview(null)} />}
    </>
  );
}

// ── Allocate Modal (manager/allocator takes checkout photo here) ───────────────
function AllocateModal({ checkout, onClose, onConfirm }) {
  const [file,       setFile]       = useState(null);
  const [preview,    setPreview]    = useState('');
  const [uploading,  setUploading]  = useState(false);
  const [error,      setError]      = useState('');
  const fileRef = useRef(null);
  useEscapeKey(onClose);

  function handleFile(f) {
    if (!f) return;
    setFile(f);
    const reader = new FileReader();
    reader.onload = e => setPreview(e.target.result);
    reader.readAsDataURL(f);
  }

  async function submit() {
    if (!file || uploading) return;
    setUploading(true); setError('');
    const path = `checkout-photos/${checkout.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { url, error: upErr } = await uploadToSupabase(file, 'checkout-photos', path);
    if (upErr) { setError(upErr); setUploading(false); return; }
    Promise.resolve(onConfirm(url, file.name))
      .then(onClose)
      .catch(err => { setError(err?.message || 'Could not mark as allocated.'); setUploading(false); });
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:420, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Hand Over Item</h3>
        <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:20 }}>
          Allocating <strong>{checkout.itemName}</strong> to <strong>{checkout.requestedBy}</strong>. Take a clear photo of the item condition before handing over.
        </p>
        <div>
          <label style={FL}>CHECKOUT PHOTO <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
          <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }} onChange={e => handleFile(e.target.files?.[0])} />
          {preview ? (
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <img src={preview} alt="Checkout photo" style={{ width:72, height:72, objectFit:'cover', borderRadius:8, border:'1px solid var(--line)' }} />
              <button type="button" className="secondary-btn" style={{ fontSize:12 }} onClick={() => fileRef.current?.click()}>Replace</button>
            </div>
          ) : (
            <button type="button" onClick={() => fileRef.current?.click()}
              style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'12px', borderRadius:9, border:'2px dashed hsla(var(--color-red),0.4)', background:'hsla(var(--color-red),0.04)', cursor:'pointer', fontSize:13, color:'var(--muted)' }}>
              <Camera size={15} /> Take / Upload Photo
            </button>
          )}
        </div>
        {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:10 }}>{error}</p>}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
          <button className="primary-btn" disabled={!file || uploading}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:140, justifyContent:'center' }} onClick={submit}>
            {uploading ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Uploading…</> : <><CheckCircle size={14} /> Confirm Handover</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Approve Modal (manager picks allocator) ───────────────────────────────────
function ApproveCheckoutModal({ checkout, onClose, onConfirm }) {
  const [allocators,  setAllocators]  = useState([]);
  const [pickedEmail, setPickedEmail] = useState('');
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState('');
  useEscapeKey(onClose);

  useEffect(() => {
    api.getItemAllocators().then(setAllocators).catch(() => {});
  }, []);

  function submit() {
    const chosen = allocators.find(a => a.email === pickedEmail);
    if (!chosen || busy) return;
    setBusy(true); setError('');
    Promise.resolve(onConfirm(chosen.email, chosen.name))
      .then(onClose)
      .catch(err => { setError(err?.message || 'Could not approve.'); setBusy(false); });
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:400, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Approve Checkout</h3>
        <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:20 }}>
          Approving <strong>{checkout.itemName}</strong> for <strong>{checkout.requestedBy}</strong>. Assign who will physically hand over the item.
        </p>
        <div>
          <label style={FL}>ASSIGN ALLOCATOR <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
          <select className="form-input" style={{ width:'100%' }} value={pickedEmail} onChange={e => setPickedEmail(e.target.value)}>
            <option value="">— select allocator —</option>
            {allocators.map(a => <option key={a.email} value={a.email}>{a.name} ({a.role})</option>)}
          </select>
        </div>
        {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:10 }}>{error}</p>}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" disabled={!pickedEmail || busy}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:120, justifyContent:'center' }} onClick={submit}>
            {busy ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Approving…</> : <><CheckCircle size={14} /> Approve</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Reject Modal ──────────────────────────────────────────────────────────────
function RejectCheckoutModal({ checkout, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  const [busy,   setBusy]   = useState(false);
  useEscapeKey(onClose);

  function submit() {
    if (!reason.trim() || busy) return;
    setBusy(true);
    Promise.resolve(onConfirm(reason.trim()))
      .then(onClose)
      .catch(() => setBusy(false));
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:380, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Reject Checkout</h3>
        <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:16 }}>Rejecting <strong>{checkout.itemName}</strong> for {checkout.requestedBy}. Give a reason.</p>
        <textarea rows={3} autoFocus className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13, marginBottom:16 }}
          placeholder="Reason for rejection…" value={reason} onChange={e => setReason(e.target.value)} />
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button disabled={!reason.trim() || busy}
            style={{ background:'hsl(var(--color-red))', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', fontWeight:700, fontSize:13.5, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:7, fontFamily:'Inter,sans-serif' }}
            onClick={submit}>
            {busy ? <Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> : <XCircle size={14} />} Reject
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Manager Checkouts Tab ─────────────────────────────────────────────────────
function ManagerCheckoutsTab({ checkouts, items, userName, userEmail, approveRequest, rejectRequest, allocateItem, refreshCheckouts, refreshItems, toast }) {
  const [statusFilter, setStatusFilter] = useState('active');
  const [approvingCo,  setApprovingCo]  = useState(null);
  const [rejectingCo,  setRejectingCo]  = useState(null);
  const [allocatingCo, setAllocatingCo] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);

  const filtered = checkouts.filter(c => {
    if (statusFilter === 'active')    return ['pending','approved','allocated'].includes(c.status);
    if (statusFilter === 'completed') return ['returned','rejected','cancelled'].includes(c.status);
    return c.status === statusFilter;
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const pending  = checkouts.filter(c => c.status === 'pending').length;
  const approved = checkouts.filter(c => c.status === 'approved').length;

  function handleApprove(co, allocEmail, allocName) {
    return approveRequest(co.id, userName, allocEmail, allocName)
      .then(() => { toast(`Approved checkout for ${co.requestedBy} — assigned to ${allocName}.`); refreshCheckouts(); });
  }

  function handleReject(co, reason) {
    rejectRequest(co.id, userName, reason);
    toast(`Checkout rejected.`);
    refreshCheckouts();
  }

  function handleAllocate(co, photoUrl, photoName) {
    return allocateItem(co.id, userName, photoUrl)
      .then(() => { toast(`Item handed over to ${co.requestedBy} — checkout confirmed.`); refreshCheckouts(); refreshItems(); });
  }

  const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric' });

  return (
    <div>
      {/* Summary chips */}
      <div style={{ display:'flex', gap:10, marginBottom:18, flexWrap:'wrap', alignItems:'center' }}>
        {[
          { key:'active',    label:'Active', count: pending + approved + checkouts.filter(c => c.status === 'allocated').length },
          { key:'pending',   label:'Pending approval', count: pending },
          { key:'approved',  label:'Awaiting handover', count: approved },
          { key:'completed', label:'Completed', count: checkouts.filter(c => ['returned','rejected','cancelled'].includes(c.status)).length },
        ].map(f => (
          <button key={f.key} onClick={() => setStatusFilter(f.key)}
            style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'6px 14px', borderRadius:20, border:`1px solid ${statusFilter === f.key ? 'var(--pine)' : 'var(--line)'}`, background: statusFilter === f.key ? 'hsla(var(--color-green),0.1)' : 'transparent', color: statusFilter === f.key ? 'hsl(var(--color-green))' : 'var(--muted)', fontWeight: statusFilter === f.key ? 700 : 500, fontSize:12.5, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            {f.label}
            {f.count > 0 && <span style={{ background: statusFilter === f.key ? 'hsl(var(--color-green))' : 'var(--muted)', color:'#fff', borderRadius:20, fontSize:10, fontWeight:800, padding:'1px 6px', minWidth:18, textAlign:'center' }}>{f.count}</span>}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
          <ShoppingCart size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
          No checkouts in this filter.
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {filtered.map(co => {
            const sm = CHECKOUT_STATUS_META[co.status] || { label: co.status, bg:'var(--mist)', fg:'var(--muted)', Icon: Package };
            const item = items.find(i => i.id === co.itemId);
            const isMyAlloc = co.assignedAllocatorEmail && co.assignedAllocatorEmail.toLowerCase() === userEmail;
            return (
              <div key={co.id} style={{ border:'1px solid var(--line)', borderRadius:12, padding:'16px 18px', background:'var(--card)', boxShadow:'var(--shadow-sm)' }}>
                <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                    {item?.photoUrl
                      ? <img src={item.photoUrl} alt={co.itemName} style={{ width:44, height:44, borderRadius:8, objectFit:'cover', border:'1px solid var(--line)', flexShrink:0 }} />
                      : <div style={{ width:44, height:44, borderRadius:8, background:'var(--mist)', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}><Package size={18} style={{ opacity:.4 }} /></div>}
                    <div>
                      <div style={{ fontWeight:700, fontSize:14 }}>{co.itemName}</div>
                      <div style={{ fontSize:12, color:'var(--muted)', marginTop:2 }}>
                        {co.requestedBy} · {co.department} · {co.days} day{co.days !== 1 ? 's' : ''} · {fmtDate(co.createdAt)}
                      </div>
                      {co.reason && <div style={{ fontSize:12, color:'var(--muted)', fontStyle:'italic', marginTop:2 }}>"{co.reason}"</div>}
                      {co.assignedAllocatorName && co.status === 'approved' && (
                        <div style={{ fontSize:11.5, color:'hsl(var(--color-blue))', marginTop:3 }}>Allocator: {co.assignedAllocatorName}</div>
                      )}
                    </div>
                  </div>
                  <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:sm.bg, color:sm.fg, flexShrink:0 }}>
                    <sm.Icon size={11} /> {sm.label}
                  </span>
                </div>

                {/* Photos row */}
                {(co.checkoutPhotoUrl || co.returnPhotoUrl) && (
                  <div style={{ display:'flex', gap:10, marginTop:12 }}>
                    {co.checkoutPhotoUrl && (
                      <button onClick={() => setPhotoPreview(co.checkoutPhotoUrl)} style={{ display:'flex', alignItems:'center', gap:5, background:'none', border:'1px solid var(--line)', borderRadius:7, padding:'4px 10px', cursor:'pointer', fontSize:11.5, color:'var(--muted)', fontFamily:'Inter,sans-serif' }}>
                        <ZoomIn size={12} /> Checkout photo
                      </button>
                    )}
                    {co.returnPhotoUrl && (
                      <button onClick={() => setPhotoPreview(co.returnPhotoUrl)} style={{ display:'flex', alignItems:'center', gap:5, background:'none', border:'1px solid var(--line)', borderRadius:7, padding:'4px 10px', cursor:'pointer', fontSize:11.5, color:'var(--muted)', fontFamily:'Inter,sans-serif' }}>
                        <ZoomIn size={12} /> Return photo
                      </button>
                    )}
                  </div>
                )}

                {/* Action buttons */}
                <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:12, flexWrap:'wrap' }}>
                  {co.status === 'pending' && (
                    <>
                      <button onClick={() => setRejectingCo(co)}
                        style={{ background:'none', border:'1px solid hsla(var(--color-red),0.4)', borderRadius:8, padding:'6px 14px', fontSize:12.5, cursor:'pointer', color:'hsl(var(--color-red))', fontWeight:600, display:'inline-flex', alignItems:'center', gap:5, fontFamily:'Inter,sans-serif' }}>
                        <XCircle size={13} /> Reject
                      </button>
                      <button className="primary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5 }}
                        onClick={() => setApprovingCo(co)}>
                        <CheckCircle size={13} /> Approve
                      </button>
                    </>
                  )}
                  {co.status === 'approved' && (isMyAlloc || true) && (
                    <button className="primary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5, background:'hsl(var(--color-orange))' }}
                      onClick={() => setAllocatingCo(co)}>
                      <Camera size={13} /> Hand Over + Photo
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {approvingCo && (
        <ApproveCheckoutModal
          checkout={approvingCo} onClose={() => setApprovingCo(null)}
          onConfirm={(email, name) => handleApprove(approvingCo, email, name)} />
      )}
      {rejectingCo && (
        <RejectCheckoutModal
          checkout={rejectingCo} onClose={() => setRejectingCo(null)}
          onConfirm={reason => handleReject(rejectingCo, reason)} />
      )}
      {allocatingCo && (
        <AllocateModal
          checkout={allocatingCo} onClose={() => setAllocatingCo(null)}
          onConfirm={(url, name) => handleAllocate(allocatingCo, url, name)} />
      )}
      {photoPreview && <ImageLightbox src={photoPreview} onClose={() => setPhotoPreview(null)} />}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────
export default function InventoryManagement({ activeSub }) {
  const {
    items, itemsLoading, itemsError,
    checkouts, checkoutsLoading, checkoutsError,
    submitCartCheckouts, approveRequest, rejectRequest,
    allocateItem, returnItem, cancelRequest,
    refreshItems, refreshCheckouts,
  } = useInventory();
  const { addNotification } = useNotifications();
  const { can, canAccessModule, loading: roleLoading } = useRole();
  const { accounts } = useMsal();
  const userName  = accounts[0]?.name     ?? 'Employee';
  const userEmail = (accounts[0]?.username ?? '').toLowerCase();

  const isManager = can('manager');  // level >= 3; checked after role loads
  const canDelete = canAccessModule('inventory', 'owner', 'full');

  const pendingCount  = checkouts.filter(c => c.status === 'pending').length;
  const approvedCount = checkouts.filter(c => c.status === 'approved').length;

  // Cart — available to everyone
  const [cart,        setCart]        = useState([]);
  const [cartOpen,    setCartOpen]    = useState(false);
  const [cartBusy,    setCartBusy]    = useState(false);
  const [returningCo, setReturningCo] = useState(null);

  const inCart = new Set(cart.map(c => c.item.id));
  function addToCart(item) {
    if (inCart.has(item.id)) return;
    setCart(prev => [...prev, { id: `cart-${Date.now()}`, item }]);
    setCartOpen(true);
  }
  async function handleSubmitCart({ days, reason }) {
    setCartBusy(true);
    const results = await submitCartCheckouts(cart, { days, reason, raisedBy: userName, raisedByEmail: userEmail });
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed    = results.filter(r => r.status === 'rejected').length;
    setCartBusy(false); setCartOpen(false); setCart([]);
    if (succeeded > 0) toast(`${succeeded} checkout${succeeded !== 1 ? 's' : ''} submitted.`);
    if (failed > 0)    toast(`${failed} checkout${failed !== 1 ? 's' : ''} failed — please retry.`, 'error');
  }

  // Manager-only tab/modal state
  const [mainTab,      setMainTab]      = useState('catalog');
  const [deptFilter,   setDeptFilter]   = useState('All');
  const [typeFilter,   setTypeFilter]   = useState('All');
  const [search,       setSearch]       = useState('');
  const [addItemOpen,  setAddItemOpen]  = useState(false);
  const [editingItem,  setEditingItem]  = useState(null);
  const [deletingItem, setDeletingItem] = useState(null);
  const [importOpen,   setImportOpen]   = useState(false);
  const [reportOpen,   setReportOpen]   = useState(false);

  const [toasts, setToasts] = useState([]);
  const toast = useCallback((message, kind = 'success') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts(prev => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), kind === 'error' ? 6000 : 4000);
  }, []);
  const dismissToast = id => setToasts(prev => prev.filter(t => t.id !== id));

  function handleAddItem(data) {
    return api.createItem(data)
      .then(() => { refreshItems(); toast(`Added "${data.name}" to the catalog.`); })
      .catch(err => { toast(err?.message || 'Could not add item.', 'error'); throw err; });
  }
  function handleEditItem(item, data) {
    return api.updateItem(item.id, data)
      .then(() => { refreshItems(); toast(`Updated "${data.name}".`); })
      .catch(err => { toast(err?.message || 'Could not save changes.', 'error'); throw err; });
  }
  function handleDeleteItem(item) {
    return api.deleteItem(item.id)
      .then(() => { refreshItems(); toast(`Deleted "${item.name}".`); setDeletingItem(null); })
      .catch(err => { toast(err?.message || 'Could not delete item.', 'error'); throw err; });
  }
  function handleImport(rows) {
    return api.importItems(rows)
      .then(res => { refreshItems(); toast(`Imported ${res.created} item${res.created !== 1 ? 's' : ''}.`); return res; })
      .catch(err => { toast(err?.message || 'Import failed.', 'error'); throw err; });
  }

  if (roleLoading) return <SkeletonBlocks count={6} height={56} borderRadius={10} />;

  // ── Unified view for all roles ────────────────────────────────────────────────
  // Non-managers see Catalog (with cart) + My Checkouts only.
  // Managers see all tabs + the same cart.
  if (!isManager) {
    return (
      <>
        <EmployeeView
          items={items} checkouts={checkouts}
          userName={userName} userEmail={userEmail}
          itemsLoading={itemsLoading} itemsError={itemsError}
          onReturn={(id, data) => returnItem(id, data)}
          refreshItems={refreshItems}
          submitCartCheckouts={submitCartCheckouts}
          cancelRequest={cancelRequest}
          addNotification={addNotification}
          toast={toast}
        />
        <Toast toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  // Manager view — same cart available via button in header
  return (
    <div style={{ animation:'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Header */}
      <div className="view-header" style={{ marginBottom:0 }}>
        <div className="view-title-group">
          <h2>Items</h2>
          <p>Company assets across all departments and locations</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          {/* Cart button — managers can also check out items */}
          <button className={cart.length ? 'primary-btn' : 'secondary-btn'}
            style={{ display:'inline-flex', alignItems:'center', gap:7, position:'relative' }}
            onClick={() => setCartOpen(true)}>
            <ShoppingCart size={14} /> Cart
            {cart.length > 0 && (
              <span style={{ position:'absolute', top:-7, right:-7, background:'hsl(var(--color-red))', color:'#fff', borderRadius:'50%', width:17, height:17, fontSize:10, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center' }}>
                {cart.length}
              </span>
            )}
          </button>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <Filter size={13} style={{ color:'var(--muted)' }} />
            <select className="form-input" value={deptFilter} onChange={e => setDeptFilter(e.target.value)} style={{ padding:'6px 10px', fontSize:13, height:34 }}>
              {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
          <select className="form-input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ padding:'6px 10px', fontSize:13, height:34 }}>
            <option value="All">All types</option>
            {ITEM_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {/* KPI strip */}
      <div className="kpi-grid" style={{ gridTemplateColumns:'repeat(4,1fr)', margin:'16px 0 20px' }}>
        {[
          { label:'Total Items',    value: items.length,                                          color:'card-blue'   },
          { label:'Available',      value: items.filter(i => i.status === 'available').length,    color:'card-green'  },
          { label:'Checked Out',    value: items.filter(i => i.status === 'checked_out').length,  color:'card-orange' },
          { label:'Missing Photos', value: items.filter(i => !i.photoUrl).length,                 color: items.filter(i => !i.photoUrl).length > 0 ? 'card-red' : '' },
        ].map(({ label, value, color }) => (
          <div key={label} className={`kpi-card ${color}`}>
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{value}</div>
          </div>
        ))}
      </div>

      {/* Tab strip */}
      <div style={{ display:'flex', gap:0, marginBottom:20, borderBottom:'1px solid var(--line)', flexWrap:'wrap' }}>
        {[
          { id:'catalog',   label:'Catalog',   Icon: Package,       badge: 0 },
          { id:'manage',    label:'Manage',    Icon: ClipboardList, badge: 0 },
          { id:'checkouts', label:'Checkouts', Icon: ShoppingCart,  badge: pendingCount + approvedCount },
          { id:'audit',     label:'Audit Log', Icon: History,       badge: 0 },
        ].map(({ id, label, Icon, badge }) => (
          <button key={id} onClick={() => setMainTab(id)}
            style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'10px 16px', background:'none', border:'none', borderBottom: mainTab === id ? '2px solid var(--pine)' : '2px solid transparent', color: mainTab === id ? 'var(--ink)' : 'var(--muted)', fontWeight: mainTab === id ? 700 : 600, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif', marginBottom:-1 }}>
            <Icon size={14} /> {label}
            {badge > 0 && <span style={{ background:'hsl(var(--color-orange))', color:'#fff', borderRadius:20, fontSize:10, fontWeight:800, padding:'1px 6px', marginLeft:2 }}>{badge}</span>}
          </button>
        ))}
        {(mainTab === 'catalog' || mainTab === 'manage') && (
          <div className="search-bar" style={{ marginLeft:'auto', width:220, marginBottom:0 }}>
            <Search size={14} style={{ flexShrink:0 }} />
            <input placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        )}
      </div>

      {/* Tab content */}
      {mainTab === 'catalog' && (
        <ManagerCatalogTab
          items={items} itemsLoading={itemsLoading} itemsError={itemsError}
          deptFilter={deptFilter} typeFilter={typeFilter} search={search}
          refreshItems={refreshItems}
          onAddToCart={addToCart} inCart={inCart}
        />
      )}
      {mainTab === 'manage' && (
        <ManagerManageTab
          items={items} itemsLoading={itemsLoading} itemsError={itemsError}
          deptFilter={deptFilter} typeFilter={typeFilter} search={search}
          refreshItems={refreshItems} canDelete={canDelete}
          onAdd={() => setAddItemOpen(true)}
          onEdit={setEditingItem}
          onDelete={setDeletingItem}
          onImport={() => setImportOpen(true)}
          onExport={() => downloadItemsCsv(items)}
          onReport={() => setReportOpen(true)}
        />
      )}
      {mainTab === 'checkouts' && (
        <ManagerCheckoutsTab
          checkouts={checkouts} items={items}
          userName={userName} userEmail={userEmail}
          approveRequest={approveRequest} rejectRequest={rejectRequest}
          allocateItem={allocateItem} refreshCheckouts={refreshCheckouts}
          refreshItems={refreshItems} toast={toast}
        />
      )}
      {mainTab === 'audit' && <AuditLogPanel />}

      {/* My checkouts — visible to managers too */}
      {mainTab === 'catalog' && (
        <MyCheckoutsPanel
          checkouts={checkouts} userEmail={userEmail} userName={userName}
          onReturn={co => setReturningCo(co)}
          onCancel={co => cancelRequest(co.id, userName).then(() => toast('Checkout cancelled.')).catch(() => toast('Could not cancel.', 'error'))}
        />
      )}

      {/* Modals */}
      {addItemOpen  && <AddItemModal   onClose={() => setAddItemOpen(false)}  onSave={handleAddItem} />}
      {editingItem  && <EditItemModal  item={editingItem} onClose={() => setEditingItem(null)} onSave={data => handleEditItem(editingItem, data)} />}
      {deletingItem && <DeleteItemModal item={deletingItem} onClose={() => setDeletingItem(null)} onConfirm={() => handleDeleteItem(deletingItem)} />}
      {importOpen   && <ImportItemsModal onClose={() => setImportOpen(false)} onImport={handleImport} />}
      {reportOpen   && <ReportModal onClose={() => setReportOpen(false)} />}
      {returningCo  && (
        <ReturnModal checkout={returningCo} onClose={() => setReturningCo(null)}
          onSubmit={data => returnItem(returningCo.id, data).then(() => { toast(`Return confirmed — ${returningCo.itemName}`); setReturningCo(null); })} />
      )}

      <CartDrawer
        open={cartOpen} cart={cart}
        onClose={() => setCartOpen(false)}
        onRemove={id => setCart(prev => prev.filter(c => c.id !== id))}
        onSubmit={handleSubmitCart}
        submitting={cartBusy}
      />

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
