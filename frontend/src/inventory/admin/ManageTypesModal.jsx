// Item Management - Item types (borrowed by Settings).
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { Plus, X, Tag } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import HoldButton from '../../ui/HoldButton';

// Manager-curated item types (Neil): managers extend the list here; a CSV import
// can never invent a type, so people can't spray in ridiculous ones by convenience.
export function ManageTypesModal({ types, counts = {}, onClose, onChanged, toast }) {
  const [list, setList] = useState(types);
  const [newType, setNewType] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    const name = newType.trim();
    if (!name || busy) return;
    setBusy(true);
    try { const updated = await api.addItemType(name); setList(updated); setNewType(''); onChanged?.(updated); }
    catch (e) { toast?.(e?.message || 'Could not add type.', 'error'); }
    finally { setBusy(false); }
  }
  // Every delete is held on its row (Hold to confirm, Neil, Oct 30 2026 - P4:
  // even zero-count types shouldn't vanish on a stray click). Types still in
  // use keep their text but stop being pickable. Undo adds it back (at the end).
  async function remove(name) {
    setBusy(true);
    try { const updated = await api.deleteItemType(name); setList(updated); onChanged?.(updated); }
    catch (e) { throw new Error(e?.message || 'Could not remove type.', { cause: e }); }
    finally { setBusy(false); }
    return { undoMessage: `Removed "${name}".`, undo: async () => {
      try { const updated = await api.addItemType(name); setList(updated); onChanged?.(updated); }
      catch (e) { toast?.(e?.message || 'Could not add type.', 'error'); }
    } };
  }

  const dirty = newType.trim() !== '';
  const guard = useUnsavedGuard(dirty, onClose, dirty ? async () => { await add(); onClose(); } : undefined);

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:24 }} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background:'var(--card)', borderRadius:16, padding:'22px 26px 20px', width:'100%', maxWidth:440, boxShadow:'var(--shadow-lg)', maxHeight:'min(85dvh,640px)', display:'flex', flexDirection:'column' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
          <h3 style={{ margin:0, fontSize:16, fontWeight:700, display:'inline-flex', alignItems:'center', gap:7 }}><Tag size={16} /> Manage Item Types</h3>
          <button onClick={guard.requestClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }}><X size={18} /></button>
        </div>
        <p style={{ margin:'0 0 14px', fontSize:12.5, color:'var(--muted)' }}>
          These are the types everyone picks from. A CSV import may match a new/unknown type to one of these or create it - the created ones are reported after the import. Add or curate them here.
        </p>
        <div style={{ display:'flex', gap:8, marginBottom:14 }}>
          <input className="form-input" style={{ flex:1 }} value={newType} placeholder="New type - e.g. Office"
            onChange={e => setNewType(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} />
          <button className="primary-btn" onClick={add} disabled={!newType.trim() || busy} style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
            {busy ? <Spinner size={14} /> : <Plus size={14} />} Add
          </button>
        </div>
        <div style={{ overflowY:'auto', display:'flex', flexDirection:'column', gap:6 }}>
          {list.map(t => (
            <div key={t} style={{ display:'flex', flexDirection:'column', gap:8, padding:'8px 12px', borderRadius:9, border:'1px solid var(--line)', background:'var(--mist)' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10 }}>
                <span style={{ display:'inline-flex', alignItems:'center', gap:8, minWidth:0 }}>
                  <span style={{ fontSize:13, fontWeight:600 }}>{t}</span>
                  <span style={{ fontSize:11, fontWeight:700, color:'var(--muted)', background:'var(--card)', border:'1px solid var(--line)', borderRadius:20, padding:'1px 8px', flexShrink:0 }}>
                    {counts[t] || 0} item{(counts[t] || 0) !== 1 ? 's' : ''}
                  </span>
                </span>
                {t.toLowerCase() !== 'other' && (
                  <HoldButton size="sm" label="Remove" doneLabel="Removed" ariaLabel={`Remove type ${t}`} onConfirm={() => remove(t)}
                    fallbackMessage={(counts[t] || 0) > 0 ? `${counts[t]} item${counts[t] !== 1 ? 's' : ''} use this - remove anyway?` : 'Remove this type?'} />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={dirty ? guard.saveAndClose : undefined} saving={guard.saving || busy} />
      )}
    </div>
  );
}
