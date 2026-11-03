// Item Management - Batch photo update and AI photo fill.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useRef } from 'react';
import { CheckCircle, X, UploadCloud, Image, Wand2, Link2 } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import HoldButton, { HOLD_MAJOR_MS } from '../../ui/HoldButton';
import { TYPE_META } from '../model/status';
import { useEscapeKey } from '../ui/hooks';
import { uploadToSupabase } from '../ui/upload';
import { TypeBadge } from '../ui/badges';
import { BatchTabs } from './BatchTabs';

// ── Batch Photo Modal ─────────────────────────────────────────────────────────
const PHOTO_TYPE_ORDER = ['Vehicles', 'Devices', 'Tools', 'Equipment', 'Keys', 'Other'];

// `items` is the CURRENTLY FILTERED list from Manage - Sai: filtering to 34
// Computers must scope this modal to those 34, not all 437. The master link bar
// (Visesh) sets one image on every shown item at once, and AI fill now lives here
// (Neil: AI fill belongs in batch photo edit, never on the Manage bar).
export function BatchPhotoModal({ items, usingSelection, onSwitchTab, onClose, onUpdate, toast }) {
  useEscapeKey(onClose);
  const [urlInputs,  setUrlInputs]  = useState({});
  const [saving,     setSaving]     = useState({});
  const [uploading,  setUploading]  = useState({});
  const [localUrls,  setLocalUrls]  = useState({});
  const [aiRow,      setAiRow]      = useState({});      // per-item AI fill in flight
  const [masterUrl,  setMasterUrl]  = useState('');
  const [applyingMaster,  setApplyingMaster]  = useState(false); // master-link apply in flight
  const [uploadingMaster, setUploadingMaster] = useState(false); // master-upload apply in flight
  const [pasteFocusId, setPasteFocusId] = useState(null);        // slot armed for Ctrl+V paste
  const [confirmState, setConfirmState] = useState(null);        // in-app confirm: { message, fn }
  const askConfirm = (message, fn) => setConfirmState({ message, fn });
  const fileRefs = useRef({});
  const masterFileRef = useRef(null);

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

  const withPhotos  = items.filter(i => localUrls[i.id] ?? i.photoUrl).length;

  // Push ONE url onto every shown item (Visesh). Sequential so the
  // dedupe/notification rules that batch updates rely on stay race-safe.
  async function pushUrlToAll(url) {
    let ok = 0;
    for (const item of items) {
      try {
        await api.updateItem(item.id, { photo_url: url });
        setLocalUrls(p => ({ ...p, [item.id]: url }));
        ok += 1;
      } catch { /* keep going */ }
    }
    onUpdate?.();
    return ok;
  }

  // Master LINK: apply a pasted url to every shown item (one in-app confirm).
  function applyMasterUrl() {
    const url = masterUrl.trim();
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      toast?.('Master link must start with https://', 'error'); return;
    }
    askConfirm('This sets the linked image on every item and overwrites their current photos.', async () => {
      setApplyingMaster(true);
      const ok = await pushUrlToAll(url);
      setApplyingMaster(false);
      setMasterUrl('');
      toast?.(`Applied the master photo to ${ok} item${ok !== 1 ? 's' : ''}.`, ok ? 'success' : 'error');
    });
  }

  // Master UPLOAD: upload ONE image, then apply it to every shown item (one confirm).
  function applyMasterFile(file) {
    if (!file) return;
    askConfirm('This uploads the image and sets it on every item, overwriting their current photos.', async () => {
      setUploadingMaster(true);
      const name = (file.name || 'photo.png').replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `items/_batch/${Date.now()}-${name}`;
      const { url, error } = await uploadToSupabase(file, 'item-photos', path);
      if (error) { toast?.(error, 'error'); setUploadingMaster(false); return; }
      const ok = await pushUrlToAll(url);
      setUploadingMaster(false);
      toast?.(`Applied the uploaded photo to ${ok} item${ok !== 1 ? 's' : ''}.`, ok ? 'success' : 'error');
    });
  }

  // Paste an image onto the master bar → upload once and apply it to every item
  // (after a confirm). Pasting text (a URL) into the link box still works normally.
  function handleMasterPaste(e) {
    const list = e.clipboardData?.items || [];
    for (const it of list) {
      if (it.type && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          const file = blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' });
          applyMasterFile(file);
          return;
        }
      }
    }
  }

  // AI fill ONE item. Never replaces an existing photo (replace=false) - Neil's
  // hard rule. This is also the fix for "can't AI-fill a single item" (the old
  // Manage button always ran every photo-less item).
  async function aiFillOne(item) {
    if (aiRow[item.id]) return;
    setAiRow(p => ({ ...p, [item.id]: true }));
    try {
      const { results } = await api.autoFillItemPhotos([item.id], false);
      const r = (results || [])[0];
      if (r?.status === 'ok' && r.photo_url) setLocalUrls(p => ({ ...p, [item.id]: r.photo_url }));
      else if (r?.status !== 'already_has_photo') toast?.(`No product photo found for ${item.name}.`, 'error');
      onUpdate?.();
    } catch {
      toast?.('AI photo fill failed.', 'error');
    } finally {
      setAiRow(p => ({ ...p, [item.id]: false }));
    }
  }

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
    const name = (file.name || 'photo.png').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `items/${item.id}/${Date.now()}-${name}`;
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

  // Paste an image straight onto a slot (Ctrl/Cmd+V) - copy a screenshot or an
  // image file, click the photo box, and paste. Clipboard images often arrive as
  // a nameless blob, so give them a filename for the upload.
  function handlePaste(item, e) {
    const list = e.clipboardData?.items || [];
    for (const it of list) {
      if (it.type && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          const file = blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' });
          handleFile(item, file);
          return;
        }
      }
    }
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:16, width:'100%', maxWidth:680, maxHeight:'90vh', display:'flex', flexDirection:'column', boxShadow:'var(--shadow-lg)' }}>
        {/* Header */}
        <div style={{ padding:'18px 24px 16px', borderBottom:'1px solid var(--line)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
            <BatchTabs tab="photos" onTab={onSwitchTab} />
            <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }}><X size={18} /></button>
          </div>
          <h3 style={{ margin:0, fontSize:16, fontWeight:700 }}>Photos · {items.length} {usingSelection ? 'selected' : 'shown'} item{items.length !== 1 ? 's' : ''}</h3>
          <p style={{ margin:'3px 0 0', fontSize:12.5, color:'var(--muted)' }}>{withPhotos} / {items.length} have a photo · click a photo box and press <strong>Ctrl/Cmd+V</strong> to paste an image</p>
        </div>
        {/* Controls: a single master image - pasted as a link OR uploaded -
            applied to every shown item. Apply sits on the right; Upload to all
            beside it on the left. */}
        <div onPaste={handleMasterPaste} style={{ padding:'12px 24px', borderBottom:'1px solid var(--line)', display:'flex', gap:10, flexWrap:'wrap', alignItems:'center', flexShrink:0 }}>
          <Link2 size={15} style={{ color:'var(--muted)', flexShrink:0 }} />
          <input value={masterUrl} onChange={e => setMasterUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !applyingMaster && !uploadingMaster && applyMasterUrl()}
            placeholder="Master image link, or paste an image to apply to all"
            className="form-input" style={{ flex:1, minWidth:200, fontSize:12.5, padding:'7px 10px', height:34 }} />
          <input type="file" accept="image/*" style={{ display:'none' }} ref={masterFileRef}
            onChange={e => { const f = e.target.files?.[0]; if (f) applyMasterFile(f); e.target.value = ''; }} />
          <button onClick={() => masterFileRef.current?.click()} disabled={applyingMaster || uploadingMaster}
            title="Upload one image and apply it to every item shown above"
            style={{ height:34, padding:'0 14px', fontSize:12.5, fontWeight:700, background:'none', color:'var(--muted)', border:'1px solid var(--line)', borderRadius:8, cursor:(applyingMaster||uploadingMaster)?'default':'pointer', fontFamily:'Inter,sans-serif', opacity:(applyingMaster||uploadingMaster)?0.5:1, display:'inline-flex', alignItems:'center', gap:6, whiteSpace:'nowrap' }}>
            {uploadingMaster ? <Spinner size={13} /> : <UploadCloud size={13} />}
            Upload to all
          </button>
          <button onClick={applyMasterUrl} disabled={!masterUrl.trim() || applyingMaster || uploadingMaster}
            title="Set this one image link on every item shown above"
            style={{ height:34, padding:'0 14px', fontSize:12.5, fontWeight:700, background:'var(--pine)', color:'#fff', border:'none', borderRadius:8, cursor:(!masterUrl.trim()||applyingMaster||uploadingMaster)?'default':'pointer', fontFamily:'Inter,sans-serif', opacity:(!masterUrl.trim()||applyingMaster||uploadingMaster)?0.5:1, display:'inline-flex', alignItems:'center', gap:6, whiteSpace:'nowrap' }}>
            {applyingMaster ? <Spinner size={13} /> : <Link2 size={13} />}
            Apply to {items.length}
          </button>
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
                {/* Thumb - also a paste target: click it, then Ctrl/Cmd+V to paste an image */}
                <div tabIndex={0} role="button"
                  title="Click, then press Ctrl/Cmd+V to paste an image"
                  onPaste={e => handlePaste(item, e)}
                  onFocus={() => setPasteFocusId(item.id)}
                  onBlur={() => setPasteFocusId(p => p === item.id ? null : p)}
                  style={{ position:'relative', width:44, height:44, borderRadius:8, flexShrink:0, overflow:'hidden', background: currentUrl ? 'transparent' : tm.bg, cursor:'pointer', outline:'none',
                    border: pasteFocusId === item.id ? '2px solid var(--pine)' : '1px solid var(--line)',
                    boxShadow: pasteFocusId === item.id ? '0 0 0 3px hsla(var(--color-green),0.18)' : 'none',
                    display:'flex', alignItems:'center', justifyContent:'center' }}>
                  {isUploading
                    ? <Spinner size="inline" />
                    : currentUrl
                    ? <img src={currentUrl} alt={item.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                    : <tm.Icon size={20} color={tm.color} />}
                  {pasteFocusId === item.id && !isUploading && (
                    <span style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'hsla(var(--color-green),0.15)', fontSize:8.5, fontWeight:800, color:'var(--pine)', letterSpacing:'.02em' }}>⌘/Ctrl V</span>
                  )}
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
                    {isSaving ? <Spinner size={12} /> : 'Save'}
                  </button>
                  <input type="file" accept="image/*" style={{ display:'none' }} ref={el => fileRefs.current[item.id] = el}
                    onChange={e => e.target.files[0] && handleFile(item, e.target.files[0])} />
                  <button onClick={() => fileRefs.current[item.id]?.click()} disabled={isUploading}
                    style={{ height:30, padding:'0 10px', fontSize:12, fontWeight:600, background:'none', border:'1px solid var(--line)', borderRadius:7, cursor:'pointer', fontFamily:'Inter,sans-serif', display:'flex', alignItems:'center', gap:4, color:'var(--muted)', opacity: isUploading ? 0.5 : 1 }}>
                    {isUploading ? <Spinner size={12} /> : <><UploadCloud size={12} /> Upload</>}
                  </button>
                  {!currentUrl && (
                    <button onClick={() => aiFillOne(item)} disabled={aiRow[item.id]}
                      title="Find a product photo for this item with AI"
                      style={{ height:30, padding:'0 10px', fontSize:12, fontWeight:600, background:'hsla(var(--color-purple),0.1)', color:'hsl(var(--color-purple))', border:'1px solid hsla(var(--color-purple),0.35)', borderRadius:7, cursor:aiRow[item.id]?'default':'pointer', fontFamily:'Inter,sans-serif', display:'flex', alignItems:'center', gap:4, opacity:aiRow[item.id]?0.6:1 }}>
                      {aiRow[item.id] ? <Spinner size={12} /> : <><Wand2 size={12} /> AI</>}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid var(--line)', display:'flex', justifyContent:'flex-end', flexShrink:0 }}>
          <button className="secondary-btn" onClick={onClose}>Done</button>
        </div>
      </div>
      {/* In-app confirm for the master "apply to all" actions - one prompt, Nexus
          styled, never the browser's native dialog. */}
      {confirmState && (
        <div onClick={e => e.target === e.currentTarget && setConfirmState(null)}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1300, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:'var(--card)', borderRadius:14, padding:'22px 24px', width:'100%', maxWidth:400, boxShadow:'var(--shadow-lg)' }}>
            <h3 style={{ margin:'0 0 7px', fontSize:15, fontWeight:700 }}>Apply to all {items.length} item{items.length !== 1 ? 's' : ''}?</h3>
            <p style={{ margin:'0 0 18px', fontSize:13, color:'var(--muted)', lineHeight:1.55 }}>{confirmState.message}</p>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <button className="secondary-btn" onClick={() => setConfirmState(null)}>Cancel</button>
              {/* Overwrites every item's photo: held (Hold to confirm, Neil, Oct 30 2026). */}
              <HoldButton label={`Apply To ${items.length}`} doneLabel="Applied" icon={Image} holdMs={HOLD_MAJOR_MS} clickRuns
                onConfirm={() => confirmState.fn?.()} onDone={() => setConfirmState(null)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
