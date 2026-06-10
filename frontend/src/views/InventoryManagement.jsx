import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Package, Plus, Search, CheckCircle, Clock, XCircle, RotateCcw, Camera,
  AlertCircle, X, Loader2, ChevronDown, UploadCloud, FileSpreadsheet,
  Download, Pencil, Trash2, MapPin, ClipboardList, History, FileBarChart,
  ShoppingCart, Filter, ZoomIn, Car, Wrench, Key, Monitor, Box, FileText,
  ArrowLeft, ChevronRight, Megaphone, ArrowUpDown, Send, Users, Image, LayoutGrid, User,
} from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { useInventory }     from '../contexts/InventoryContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useRole }          from '../contexts/RoleContext';
import { api }              from '../api';
import { supabase }         from '../lib/supabase';
import { useMsal }          from '@azure/msal-react';
import { cleanName }        from '../lib/utils';

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
  pending:         { label: 'Pending',            bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))', Icon: Clock },
  approved:        { label: 'Awaiting Handover',  bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: Package },
  pending_receipt: { label: 'Confirm Receipt',    bg: 'hsla(var(--color-purple),0.12)', fg: 'hsl(var(--color-purple))', Icon: Camera },
  allocated:       { label: 'In Use',             bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))',  Icon: CheckCircle },
  rejected:        { label: 'Rejected',           bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))',    Icon: XCircle },
  returned:        { label: 'Returned',           bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: RotateCcw },
  cancelled:       { label: 'Cancelled',          bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))',    Icon: XCircle },
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
          <div style={{ fontSize:13, color:'var(--ink)', lineHeight:1.4, flex:1 }}>{t.message}</div>
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

// ── Audit helpers ─────────────────────────────────────────────────────────────
function formatAuditDetails(action, rawDetails) {
  let d = {};
  try { d = JSON.parse(rawDetails || '{}'); } catch { return rawDetails || '—'; }
  const a = (action || '').toLowerCase();
  const skip = new Set(['path', 'status']);

  if (a.includes('checkout') || a.includes('checked out')) {
    const parts = [];
    if (d.item_name) parts.push(d.item_name);
    if (d.item_type) parts.push(`(${d.item_type})`);
    if (d.days)      parts.push(`for ${d.days} day${d.days !== 1 ? 's' : ''}`);
    if (d.reason)    parts.push(`— "${d.reason}"`);
    if (d.department) parts.push(`[${d.department}]`);
    return parts.length ? parts.join(' ') : '—';
  }
  if (a.includes('deleted item cart') || (a.includes('cart') && a.includes('delet'))) {
    return 'Removed item from cart';
  }
  if (a.includes('approved')) {
    const parts = [];
    if (d.item_name) parts.push(d.item_name);
    if (d.allocator_name) parts.push(`→ assigned to ${d.allocator_name}`);
    return parts.length ? parts.join(' ') : '—';
  }
  if (a.includes('rejected')) {
    const parts = [];
    if (d.item_name) parts.push(d.item_name);
    if (d.reason)    parts.push(`Reason: "${d.reason}"`);
    return parts.join(' — ') || '—';
  }
  if (a.includes('return')) {
    return d.item_name ? `${d.item_name} returned` : '—';
  }
  if (a.includes('allocated') || a.includes('hand over')) {
    return d.item_name ? `${d.item_name} handed over${d.requested_by ? ` to ${d.requested_by}` : ''}` : '—';
  }

  // Generic fallback — drop path/status, render remaining keys in plain English
  const entries = Object.entries(d).filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== '');
  return entries.length ? entries.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') : '—';
}

function orderActivitySummary(orderItems) {
  const first = orderItems[0];
  const returned  = orderItems.filter(c => c.status === 'returned');
  const rejected  = orderItems.filter(c => c.status === 'rejected');
  const cancelled = orderItems.filter(c => c.status === 'cancelled');

  const fmtFull = iso => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month:'numeric', day:'numeric', year:'numeric' })
      + ' at ' + d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  };
  const duration = (fromIso, toIso) => {
    const ms = new Date(toIso) - new Date(fromIso);
    if (ms <= 0) return null;
    const totalMins = Math.round(ms / 60000);
    const days  = Math.floor(totalMins / 1440);
    const hours = Math.floor((totalMins % 1440) / 60);
    const mins  = totalMins % 60;
    const parts = [];
    if (days)  parts.push(`${days} day${days  !== 1 ? 's' : ''}`);
    if (hours) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
    if (!days && !hours && mins) parts.push(`${mins} minute${mins !== 1 ? 's' : ''}`);
    return parts.join(' and ') || null;
  };

  const who    = first.requestedBy;
  const items  = orderItems.length > 1 ? `${orderItems.length} items` : first.itemName;
  const them   = orderItems.length > 1 ? 'them' : 'it';

  if (cancelled.length === orderItems.length) {
    return `${who} cancelled their request for ${items} on ${fmtFull(first.createdAt)}.`;
  }
  if (rejected.length === orderItems.length) {
    const reason = rejected[0].rejectReason;
    return `${who} requested ${items} on ${fmtFull(first.createdAt)} — request was rejected${reason ? ` ("${reason}")` : ''}.`;
  }
  if (returned.length > 0) {
    const allocator = returned[0].assignedAllocatorName || 'the allocator';
    const returnTs  = returned[0].returnedAt;
    const dur       = returnTs ? duration(first.createdAt, returnTs) : null;
    return `${who} checked out ${items} on ${fmtFull(first.createdAt)} and returned ${them} to ${allocator}${returnTs ? ` on ${fmtFull(returnTs)}` : ''}${dur ? ` for a total of ${dur}` : ''}.`;
  }
  return null;
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
                  <td style={{ padding:'9px 14px', color:'var(--muted)' }}>{formatAuditDetails(log.action, log.details)}</td>
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
  { key:'pending',         label:'Submitted'   },
  { key:'approved',        label:'Approved'    },
  { key:'pending_receipt', label:'Handed Over' },
  { key:'allocated',       label:'In Use'      },
  { key:'returned',        label:'Returned'    },
];
function StageTracker({ checkout }) {
  const ORDER = ['pending','approved','pending_receipt','allocated','returned'];
  // Treat 'allocated' reached directly (no pending_receipt) as if pending_receipt was passed
  let status = checkout.status;
  if (status === 'allocated' && !checkout.handedOverAt && checkout.handoverPhotoBy !== 'employee') {
    // allocator-direct path: skip the pending_receipt dot visually by treating it as done
  }
  const idx = ORDER.indexOf(status);
  const isRejected  = checkout.status === 'rejected';
  const isCancelled = checkout.status === 'cancelled';

  if (isRejected || isCancelled) return (
    <div style={{ marginTop:8, fontSize:12, color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', borderRadius:6, padding:'4px 10px', display:'inline-block' }}>
      {isRejected ? `Rejected${checkout.rejectReason ? ` — "${checkout.rejectReason}"` : ''}` : 'Cancelled'}
    </div>
  );

  return (
    <div style={{ display:'flex', alignItems:'center', margin:'10px 0 6px' }}>
      {STAGES.map((stage, i) => {
        const done    = i < idx;
        const current = i === idx;
        return (
          <React.Fragment key={stage.key}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
              <div style={{ width:10, height:10, borderRadius:'50%', transition:'background 0.2s',
                background: done ? 'hsl(var(--color-green))' : current ? 'hsl(var(--color-blue))' : 'var(--line)',
                outline: current ? '2px solid hsla(var(--color-blue),0.3)' : 'none', outlineOffset:2 }} />
              <span style={{ fontSize:9.5, fontWeight: current ? 700 : 400, whiteSpace:'nowrap',
                color: done ? 'hsl(var(--color-green))' : current ? 'hsl(var(--color-blue))' : 'var(--muted)' }}>
                {stage.label}
              </span>
            </div>
            {i < STAGES.length - 1 && (
              <div style={{ flex:1, height:2, marginBottom:13, marginLeft:4, marginRight:4, transition:'background 0.2s',
                background: done ? 'hsl(var(--color-green))' : 'var(--line)' }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Cart Drawer ────────────────────────────────────────────────────────────────
function CartDrawer({ open, cart, onClose, onRemove, onSubmit, submitting, onDaysChange }) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (!open) return; const h = e => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open, onClose]);
  useEffect(() => { document.body.style.overflow = open ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [open]);

  const canSubmit = cart.length > 0 && reason.trim() && !submitting;

  function applyDaysToAll(days) {
    cart.forEach(c => onDaysChange(c.id, days));
  }

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
              {/* Per-item days */}
              <div style={{ marginBottom:6 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                  <label style={{ ...FL, marginBottom:0 }}>DAYS NEEDED PER ITEM</label>
                  <button onClick={() => applyDaysToAll(cart[0]?.days ?? 1)}
                    style={{ fontSize:11, color:'hsl(var(--color-blue))', background:'none', border:'none', cursor:'pointer', padding:'2px 6px', fontFamily:'Inter,sans-serif' }}>
                    Apply first to all
                  </button>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:20 }}>
                  {cart.map(cartItem => {
                    const tm = TYPE_META[cartItem.item.itemType] || TYPE_META.Other;
                    const itemDays = cartItem.days ?? 1;
                    return (
                      <div key={cartItem.id} style={{ border:'1px solid var(--line)', borderRadius:12, padding:'10px 14px', background:'var(--card)', display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ width:36, height:36, borderRadius:7, overflow:'hidden', flexShrink:0, border:'1px solid var(--line)', background: cartItem.item.photoUrl ? 'transparent' : tm.bg, display:'flex', alignItems:'center', justifyContent:'center' }}>
                          {cartItem.item.photoUrl
                            ? <img src={cartItem.item.photoUrl} alt={cartItem.item.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                            : <tm.Icon size={16} color={tm.color} />}
                        </div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontWeight:700, fontSize:13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{cartItem.item.name}</div>
                          <div style={{ display:'flex', alignItems:'center', gap:5, marginTop:2 }}>
                            <TypeBadge type={cartItem.item.itemType} />
                            {cartItem.item.location && <span style={{ fontSize:10.5, color:'var(--muted)' }}><MapPin size={9} style={{ display:'inline', marginRight:2 }} />{cartItem.item.location}</span>}
                          </div>
                        </div>
                        {/* Days stepper */}
                        <div style={{ display:'flex', alignItems:'center', gap:4, flexShrink:0 }}>
                          <button onClick={() => onDaysChange(cartItem.id, Math.max(1, itemDays - 1))}
                            style={{ width:26, height:26, borderRadius:6, border:'1px solid var(--line)', background:'var(--mist)', cursor:'pointer', fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Inter,sans-serif' }}>−</button>
                          <input type="number" min={1} max={90} value={itemDays}
                            onChange={e => onDaysChange(cartItem.id, Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
                            style={{ width:38, textAlign:'center', padding:'4px 2px', border:'1px solid var(--line)', borderRadius:6, fontSize:13, fontWeight:700, fontFamily:'Inter,sans-serif', background:'var(--card)' }} />
                          <button onClick={() => onDaysChange(cartItem.id, Math.min(90, itemDays + 1))}
                            style={{ width:26, height:26, borderRadius:6, border:'1px solid var(--line)', background:'var(--mist)', cursor:'pointer', fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Inter,sans-serif' }}>+</button>
                        </div>
                        <button onClick={() => onRemove(cartItem.id)}
                          style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', padding:4, borderRadius:6, display:'flex', flexShrink:0 }}>
                          <X size={15} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ background:'hsla(var(--color-blue),0.06)', border:'1px solid hsla(var(--color-blue),0.2)', borderRadius:9, padding:'10px 14px', marginBottom:16, display:'flex', alignItems:'flex-start', gap:8 }}>
                <AlertCircle size={14} color="hsl(var(--color-blue))" style={{ flexShrink:0, marginTop:1 }} />
                <span style={{ fontSize:12.5, color:'hsl(var(--color-blue))', lineHeight:1.4 }}>
                  Once approved, you'll be prompted to upload a photo confirming you received each item.
                </span>
              </div>

              <div>
                <label style={FL}>REASON FOR CHECKOUT <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
                <textarea rows={3} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13 }}
                  placeholder="Briefly explain why you need these items…"
                  value={reason} onChange={e => setReason(e.target.value)} />
              </div>
            </>
          )}
        </div>

        {cart.length > 0 && (
          <div style={{ padding:'16px 22px', borderTop:'1px solid var(--line)', flexShrink:0 }}>
            <button className="primary-btn" disabled={!canSubmit}
              style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}
              onClick={() => onSubmit({ reason })}>
              {submitting ? <><Loader2 size={15} style={{ animation:'spin 1s linear infinite' }} /> Submitting…</> : <><CheckCircle size={15} /> Submit {cart.length} Checkout{cart.length !== 1 ? 's' : ''}</>}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ── My Checkouts Panel ────────────────────────────────────────────────────────
function MyCheckoutsPanel({ checkouts, userEmail, userName, onReturn, onCancel, onSelfAllocate, onEmployeeAccept, onConfirmReceipt, onReRequest }) {
  const mine = checkouts.filter(c =>
    (c.requestedByEmail && c.requestedByEmail.toLowerCase() === userEmail) ||
    c.requestedBy === userName
  );
  const [dismissedIds,    setDismissedIds]    = useState(new Set());
  const [reRequestId,     setReRequestId]     = useState(null);
  const [reRequestReason, setReRequestReason] = useState('');
  const [reRequestBusy,   setReRequestBusy]   = useState(false);
  const [confirmingCo,    setConfirmingCo]    = useState(null);

  // Find order groups where ALL items are rejected → auto-move to past, no manual discard needed
  const _orderMap = (() => {
    const m = new Map();
    for (const c of mine) {
      const key = c.orderId || `solo-${c.id}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(c);
    }
    return m;
  })();
  const allRejectedKeys = new Set(
    [..._orderMap.entries()]
      .filter(([, items]) => items.every(c => c.status === 'rejected'))
      .map(([key]) => key)
  );

  const active    = mine.filter(c => {
    if (['pending','approved','pending_receipt','allocated'].includes(c.status)) return true;
    if (c.status === 'rejected') {
      const key = c.orderId || `solo-${c.id}`;
      if (allRejectedKeys.has(key)) return false;
      return !dismissedIds.has(c.id);
    }
    return false;
  });
  const completed = mine.filter(c => {
    if (['returned','cancelled'].includes(c.status)) return true;
    if (c.status === 'rejected') {
      const key = c.orderId || `solo-${c.id}`;
      if (allRejectedKeys.has(key)) return true;
      return dismissedIds.has(c.id);
    }
    return false;
  });
  const [histOpen, setHistOpen] = useState(false);
  const [cancelId, setCancelId] = useState(null);
  const [cancelBusy, setCancelBusy] = useState(null);
  const [cancelAllKey, setCancelAllKey] = useState(null);
  const [cancelAllBusy, setCancelAllBusy] = useState(false);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [acceptingCo, setAcceptingCo] = useState(null);
  const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });

  // Group active checkouts by orderId so cart submissions appear as one block
  const activeGroups = (() => {
    const map = new Map();
    for (const c of active) {
      const key = c.orderId || c.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    return Array.from(map.values());
  })();

  const fmtDateShort = iso => new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric' });

  if (!mine.length) return null;

  return (
    <div style={{ marginTop:32 }}>
      <h3 style={{ fontSize:14, fontWeight:700, marginBottom:14, display:'flex', alignItems:'center', gap:8 }}>
        <Clock size={15} color="hsl(var(--color-blue))" /> My Active Checkouts
        {active.length > 0 && <span style={{ padding:'1px 8px', borderRadius:20, fontSize:11, fontWeight:700, background:'hsla(var(--color-blue),0.12)', color:'hsl(var(--color-blue))' }}>{active.length}</span>}
      </h3>

      {activeGroups.map(groupItems => {
        const isMulti = groupItems.length > 1;
        const firstItem = groupItems[0];
        const groupKey = firstItem.orderId || firstItem.id;
        const cancellableItems = groupItems.filter(c => ['pending','approved'].includes(c.status));
        const pendingReceiptItems = groupItems.filter(c => c.status === 'pending_receipt');
        const allPendingReceipt = isMulti && pendingReceiptItems.length === groupItems.length;
        return (
          <div key={groupKey} style={{ border:'1px solid var(--line)', borderRadius:12, overflow:'hidden', marginBottom:12, background:'var(--card)', boxShadow:'var(--shadow-sm)' }}>
            {isMulti && (
              <div style={{ padding:'10px 16px', background:'var(--mist)', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                <ShoppingCart size={13} color="hsl(var(--color-blue))" />
                <span style={{ fontSize:12.5, fontWeight:700, color:'hsl(var(--color-blue))' }}>Order · {groupItems.length} items</span>
                <span style={{ fontSize:12, color:'var(--muted)', marginLeft:4 }}>· {fmtDateShort(firstItem.createdAt)}</span>
                {firstItem.reason && <span style={{ fontSize:12, color:'var(--muted)', fontStyle:'italic', marginLeft:4 }}>"{firstItem.reason}"</span>}
                {/* Group-level confirm receipt button when all items are pending_receipt */}
                {allPendingReceipt && onConfirmReceipt && (
                  <button className="primary-btn"
                    style={{ marginLeft:'auto', fontSize:11.5, padding:'4px 12px', display:'inline-flex', alignItems:'center', gap:4 }}
                    onClick={() => setConfirmingCo(pendingReceiptItems)}>
                    <Camera size={12} /> Confirm Receipt for All
                  </button>
                )}
                {cancellableItems.length > 1 && !allPendingReceipt && cancelAllKey !== groupKey && (
                  <button onClick={() => setCancelAllKey(groupKey)}
                    style={{ marginLeft:'auto', background:'none', border:'1px solid hsla(var(--color-red),0.4)', borderRadius:7, padding:'3px 10px', fontSize:11.5, cursor:'pointer', color:'hsl(var(--color-red))', display:'inline-flex', alignItems:'center', gap:4, fontFamily:'Inter,sans-serif', fontWeight:600 }}>
                    <XCircle size={11} /> Cancel All
                  </button>
                )}
                {cancelAllKey === groupKey && (
                  <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6, background:'hsla(var(--color-red),0.05)', border:'1px solid hsla(var(--color-red),0.2)', borderRadius:8, padding:'5px 10px' }}>
                    <span style={{ fontSize:12, color:'var(--ink)' }}>Cancel all {cancellableItems.length} items?</span>
                    <button onClick={() => setCancelAllKey(null)} className="secondary-btn" style={{ fontSize:11.5, padding:'3px 8px' }}>Keep</button>
                    <button disabled={cancelAllBusy}
                      style={{ background:'hsl(var(--color-red))', color:'#fff', border:'none', borderRadius:6, padding:'3px 10px', fontSize:11.5, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:4, fontWeight:700, fontFamily:'Inter,sans-serif' }}
                      onClick={() => {
                        setCancelAllBusy(true);
                        Promise.allSettled(cancellableItems.map(c => onCancel(c)))
                          .finally(() => { setCancelAllBusy(false); setCancelAllKey(null); });
                      }}>
                      {cancelAllBusy ? <Loader2 size={11} style={{ animation:'spin 1s linear infinite' }} /> : null} Yes, Cancel All
                    </button>
                  </div>
                )}
              </div>
            )}
            {groupItems.map((c, idx) => {
              const sm = CHECKOUT_STATUS_META[c.status];
              return (
                <div key={c.id} style={{ padding:'16px 18px', borderTop: idx > 0 ? '1px solid var(--line)' : 'none' }}>
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
                  {!isMulti && c.reason && (
                    <div style={{ fontSize:12, color:'var(--muted)', background:'var(--mist)', borderRadius:7, padding:'6px 10px', marginBottom:4 }}>"{c.reason}"</div>
                  )}
                  <StageTracker checkout={c} onViewPhoto={url => setPhotoPreview(url)} />
                  {c.status === 'rejected' ? (
                    reRequestId === c.id ? (
                      <div style={{ marginTop:10, display:'flex', flexDirection:'column', gap:8, background:'hsla(var(--color-blue),0.05)', border:'1px solid hsla(var(--color-blue),0.2)', borderRadius:9, padding:'10px 12px' }}>
                        <label style={{ fontSize:12, fontWeight:600, color:'var(--muted)' }}>NEW COMMENT (required)</label>
                        <textarea rows={2} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13 }}
                          placeholder="Add context for your re-request…"
                          value={reRequestReason} onChange={e => setReRequestReason(e.target.value)} />
                        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                          <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => { setReRequestId(null); setReRequestReason(''); }}>Cancel</button>
                          <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5 }}
                            disabled={!reRequestReason.trim() || reRequestBusy}
                            onClick={() => {
                              setReRequestBusy(true);
                              onReRequest(c, reRequestReason.trim())
                                .then(() => { setReRequestId(null); setReRequestReason(''); })
                                .finally(() => setReRequestBusy(false));
                            }}>
                            {reRequestBusy ? <Loader2 size={12} style={{ animation:'spin 1s linear infinite' }} /> : <RotateCcw size={12} />}
                            Submit Again
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', flexWrap:'wrap', marginTop:10 }}>
                        <button onClick={() => {
                            setDismissedIds(prev => new Set([...prev, c.id]));
                            onCancel && onCancel(c, { silent: true });
                          }}
                          style={{ background:'none', border:'1px solid var(--line)', borderRadius:8, padding:'5px 12px', fontSize:12, cursor:'pointer', color:'var(--muted)', display:'inline-flex', alignItems:'center', gap:5, fontFamily:'Inter,sans-serif', fontWeight:600 }}>
                          <X size={12} /> Discard
                        </button>
                        {onReRequest && (
                          <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5 }}
                            onClick={() => { setReRequestId(c.id); setReRequestReason(''); }}>
                            <RotateCcw size={12} /> Request Again
                          </button>
                        )}
                      </div>
                    )
                  ) : (
                  <div style={{ display:'flex', gap:8, justifyContent:'flex-end', flexWrap:'wrap', marginTop:8 }}>
                    {c.status === 'allocated' && (
                      <button className="secondary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5 }}
                        onClick={() => onReturn(c)}>
                        <RotateCcw size={13} /> Return Item
                      </button>
                    )}
                    {c.status === 'pending_receipt' && onConfirmReceipt && (
                      <button className="primary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5 }}
                        onClick={() => setConfirmingCo(c)}>
                        <Camera size={13} /> Confirm Receipt &amp; Upload Photo
                      </button>
                    )}
                    {c.status === 'approved' && (onEmployeeAccept || onSelfAllocate) && (
                      <button className="primary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5, background:'hsl(var(--color-green))' }}
                        onClick={() => onEmployeeAccept ? setAcceptingCo(c) : onSelfAllocate(c)}>
                        <Camera size={13} /> Accept &amp; Upload Photo
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
                  )}
                </div>
              );
            })}
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
              <div key={c.id} style={{ borderTop:'1px solid var(--line)', padding:'10px 16px', display:'flex', alignItems:'flex-start', gap:10, flexWrap:'wrap' }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:600, fontSize:13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.itemName}</div>
                  <div style={{ fontSize:11.5, color:'var(--muted)' }}>{fmtDate(c.createdAt)}</div>
                  {c.status === 'rejected' && c.rejectReason && (
                    <div style={{ fontSize:11.5, color:'hsl(var(--color-red))', marginTop:3 }}>Rejected: "{c.rejectReason}"</div>
                  )}
                </div>
                <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700, background:sm.bg, color:sm.fg, flexShrink:0 }}>
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
      {acceptingCo && onEmployeeAccept && (
        <EmployeeAcceptModal
          checkout={acceptingCo}
          onClose={() => setAcceptingCo(null)}
          onConfirm={(url, name) => onEmployeeAccept(acceptingCo, url, name).then(() => setAcceptingCo(null))}
        />
      )}
      {confirmingCo && onConfirmReceipt && (() => {
        const isArr = Array.isArray(confirmingCo);
        const coList = isArr ? confirmingCo : [confirmingCo];
        return (
          <ReceiptConfirmModal
            checkouts={coList}
            onClose={() => setConfirmingCo(null)}
            onConfirm={({ batch, photoMap }) => {
              const calls = coList.map(co => onConfirmReceipt(co, batch, photoMap));
              return Promise.all(calls).then(() => setConfirmingCo(null));
            }}
          />
        );
      })()}
    </div>
  );
}

// ── Employee View ─────────────────────────────────────────────────────────────
// ── Item Photo Grid (shared by employee + manager catalog) ────────────────────
function ItemPhotoGrid({ items, checkouts, itemsLoading, itemsError, refreshItems, onAddToCart, inCart, emptyLabel }) {
  const [lightbox, setLightbox] = useState(null);

  if (itemsError) return <ErrorBanner message="Could not load items right now." onRetry={refreshItems} />;
  if (itemsLoading && !items.length) return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:14 }}>
      {Array.from({ length: 6 }).map((_, i) => <SkeletonBlocks key={i} count={1} height={200} borderRadius={12} />)}
    </div>
  );
  if (!items.length) return (
    <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
      <Package size={36} style={{ opacity:.2, display:'block', margin:'0 auto 12px' }} />
      {emptyLabel || 'No items available right now.'}
    </div>
  );

  // Items with active requests: combine server-reported flag (works for all
  // users, not just managers) with the local checkouts list.
  const pendingCheckoutIds = new Set(
    (checkouts || []).filter(c => ['pending','approved','pending_receipt'].includes(c.status)).map(c => c.itemId)
  );

  // Available items first, then unavailable, alpha within each group
  const sorted = [...items].sort((a, b) => {
    const aAvail = a.status === 'available' ? 0 : 1;
    const bAvail = b.status === 'available' ? 0 : 1;
    if (aAvail !== bAvail) return aAvail - bAvail;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:14 }}>
        {sorted.map(item => {
          const tm = TYPE_META[item.itemType] || TYPE_META.Other;
          const alreadyInCart = inCart?.has(item.id);
          const isAvailable = item.status === 'available';
          // hasPending: item has a request in flight — block Add to Cart for everyone.
          // item.hasActiveRequest comes from the server and is visible to all users,
          // even employees who can't see other users' checkouts.
          const hasPending  = isAvailable && (pendingCheckoutIds.has(item.id) || !!item.hasActiveRequest);
          const canAdd = onAddToCart && isAvailable && !hasPending && item.ownershipType === 'transient';

          // Show who has the item and when it becomes available.
          // Use local checkouts list if visible (managers), fall back to server fields.
          let checkedOutBy = null, daysLeft = null;
          if (!isAvailable || hasPending) {
            const co = checkouts?.find(c => c.itemId === item.id && ['approved','pending_receipt','allocated'].includes(c.status));
            checkedOutBy = co?.requestedBy ?? item.activeRequestedBy ?? null;
            const dueSrc = co
              ? (() => { const d = new Date(co.createdAt); d.setDate(d.getDate() + (co.days || 1)); return d; })()
              : item.activeDueDate ? new Date(item.activeDueDate) : null;
            if (dueSrc) {
              const diff = Math.ceil((dueSrc - Date.now()) / 86400000);
              daysLeft = diff > 0 ? diff : 0;
            }
          }

          return (
            <div key={item.id}
              style={{ border:'1px solid var(--line)', borderRadius:12, overflow:'hidden', background:'var(--card)', display:'flex', flexDirection:'column', transition:'box-shadow 0.15s', boxShadow:'var(--shadow-sm)', opacity: (isAvailable && !hasPending) ? 1 : 0.62 }}
              onMouseEnter={e => e.currentTarget.style.boxShadow = 'var(--shadow-md)'}
              onMouseLeave={e => e.currentTarget.style.boxShadow = 'var(--shadow-sm)'}>
              {/* Photo */}
              <div onClick={() => item.photoUrl && isAvailable && !hasPending && setLightbox({ src: item.photoUrl, alt: item.name })}
                style={{ height:140, background: item.photoUrl ? 'transparent' : tm.bg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, cursor: item.photoUrl && isAvailable && !hasPending ? 'zoom-in' : 'default', position:'relative', overflow:'hidden' }}>
                {item.photoUrl
                  ? <img src={item.photoUrl} alt={item.name} style={{ width:'100%', height:'100%', objectFit:'cover', filter: (isAvailable && !hasPending) ? 'none' : 'grayscale(35%)' }} />
                  : <tm.Icon size={40} color={tm.color} />}
                {item.photoUrl && isAvailable && !hasPending && (
                  <div style={{ position:'absolute', top:6, right:6, background:'rgba(0,0,0,0.45)', borderRadius:6, padding:'2px 5px', display:'flex', alignItems:'center', gap:3 }}>
                    <ZoomIn size={11} color="#fff" />
                  </div>
                )}
                {alreadyInCart && (
                  <div style={{ position:'absolute', top:6, left:6, background:'hsl(var(--color-green))', borderRadius:6, padding:'2px 7px', display:'flex', alignItems:'center', gap:3 }}>
                    <CheckCircle size={10} color="#fff" />
                    <span style={{ fontSize:10, color:'#fff', fontWeight:700 }}>In Cart</span>
                  </div>
                )}
                {hasPending && (
                  <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.18)', display:'flex', alignItems:'flex-end', justifyContent:'center', padding:'0 0 8px' }}>
                    <span style={{ background:'rgba(220,120,0,0.85)', color:'#fff', fontSize:10.5, fontWeight:700, borderRadius:6, padding:'2px 8px' }}>
                      Pending Request
                    </span>
                  </div>
                )}
                {!isAvailable && (
                  <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.15)', display:'flex', alignItems:'flex-end', justifyContent:'center', padding:'0 0 8px' }}>
                    <span style={{ background:'rgba(0,0,0,0.65)', color:'#fff', fontSize:10.5, fontWeight:700, borderRadius:6, padding:'2px 8px' }}>
                      {STATUS_META[item.status]?.label || item.status}
                    </span>
                  </div>
                )}
              </div>
              {/* Info */}
              <div style={{ padding:'10px 12px', flex:1, display:'flex', flexDirection:'column', gap:4 }}>
                <div style={{ fontWeight:700, fontSize:13, lineHeight:1.3 }}>{item.name}</div>
                <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                  <TypeBadge type={item.itemType} />
                </div>
                {(item.make || item.model) && (
                  <div style={{ fontSize:11.5, color:'var(--muted)' }}>{[item.make, item.model].filter(Boolean).join(' · ')}</div>
                )}
                {item.location && (
                  <div style={{ display:'flex', alignItems:'center', gap:3, fontSize:11.5, color:'var(--muted)' }}>
                    <MapPin size={10} /> {item.location}
                  </div>
                )}
              </div>
              {/* Action */}
              <div style={{ padding:'0 12px 12px' }}>
                {canAdd ? (
                  <button onClick={() => onAddToCart(item)} disabled={alreadyInCart}
                    className={alreadyInCart ? 'secondary-btn' : 'primary-btn'}
                    style={{ width:'100%', fontSize:12.5, padding:'7px 0', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                    {alreadyInCart ? <><CheckCircle size={12} /> In Cart</> : <><Plus size={12} /> Add to Cart</>}
                  </button>
                ) : hasPending ? (
                  <div style={{ textAlign:'center', fontSize:11.5, color:'hsl(var(--color-orange))', fontWeight:600 }}>Under Review</div>
                ) : !isAvailable ? (
                  <div style={{ textAlign:'center', fontSize:11, color:'hsl(var(--color-orange))', fontWeight:600, lineHeight:1.4 }}>
                    {item.status === 'checked_out' ? (
                      <>
                        {checkedOutBy ? `In Use — ${checkedOutBy}` : 'In Use'}
                        {daysLeft != null && (
                          <span style={{ display:'block', fontSize:10.5, fontWeight:500, color:'var(--muted)' }}>
                            {daysLeft === 0 ? 'due today' : `available in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}
                          </span>
                        )}
                      </>
                    ) : item.status === 'permanently_assigned' ? 'Assigned'
                      : item.status === 'retired' ? 'Retired'
                      : 'Unavailable'}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </>
  );
}

// ── Employee View ─────────────────────────────────────────────────────────────
function EmployeeView({ items, checkouts, userName, userEmail, itemsLoading, itemsError, onReturn, refreshItems, refreshCheckouts, submitCartCheckouts, cancelRequest, allocateItem, confirmReceipt, toast }) {
  const [tab,            setTab]            = useState('catalog');
  const [mode,           setMode]           = useState('home');
  const [viewMode,       setViewMode]       = useState('tile');
  const [search,         setSearch]         = useState('');
  const [typeFilter,     setTypeFilter]     = useState('All');
  const [locationFilter, setLocationFilter] = useState('All');
  const [cartOpen,       setCartOpen]       = useState(false);
  const [cart,           setCart]           = useState([]);
  const [returningCo,    setReturningCo]    = useState(null);
  const [submitting,     setSubmitting]     = useState(false);

  useEffect(() => {
    api.getItemCart().then(rows => {
      setCart(rows.map(r => ({ id: r.id, item: { id: r.itemId, name: r.itemName, itemType: r.itemType }, days: 1 })));
    }).catch(() => {});
  }, []);

  const myCheckouts     = checkouts.filter(c =>
    (c.requestedByEmail && c.requestedByEmail.toLowerCase() === userEmail) || c.requestedBy === userName
  );
  const activeCheckouts = myCheckouts.filter(c => ['pending','approved','pending_receipt','allocated'].includes(c.status));
  const allTransient    = items.filter(i => i.ownershipType === 'transient');
  const availableItems  = allTransient.filter(i => i.status === 'available');
  const inCart          = new Set(cart.map(c => c.item.id));

  // Derive location list from all transient items (not just available)
  const locations = ['All', ...Array.from(new Set(allTransient.map(i => i.location).filter(Boolean))).sort()];

  const filteredItems = allTransient.filter(i => {
    const ms = !search || i.name.toLowerCase().includes(search.toLowerCase()) ||
      (i.make||'').toLowerCase().includes(search.toLowerCase()) ||
      (i.model||'').toLowerCase().includes(search.toLowerCase());
    const mt = typeFilter     === 'All' || i.itemType === typeFilter;
    const ml = locationFilter === 'All' || i.location === locationFilter;
    return ms && mt && ml;
  });

  function addToCart(item) {
    if (inCart.has(item.id)) return;
    const optimisticId = `cart-${Date.now()}`;
    setCart(prev => [...prev, { id: optimisticId, item, days: 1 }]);
    api.addItemToCart({ item_id: item.id, item_name: item.name, item_type: item.itemType })
      .then(saved => setCart(prev => prev.map(c => c.id === optimisticId ? { id: saved.id, item, days: 1 } : c)))
      .catch(err => {
        setCart(prev => prev.filter(c => c.id !== optimisticId));
        toast(err?.message || 'Could not add item to cart.', 'error');
      });
  }

  function removeFromCart(cartId) {
    const entry = cart.find(c => c.id === cartId);
    setCart(prev => prev.filter(c => c.id !== cartId));
    if (entry) api.removeItemFromCart(entry.item.id).catch(() => {});
  }

  function handleDaysChange(cartId, days) {
    setCart(prev => prev.map(c => c.id === cartId ? { ...c, days } : c));
  }

  async function handleSubmitCart({ reason }) {
    setSubmitting(true);
    const results = await submitCartCheckouts(cart, { reason, raisedBy: userName, raisedByEmail: userEmail });
    const succeededItems = cart.filter((_, i) => results[i].status === 'fulfilled');
    const failedItems    = cart.filter((_, i) => results[i].status === 'rejected');
    await Promise.all(succeededItems.map(c => api.removeItemFromCart(c.item.id).catch(() => {})));
    setSubmitting(false);
    setCartOpen(false);
    setCart(failedItems);
    if (failedItems.length === 0) setTab('checkouts');
    if (succeededItems.length > 0) toast(`${succeededItems.length} checkout request${succeededItems.length !== 1 ? 's' : ''} submitted.`);
    if (failedItems.length > 0) {
      const allConflict = results.filter(r => r.status === 'rejected').every(r => r.reason?.message?.includes('active checkout'));
      toast(
        <div>
          <div style={{ fontWeight:700, marginBottom:5 }}>
            {failedItems.length} item{failedItems.length !== 1 ? 's' : ''} couldn't be submitted
          </div>
          <ul style={{ margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:2 }}>
            {failedItems.map((c, i) => <li key={i} style={{ fontSize:12 }}>{c.item.name}</li>)}
          </ul>
          {allConflict && <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:5 }}>Each already has an active checkout request.</div>}
        </div>,
        'error'
      );
    }
  }

  function handleReturn(co) { setReturningCo(co); }
  function handleReturnSubmit(data) {
    return onReturn(returningCo.id, data).then(() => {
      toast(`Return confirmed — ${returningCo.itemName}`);
      setReturningCo(null);
    }).catch(() => toast('Could not confirm return — please try again.', 'error'));
  }
  function handleCancel(co, opts = {}) {
    return cancelRequest(co.id, userName)
      .then(() => { if (!opts.silent) toast('Checkout cancelled.'); })
      .catch(() => { if (!opts.silent) toast('Could not cancel.', 'error'); });
  }
  async function handleReRequest(co, newReason) {
    await api.createItemCheckout({
      id: crypto.randomUUID(),
      item_id: co.itemId, item_name: co.itemName, item_type: co.itemType,
      requested_by: co.requestedBy, requested_by_email: co.requestedByEmail || userEmail,
      raised_by: userName, department: co.department, days: co.days || 1,
      reason: newReason, order_id: null,
    });
    toast(`Re-submitted request for ${co.itemName}.`);
    if (refreshCheckouts) refreshCheckouts();
  }

  // ── Home screen ─────────────────────────────────────────────────────────────
  if (mode === 'home') {
    return (
      <div style={{ animation:'fadeIn var(--transition-normal) ease-in-out' }}>
        <div style={{ marginBottom:32 }}>
          <h2 style={{ fontSize:20, fontWeight:700, margin:'0 0 4px' }}>Item Management</h2>
          <p style={{ fontSize:13, color:'var(--muted)', margin:0 }}>What would you like to do today?</p>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:16, maxWidth:820, marginBottom:cart.length ? 28 : 0 }}>
          {[
            { Icon:ShoppingCart,  colorVar:'color-green',  title:'Checkout an Item',      sub:'Browse available equipment and raise a checkout request.',                                                                          go:() => { setMode('catalog'); setTab('catalog'); },   badge:null },
            { Icon:RotateCcw,     colorVar:'color-blue',   title:'Return an Item',         sub:activeCheckouts.length > 0 ? `${activeCheckouts.length} item${activeCheckouts.length!==1?'s':''} currently checked out.` : 'Return equipment you currently have with you.', go:() => { setMode('catalog'); setTab('checkouts'); }, badge:activeCheckouts.length||null },
            { Icon:ClipboardList, colorVar:'color-orange', title:'Raise Purchase Request', sub:'Need something not in the catalog? Submit a formal purchase request.',                                                              go:() => window.dispatchEvent(new CustomEvent('nexus:navigate',{detail:{view:'purchase'}})),                      badge:null },
          ].map(({ Icon, colorVar, title, sub, go, badge }) => (
            <button key={title} onClick={go}
              style={{ display:'flex', alignItems:'flex-start', gap:16, padding:'20px 20px', borderRadius:14, border:'1px solid var(--line)', background:'var(--card)', cursor:'pointer', textAlign:'left', fontFamily:'Inter,sans-serif', transition:'box-shadow 0.15s', boxShadow:'var(--shadow-sm)', position:'relative' }}
              onMouseEnter={e => e.currentTarget.style.boxShadow='var(--shadow-md)'}
              onMouseLeave={e => e.currentTarget.style.boxShadow='var(--shadow-sm)'}>
              <div style={{ width:46, height:46, borderRadius:12, background:`hsla(var(--${colorVar}),0.12)`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <Icon size={22} color={`hsl(var(--${colorVar}))`} />
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:15, color:'var(--ink)', marginBottom:4 }}>
                  {title}
                  {badge > 0 && <span style={{ marginLeft:8, padding:'1px 8px', borderRadius:20, fontSize:11, fontWeight:700, background:`hsla(var(--${colorVar}),0.12)`, color:`hsl(var(--${colorVar}))` }}>{badge} active</span>}
                </div>
                <div style={{ fontSize:12.5, color:'var(--muted)', lineHeight:1.5 }}>{sub}</div>
              </div>
              <ChevronRight size={16} color="var(--muted)" style={{ flexShrink:0, alignSelf:'center' }} />
            </button>
          ))}
        </div>
        {cart.length > 0 && (
          <div style={{ padding:'14px 18px', borderRadius:12, border:'1px solid hsla(var(--color-green),0.3)', background:'hsla(var(--color-green),0.06)', display:'flex', alignItems:'center', gap:12, maxWidth:520, marginTop:24 }}>
            <ShoppingCart size={16} color="hsl(var(--color-green))" style={{ flexShrink:0 }} />
            <span style={{ fontSize:13, fontWeight:600, color:'var(--ink)', flex:1 }}>{cart.length} item{cart.length!==1?'s':''} waiting in your cart</span>
            <button className="primary-btn" onClick={() => setCartOpen(true)} style={{ fontSize:12, padding:'6px 14px', flexShrink:0 }}>View Cart</button>
          </div>
        )}
        <CartDrawer open={cartOpen} cart={cart} onClose={() => setCartOpen(false)} onRemove={removeFromCart} onSubmit={handleSubmitCart} submitting={submitting} onDaysChange={handleDaysChange} />
      </div>
    );
  }

  // ── Catalog / Checkouts view ─────────────────────────────────────────────────
  return (
    <div style={{ animation:'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Back to home */}
      <button onClick={() => setMode('home')}
        style={{ display:'inline-flex', alignItems:'center', gap:6, marginBottom:18, background:'none', border:'none', cursor:'pointer', color:'var(--muted)', fontSize:13, fontFamily:'Inter,sans-serif', padding:'4px 0', transition:'color 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.color='var(--ink)'}
        onMouseLeave={e => e.currentTarget.style.color='var(--muted)'}>
        <ArrowLeft size={14} /> Back to Home
      </button>

      {/* Tab strip */}
      <div style={{ display:'flex', alignItems:'center', borderBottom:'2px solid var(--line)', marginBottom:24 }}>
        {[
          { id:'catalog',   label:'Browse Catalog', Icon: Package,       badge: null },
          { id:'checkouts', label:'My Checkouts',   Icon: ClipboardList, badge: activeCheckouts.length || null },
        ].map(({ id, label, Icon, badge }) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'10px 18px', background:'none', border:'none',
              borderBottom: tab === id ? '2px solid var(--pine)' : '2px solid transparent',
              color: tab === id ? 'var(--ink)' : 'var(--muted)', fontWeight: tab === id ? 700 : 500,
              fontSize:14, cursor:'pointer', fontFamily:'Inter,sans-serif', marginBottom:-2, transition:'color 0.15s' }}>
            <Icon size={15} /> {label}
            {badge > 0 && <span style={{ background:'hsl(var(--color-blue))', color:'#fff', borderRadius:20, fontSize:10.5, fontWeight:800, padding:'1px 7px', marginLeft:3 }}>{badge}</span>}
          </button>
        ))}
        <button onClick={() => setCartOpen(true)}
          className={cart.length ? 'primary-btn' : 'secondary-btn'}
          style={{ marginLeft:'auto', display:'inline-flex', alignItems:'center', gap:6, position:'relative', fontSize:13, padding:'7px 14px' }}>
          <ShoppingCart size={14} /> Cart
          {cart.length > 0 && <span style={{ position:'absolute', top:-7, right:-7, background:'hsl(var(--color-red))', color:'#fff', borderRadius:'50%', width:17, height:17, fontSize:10, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center' }}>{cart.length}</span>}
        </button>
      </div>

      {/* ── CATALOG TAB ── */}
      {tab === 'catalog' && (
        <div style={{ paddingBottom: cart.length ? 80 : 0 }}>
          <div style={{ display:'flex', flexDirection:'column', gap:12, marginBottom:20 }}>
            <div className="search-bar" style={{ width:'100%' }}>
              <Search size={14} style={{ flexShrink:0 }} />
              <input placeholder="Search by name, make, or model…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
            </div>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', justifyContent:'space-between' }}>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                {['All', ...ITEM_TYPES].map(t => {
                  const active = typeFilter === t;
                  return (
                    <button key={t} onClick={() => setTypeFilter(t)}
                      style={{ padding:'5px 14px', borderRadius:20, border:`1px solid ${active ? 'var(--pine)' : 'var(--line)'}`, background: active ? 'var(--pine)' : 'var(--card)', color: active ? '#fff' : 'var(--ink)', fontSize:12.5, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif', transition:'all 0.15s' }}>
                      {t}
                    </button>
                  );
                })}
                <span style={{ fontSize:12.5, color:'var(--muted)', alignSelf:'center', marginLeft:4 }}>
                  {filteredItems.filter(i => i.status === 'available').length} available · {filteredItems.length} total
                </span>
              </div>
              <div style={{ display:'flex', gap:4, flexShrink:0 }}>
                <button onClick={() => setViewMode('tile')}
                  style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:8, border:`1px solid ${viewMode==='tile' ? 'var(--pine)' : 'var(--line)'}`, background: viewMode==='tile' ? 'hsla(var(--color-green),0.1)' : 'transparent', color: viewMode==='tile' ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                  <LayoutGrid size={13} /> Tile
                </button>
                <button onClick={() => setViewMode('list')}
                  style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:8, border:`1px solid ${viewMode==='list' ? 'var(--pine)' : 'var(--line)'}`, background: viewMode==='list' ? 'hsla(var(--color-green),0.1)' : 'transparent', color: viewMode==='list' ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                  <ClipboardList size={13} /> List
                </button>
              </div>
            </div>
            {locations.length > 2 && (
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                <MapPin size={13} style={{ color:'var(--muted)', flexShrink:0 }} />
                {locations.map(loc => {
                  const active = locationFilter === loc;
                  return (
                    <button key={loc} onClick={() => setLocationFilter(loc)}
                      style={{ padding:'4px 12px', borderRadius:20, border:`1px solid ${active ? 'hsl(var(--color-blue))' : 'var(--line)'}`, background: active ? 'hsla(var(--color-blue),0.1)' : 'transparent', color: active ? 'hsl(var(--color-blue))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif', transition:'all 0.15s' }}>
                      {loc}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {viewMode === 'tile' ? (
            <ItemPhotoGrid
              items={filteredItems} checkouts={checkouts}
              itemsLoading={itemsLoading} itemsError={itemsError}
              refreshItems={refreshItems} onAddToCart={addToCart} inCart={inCart}
              emptyLabel={search || typeFilter !== 'All' || locationFilter !== 'All' ? 'No items match your search.' : 'No items available.'}
            />
          ) : (
            itemsError ? <ErrorBanner message="Could not load items." onRetry={refreshItems} /> :
            itemsLoading && !filteredItems.length ? <SkeletonBlocks count={6} height={48} borderRadius={8} /> :
            filteredItems.length === 0 ? (
              <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
                <Package size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
                {search || typeFilter !== 'All' || locationFilter !== 'All' ? 'No items match your search.' : 'No items available.'}
              </div>
            ) : (
              <div style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'auto', marginBottom:20 }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr style={{ background:'var(--mist)' }}>
                      {['Photo','Name','Type','Make / Model','Location','Status',''].map(h =>
                        <th key={h} style={{ textAlign:'left', padding:'9px 14px', fontWeight:700, color:'var(--muted)', fontSize:11.5, whiteSpace:'nowrap' }}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {[...filteredItems].sort((a,b) => {
                      const aA = a.status==='available' ? 0 : 1, bA = b.status==='available' ? 0 : 1;
                      if (aA!==bA) return aA-bA; return a.name.localeCompare(b.name);
                    }).map(item => {
                      const tm = TYPE_META[item.itemType] || TYPE_META.Other;
                      const alreadyInCart = inCart.has(item.id);
                      const hasPending = item.status==='available' && checkouts.some(c => ['pending','approved'].includes(c.status) && c.itemId===item.id);
                      const canAdd = item.status==='available' && !hasPending && item.ownershipType==='transient';
                      return (
                        <tr key={item.id} style={{ borderTop:'1px solid var(--line)', opacity: item.status==='available'&&!hasPending ? 1 : 0.65 }}>
                          <td style={{ padding:'8px 14px' }}>
                            {item.photoUrl
                              ? <img src={item.photoUrl} alt={item.name} style={{ width:36, height:36, borderRadius:7, objectFit:'cover', border:'1px solid var(--line)' }} />
                              : <div style={{ width:36, height:36, borderRadius:7, background:tm.bg, display:'flex', alignItems:'center', justifyContent:'center' }}><tm.Icon size={16} color={tm.color} /></div>}
                          </td>
                          <td style={{ padding:'8px 14px', fontWeight:600 }}>{item.name}</td>
                          <td style={{ padding:'8px 14px' }}><TypeBadge type={item.itemType} /></td>
                          <td style={{ padding:'8px 14px', color:'var(--muted)', fontSize:12 }}>{[item.make,item.model].filter(Boolean).join(' · ')||'—'}</td>
                          <td style={{ padding:'8px 14px', color:'var(--muted)', fontSize:12 }}>{item.location||'—'}</td>
                          <td style={{ padding:'8px 14px' }}><StatusBadge status={hasPending ? 'checked_out' : item.status} /></td>
                          <td style={{ padding:'8px 14px' }}>
                            {canAdd && (
                              <button onClick={() => addToCart(item)} disabled={alreadyInCart}
                                className={alreadyInCart ? 'secondary-btn' : 'primary-btn'}
                                style={{ fontSize:12, padding:'5px 12px', display:'inline-flex', alignItems:'center', gap:5 }}>
                                {alreadyInCart ? <><CheckCircle size={11} /> In Cart</> : <><Plus size={11} /> Add</>}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}

          {cart.length > 0 && (
            <div style={{ position:'fixed', bottom:0, left:0, right:0, background:'var(--pine)', padding:'14px 24px', zIndex:200, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, boxShadow:'0 -4px 24px rgba(0,0,0,0.18)' }}>
              <div style={{ color:'#fff' }}>
                <span style={{ fontWeight:700, fontSize:15 }}>{cart.length} item{cart.length!==1?'s':''} in cart</span>
                <div style={{ fontSize:12, opacity:.8, marginTop:1 }}>Ready to submit your request</div>
              </div>
              <button onClick={() => setCartOpen(true)}
                style={{ background:'#fff', color:'var(--pine)', border:'none', borderRadius:10, padding:'10px 20px', fontWeight:700, fontSize:14, cursor:'pointer', display:'flex', alignItems:'center', gap:8, fontFamily:'Inter,sans-serif', flexShrink:0 }}>
                Review & Submit <ChevronRight size={15} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── MY CHECKOUTS TAB ── */}
      {tab === 'checkouts' && (
        <div>
          {myCheckouts.length === 0 ? (
            <div style={{ textAlign:'center', padding:'64px 20px', color:'var(--muted)' }}>
              <Package size={36} style={{ opacity:.15, display:'block', margin:'0 auto 14px' }} />
              <div style={{ fontWeight:600, fontSize:15, marginBottom:6 }}>No checkouts yet</div>
              <div style={{ fontSize:13, marginBottom:20 }}>Browse the catalog to check out equipment.</div>
              <button className="primary-btn" onClick={() => setTab('catalog')} style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                <Package size={14} /> Browse Catalog
              </button>
            </div>
          ) : (
            <MyCheckoutsPanel
              checkouts={checkouts} userEmail={userEmail} userName={userName}
              onReturn={handleReturn} onCancel={handleCancel} onReRequest={handleReRequest}
              onEmployeeAccept={allocateItem ? (co, photoUrl) =>
                allocateItem(co.id, userName, photoUrl)
                  .then(() => toast(`Confirmed — ${co.itemName} is with you.`))
                  .catch(() => toast('Could not confirm receipt — please try again.', 'error'))
              : undefined}
              onConfirmReceipt={confirmReceipt ? (co, batch, photoMap) =>
                confirmReceipt(co.id, userName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '')
                  .catch(() => { throw new Error(`Could not confirm receipt for ${co.itemName}.`); })
              : undefined}
            />
          )}
          <div style={{ marginTop:28, paddingTop:20, borderTop:'1px solid var(--line)', display:'flex', justifyContent:'center' }}>
            <button onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view:'purchase' } }))}
              style={{ background:'none', border:'1px solid var(--line)', borderRadius:10, padding:'10px 20px', cursor:'pointer', fontFamily:'Inter,sans-serif', fontSize:13, color:'var(--muted)', display:'inline-flex', alignItems:'center', gap:8 }}>
              <ClipboardList size={14} /> Need something not in the catalog? Raise a purchase requisition
            </button>
          </div>
        </div>
      )}

      <CartDrawer
        open={cartOpen} cart={cart}
        onClose={() => setCartOpen(false)}
        onRemove={removeFromCart}
        onSubmit={handleSubmitCart}
        submitting={submitting}
        onDaysChange={handleDaysChange}
      />
      {returningCo && <ReturnModal checkout={returningCo} onClose={() => setReturningCo(null)} onSubmit={handleReturnSubmit} />}
    </div>
  );
}

// ── Manager Catalog Tab ───────────────────────────────────────────────────────
function ManagerCatalogTab({ items, itemsLoading, itemsError, deptFilter, typeFilter, search, refreshItems, onAddToCart, inCart, checkouts, userEmail, userName, onReturn, onCancel, onSelfAllocate }) {
  const [viewMode, setViewMode] = useState('tile'); // 'tile' | 'list'

  const filtered = items.filter(i => {
    const mS = !search || i.name.toLowerCase().includes(search.toLowerCase()) || (i.make||'').toLowerCase().includes(search.toLowerCase()) || (i.model||'').toLowerCase().includes(search.toLowerCase());
    const mD = deptFilter === 'All' || i.department === deptFilter;
    const mT = typeFilter === 'All' || i.itemType === typeFilter;
    return mS && mD && mT;
  });

  // Sorted for list view: available first, then alpha
  const sortedForList = [...filtered].sort((a, b) => {
    const aAvail = a.status === 'available' ? 0 : 1;
    const bAvail = b.status === 'available' ? 0 : 1;
    if (aAvail !== bAvail) return aAvail - bAvail;
    return a.name.localeCompare(b.name);
  });

  const pendingCheckoutIds = new Set(
    (checkouts || []).filter(c => ['pending','approved','allocated'].includes(c.status)).map(c => c.itemId)
  );

  return (
    <>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
        <p style={{ fontSize:12, color:'var(--muted)', margin:0 }}>{filtered.length} item{filtered.length !== 1 ? 's' : ''}</p>
        <div style={{ display:'flex', gap:4 }}>
          <button onClick={() => setViewMode('tile')}
            style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:8, border:`1px solid ${viewMode === 'tile' ? 'var(--pine)' : 'var(--line)'}`, background: viewMode === 'tile' ? 'hsla(var(--color-green),0.1)' : 'transparent', color: viewMode === 'tile' ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            <LayoutGrid size={13} /> Tile
          </button>
          <button onClick={() => setViewMode('list')}
            style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:8, border:`1px solid ${viewMode === 'list' ? 'var(--pine)' : 'var(--line)'}`, background: viewMode === 'list' ? 'hsla(var(--color-green),0.1)' : 'transparent', color: viewMode === 'list' ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            <ClipboardList size={13} /> List
          </button>
        </div>
      </div>

      {viewMode === 'tile' ? (
        <ItemPhotoGrid
          items={filtered}
          checkouts={checkouts}
          itemsLoading={itemsLoading}
          itemsError={itemsError}
          refreshItems={refreshItems}
          onAddToCart={onAddToCart}
          inCart={inCart}
          emptyLabel="No items match your filters."
        />
      ) : (
        itemsError ? <ErrorBanner message="Could not load items." onRetry={refreshItems} /> :
        itemsLoading && !filtered.length ? <SkeletonBlocks count={6} height={48} borderRadius={8} /> :
        sortedForList.length === 0 ? (
          <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
            <Package size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
            No items match your filters.
          </div>
        ) : (
          <div style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'auto', marginBottom:20 }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:'var(--mist)' }}>
                  {['Photo','Name','Type','Make / Model','Location','Status',''].map(h =>
                    <th key={h} style={{ textAlign:'left', padding:'9px 14px', fontWeight:700, color:'var(--muted)', fontSize:11.5, whiteSpace:'nowrap' }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {sortedForList.map(item => {
                  const tm = TYPE_META[item.itemType] || TYPE_META.Other;
                  const alreadyInCart = inCart?.has(item.id);
                  const hasPending = pendingCheckoutIds.has(item.id);
                  const canAdd = onAddToCart && item.status === 'available' && !hasPending && item.ownershipType === 'transient';
                  const co = checkouts?.find(c => c.itemId === item.id && ['approved','allocated'].includes(c.status));
                  return (
                    <tr key={item.id} style={{ borderTop:'1px solid var(--line)', opacity: item.status === 'available' && !hasPending ? 1 : 0.65 }}>
                      <td style={{ padding:'8px 14px' }}>
                        {item.photoUrl
                          ? <img src={item.photoUrl} alt={item.name} style={{ width:36, height:36, borderRadius:7, objectFit:'cover', border:'1px solid var(--line)' }} />
                          : <div style={{ width:36, height:36, borderRadius:7, background:tm.bg, display:'flex', alignItems:'center', justifyContent:'center' }}><tm.Icon size={16} color={tm.color} /></div>}
                      </td>
                      <td style={{ padding:'8px 14px', fontWeight:600 }}>
                        {item.name}
                        {co && <div style={{ fontSize:11, color:'hsl(var(--color-orange))', marginTop:1 }}>With {co.requestedBy}</div>}
                      </td>
                      <td style={{ padding:'8px 14px' }}><TypeBadge type={item.itemType} /></td>
                      <td style={{ padding:'8px 14px', color:'var(--muted)', fontSize:12 }}>{[item.make, item.model].filter(Boolean).join(' · ') || '—'}</td>
                      <td style={{ padding:'8px 14px', color:'var(--muted)', fontSize:12 }}>{item.location || '—'}</td>
                      <td style={{ padding:'8px 14px' }}><StatusBadge status={hasPending ? 'checked_out' : item.status} /></td>
                      <td style={{ padding:'8px 14px' }}>
                        {canAdd && (
                          <button onClick={() => onAddToCart(item)} disabled={alreadyInCart}
                            className={alreadyInCart ? 'secondary-btn' : 'primary-btn'}
                            style={{ fontSize:12, padding:'5px 12px', display:'inline-flex', alignItems:'center', gap:5 }}>
                            {alreadyInCart ? <><CheckCircle size={11} /> In Cart</> : <><Plus size={11} /> Add</>}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

    </>
  );
}

// ── Batch Delete Confirm Modal ────────────────────────────────────────────────
function BatchDeleteConfirmModal({ selectedItems, blockedItems, onClose, onConfirm, deleting }) {
  useEscapeKey(onClose);
  const deletable = selectedItems.filter(i => !blockedItems.find(b => b.id === i.id));
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:24 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:16, padding:28, width:'100%', maxWidth:460, boxShadow:'var(--shadow-lg)' }}>
        <h3 style={{ margin:'0 0 6px', fontSize:16, fontWeight:700 }}>Delete {selectedItems.length} item{selectedItems.length !== 1 ? 's' : ''}?</h3>
        <p style={{ margin:'0 0 16px', fontSize:13, color:'var(--muted)' }}>This cannot be undone.</p>
        {blockedItems.length > 0 && (
          <div style={{ background:'hsla(var(--color-orange),0.1)', border:'1px solid hsla(var(--color-orange),0.3)', borderRadius:10, padding:'10px 14px', marginBottom:14 }}>
            <div style={{ fontWeight:700, fontSize:12.5, color:'hsl(var(--color-orange))', marginBottom:6 }}>
              <AlertCircle size={13} style={{ verticalAlign:'middle', marginRight:4 }} />
              {blockedItems.length} item{blockedItems.length !== 1 ? 's' : ''} cannot be deleted (active checkout)
            </div>
            {blockedItems.map(i => <div key={i.id} style={{ fontSize:12, color:'var(--muted)', paddingLeft:4 }}>· {i.name}</div>)}
          </div>
        )}
        {deletable.length > 0 && (
          <div style={{ background:'var(--mist)', borderRadius:10, padding:'10px 14px', marginBottom:18 }}>
            <div style={{ fontWeight:700, fontSize:12.5, marginBottom:6 }}>Will be deleted:</div>
            {deletable.map(i => <div key={i.id} style={{ fontSize:12, color:'var(--muted)', paddingLeft:4 }}>· {i.name}</div>)}
          </div>
        )}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={deleting}>Cancel</button>
          {deletable.length > 0 && (
            <button onClick={onConfirm} disabled={deleting}
              style={{ display:'inline-flex', alignItems:'center', gap:6, background:'hsl(var(--color-red))', color:'#fff', border:'none', borderRadius:9, padding:'9px 18px', fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif', opacity: deleting ? 0.6 : 1 }}>
              {deleting ? <Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> : <Trash2 size={14} />}
              Delete {deletable.length} item{deletable.length !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Batch Photo Modal ─────────────────────────────────────────────────────────
const PHOTO_TYPE_ORDER = ['Vehicles', 'Devices', 'Tools', 'Equipment', 'Keys', 'Other'];

function BatchPhotoModal({ items, onClose, onUpdate, toast }) {
  useEscapeKey(onClose);
  const [urlInputs,  setUrlInputs]  = useState({});
  const [saving,     setSaving]     = useState({});
  const [uploading,  setUploading]  = useState({});
  const [localUrls,  setLocalUrls]  = useState({});
  const fileRefs = useRef({});

  // Sort: missing photos first, then by type hierarchy, then alpha
  const sortedItems = [...items].sort((a, b) => {
    const aHas = (localUrls[a.id] ?? a.photoUrl) ? 1 : 0;
    const bHas = (localUrls[b.id] ?? b.photoUrl) ? 1 : 0;
    if (aHas !== bHas) return aHas - bHas;
    const at = PHOTO_TYPE_ORDER.indexOf(a.itemType);
    const bt = PHOTO_TYPE_ORDER.indexOf(b.itemType);
    if (at !== bt) return at - bt;
    return a.name.localeCompare(b.name);
  });

  const withPhotos = items.filter(i => localUrls[i.id] ?? i.photoUrl).length;

  async function saveUrl(item) {
    const url = (urlInputs[item.id] || '').trim();
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      toast?.('URL must start with https://', 'error'); return;
    }
    setSaving(p => ({ ...p, [item.id]: true }));
    try {
      await api.updateItem(item.id, { photo_url: url });
      setLocalUrls(p => ({ ...p, [item.id]: url }));
      setUrlInputs(p => ({ ...p, [item.id]: '' }));
      onUpdate?.();
    } catch {
      toast?.('Could not save photo URL.', 'error');
    } finally {
      setSaving(p => ({ ...p, [item.id]: false }));
    }
  }

  async function handleFile(item, file) {
    if (!file) return;
    setUploading(p => ({ ...p, [item.id]: true }));
    const path = `items/${item.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { url, error } = await uploadToSupabase(file, 'item-photos', path);
    if (error) { toast?.(error, 'error'); setUploading(p => ({ ...p, [item.id]: false })); return; }
    try {
      await api.updateItem(item.id, { photo_url: url });
      setLocalUrls(p => ({ ...p, [item.id]: url }));
      onUpdate?.();
    } catch {
      toast?.('Photo uploaded but could not save to item.', 'error');
    } finally {
      setUploading(p => ({ ...p, [item.id]: false }));
    }
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:16, width:'100%', maxWidth:680, maxHeight:'90vh', display:'flex', flexDirection:'column', boxShadow:'var(--shadow-lg)' }}>
        {/* Header */}
        <div style={{ padding:'20px 24px 16px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div>
            <h3 style={{ margin:0, fontSize:16, fontWeight:700 }}>Assign Photos</h3>
            <p style={{ margin:'3px 0 0', fontSize:12.5, color:'var(--muted)' }}>{withPhotos} / {items.length} items have photos</p>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }}><X size={18} /></button>
        </div>
        {/* Scrollable list */}
        <div style={{ overflowY:'auto', flex:1, padding:'12px 24px' }}>
          {sortedItems.map(item => {
            const currentUrl = localUrls[item.id] ?? item.photoUrl;
            const tm = TYPE_META[item.itemType] || TYPE_META.Other;
            const isSaving   = saving[item.id];
            const isUploading = uploading[item.id];
            return (
              <div key={item.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 0', borderBottom:'1px solid var(--line)' }}>
                {/* Thumb */}
                <div style={{ width:44, height:44, borderRadius:8, flexShrink:0, overflow:'hidden', background: currentUrl ? 'transparent' : tm.bg, border:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                  {currentUrl
                    ? <img src={currentUrl} alt={item.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                    : <tm.Icon size={20} color={tm.color} />}
                </div>
                {/* Name + location */}
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:600, fontSize:13, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{item.name}</div>
                  <div style={{ display:'flex', gap:6, alignItems:'center', marginTop:2 }}>
                    <TypeBadge type={item.itemType} />
                    {item.location && <span style={{ fontSize:11, color:'var(--muted)' }}>{item.location}</span>}
                    {currentUrl && <CheckCircle size={12} color="hsl(var(--color-green))" />}
                  </div>
                </div>
                {/* URL input + upload */}
                <div style={{ display:'flex', gap:6, alignItems:'center', flexShrink:0 }}>
                  <input
                    value={urlInputs[item.id] || ''}
                    onChange={e => setUrlInputs(p => ({ ...p, [item.id]: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && saveUrl(item)}
                    placeholder="Paste URL…"
                    className="form-input"
                    style={{ width:160, fontSize:12, padding:'5px 8px', height:30 }}
                  />
                  <button onClick={() => saveUrl(item)} disabled={!urlInputs[item.id] || isSaving}
                    style={{ height:30, padding:'0 10px', fontSize:12, fontWeight:600, background:'var(--pine)', color:'#fff', border:'none', borderRadius:7, cursor:'pointer', fontFamily:'Inter,sans-serif', opacity: (!urlInputs[item.id] || isSaving) ? 0.5 : 1, display:'flex', alignItems:'center', gap:4 }}>
                    {isSaving ? <Loader2 size={12} style={{ animation:'spin 1s linear infinite' }} /> : 'Save'}
                  </button>
                  <input type="file" accept="image/*" style={{ display:'none' }} ref={el => fileRefs.current[item.id] = el}
                    onChange={e => e.target.files[0] && handleFile(item, e.target.files[0])} />
                  <button onClick={() => fileRefs.current[item.id]?.click()} disabled={isUploading}
                    style={{ height:30, padding:'0 10px', fontSize:12, fontWeight:600, background:'none', border:'1px solid var(--line)', borderRadius:7, cursor:'pointer', fontFamily:'Inter,sans-serif', display:'flex', alignItems:'center', gap:4, color:'var(--muted)', opacity: isUploading ? 0.5 : 1 }}>
                    {isUploading ? <Loader2 size={12} style={{ animation:'spin 1s linear infinite' }} /> : <><UploadCloud size={12} /> Upload</>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid var(--line)', display:'flex', justifyContent:'flex-end', flexShrink:0 }}>
          <button className="secondary-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Send Alert Modal ──────────────────────────────────────────────────────────
function SendAlertModal({ onClose, toast }) {
  useEscapeKey(onClose);
  const { accounts } = useMsal();
  const senderName  = cleanName(accounts[0]?.name ?? 'Manager');

  const [users,      setUsers]      = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [search,     setSearch]     = useState('');
  const [selected,   setSelected]   = useState(new Set());
  const [subject,    setSubject]    = useState('');
  const [message,    setMessage]    = useState('');
  const [sending,    setSending]    = useState(false);

  useEffect(() => {
    api.getAllRoles()
      .then(rows => setUsers(rows))
      .catch(() => setUsers([]))
      .finally(() => setUsersLoading(false));
  }, []);

  const filteredUsers = users.filter(u => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (u.display_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  function toggleUser(email) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  }

  async function handleSend() {
    if (!selected.size) { toast?.('Select at least one recipient.', 'error'); return; }
    if (!subject.trim()) { toast?.('Subject is required.', 'error'); return; }
    if (!message.trim()) { toast?.('Message is required.', 'error'); return; }
    setSending(true);
    try {
      const res = await api.sendAlert({ to: [...selected], subject: subject.trim(), message: message.trim() });
      toast?.(res.email_sent
        ? `Alert sent to ${selected.size} recipient${selected.size !== 1 ? 's' : ''}.`
        : `Notification sent (email delivery failed — check Azure config).`, res.email_sent ? 'success' : 'error');
      onClose();
    } catch (err) {
      toast?.(err?.message || 'Could not send alert.', 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:16, width:'100%', maxWidth:560, maxHeight:'90vh', display:'flex', flexDirection:'column', boxShadow:'var(--shadow-lg)' }}>
        {/* Header */}
        <div style={{ padding:'20px 24px 16px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:'hsla(var(--color-orange),0.12)', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <Megaphone size={18} color="hsl(var(--color-orange))" />
            </div>
            <div>
              <h3 style={{ margin:0, fontSize:15, fontWeight:700 }}>Send Alert</h3>
              <p style={{ margin:0, fontSize:12, color:'var(--muted)' }}>Bell notification + email to selected users</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY:'auto', flex:1, padding:'16px 24px', display:'flex', flexDirection:'column', gap:16 }}>
          {/* Recipients */}
          <div>
            <label style={FL}>Recipients{selected.size > 0 ? ` (${selected.size} selected)` : ''}</label>
            <div className="search-bar" style={{ marginBottom:8 }}>
              <Users size={13} style={{ flexShrink:0 }} />
              <input placeholder="Search by name or email…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div style={{ border:'1px solid var(--line)', borderRadius:10, maxHeight:180, overflowY:'auto' }}>
              {usersLoading ? (
                <div style={{ padding:'20px', textAlign:'center', color:'var(--muted)', fontSize:13 }}>Loading users…</div>
              ) : filteredUsers.length === 0 ? (
                <div style={{ padding:'16px', textAlign:'center', color:'var(--muted)', fontSize:13 }}>No users found.</div>
              ) : filteredUsers.map(u => {
                const checked = selected.has(u.email);
                return (
                  <label key={u.email} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', cursor:'pointer', borderBottom:'1px solid var(--line)', background: checked ? 'hsla(var(--color-green),0.06)' : 'transparent' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleUser(u.email)} style={{ cursor:'pointer', accentColor:'var(--pine)' }} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:600, fontSize:13 }}>{u.display_name || u.email}</div>
                      <div style={{ fontSize:11.5, color:'var(--muted)' }}>{u.email}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
          {/* Subject */}
          <div>
            <label style={FL}>Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Alert subject…" className="form-input" style={{ width:'100%' }} />
          </div>
          {/* Message */}
          <div>
            <label style={FL}>Message</label>
            <textarea value={message} onChange={e => setMessage(e.target.value)} placeholder={`Write your message…\n\n— ${senderName}`} rows={4}
              className="form-input" style={{ width:'100%', resize:'vertical', fontFamily:'Inter,sans-serif', fontSize:13 }} />
          </div>
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid var(--line)', display:'flex', gap:10, justifyContent:'flex-end', flexShrink:0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={sending}>Cancel</button>
          <button onClick={handleSend} disabled={sending || !selected.size || !subject.trim() || !message.trim()}
            style={{ display:'inline-flex', alignItems:'center', gap:7, background:'hsl(var(--color-orange))', color:'#fff', border:'none', borderRadius:9, padding:'9px 18px', fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif', opacity: (sending || !selected.size || !subject.trim() || !message.trim()) ? 0.55 : 1 }}>
            {sending ? <Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> : <Send size={14} />}
            Send Alert
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Manager Manage Tab ────────────────────────────────────────────────────────
function ManagerManageTab({ items, itemsLoading, itemsError, deptFilter, typeFilter, search, refreshItems, canDelete, onAdd, onEdit, onDelete, onImport, onExport, onReport, checkouts, toast }) {
  const [photoPreview,       setPhotoPreview]       = useState(null);
  const [selected,           setSelected]           = useState(new Set());
  const [sortCol,            setSortCol]            = useState('name');
  const [sortDir,            setSortDir]            = useState('asc');
  const [batchPhotoOpen,     setBatchPhotoOpen]     = useState(false);
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  const [batchDeleting,      setBatchDeleting]      = useState(false);

  const TYPE_ORDER = ['Vehicles', 'Devices', 'Tools', 'Equipment', 'Keys', 'Other'];

  const filtered = items.filter(i => {
    const mS = !search || i.name.toLowerCase().includes(search.toLowerCase()) || (i.make||'').toLowerCase().includes(search.toLowerCase());
    const mD = deptFilter === 'All' || i.department === deptFilter;
    const mT = typeFilter === 'All' || i.itemType === typeFilter;
    return mS && mD && mT;
  });

  const sorted = [...filtered].sort((a, b) => {
    let av, bv;
    if (sortCol === 'name')     { av = a.name.toLowerCase();                          bv = b.name.toLowerCase(); }
    if (sortCol === 'type')     { av = TYPE_ORDER.indexOf(a.itemType);                bv = TYPE_ORDER.indexOf(b.itemType); }
    if (sortCol === 'location') { av = (a.location || '').toLowerCase();              bv = (b.location || '').toLowerCase(); }
    if (sortCol === 'status')   { av = a.status;                                      bv = b.status; }
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const missingPhotos = items.filter(i => !i.photoUrl).length;
  const selItems      = filtered.filter(i => selected.has(i.id));
  const blockedItems  = selItems.filter(i =>
    (checkouts || []).some(c => c.itemId === i.id && ['pending','approved','allocated'].includes(c.status))
  );

  function toggleSelect(id) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(selected.size === filtered.length && filtered.length > 0 ? new Set() : new Set(filtered.map(i => i.id)));
  }
  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  async function executeBatchDelete() {
    setBatchDeleting(true);
    const deletable = selItems.filter(i => !blockedItems.find(b => b.id === i.id));
    let failed = 0;
    for (const item of deletable) {
      try { await api.deleteItem(item.id); } catch { failed++; }
    }
    await refreshItems();
    setSelected(new Set());
    setBatchDeleteConfirm(false);
    setBatchDeleting(false);
    if (failed === 0) toast?.(`Deleted ${deletable.length} item${deletable.length !== 1 ? 's' : ''}.`);
    else toast?.(`Deleted ${deletable.length - failed} items · ${failed} failed.`, 'error');
  }

  const SortTh = ({ col, label }) => {
    const active = sortCol === col;
    return (
      <th onClick={() => toggleSort(col)}
        style={{ textAlign:'left', padding:'10px 14px', fontWeight:700, color: active ? 'var(--ink)' : 'var(--muted)', whiteSpace:'nowrap', fontSize:11.5, cursor:'pointer', userSelect:'none' }}>
        <span style={{ display:'inline-flex', alignItems:'center', gap:3 }}>
          {label}
          <ArrowUpDown size={11} style={{ opacity: active ? 1 : 0.35, color: active ? 'var(--pine)' : 'inherit', transform: active && sortDir === 'desc' ? 'scaleY(-1)' : 'none' }} />
        </span>
      </th>
    );
  };

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
        {/* Assign Photos */}
        <button className="secondary-btn" style={{ display:'inline-flex', alignItems:'center', gap:7, position:'relative' }} onClick={() => setBatchPhotoOpen(true)}>
          <Image size={14} /> Assign Photos
          {missingPhotos > 0 && (
            <span style={{ position:'absolute', top:-6, right:-6, background:'hsl(var(--color-red))', color:'#fff', borderRadius:'50%', width:16, height:16, fontSize:9.5, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center' }}>
              {missingPhotos > 99 ? '99+' : missingPhotos}
            </span>
          )}
        </button>
        {/* Batch delete */}
        {canDelete && selected.size > 0 && (
          <button onClick={() => setBatchDeleteConfirm(true)}
            style={{ display:'inline-flex', alignItems:'center', gap:7, background:'hsl(var(--color-red))', color:'#fff', border:'none', borderRadius:9, padding:'7px 14px', fontWeight:700, fontSize:12.5, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            <Trash2 size={13} /> Delete {selected.size}
          </button>
        )}
        {missingPhotos > 0 && selected.size === 0 && (
          <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6, fontSize:12.5, color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', borderRadius:8, padding:'6px 12px', border:'1px solid hsla(var(--color-red),0.25)' }}>
            <AlertCircle size={14} /> {missingPhotos} item{missingPhotos !== 1 ? 's' : ''} missing photo
          </div>
        )}
      </div>

      {itemsLoading && !items.length ? (
        <SkeletonBlocks count={8} height={52} borderRadius={8} />
      ) : sorted.length === 0 ? (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
          <Package size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
          {items.length ? 'No items match your filters.' : 'No items yet. Add one above or import a CSV.'}
        </div>
      ) : (
        <div style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'var(--mist)' }}>
                <th style={{ padding:'10px 14px', width:36 }}>
                  <input type="checkbox"
                    checked={selected.size === filtered.length && filtered.length > 0}
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < filtered.length; }}
                    onChange={toggleAll}
                    style={{ cursor:'pointer', accentColor:'var(--pine)' }} />
                </th>
                <th style={{ textAlign:'left', padding:'10px 14px', fontWeight:700, color:'var(--muted)', fontSize:11.5 }}>Photo</th>
                <SortTh col="name" label="Name" />
                <SortTh col="type" label="Type" />
                <th style={{ textAlign:'left', padding:'10px 14px', fontWeight:700, color:'var(--muted)', fontSize:11.5, whiteSpace:'nowrap' }}>Make / Model</th>
                <th style={{ textAlign:'left', padding:'10px 14px', fontWeight:700, color:'var(--muted)', fontSize:11.5 }}>Dept</th>
                <SortTh col="location" label="Location" />
                <th style={{ textAlign:'left', padding:'10px 14px', fontWeight:700, color:'var(--muted)', fontSize:11.5 }}>Ownership</th>
                <SortTh col="status" label="Status" />
                <th style={{ padding:'10px 14px' }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(item => (
                <tr key={item.id} style={{ borderTop:'1px solid var(--line)', background: selected.has(item.id) ? 'hsla(var(--color-blue),0.05)' : 'transparent' }}>
                  <td style={{ padding:'10px 14px' }}>
                    <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelect(item.id)}
                      style={{ cursor:'pointer', accentColor:'var(--pine)' }} />
                  </td>
                  <td style={{ padding:'10px 14px' }}>
                    {item.photoUrl
                      ? <PhotoThumb url={item.photoUrl} size={40} onPreview={url => setPhotoPreview(url)} />
                      : (
                        <div style={{ width:40, height:40, borderRadius:8, background:'hsla(var(--color-red),0.08)', border:'1px dashed hsla(var(--color-red),0.4)', display:'flex', alignItems:'center', justifyContent:'center' }} title="Missing photo">
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
                      <button onClick={() => onEdit(item)}
                        style={{ display:'inline-flex', alignItems:'center', gap:4, background:'none', border:'1px solid var(--line)', borderRadius:7, padding:'5px 10px', color:'var(--muted)', fontSize:11.5, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                        <Pencil size={12} /> Edit
                      </button>
                      {canDelete && (
                        <button onClick={() => onDelete(item)}
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
      <p style={{ fontSize:12, color:'var(--muted)', marginTop:10 }}>
        {sorted.length} item{sorted.length !== 1 ? 's' : ''} shown · {items.length} total
        {selected.size > 0 && <> · <strong>{selected.size} selected</strong></>}
      </p>

      {photoPreview && <ImageLightbox src={photoPreview} onClose={() => setPhotoPreview(null)} />}
      {batchPhotoOpen && (
        <BatchPhotoModal items={items} onClose={() => setBatchPhotoOpen(false)} onUpdate={refreshItems} toast={toast} />
      )}
      {batchDeleteConfirm && (
        <BatchDeleteConfirmModal
          selectedItems={selItems} blockedItems={blockedItems}
          onClose={() => setBatchDeleteConfirm(false)}
          onConfirm={executeBatchDelete} deleting={batchDeleting} />
      )}
    </>
  );
}

// ── Employee Accept Modal (employee takes checkout photo to confirm receipt) ───
function EmployeeAcceptModal({ checkout, onClose, onConfirm }) {
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
      .catch(err => { setError(err?.message || 'Could not confirm receipt.'); setUploading(false); });
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:420, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Confirm You Have It</h3>
        <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:20 }}>
          Take a photo of <strong>{checkout.itemName}</strong> to confirm you received it. This creates a condition record for the handover.
        </p>
        <div>
          <label style={FL}>HANDOVER PHOTO <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
          <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }} onChange={e => handleFile(e.target.files?.[0])} />
          {preview ? (
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <img src={preview} alt="Handover photo" style={{ width:72, height:72, objectFit:'cover', borderRadius:8, border:'1px solid var(--line)' }} />
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
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:160, justifyContent:'center' }} onClick={submit}>
            {uploading ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Uploading…</> : <><CheckCircle size={14} /> Confirm Receipt</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Allocate Modal (manager/allocator takes checkout photo here) ───────────────
// ── Photo upload slot used inside AllocateModal and ReceiptConfirmModal ────────
function PhotoSlot({ label, slotKey, photos, onChange }) {
  const ref = useRef(null);
  const entry = photos[slotKey] || {};
  function handleFile(f) {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = e => onChange(slotKey, { file: f, preview: e.target.result, name: f.name });
    reader.readAsDataURL(f);
  }
  return (
    <div style={{ marginBottom:12 }}>
      {label && <div style={{ fontSize:11.5, fontWeight:600, color:'var(--muted)', marginBottom:5, textTransform:'uppercase', letterSpacing:'.04em' }}>{label}</div>}
      <input ref={ref} type="file" accept="image/*" style={{ display:'none' }} onChange={e => handleFile(e.target.files?.[0])} />
      {entry.preview ? (
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <img src={entry.preview} alt="" style={{ width:64, height:64, objectFit:'cover', borderRadius:8, border:'1px solid var(--line)', flexShrink:0 }} />
          <div>
            <div style={{ fontSize:12, fontWeight:600, marginBottom:4 }}>{entry.name}</div>
            <button type="button" className="secondary-btn" style={{ fontSize:11.5, padding:'3px 10px' }} onClick={() => ref.current?.click()}>Replace</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => ref.current?.click()}
          style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'12px', borderRadius:9, border:'2px dashed var(--line)', background:'var(--mist)', cursor:'pointer', fontSize:13, color:'var(--muted)', fontFamily:'Inter,sans-serif' }}>
          <Camera size={15} /> Upload Photo <span style={{ fontSize:11, marginLeft:4, opacity:.6 }}>(optional)</span>
        </button>
      )}
    </div>
  );
}

// ── Handover modal for the assigned allocator ──────────────────────────────────
// onConfirm receives: { photoBy:'allocator'|'employee', batch:bool, photoMap:{[id]:{url,name}} }
function AllocateModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm }) {
  const coItems = checkoutBatch || (checkout ? [checkout] : []);
  const first   = coItems[0] || {};
  const isMulti = coItems.length > 1;

  const [step,      setStep]      = useState('who');   // 'who' | 'mode' | 'upload' | 'employee'
  const [photoMode, setPhotoMode] = useState('batch'); // 'batch' | 'individual'
  const [photos,    setPhotos]    = useState({});       // { [coId|'batch']: { file, preview, name } }
  const [uploading, setUploading] = useState(false);
  const [error,     setError]     = useState('');
  useEscapeKey(onClose);

  function handlePhotoChange(key, val) { setPhotos(prev => ({ ...prev, [key]: val })); }

  async function uploadPhotoEntry(entry, checkoutId) {
    if (!entry?.file) return { url: '', name: '' };
    const path = `checkout-photos/${checkoutId}/${Date.now()}-${entry.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { url, error: upErr } = await uploadToSupabase(entry.file, 'checkout-photos', path);
    if (upErr) throw new Error(upErr);
    return { url, name: entry.file.name };
  }

  async function submitAllocator() {
    setUploading(true); setError('');
    try {
      const photoMap = {};
      if (photoMode === 'batch') {
        const { url, name } = await uploadPhotoEntry(photos['batch'], first.id);
        coItems.forEach(co => { photoMap[co.id] = { url, name }; });
      } else {
        for (const co of coItems) {
          const { url, name } = await uploadPhotoEntry(photos[co.id], co.id);
          photoMap[co.id] = { url, name };
        }
      }
      await Promise.resolve(onConfirm({ photoBy: 'allocator', batch: photoMode === 'batch', photoMap }));
      onClose();
    } catch (err) {
      setError(err?.message || 'Upload failed — please try again.');
      setUploading(false);
    }
  }

  async function submitEmployee() {
    setUploading(true); setError('');
    try {
      await Promise.resolve(onConfirm({ photoBy: 'employee', batch: false, photoMap: {} }));
      onClose();
    } catch (err) {
      setError(err?.message || 'Could not initiate handover.');
      setUploading(false);
    }
  }

  const CARD = { background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:460, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', maxHeight:'90vh', overflowY:'auto' };

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={CARD}>

        {/* Step: who takes photos */}
        {step === 'who' && (
          <>
            <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Hand Over {isMulti ? `${coItems.length} Items` : first.itemName}</h3>
            <p style={{ fontSize:13, color:'var(--muted)', marginBottom:20 }}>
              To <strong>{first.requestedBy}</strong> — who will upload the handover photo?
            </p>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:20 }}>
              {[
                { id:'you',      icon:'📷', title:'Photos by You',      sub:'You upload now — individual items or a batch shot.' },
                { id:'employee', icon:'📱', title:'Photos by Employee', sub:'Employee confirms receipt and uploads on their side.' },
              ].map(opt => (
                <button key={opt.id} onClick={() => opt.id === 'you' ? setStep(isMulti ? 'mode' : 'upload') || setPhotoMode('batch') : setStep('employee')}
                  style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:6, padding:'14px 16px', borderRadius:12, border:'1.5px solid var(--line)', background:'var(--mist)', cursor:'pointer', textAlign:'left', fontFamily:'Inter,sans-serif', transition:'border-color .15s, box-shadow .15s' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor='var(--pine)'; e.currentTarget.style.boxShadow='0 2px 12px rgba(0,0,0,.08)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor='var(--line)'; e.currentTarget.style.boxShadow='none'; }}>
                  <span style={{ fontSize:22 }}>{opt.icon}</span>
                  <span style={{ fontWeight:700, fontSize:13.5 }}>{opt.title}</span>
                  <span style={{ fontSize:12, color:'var(--muted)', lineHeight:1.4 }}>{opt.sub}</span>
                </button>
              ))}
            </div>
            <div style={{ display:'flex', justifyContent:'flex-end' }}>
              <button className="secondary-btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {/* Step: individual or batch (only for multi-item orders) */}
        {step === 'mode' && (
          <>
            <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Photo Style</h3>
            <p style={{ fontSize:13, color:'var(--muted)', marginBottom:20 }}>
              Handing over <strong>{coItems.length} items</strong> to <strong>{first.requestedBy}</strong>.
            </p>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:20 }}>
              {[
                { id:'individual', icon:'🖼️', title:'Individual Photos', sub:'One photo per item — best for high-value assets.' },
                { id:'batch',      icon:'📦', title:'Batch Photo',       sub:'One photo of all items together — quick for groups.' },
              ].map(opt => (
                <button key={opt.id} onClick={() => { setPhotoMode(opt.id); setStep('upload'); }}
                  style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:6, padding:'14px 16px', borderRadius:12, border:'1.5px solid var(--line)', background:'var(--mist)', cursor:'pointer', textAlign:'left', fontFamily:'Inter,sans-serif', transition:'border-color .15s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor='var(--pine)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor='var(--line)'}>
                  <span style={{ fontSize:22 }}>{opt.icon}</span>
                  <span style={{ fontWeight:700, fontSize:13.5 }}>{opt.title}</span>
                  <span style={{ fontSize:12, color:'var(--muted)', lineHeight:1.4 }}>{opt.sub}</span>
                </button>
              ))}
            </div>
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => setStep('who')}>← Back</button>
              <button className="secondary-btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {/* Step: upload photos */}
        {step === 'upload' && (
          <>
            <h3 style={{ fontSize:16, fontWeight:700, marginBottom:4 }}>
              {photoMode === 'batch' ? 'Batch Photo' : 'Individual Photos'}
            </h3>
            <p style={{ fontSize:13, color:'var(--muted)', marginBottom:16 }}>
              {photoMode === 'batch'
                ? `One photo covering all ${isMulti ? coItems.length + ' items' : first.itemName} for ${first.requestedBy}.`
                : `Upload a photo for each item being handed to ${first.requestedBy}.`}
            </p>
            {photoMode === 'batch' ? (
              <PhotoSlot label={isMulti ? `All ${coItems.length} items together` : first.itemName} slotKey="batch" photos={photos} onChange={handlePhotoChange} />
            ) : (
              coItems.map(co => <PhotoSlot key={co.id} label={co.itemName} slotKey={co.id} photos={photos} onChange={handlePhotoChange} />)
            )}
            {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:8 }}>{error}</p>}
            <div style={{ display:'flex', gap:10, justifyContent:'space-between', marginTop:16 }}>
              <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => setStep(isMulti ? 'mode' : 'who')}>← Back</button>
              <div style={{ display:'flex', gap:8 }}>
                <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
                <button className="primary-btn" disabled={uploading}
                  style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:150, justifyContent:'center' }}
                  onClick={submitAllocator}>
                  {uploading ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Uploading…</> : <><CheckCircle size={14} /> Confirm Handover</>}
                </button>
              </div>
            </div>
          </>
        )}

        {/* Step: employee-photo confirmation */}
        {step === 'employee' && (
          <>
            <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Confirm Handover</h3>
            <div style={{ background:'hsla(var(--color-blue),0.07)', border:'1px solid hsla(var(--color-blue),0.2)', borderRadius:10, padding:'14px 16px', marginBottom:20 }}>
              <div style={{ fontWeight:600, fontSize:13.5, marginBottom:4 }}>
                {isMulti ? `${coItems.length} items` : first.itemName} → {first.requestedBy}
              </div>
              {isMulti && (
                <div style={{ marginTop:6, display:'flex', flexDirection:'column', gap:2 }}>
                  {coItems.map(co => <div key={co.id} style={{ fontSize:12, color:'var(--muted)' }}>· {co.itemName}</div>)}
                </div>
              )}
              <div style={{ fontSize:12.5, color:'var(--muted)', marginTop:8, lineHeight:1.5 }}>
                The employee will be prompted on their side to confirm receipt and upload a photo. The checkout won't complete until they do.
              </div>
            </div>
            {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:8 }}>{error}</p>}
            <div style={{ display:'flex', gap:10, justifyContent:'space-between' }}>
              <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => setStep('who')}>← Back</button>
              <div style={{ display:'flex', gap:8 }}>
                <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
                <button className="primary-btn" disabled={uploading}
                  style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:160, justifyContent:'center' }}
                  onClick={submitEmployee}>
                  {uploading ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Please wait…</> : <><CheckCircle size={14} /> Handed Over — Notify Employee</>}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Receipt confirmation modal for the employee ────────────────────────────────
// onConfirm receives: { batch:bool, photoMap:{[id]:{url,name}} }
function ReceiptConfirmModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm }) {
  const coItems = checkoutBatch || (checkout ? [checkout] : []);
  const first   = coItems[0] || {};
  const isMulti = coItems.length > 1;

  const [step,      setStep]      = useState(isMulti ? 'mode' : 'upload');
  const [photoMode, setPhotoMode] = useState('batch');
  const [photos,    setPhotos]    = useState({});
  const [uploading, setUploading] = useState(false);
  const [error,     setError]     = useState('');
  useEscapeKey(onClose);

  function handlePhotoChange(key, val) { setPhotos(prev => ({ ...prev, [key]: val })); }

  async function uploadPhotoEntry(entry, checkoutId) {
    if (!entry?.file) return { url: '', name: '' };
    const path = `receipt-photos/${checkoutId}/${Date.now()}-${entry.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { url, error: upErr } = await uploadToSupabase(entry.file, 'checkout-photos', path);
    if (upErr) throw new Error(upErr);
    return { url, name: entry.file.name };
  }

  async function submit() {
    setUploading(true); setError('');
    try {
      const photoMap = {};
      if (photoMode === 'batch') {
        const { url, name } = await uploadPhotoEntry(photos['batch'], first.id);
        coItems.forEach(co => { photoMap[co.id] = { url, name }; });
      } else {
        for (const co of coItems) {
          const { url, name } = await uploadPhotoEntry(photos[co.id], co.id);
          photoMap[co.id] = { url, name };
        }
      }
      await Promise.resolve(onConfirm({ batch: photoMode === 'batch', photoMap }));
      onClose();
    } catch (err) {
      setError(err?.message || 'Upload failed — please try again.');
      setUploading(false);
    }
  }

  const CARD = { background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:460, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', maxHeight:'90vh', overflowY:'auto' };

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={CARD}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:4 }}>Confirm Receipt</h3>
        <p style={{ fontSize:13, color:'var(--muted)', marginBottom:16 }}>
          {isMulti
            ? `${first.assignedAllocatorName || 'Your allocator'} has handed over ${coItems.length} items to you.`
            : `${first.assignedAllocatorName || 'Your allocator'} has handed over ${first.itemName} to you.`}
        </p>

        {step === 'mode' && (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:20 }}>
              {[
                { id:'individual', icon:'🖼️', title:'Individual Photos', sub:'One photo per item.' },
                { id:'batch',      icon:'📦', title:'Batch Photo',       sub:'One photo of all items together.' },
              ].map(opt => (
                <button key={opt.id} onClick={() => { setPhotoMode(opt.id); setStep('upload'); }}
                  style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:6, padding:'14px 16px', borderRadius:12, border:'1.5px solid var(--line)', background:'var(--mist)', cursor:'pointer', textAlign:'left', fontFamily:'Inter,sans-serif', transition:'border-color .15s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor='var(--pine)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor='var(--line)'}>
                  <span style={{ fontSize:22 }}>{opt.icon}</span>
                  <span style={{ fontWeight:700, fontSize:13.5 }}>{opt.title}</span>
                  <span style={{ fontSize:12, color:'var(--muted)', lineHeight:1.4 }}>{opt.sub}</span>
                </button>
              ))}
            </div>
            <div style={{ display:'flex', justifyContent:'flex-end' }}>
              <button className="secondary-btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {step === 'upload' && (
          <>
            {photoMode === 'batch' ? (
              <PhotoSlot label={isMulti ? `All ${coItems.length} items` : first.itemName} slotKey="batch" photos={photos} onChange={handlePhotoChange} />
            ) : (
              coItems.map(co => <PhotoSlot key={co.id} label={co.itemName} slotKey={co.id} photos={photos} onChange={handlePhotoChange} />)
            )}
            {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:8 }}>{error}</p>}
            <div style={{ display:'flex', gap:10, justifyContent:'space-between', marginTop:16 }}>
              {isMulti ? (
                <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => setStep('mode')}>← Back</button>
              ) : <span />}
              <div style={{ display:'flex', gap:8 }}>
                <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
                <button className="primary-btn" disabled={uploading}
                  style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:150, justifyContent:'center' }}
                  onClick={submit}>
                  {uploading ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Uploading…</> : <><CheckCircle size={14} /> Confirm Receipt</>}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Approve Modal (manager picks allocator) — supports single or batch ────────
function ApproveCheckoutModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm, currentUserEmail, currentUserName }) {
  const items  = checkoutBatch || (checkout ? [checkout] : []);
  const first  = items[0] || {};
  const isMulti = items.length > 1;

  const [allocators,  setAllocators]  = useState([]);
  const [pickedEmail, setPickedEmail] = useState('');
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState('');
  useEscapeKey(onClose);

  useEffect(() => {
    api.getItemAllocators().then(setAllocators).catch(() => {});
  }, []);

  function submit() {
    const chosen = allocators.find(a => a.email === pickedEmail)
      || (pickedEmail === currentUserEmail ? { email: currentUserEmail, name: currentUserName } : null);
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
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:420, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Approve Checkout{isMulti ? 's' : ''}</h3>
        {isMulti ? (
          <>
            <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:8 }}>
              Approving <strong>{items.length} items</strong> for <strong>{first.requestedBy}</strong>. One allocator will be assigned to all.
            </p>
            <div style={{ background:'var(--mist)', borderRadius:8, padding:'8px 12px', marginBottom:16, maxHeight:120, overflowY:'auto' }}>
              {items.map(co => (
                <div key={co.id} style={{ fontSize:12, color:'var(--fg)', padding:'2px 0', display:'flex', gap:8, alignItems:'center' }}>
                  <span style={{ opacity:.5 }}>·</span> {co.itemName} <span style={{ color:'var(--muted)' }}>({co.days}d)</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:20 }}>
            Approving <strong>{first.itemName}</strong> for <strong>{first.requestedBy}</strong>. Assign who will physically hand over the item.
          </p>
        )}
        <div>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
            <label style={{ ...FL, marginBottom:0 }}>ASSIGN ALLOCATOR <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
            {currentUserEmail && (
              <button onClick={() => setPickedEmail(currentUserEmail)}
                style={{ fontSize:11.5, color:'hsl(var(--color-blue))', background:'none', border:'none', cursor:'pointer', fontFamily:'Inter,sans-serif', padding:'2px 6px' }}>
                Assign to me
              </button>
            )}
          </div>
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

// ── Reject Modal — supports single or batch ───────────────────────────────────
function RejectCheckoutModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm }) {
  const items   = checkoutBatch || (checkout ? [checkout] : []);
  const first   = items[0] || {};
  const isMulti = items.length > 1;

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
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Reject Checkout{isMulti ? 's' : ''}</h3>
        {isMulti ? (
          <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:16 }}>
            Rejecting <strong>{items.length} items</strong> for <strong>{first.requestedBy}</strong>. One reason applies to all.
          </p>
        ) : (
          <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:16 }}>Rejecting <strong>{first.itemName}</strong> for {first.requestedBy}. Give a reason.</p>
        )}
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
function ManagerCheckoutsTab({ checkouts, items, userName, userEmail, approveRequest, rejectRequest, allocateItem, initiateHandover, refreshCheckouts, refreshItems, toast }) {
  const { can } = useRole();
  const isManager = can('manager');
  const [statusFilter,   setStatusFilter]   = useState('active');
  const [heldByFilter,   setHeldByFilter]   = useState('All');
  const [approvingCo,    setApprovingCo]    = useState(null);
  const [rejectingCo,    setRejectingCo]    = useState(null);
  const [approvingOrder, setApprovingOrder] = useState(null);
  const [rejectingOrder, setRejectingOrder] = useState(null);
  const [allocatingCo,   setAllocatingCo]   = useState(null);
  const [allocatingOrder, setAllocatingOrder] = useState(null);
  const [photoPreview,   setPhotoPreview]   = useState(null);
  // IDs of completed items dismissed from the active-order view via X button
  const [dismissedIds,   setDismissedIds]   = useState(new Set());

  // Build list of people who currently hold items (active checkouts)
  const holdersMap = (() => {
    const map = new Map();
    for (const c of checkouts) {
      if (['pending','approved','allocated'].includes(c.status) && c.requestedBy) {
        map.set(c.requestedByEmail || c.requestedBy, c.requestedBy);
      }
    }
    return map;
  })();

  // Group ALL checkouts by orderId first, then filter groups
  const allGrouped = (() => {
    const map = new Map();
    for (const co of [...checkouts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))) {
      const key = co.orderId || co.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(co);
    }
    return Array.from(map.values());
  })();

  const groupedOrders = allGrouped.filter(groupItems => {
    const first = groupItems[0];
    if (heldByFilter !== 'All') {
      const holderKey = first.requestedByEmail || first.requestedBy;
      if (holderKey !== heldByFilter) return false;
    }
    if (statusFilter === 'active')    return groupItems.some(c => ['pending','approved','allocated'].includes(c.status));
    if (statusFilter === 'completed') return groupItems.every(c => ['returned','rejected','cancelled'].includes(c.status));
    return groupItems.some(c => c.status === statusFilter);
  });

  const pending  = checkouts.filter(c => c.status === 'pending').length;
  const approved = checkouts.filter(c => c.status === 'approved').length;

  function handleApprove(co, allocEmail, allocName) {
    return approveRequest(co.id, userName, allocEmail, allocName)
      .then(() => { toast(`Approved ${co.itemName} — assigned to ${allocName}.`); refreshCheckouts(); });
  }

  async function handleApproveOrder(orderItems, allocEmail, allocName) {
    await Promise.allSettled(orderItems.map(co => approveRequest(co.id, userName, allocEmail, allocName)));
    toast(`${orderItems.length} item${orderItems.length > 1 ? 's' : ''} approved — assigned to ${allocName}.`);
    refreshCheckouts();
  }

  function handleReject(co, reason) {
    rejectRequest(co.id, userName, reason);
    toast('Checkout rejected.');
    refreshCheckouts();
  }

  function handleRejectOrder(orderItems, reason) {
    orderItems.forEach(co => rejectRequest(co.id, userName, reason));
    toast(`${orderItems.length} item${orderItems.length > 1 ? 's' : ''} rejected.`);
    refreshCheckouts();
  }

  function handleAllocate(co, { photoBy, batch, photoMap }) {
    const p = photoBy === 'employee'
      ? initiateHandover(co.id, userName)
      : allocateItem(co.id, userName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '', { handoverPhotoBy: 'allocator', handoverBatch: batch });
    return p.then(() => {
      if (photoBy === 'employee') {
        toast(`${co.requestedBy} has been notified to confirm receipt.`);
      } else {
        toast(`Item handed over to ${co.requestedBy} — checkout confirmed.`);
        refreshItems();
      }
      refreshCheckouts();
    });
  }

  async function handleAllocateOrder(orderItems, { photoBy, batch, photoMap }) {
    if (photoBy === 'employee') {
      await Promise.allSettled(orderItems.map(co => initiateHandover(co.id, userName)));
      toast(`${orderItems[0]?.requestedBy} has been notified to confirm receipt of ${orderItems.length} item${orderItems.length > 1 ? 's' : ''}.`);
    } else {
      await Promise.allSettled(orderItems.map(co =>
        allocateItem(co.id, userName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '', { handoverPhotoBy: 'allocator', handoverBatch: batch })
      ));
      toast(`${orderItems.length} item${orderItems.length > 1 ? 's' : ''} handed over to ${orderItems[0]?.requestedBy}.`);
      refreshItems();
    }
    refreshCheckouts();
  }

  const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric' });

  return (
    <div>
      {/* Summary chips */}
      <div style={{ display:'flex', gap:10, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
        {[
          { key:'active',    label:'Active',            count: pending + approved + checkouts.filter(c => c.status === 'allocated').length },
          { key:'pending',   label:'Pending approval',  count: pending },
          { key:'approved',  label:'Awaiting handover', count: approved },
          { key:'completed', label:'Completed',         count: checkouts.filter(c => ['returned','rejected','cancelled'].includes(c.status)).length },
        ].map(f => (
          <button key={f.key} onClick={() => setStatusFilter(f.key)}
            style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'6px 14px', borderRadius:20, border:`1px solid ${statusFilter === f.key ? 'var(--pine)' : 'var(--line)'}`, background: statusFilter === f.key ? 'hsla(var(--color-green),0.1)' : 'transparent', color: statusFilter === f.key ? 'hsl(var(--color-green))' : 'var(--muted)', fontWeight: statusFilter === f.key ? 700 : 500, fontSize:12.5, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            {f.label}
            {f.count > 0 && <span style={{ background: statusFilter === f.key ? 'hsl(var(--color-green))' : 'var(--muted)', color:'#fff', borderRadius:20, fontSize:10, fontWeight:800, padding:'1px 6px', minWidth:18, textAlign:'center' }}>{f.count}</span>}
          </button>
        ))}
      </div>
      {/* Who has what filter */}
      {holdersMap.size > 0 && (
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:18, flexWrap:'wrap' }}>
          <span style={{ fontSize:12, color:'var(--muted)', display:'flex', alignItems:'center', gap:4 }}><Users size={13} /> Who has it:</span>
          <button onClick={() => setHeldByFilter('All')}
            style={{ padding:'4px 12px', borderRadius:20, border:`1px solid ${heldByFilter === 'All' ? 'var(--pine)' : 'var(--line)'}`, background: heldByFilter === 'All' ? 'hsla(var(--color-green),0.1)' : 'transparent', color: heldByFilter === 'All' ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            All
          </button>
          {[...holdersMap.entries()].map(([key, name]) => (
            <button key={key} onClick={() => setHeldByFilter(key)}
              style={{ padding:'4px 12px', borderRadius:20, border:`1px solid ${heldByFilter === key ? 'var(--pine)' : 'var(--line)'}`, background: heldByFilter === key ? 'hsla(var(--color-green),0.1)' : 'transparent', color: heldByFilter === key ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
              {name}
            </button>
          ))}
        </div>
      )}

      {groupedOrders.length === 0 ? (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
          <ShoppingCart size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
          No checkouts in this filter.
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {groupedOrders.map(orderItems => {
            const first         = orderItems[0];
            const isMulti       = orderItems.length > 1;
            const pendingItems  = orderItems.filter(c => c.status === 'pending');
            const approvedItems = orderItems.filter(c => c.status === 'approved');
            const visibleItems  = statusFilter === 'active'
              ? orderItems.filter(c => !(['returned','rejected','cancelled'].includes(c.status) && dismissedIds.has(c.id)))
              : orderItems;

            return (
              <div key={first.orderId || first.id} style={{ border:'1px solid var(--line)', borderRadius:12, overflow:'hidden', background:'var(--card)', boxShadow:'var(--shadow-sm)' }}>
                {/* Order header */}
                <div style={{ padding:'14px 18px', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, flexWrap:'wrap', background: isMulti ? 'var(--mist)' : 'transparent', borderBottom:`1px solid var(--line)` }}>
                  <div>
                    <div style={{ fontWeight:700, fontSize:14 }}>{first.requestedBy}</div>
                    <div style={{ fontSize:12, color:'var(--muted)', marginTop:2 }}>
                      {first.department} · {fmtDate(first.createdAt)}{isMulti && ` · ${orderItems.length} items`}
                    </div>
                    {first.reason && <div style={{ fontSize:12, color:'var(--muted)', fontStyle:'italic', marginTop:3 }}>"{first.reason}"</div>}
                    {statusFilter === 'completed' && (() => {
                      const summary = orderActivitySummary(orderItems);
                      return summary ? (
                        <div style={{ marginTop:8, fontSize:12.5, color:'var(--ink)', background:'hsla(var(--color-green),0.07)', border:'1px solid hsla(var(--color-green),0.18)', borderRadius:7, padding:'7px 11px', lineHeight:1.55, maxWidth:540 }}>
                          {summary}
                        </div>
                      ) : null;
                    })()}
                  </div>
                  <div style={{ display:'flex', gap:6, flexShrink:0, alignItems:'center', flexWrap:'wrap' }}>
                    {pendingItems.length > 1 && (
                      <>
                        <button onClick={() => setRejectingOrder(pendingItems)}
                          style={{ background:'none', border:'1px solid hsla(var(--color-red),0.4)', borderRadius:8, padding:'5px 12px', fontSize:12, cursor:'pointer', color:'hsl(var(--color-red))', fontWeight:600, display:'inline-flex', alignItems:'center', gap:5, fontFamily:'Inter,sans-serif' }}>
                          <XCircle size={12} /> Reject All
                        </button>
                        <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5, padding:'6px 14px' }}
                          onClick={() => setApprovingOrder(pendingItems)}>
                          <CheckCircle size={12} /> Approve All ({pendingItems.length})
                        </button>
                      </>
                    )}
                    {approvedItems.length > 1 && (
                      <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5, padding:'6px 14px', background:'hsl(var(--color-orange))' }}
                        onClick={() => setAllocatingOrder(approvedItems)}>
                        <Camera size={12} /> Hand Over All ({approvedItems.length})
                      </button>
                    )}
                  </div>
                </div>

                {/* Item rows */}
                <div>
                  {visibleItems.map((co, idx) => {
                    const sm = CHECKOUT_STATUS_META[co.status] || { label: co.status, bg:'var(--mist)', fg:'var(--muted)', Icon: Package };
                    const item = items.find(i => i.id === co.itemId);
                    const isMyAlloc = co.assignedAllocatorEmail && co.assignedAllocatorEmail.toLowerCase() === userEmail;
                    const due = new Date(co.createdAt);
                    due.setDate(due.getDate() + (co.days || 1));
                    const isOverdue = co.status === 'allocated' && due < new Date();
                    const isCompleted = ['returned','rejected','cancelled'].includes(co.status);

                    return (
                      <div key={co.id} style={{ padding:'12px 18px', borderTop: idx > 0 ? '1px solid var(--line)' : 'none', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap', opacity: isCompleted ? 0.7 : 1 }}>
                        {item?.photoUrl
                          ? <img src={item.photoUrl} alt={co.itemName} style={{ width:38, height:38, borderRadius:7, objectFit:'cover', border:'1px solid var(--line)', flexShrink:0 }} />
                          : <div style={{ width:38, height:38, borderRadius:7, background:'var(--mist)', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}><Package size={15} style={{ opacity:.4 }} /></div>}

                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontWeight:600, fontSize:13 }}>{co.itemName}</div>
                          <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:1 }}>
                            {co.itemType} · {co.days} day{co.days !== 1 ? 's' : ''}
                            {co.assignedAllocatorName && co.status === 'approved' && <span style={{ color:'hsl(var(--color-blue))' }}> · {co.assignedAllocatorName}</span>}
                          </div>
                          {co.rejectReason && <div style={{ fontSize:11, color:'hsl(var(--color-red))', marginTop:2 }}>{co.rejectReason}</div>}
                        </div>

                        <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0, flexWrap:'wrap', justifyContent:'flex-end' }}>
                          {isOverdue && (
                            <span style={{ display:'inline-flex', alignItems:'center', gap:3, padding:'2px 7px', borderRadius:20, fontSize:10.5, fontWeight:800, background:'hsla(var(--color-orange),0.15)', color:'hsl(var(--color-orange))' }}>
                              <AlertCircle size={10} /> Overdue
                            </span>
                          )}
                          <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:sm.bg, color:sm.fg, whiteSpace:'nowrap' }}>
                            <sm.Icon size={11} /> {sm.label}
                          </span>
                          {(co.checkoutPhotoUrl || co.returnPhotoUrl) && (
                            <button onClick={() => setPhotoPreview(co.returnPhotoUrl || co.checkoutPhotoUrl)}
                              style={{ background:'none', border:'1px solid var(--line)', borderRadius:7, padding:'4px 8px', cursor:'pointer', color:'var(--muted)', display:'flex', alignItems:'center' }}>
                              <ZoomIn size={12} />
                            </button>
                          )}
                          {co.status === 'pending' && (
                            <>
                              <button onClick={() => setRejectingCo(co)}
                                style={{ background:'none', border:'1px solid hsla(var(--color-red),0.4)', borderRadius:8, padding:'5px 11px', fontSize:12, cursor:'pointer', color:'hsl(var(--color-red))', fontWeight:600, display:'inline-flex', alignItems:'center', gap:4, fontFamily:'Inter,sans-serif' }}>
                                <XCircle size={12} /> Reject
                              </button>
                              <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:4, padding:'6px 12px' }}
                                onClick={() => setApprovingCo(co)}>
                                <CheckCircle size={12} /> Approve
                              </button>
                            </>
                          )}
                          {co.status === 'approved' && isManager && (
                            <button onClick={() => setRejectingCo(co)}
                              style={{ background:'none', border:'1px solid hsla(var(--color-red),0.4)', borderRadius:8, padding:'5px 11px', fontSize:12, cursor:'pointer', color:'hsl(var(--color-red))', fontWeight:600, display:'inline-flex', alignItems:'center', gap:4, fontFamily:'Inter,sans-serif' }}>
                              <XCircle size={12} /> Reject
                            </button>
                          )}
                          {co.status === 'approved' && (isMyAlloc || isManager) && (
                            <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:4, background:'hsl(var(--color-orange))', padding:'6px 12px' }}
                              onClick={() => setAllocatingCo(co)}>
                              <Camera size={12} /> Hand Over
                            </button>
                          )}
                          {isCompleted && statusFilter === 'active' && (
                            <button onClick={() => setDismissedIds(prev => new Set([...prev, co.id]))} title="Dismiss"
                              style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', padding:4, display:'flex', alignItems:'center', borderRadius:6 }}>
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {approvingCo && (
        <ApproveCheckoutModal checkout={approvingCo} onClose={() => setApprovingCo(null)}
          onConfirm={(email, name) => handleApprove(approvingCo, email, name)}
          currentUserEmail={userEmail} currentUserName={userName} />
      )}
      {rejectingCo && (
        <RejectCheckoutModal checkout={rejectingCo} onClose={() => setRejectingCo(null)}
          onConfirm={reason => handleReject(rejectingCo, reason)} />
      )}
      {approvingOrder && (
        <ApproveCheckoutModal checkouts={approvingOrder} onClose={() => setApprovingOrder(null)}
          onConfirm={(email, name) => handleApproveOrder(approvingOrder, email, name)}
          currentUserEmail={userEmail} currentUserName={userName} />
      )}
      {rejectingOrder && (
        <RejectCheckoutModal checkouts={rejectingOrder} onClose={() => setRejectingOrder(null)}
          onConfirm={reason => handleRejectOrder(rejectingOrder, reason)} />
      )}
      {allocatingCo && (
        <AllocateModal checkout={allocatingCo} onClose={() => setAllocatingCo(null)}
          onConfirm={payload => handleAllocate(allocatingCo, payload)} />
      )}
      {allocatingOrder && (
        <AllocateModal checkouts={allocatingOrder} onClose={() => setAllocatingOrder(null)}
          onConfirm={payload => handleAllocateOrder(allocatingOrder, payload)} />
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
    allocateItem, initiateHandover, confirmReceipt, returnItem, cancelRequest,
    refreshItems, refreshCheckouts,
  } = useInventory();
  const { addNotification } = useNotifications();
  const { can, canAccessModule, loading: roleLoading } = useRole();
  const { accounts } = useMsal();
  const userName  = cleanName(accounts[0]?.name ?? 'Employee');
  const userEmail = (accounts[0]?.username ?? '').toLowerCase();

  const isManager = can('manager');  // level >= 3; checked after role loads
  const canDelete = canAccessModule('inventory', 'owner', 'full');

  const pendingCount   = checkouts.filter(c => c.status === 'pending').length;
  const approvedCount  = checkouts.filter(c => c.status === 'approved').length;
  const myActiveCount  = checkouts.filter(c =>
    ['pending','approved','pending_receipt','allocated'].includes(c.status) &&
    ((c.requestedByEmail && c.requestedByEmail.toLowerCase() === userEmail) || c.requestedBy === userName)
  ).length;

  // Cart — DB-backed, survives logout and device switches
  const [cart,        setCart]        = useState([]);
  const [cartOpen,    setCartOpen]    = useState(false);
  const [cartBusy,    setCartBusy]    = useState(false);
  const [returningCo, setReturningCo] = useState(null);

  useEffect(() => {
    api.getItemCart().then(rows => {
      setCart(rows.map(r => ({ id: r.id, item: { id: r.itemId, name: r.itemName, itemType: r.itemType }, days: 1 })));
    }).catch(() => {});
  }, []);

  const inCart = new Set(cart.map(c => c.item.id));
  function addToCart(item) {
    if (inCart.has(item.id)) return;
    const optimisticId = `cart-${Date.now()}`;
    setCart(prev => [...prev, { id: optimisticId, item, days: 1 }]);
    api.addItemToCart({ item_id: item.id, item_name: item.name, item_type: item.itemType })
      .then(saved => setCart(prev => prev.map(c => c.id === optimisticId ? { id: saved.id, item, days: 1 } : c)))
      .catch(() => setCart(prev => prev.filter(c => c.id !== optimisticId)));
  }
  function removeFromCart(cartId) {
    const entry = cart.find(c => c.id === cartId);
    setCart(prev => prev.filter(c => c.id !== cartId));
    if (entry) api.removeItemFromCart(entry.item.id).catch(() => {});
  }
  function handleDaysChange(cartId, days) {
    setCart(prev => prev.map(c => c.id === cartId ? { ...c, days } : c));
  }
  async function handleSubmitCart({ reason }) {
    setCartBusy(true);
    const results = await submitCartCheckouts(cart, { reason, raisedBy: userName, raisedByEmail: userEmail });
    const succeededItems = cart.filter((_, i) => results[i].status === 'fulfilled');
    const failedItems    = cart.filter((_, i) => results[i].status === 'rejected');
    await Promise.all(succeededItems.map(c => api.removeItemFromCart(c.item.id).catch(() => {})));
    setCartBusy(false); setCartOpen(false); setCart(failedItems);
    if (succeededItems.length > 0) toast(`${succeededItems.length} checkout${succeededItems.length !== 1 ? 's' : ''} submitted.`);
    if (failedItems.length > 0) {
      const allConflict = results.filter(r => r.status === 'rejected').every(r => r.reason?.message?.includes('active checkout'));
      toast(
        <div>
          <div style={{ fontWeight:700, marginBottom:5 }}>
            {failedItems.length} item{failedItems.length !== 1 ? 's' : ''} couldn't be submitted
          </div>
          <ul style={{ margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:2 }}>
            {failedItems.map((c, i) => <li key={i} style={{ fontSize:12 }}>{c.item.name}</li>)}
          </ul>
          {allConflict && <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:5 }}>Each already has an active checkout request.</div>}
        </div>,
        'error'
      );
    }
  }

  // Manager-only tab/modal state
  const [mainTab,       setMainTab]       = useState('catalog');
  const [deptFilter,    setDeptFilter]    = useState('All');
  const [typeFilter,    setTypeFilter]    = useState('All');
  const [search,        setSearch]        = useState('');
  const [addItemOpen,   setAddItemOpen]   = useState(false);
  const [editingItem,   setEditingItem]   = useState(null);
  const [deletingItem,  setDeletingItem]  = useState(null);
  const [importOpen,    setImportOpen]    = useState(false);
  const [reportOpen,    setReportOpen]    = useState(false);
  const [sendAlertOpen, setSendAlertOpen] = useState(false);

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

  if (!isManager) {
    return (
      <>
        <EmployeeView
          items={items} checkouts={checkouts}
          userName={userName} userEmail={userEmail}
          itemsLoading={itemsLoading} itemsError={itemsError}
          onReturn={(id, data) => returnItem(id, data)}
          refreshItems={refreshItems} refreshCheckouts={refreshCheckouts}
          submitCartCheckouts={submitCartCheckouts}
          cancelRequest={cancelRequest}
          allocateItem={allocateItem}
          confirmReceipt={confirmReceipt}
          addNotification={addNotification}
          toast={toast}
        />
        <Toast toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  const cancelCo = (co, opts = {}) => cancelRequest(co.id, userName)
    .then(() => { if (!opts.silent) toast('Checkout cancelled.'); })
    .catch(() => { if (!opts.silent) toast('Could not cancel.', 'error'); });

  return (
    <div style={{ animation:'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Header */}
      <div className="view-header" style={{ marginBottom:0 }}>
        <div className="view-title-group">
          <h2>Item Management</h2>
          <p>Company assets across all departments and locations</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          <button className="secondary-btn" style={{ display:'inline-flex', alignItems:'center', gap:7, color:'hsl(var(--color-orange))' }} onClick={() => setSendAlertOpen(true)} title="Send alert to team members">
            <Megaphone size={14} /> Send Alert
          </button>
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

      {/* Pending approvals banner */}
      {pendingCount > 0 && (
        <div onClick={() => setMainTab('checkouts')}
          style={{ margin:'16px 0 0', background:'hsla(var(--color-orange),0.1)', border:'1px solid hsla(var(--color-orange),0.35)', borderRadius:12, padding:'12px 18px', display:'flex', alignItems:'center', gap:12, cursor:'pointer' }}>
          <AlertCircle size={18} color="hsl(var(--color-orange))" style={{ flexShrink:0 }} />
          <div style={{ flex:1 }}>
            <span style={{ fontWeight:700, fontSize:13.5 }}>{pendingCount} checkout request{pendingCount !== 1 ? 's' : ''} waiting for your approval</span>
            <span style={{ fontSize:12, color:'var(--muted)', marginLeft:8 }}>Tap to review</span>
          </div>
          <ChevronRight size={16} style={{ color:'var(--muted)', flexShrink:0 }} />
        </div>
      )}

      {/* KPI strip — only relevant when browsing or managing items */}
      {(mainTab === 'catalog' || mainTab === 'manage') && <div className="kpi-grid" style={{ gridTemplateColumns:'repeat(4,1fr)', margin:'16px 0 20px' }}>
        {[
          { label:'Available',      value: items.filter(i => i.status === 'available').length,    color:'card-green'  },
          { label:'Total Items',    value: items.length,                                          color:'card-blue'   },
          { label:'Checked Out',    value: items.filter(i => i.status === 'checked_out').length,  color:'card-orange' },
          { label:'Missing Photos', value: items.filter(i => !i.photoUrl).length,                 color: items.filter(i => !i.photoUrl).length > 0 ? 'card-red' : '' },
        ].map(({ label, value, color }) => (
          <div key={label} className={`kpi-card ${color}`}>
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{value}</div>
          </div>
        ))}
      </div>}

      {/* Tab strip */}
      <div style={{ display:'flex', gap:0, marginBottom:20, borderBottom:'1px solid var(--line)', flexWrap:'wrap' }}>
        {[
          { id:'catalog',      label:'Catalog',           Icon: Package                                     },
          { id:'manage',       label:'Manage',            Icon: ClipboardList                               },
          { id:'checkouts',    label:'Checkouts',         Icon: ShoppingCart, badge: pendingCount + approvedCount },
          { id:'purchasereqs', label:'Purchase Requests', Icon: FileText                                    },
          { id:'myitems',      label:'My Items',          Icon: User,         badge: myActiveCount          },
          { id:'audit',        label:'Audit Log',         Icon: History                                     },
        ].map(({ id, label, Icon, badge }) => (
          <button key={id} onClick={() => setMainTab(id)}
            style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'10px 16px', background:'none', border:'none', borderBottom: mainTab === id ? '2px solid var(--pine)' : '2px solid transparent', color: mainTab === id ? 'var(--ink)' : 'var(--muted)', fontWeight: mainTab === id ? 700 : 600, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif', marginBottom:-1 }}>
            <Icon size={14} /> {label}
            {badge > 0 && <span style={{ background:'hsl(var(--color-orange))', color:'#fff', borderRadius:20, fontSize:10, fontWeight:800, padding:'1px 6px', marginLeft:2 }}>{badge}</span>}
          </button>
        ))}
        {(mainTab === 'catalog' || mainTab === 'manage') && (
          <div className="search-bar" style={{ marginLeft:'auto', flex:1, maxWidth:480, minWidth:220, marginBottom:0 }}>
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
          refreshItems={refreshItems} onAddToCart={addToCart} inCart={inCart}
          checkouts={checkouts} userEmail={userEmail} userName={userName}
          onReturn={co => setReturningCo(co)} onCancel={cancelCo}
          onSelfAllocate={co => allocateItem(co.id, userName).then(() => toast(`Confirmed — ${co.itemName} is with you.`)).catch(() => toast('Could not confirm.', 'error'))}
        />
      )}
      {mainTab === 'manage' && (
        <ManagerManageTab
          items={items} itemsLoading={itemsLoading} itemsError={itemsError}
          deptFilter={deptFilter} typeFilter={typeFilter} search={search}
          refreshItems={refreshItems} canDelete={canDelete}
          onAdd={() => setAddItemOpen(true)} onEdit={setEditingItem}
          onDelete={setDeletingItem} onImport={() => setImportOpen(true)}
          onExport={() => downloadItemsCsv(items)} onReport={() => setReportOpen(true)}
          checkouts={checkouts} toast={toast}
        />
      )}
      {mainTab === 'myitems' && (
        <div>
          <MyCheckoutsPanel
            checkouts={checkouts} userEmail={userEmail} userName={userName}
            onReturn={co => setReturningCo(co)} onCancel={cancelCo}
            onSelfAllocate={co => allocateItem(co.id, userName).then(() => toast(`Confirmed — ${co.itemName} is with you.`)).catch(() => toast('Could not confirm.', 'error'))}
            onConfirmReceipt={(co, batch, photoMap) =>
              confirmReceipt(co.id, userName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '')
                .catch(() => { throw new Error(`Could not confirm receipt for ${co.itemName}.`); })
            }
            onReRequest={async (co, newReason) => {
              await api.createItemCheckout({
                id: crypto.randomUUID(),
                item_id: co.itemId, item_name: co.itemName, item_type: co.itemType,
                requested_by: co.requestedBy, requested_by_email: co.requestedByEmail || userEmail,
                raised_by: userName, department: co.department, days: co.days || 1,
                reason: newReason, order_id: null,
              });
              toast(`Re-submitted request for ${co.itemName}.`);
              refreshCheckouts();
            }}
          />
          {myActiveCount === 0 && (
            <div style={{ textAlign:'center', padding:'64px 20px', color:'var(--muted)' }}>
              <Package size={36} style={{ opacity:.15, display:'block', margin:'0 auto 14px' }} />
              <div style={{ fontWeight:600, fontSize:15, marginBottom:6 }}>No active checkouts</div>
              <div style={{ fontSize:13 }}>Your personal item checkouts will appear here.</div>
            </div>
          )}
        </div>
      )}
      {mainTab === 'checkouts' && (
        <ManagerCheckoutsTab
          checkouts={checkouts} items={items}
          userName={userName} userEmail={userEmail}
          approveRequest={approveRequest} rejectRequest={rejectRequest}
          allocateItem={allocateItem} initiateHandover={initiateHandover}
          refreshCheckouts={refreshCheckouts} refreshItems={refreshItems} toast={toast}
        />
      )}
      {mainTab === 'purchasereqs' && (
        <div style={{ padding:'48px 0', textAlign:'center', color:'var(--muted)' }}>
          <FileText size={40} style={{ opacity:.15, display:'block', margin:'0 auto 16px' }} />
          <div style={{ fontWeight:700, fontSize:16, marginBottom:8 }}>Purchase Requests</div>
          <div style={{ fontSize:13, maxWidth:360, margin:'0 auto' }}>
            Submit and track requests for items that aren't in the current catalog.
            This feature is coming soon.
          </div>
        </div>
      )}
      {mainTab === 'audit' && <AuditLogPanel />}

      {sendAlertOpen && <SendAlertModal onClose={() => setSendAlertOpen(false)} toast={toast} />}
      {addItemOpen  && <AddItemModal   onClose={() => setAddItemOpen(false)}  onSave={handleAddItem} />}
      {editingItem  && <EditItemModal  item={editingItem} onClose={() => setEditingItem(null)} onSave={data => handleEditItem(editingItem, data)} />}
      {deletingItem && <DeleteItemModal item={deletingItem} onClose={() => setDeletingItem(null)} onConfirm={() => handleDeleteItem(deletingItem)} />}
      {importOpen   && <ImportItemsModal onClose={() => setImportOpen(false)} onImport={handleImport} />}
      {reportOpen   && <ReportModal onClose={() => setReportOpen(false)} />}
      {returningCo  && (
        <ReturnModal checkout={returningCo} onClose={() => setReturningCo(null)}
          onSubmit={data => returnItem(returningCo.id, data).then(() => { toast(`Return confirmed — ${returningCo.itemName}`); setReturningCo(null); })} />
      )}

      <CartDrawer open={cartOpen} cart={cart} onClose={() => setCartOpen(false)}
        onRemove={removeFromCart} onSubmit={handleSubmitCart} submitting={cartBusy}
        onDaysChange={handleDaysChange} />

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
