// Item Management - The Recycle Bin.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useRef, useEffect, useCallback } from 'react';
import { RotateCcw, X, Trash2 } from 'lucide-react';
import { SkeletonBlocks } from '../../components/AsyncState';
import { api } from '../../api';
import { useNameResolver } from '../../lib/useNameResolver';
import { formatDateLong } from '../../lib/datetime';
import { RECYCLE_BIN_DAYS } from '../model/status';
import { useEscapeKey } from '../ui/hooks';

// ── Recycle Bin (deleted items) ───────────────────────────────────────────────
// Soft-deleted items, restorable (Ankush). Shows "Deleted In" = location at the
// time of deletion, plus who/when.
export function DeletedItemsModal({ onClose, onRestored, toast, highlightId }) {
  useEscapeKey(onClose);
  const [rows,      setRows]      = useState(null);
  const [selected,  setSelected]  = useState(new Set());
  const [busy,      setBusy]      = useState(false);
  const [flash,     setFlash]     = useState(null);   // item id glowing (from "Open item →")
  const highlightRef = useRef(null);
  const nameOf = useNameResolver();

  const load = useCallback(() => {
    api.getDeletedItems().then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Once the list loads, scroll to + select + glow the item we were sent here for.
  useEffect(() => {
    if (!highlightId || !rows) return;
    if (!rows.some(r => r.id === highlightId)) return; // not in the bin (e.g. purged)
    setFlash(highlightId);
    setSelected(new Set([highlightId]));
    if (highlightRef.current) highlightRef.current.scrollIntoView({ behavior:'smooth', block:'center' });
    const t = setTimeout(() => setFlash(null), 2800);
    return () => clearTimeout(t);
  }, [highlightId, rows]);

  const toggle = id => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const fmtWhen = iso => formatDateLong(iso, '');
  // Days remaining before this item is purged for good (deleted_at + retention).
  const daysLeft = iso => { try { return Math.max(0, Math.ceil((new Date(iso).getTime() + RECYCLE_BIN_DAYS * 864e5 - Date.now()) / 864e5)); } catch { return null; } };

  async function restore(ids) {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      if (ids.length === 1) await api.restoreItem(ids[0]);
      else await api.bulkRestoreItems(ids);
      toast?.(`Restored ${ids.length} item${ids.length !== 1 ? 's' : ''}.`);
      setSelected(new Set());
      onRestored?.();
      load();
    } catch (e) {
      toast?.(e?.message || 'Could not restore.', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:16, width:'100%', maxWidth:680, maxHeight:'88vh', display:'flex', flexDirection:'column', boxShadow:'var(--shadow-lg)' }}>
        <div style={{ padding:'20px 24px 14px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div>
            <h3 style={{ margin:0, fontSize:16, fontWeight:700 }}>Recycle Bin</h3>
            <p style={{ margin:'3px 0 0', fontSize:12.5, color:'var(--muted)' }}>{rows ? `${rows.length} deleted item${rows.length !== 1 ? 's' : ''}` : 'Loading…'} · kept for {RECYCLE_BIN_DAYS} days, then permanently deleted</p>
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            {selected.size > 0 && (
              <button onClick={() => restore([...selected])} disabled={busy}
                style={{ display:'inline-flex', alignItems:'center', gap:6, background:'var(--pine)', color:'#fff', border:'none', borderRadius:8, padding:'7px 12px', fontWeight:700, fontSize:12.5, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                <RotateCcw size={13} /> Restore {selected.size}
              </button>
            )}
            <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }}><X size={18} /></button>
          </div>
        </div>
        <div style={{ overflowY:'auto', flex:1, padding:'8px 24px 16px' }}>
          {!rows ? <SkeletonBlocks count={5} height={48} borderRadius={8} />
            : rows.length === 0 ? (
              <div style={{ textAlign:'center', padding:'48px 0', color:'var(--muted)' }}>
                <Trash2 size={30} style={{ opacity:.2, display:'block', margin:'0 auto 10px' }} />
                The recycle bin is empty.
              </div>
            ) : rows.map(item => (
              <div key={item.id} ref={item.id === highlightId ? highlightRef : null}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 12px', margin:'0 -12px', borderBottom:'1px solid var(--line)', background: flash === item.id ? 'hsla(40,92%,55%,0.18)' : 'transparent', boxShadow: flash === item.id ? 'inset 4px 0 0 hsl(40,92%,50%)' : 'none', borderRadius: flash === item.id ? 8 : 0, transition:'background .9s ease, box-shadow .9s ease' }}>
                <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} style={{ cursor:'pointer', accentColor:'var(--pine)', flexShrink:0 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:600, fontSize:13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.name}</span>
                    {item.deletedAt && (() => { const dl = daysLeft(item.deletedAt); return dl == null ? null : (
                      <span style={{ flexShrink:0, fontSize:10.5, fontWeight:700, padding:'1px 7px', borderRadius:20, background: dl <= 5 ? 'hsla(var(--color-red),0.12)' : 'var(--mist)', color: dl <= 5 ? 'hsl(var(--color-red))' : 'var(--muted)' }}>
                        {dl === 0 ? 'purges today' : `${dl} day${dl !== 1 ? 's' : ''} left`}
                      </span>
                    ); })()}
                  </div>
                  <div style={{ fontSize:11.5, color:'var(--muted)' }}>
                    {item.serialNumber || '-'} · Deleted in <strong style={{ color:'var(--ink)' }}>{item.deletedLocation || '-'}</strong>
                    {item.deletedAt && <> · {fmtWhen(item.deletedAt)}</>}
                    {item.deletedBy && <> · by {nameOf(item.deletedBy)}</>}
                  </div>
                </div>
                <button onClick={() => restore([item.id])} disabled={busy}
                  style={{ display:'inline-flex', alignItems:'center', gap:5, background:'none', border:'1px solid var(--line)', borderRadius:7, padding:'6px 12px', color:'var(--ink)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                  <RotateCcw size={12} /> Restore
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
