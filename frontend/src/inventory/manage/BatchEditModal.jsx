// Item Management - Batch edit fields on many items.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { X, Pencil } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { ITEM_TYPES, OP_STATUSES, OP_STATUS_META, DEPARTMENTS } from '../model/status';
import { PersonTypeahead } from '../ui/PersonTypeahead';
import { BatchTabs } from './BatchTabs';

// ── Batch Edit Modal ──────────────────────────────────────────────────────────
// Change the same descriptive field(s) across many selected items at once - the
// replacement for editing fields by re-uploading a CSV. Serial is the static
// identity and is never editable here; only ticked fields are written.
const BATCH_FIELDS = [
  { key: 'name',           label: 'Name' },
  { key: 'item_type',      label: 'Type',       options: ITEM_TYPES },
  { key: 'make',           label: 'Make' },
  { key: 'model',          label: 'Model' },
  { key: 'year',           label: 'Year' },
  { key: 'department',     label: 'Department', options: DEPARTMENTS.filter(d => d !== 'All') },
  { key: 'default_owner',  label: 'Owner' },
  { key: 'ownership_type', label: 'Ownership',  options: ['transient', 'permanent'] },
  { key: 'location',       label: 'Location' },
  { key: 'op_status',      label: 'Status',     options: OP_STATUSES },
  { key: 'asset_value',    label: 'Asset Value ($)' },
];

export function BatchEditModal({ selectedItems, usingSelection, onSwitchTab, onClose, onSave, saving, locations = [], types = ITEM_TYPES }) {
  const [enabled, setEnabled] = useState(new Set());
  const [vals,    setVals]    = useState({});
  // Assignment lives in Batch Edit now (Neil: not a separate button). Optional -
  // tick it to also assign the selection to a place or a person.
  const [assignOn,    setAssignOn]    = useState(false);
  const [assignKind,  setAssignKind]  = useState('location');
  const [assignLoc,   setAssignLoc]   = useState('');
  const [assignName,  setAssignName]  = useState('');
  const [assignEmail, setAssignEmail] = useState('');
  const [assignSkip,  setAssignSkip]  = useState(false); // person assigns go active without acceptance

  function toggleField(key) {
    setEnabled(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  const setVal = (key, v) => setVals(prev => ({ ...prev, [key]: v }));

  const fields = {};
  for (const f of BATCH_FIELDS) if (enabled.has(f.key)) fields[f.key] = vals[f.key] ?? (f.options ? f.options[0] : '');
  const nameBlank   = enabled.has('name') && !(fields.name || '').trim();
  const assignVal   = assignOn ? (assignKind === 'location' ? assignLoc.trim() : assignEmail.trim()) : '';
  const assignReady = !assignOn || !!assignVal;
  const canSave     = (enabled.size > 0 || (assignOn && assignVal)) && !nameBlank && assignReady && !saving;

  function submit() {
    const assignment = (assignOn && assignVal)
      ? { kind: assignKind, location: assignLoc.trim(), email: assignEmail.trim().toLowerCase(), name: assignName.trim(), skipAcceptance: assignSkip }
      : null;
    onSave(fields, assignment);
  }

  const dirty = enabled.size > 0 || assignOn;
  const guard = useUnsavedGuard(dirty, onClose, canSave ? submit : undefined);

  return (
    <div role="dialog" aria-modal="true" className="modal-overlay" style={{ zIndex:4100 }} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div className="modal-content nx-popup" style={{ display:'flex', flexDirection:'column', padding:'22px 28px 20px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
          <BatchTabs tab="fields" onTab={onSwitchTab} />
          <button onClick={guard.requestClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }}><X size={18} /></button>
        </div>
        <h3 style={{ margin:'0 0 6px', fontSize:16, fontWeight:700 }}>
          Edit {selectedItems.length} {usingSelection ? 'selected' : 'shown'} item{selectedItems.length !== 1 ? 's' : ''}
        </h3>
        <p style={{ margin:'0 0 16px', fontSize:13, color:'var(--muted)' }}>
          {usingSelection
            ? 'Tick a field to apply the same value to every selected item.'
            : 'No rows selected - this applies to every item the current filters show. Tick rows first to narrow it.'} Unticked fields are left untouched. Serials never change.
        </p>
        <div style={{ overflowY:'auto', minHeight:0, display:'flex', flexDirection:'column', gap:10 }}>
          {BATCH_FIELDS.map(f => {
            const on = enabled.has(f.key);
            // Type options come from the live (manager-curated) list, not the static one.
            const opts = f.key === 'item_type' ? types : f.options;
            return (
              <div key={f.key} style={{ display:'flex', alignItems:'center', gap:10 }}>
                <label style={{ display:'flex', alignItems:'center', gap:8, width:120, flexShrink:0, cursor:'pointer', userSelect:'none' }}>
                  <input type="checkbox" checked={on} onChange={() => toggleField(f.key)}
                    style={{ cursor:'pointer', accentColor:'var(--pine)' }} />
                  <span style={{ fontSize:12.5, fontWeight:600, color: on ? 'var(--ink)' : 'var(--muted)' }}>{f.label}</span>
                </label>
                {opts ? (
                  // Unticked dropdowns show blank, not a default value - otherwise it
                  // looks like (e.g.) "Transient" will be applied when it won't (Neil).
                  <select disabled={!on} value={on ? (vals[f.key] ?? opts[0]) : ''} onChange={e => setVal(f.key, e.target.value)}
                    style={{ flex:1, padding:'8px 10px', borderRadius:8, border:'1px solid var(--line)', background: on ? 'var(--card)' : 'var(--mist)', fontSize:13, fontFamily:'Inter,sans-serif', color: on ? 'var(--ink)' : 'var(--muted)' }}>
                    {!on && <option value="">-</option>}
                    {opts.map(o => <option key={o} value={o}>{
                      f.key === 'op_status'       ? (OP_STATUS_META[o]?.label || o)
                      : f.key === 'ownership_type' ? (o === 'transient' ? 'Temporary' : 'Permanent')
                      : o
                    }</option>)}
                  </select>
                ) : (
                  <input disabled={!on} value={vals[f.key] ?? ''} onChange={e => setVal(f.key, e.target.value)}
                    placeholder={on ? `New ${f.label.toLowerCase()}…` : ''}
                    style={{ flex:1, padding:'8px 10px', borderRadius:8, border:'1px solid var(--line)', background: on ? 'var(--card)' : 'var(--mist)', fontSize:13, fontFamily:'Inter,sans-serif' }} />
                )}
              </div>
            );
          })}
        </div>
        {/* Assignment - fold-in of the old separate Assign button (Neil) */}
        <div style={{ marginTop:14, paddingTop:14, borderTop:'1px solid var(--line)', flexShrink:0 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', userSelect:'none' }}>
            <input type="checkbox" checked={assignOn} onChange={() => setAssignOn(v => !v)} style={{ cursor:'pointer', accentColor:'var(--pine)' }} />
            <span style={{ fontSize:12.5, fontWeight:700, color: assignOn ? 'var(--ink)' : 'var(--muted)' }}>Assign These Items</span>
          </label>
          {assignOn && (
            <div style={{ display:'flex', flexDirection:'column', gap:9, marginTop:10 }}>
              <div style={{ display:'flex', gap:6 }}>
                {[['location','To a location'], ['person','To a person']].map(([k, lbl]) => (
                  <button key={k} type="button" onClick={() => setAssignKind(k)}
                    style={{ flex:1, padding:'7px 0', borderRadius:8, border:`1px solid ${assignKind === k ? 'var(--pine)' : 'var(--line)'}`, background: assignKind === k ? 'var(--pine)' : 'transparent', color: assignKind === k ? '#fff' : 'var(--muted)', fontWeight:700, fontSize:12.5, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                    {lbl}
                  </button>
                ))}
              </div>
              {assignKind === 'location' ? (
                <>
                  <input className="form-input" list="batch-assign-locs" value={assignLoc} onChange={e => setAssignLoc(e.target.value)}
                    placeholder="Location - e.g. GG Corp, GSE" style={{ width:'100%' }} />
                  <datalist id="batch-assign-locs">{locations.map(l => <option key={l} value={l} />)}</datalist>
                </>
              ) : (
                // Type a name → pick from the company directory (fills the email we
                // need so they can accept). Free-typed names without a pick can't be
                // assigned - there's no inbox to notify.
                <PersonTypeahead valueName={assignName}
                  onPick={({ email, name }) => { setAssignName(name); setAssignEmail(email); }}
                  placeholder="Type a person's name…" />
              )}
              {assignKind === 'person' && (
                <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', userSelect:'none' }}>
                  <input type="checkbox" checked={assignSkip} onChange={e => setAssignSkip(e.target.checked)}
                    style={{ cursor:'pointer', accentColor:'var(--pine)' }} />
                  <span style={{ fontSize:12, color:'var(--muted)' }}>
                    <strong style={{ color:'var(--ink)' }}>Skip acceptance</strong> - assignments go active right away
                  </span>
                </label>
              )}
              <p style={{ fontSize:11, color:'var(--muted)', margin:0 }}>
                {assignKind === 'location'
                  ? 'Sets where these items physically live - their holder (if any) is unchanged.'
                  : (assignName && !assignEmail
                      ? 'Pick a person from the list so they can be notified to accept.'
                      : assignSkip
                        ? 'The person is notified, but the items are theirs immediately - no acceptance step.'
                        : 'Each person must accept their item (with a photo) from My Items.')}
              </p>
            </div>
          )}
        </div>
        {nameBlank && <p style={{ margin:'12px 0 0', fontSize:12, color:'hsl(var(--color-red))' }}>Name cannot be blank.</p>}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', paddingTop:16, flexShrink:0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button onClick={submit} disabled={!canSave}
            style={{ display:'inline-flex', alignItems:'center', gap:6, background:'var(--pine)', color:'#fff', border:'none', borderRadius:9, padding:'9px 18px', fontWeight:700, fontSize:13, cursor: canSave ? 'pointer' : 'default', fontFamily:'Inter,sans-serif', opacity: canSave ? 1 : 0.55 }}>
            {saving ? <Spinner size={14} /> : <Pencil size={14} />}
            Apply to {selectedItems.length}
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={canSave ? guard.saveAndClose : undefined} saving={guard.saving || saving} />
      )}
    </div>
  );
}
