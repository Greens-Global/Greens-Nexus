// Item Management - Item custom fields (borrowed by Settings).
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import HoldButton from '../../ui/HoldButton';
import { ITEM_TYPES } from '../model/status';
import { FL } from '../ui/styles';
import { useRole } from '../../contexts/RoleContext';

// ── Custom Fields Admin Modal ─────────────────────────────────────────────────
// Define the custom fields that show in the Details panel. Flexible by design:
// any type, optionally scoped to one item type (Ankush).
const CUSTOM_FIELD_TYPE_OPTS = [
  { v:'text', label:'Text' }, { v:'number', label:'Number' }, { v:'date', label:'Date' },
  { v:'select', label:'Dropdown' }, { v:'boolean', label:'Yes / No' }, { v:'url', label:'Link' },
];

export function CustomFieldsAdminModal({ fields, onClose, onChanged, toast }) {
  // DELETE /items/custom-fields answers only a Super Administrator or a Full
  // Inventory grant (require_custom_field_delete); everyone else who may open
  // this (managers, Inventory editors) adds and edits but sees no Delete.
  const { canAccessModule } = useRole();
  const canDelete = canAccessModule('inventory', 'owner', 'full');
  const [label,      setLabel]      = useState('');
  const [fieldType,  setFieldType]  = useState('text');
  const [options,    setOptions]    = useState('');
  const [appliesTo,  setAppliesTo]  = useState('');
  const [saving,     setSaving]     = useState(false);
  const [busyId,     setBusyId]     = useState(null);

  async function add() {
    if (!label.trim() || saving) return;
    setSaving(true);
    try {
      await api.createItemCustomField({
        label: label.trim(), field_type: fieldType,
        options: fieldType === 'select' ? options.split(',').map(s => s.trim()).filter(Boolean) : [],
        applies_to_type: appliesTo,
      });
      setLabel(''); setOptions(''); setFieldType('text'); setAppliesTo('');
      onChanged?.();
      toast?.('Custom field added.');
    } catch (e) {
      toast?.(e?.message || 'Could not add field.', 'error');
    } finally { setSaving(false); }
  }
  // Delete is held on the row (Hold to confirm, Neil, Oct 30 2026); a refusal
  // rewinds the button with the reason; the list re-reads once the check shows.
  async function remove(f) {
    setBusyId(f.id);
    try { await api.deleteItemCustomField(f.id); }
    catch (e) { throw new Error(e?.message || 'Could not delete field.', { cause: e }); }
    finally { setBusyId(null); }
  }

  const dirty = label.trim() !== '' || fieldType !== 'text' || options !== '' || appliesTo !== '';
  const guard = useUnsavedGuard(dirty, onClose, label.trim() ? async () => { await add(); onClose(); } : undefined);

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background:'var(--card)', borderRadius:16, width:'100%', maxWidth:560, maxHeight:'88vh', display:'flex', flexDirection:'column', boxShadow:'var(--shadow-lg)' }}>
        <div style={{ padding:'20px 24px 14px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <h3 style={{ margin:0, fontSize:16, fontWeight:700 }}>Custom Fields</h3>
          <button onClick={guard.requestClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY:'auto', flex:1, padding:'14px 24px' }}>
          {/* Existing */}
          {(fields || []).length === 0 ? (
            <div style={{ fontSize:13, color:'var(--muted)', padding:'4px 0 14px' }}>No custom fields yet. Add one below.</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:16 }}>
              {fields.map(f => (
                <div key={f.id} style={{ display:'flex', flexDirection:'column', gap:8, border:'1px solid var(--line)', borderRadius:9, padding:'8px 12px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:600, fontSize:13 }}>{f.label}</div>
                      <div style={{ fontSize:11, color:'var(--muted)' }}>
                        {(CUSTOM_FIELD_TYPE_OPTS.find(o => o.v === f.fieldType)?.label || f.fieldType)}
                        {f.appliesToType ? ` · ${f.appliesToType} only` : ' · all types'}
                        {f.fieldType === 'select' && f.options?.length ? ` · ${f.options.join(', ')}` : ''}
                      </div>
                    </div>
                    {canDelete && (
                      <HoldButton size="sm" label="Delete" doneLabel="Deleted" ariaLabel={`Delete the ${f.label} field`} onConfirm={() => remove(f)} onDone={() => onChanged?.()} disabled={!!busyId && busyId !== f.id}
                        fallbackMessage={`Delete the "${f.label}" field? Existing values stay stored but stop showing.`} />
                    )}
                  </div>
                </div>
              ))}
              {!canDelete && (
                <div style={{ fontSize:11.5, color:'var(--muted)' }}>Only a Super Administrator or someone with Full Inventory access can delete a custom field.</div>
              )}
            </div>
          )}
          {/* Add new */}
          <div style={{ borderTop:'1px solid var(--line)', paddingTop:14 }}>
            <div style={{ fontSize:10.5, fontWeight:800, color:'var(--muted)', letterSpacing:'.06em', marginBottom:10 }}>ADD A FIELD</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <div>
                <label style={FL}>LABEL</label>
                <input className="form-input" style={{ width:'100%' }} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Warranty End" />
              </div>
              <div>
                <label style={FL}>TYPE</label>
                <select className="form-input" style={{ width:'100%' }} value={fieldType} onChange={e => setFieldType(e.target.value)}>
                  {CUSTOM_FIELD_TYPE_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
              </div>
              {fieldType === 'select' && (
                <div style={{ gridColumn:'1 / -1' }}>
                  <label style={FL}>OPTIONS (comma-separated)</label>
                  <input className="form-input" style={{ width:'100%' }} value={options} onChange={e => setOptions(e.target.value)} placeholder="e.g. Good, Fair, Poor" />
                </div>
              )}
              <div style={{ gridColumn:'1 / -1' }}>
                <label style={FL}>APPLIES TO</label>
                <select className="form-input" style={{ width:'100%' }} value={appliesTo} onChange={e => setAppliesTo(e.target.value)}>
                  <option value="">All item types</option>
                  {ITEM_TYPES.map(t => <option key={t} value={t}>{t} only</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid var(--line)', display:'flex', justifyContent:'flex-end', gap:10, flexShrink:0 }}>
          <button className="secondary-btn" onClick={onClose}>Done</button>
          <button className="primary-btn" onClick={add} disabled={!label.trim() || saving}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:110, justifyContent:'center', opacity:(!label.trim()||saving)?0.55:1 }}>
            {saving ? <Spinner size={14} /> : <Plus size={14} />} Add field
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={label.trim() ? guard.saveAndClose : undefined} saving={guard.saving || saving} />
      )}
    </div>
  );
}
