// Item Management - The item Details slide-over with custom fields.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { useNameResolver } from '../../lib/useNameResolver';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { TYPE_META, OP_STATUSES, OP_STATUS_META, OP_STATUS_PERSON, displayStatus } from '../model/status';
import { cleanField } from '../model/fields';
import { fmtMoney } from '../model/format';
import { TypeBadge, StatusBadge, OpStatusBadge } from '../ui/badges';
import { PersonTypeahead } from '../ui/PersonTypeahead';

// ── Item Details Panel ────────────────────────────────────────────────────────
// Ankush: a Details button per item that opens everything NOT in the main table -
// operational status, location assignment, and admin-defined custom fields - so
// the table stays lean. Editable in place.
export function ItemDetailsPanel({ item, customFields, canEdit, onClose, onSaved, toast }) {
  const nameOf = useNameResolver(); // resolve holder name, never a raw email (P4 names)
  const applicable = (customFields || []).filter(f => !f.appliesToType || f.appliesToType === item.itemType);
  const [op,      setOp]      = useState(item.opStatus || '');
  const [opPersonEmail, setOpPersonEmail] = useState(item.opStatusPersonEmail || '');
  const [opPersonName,  setOpPersonName]  = useState(item.opStatusPersonName  || '');
  const [values,  setValues]  = useState(() => ({ ...(item.customFields || {}) }));
  const [loc,     setLoc]     = useState(item.assignedToLocation || '');
  const [saving,  setSaving]  = useState(false);
  const setVal = (k, v) => setValues(p => ({ ...p, [k]: v }));

  const personHeld = !!item.assignedToEmail;

  async function save() {
    setSaving(true);
    try {
      const cf = {};
      applicable.forEach(f => { cf[f.fieldKey] = values[f.fieldKey] ?? ''; });
      await api.updateItem(item.id, { op_status: op, custom_fields: cf, op_status_person_email: opPersonEmail, op_status_person_name: opPersonName });
      // Location assignment is its own endpoint (no photo-acceptance for a place).
      if (!personHeld && (loc || '').trim() !== (item.assignedToLocation || '').trim()) {
        await api.assignItemToLocation(item.id, (loc || '').trim());
      }
      toast?.(`Saved details for ${item.name}.`);
      onSaved?.();
      onClose();
    } catch (e) {
      toast?.(e?.message || 'Could not save item details.', 'error');
    } finally {
      setSaving(false);
    }
  }

  const Row = ({ label, children }) => (
    <div style={{ display:'flex', gap:12, padding:'7px 0', borderBottom:'1px solid var(--line)', fontSize:13 }}>
      <div style={{ width:130, flexShrink:0, color:'var(--muted)', fontWeight:600 }}>{label}</div>
      <div style={{ flex:1, minWidth:0 }}>{children}</div>
    </div>
  );

  const dirty = canEdit && (op !== (item.opStatus || '') || opPersonEmail !== (item.opStatusPersonEmail || '')
    || opPersonName !== (item.opStatusPersonName || '') || JSON.stringify(values) !== JSON.stringify(item.customFields || {})
    || loc !== (item.assignedToLocation || ''));
  const guard = useUnsavedGuard(dirty, onClose, canEdit ? save : undefined);

  return (
    <div role="dialog" aria-modal="true" className="modal-overlay" style={{ zIndex:4100 }} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div className="modal-content nx-popup" style={{ display:'flex', flexDirection:'column', padding:0 }}>
        <div style={{ padding:'18px 22px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
          <div style={{ width:46, height:46, borderRadius:9, overflow:'hidden', flexShrink:0, border:'1px solid var(--line)', background: item.photoUrl ? 'transparent' : (TYPE_META[item.itemType]||TYPE_META.Other).bg, display:'flex', alignItems:'center', justifyContent:'center' }}>
            {item.photoUrl ? <img src={item.photoUrl} alt={item.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
              : React.createElement((TYPE_META[item.itemType]||TYPE_META.Other).Icon, { size:22, color:(TYPE_META[item.itemType]||TYPE_META.Other).color })}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontWeight:700, fontSize:15, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.name}</div>
            <div style={{ fontSize:11.5, color:'var(--muted)', fontFamily:'ui-monospace,Menlo,monospace' }}>{item.serialNumber || '-'}</div>
          </div>
          <button onClick={guard.requestClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }}><X size={18} /></button>
        </div>

        <div style={{ overflowY:'auto', flex:1, padding:'14px 22px' }}>
          {/* Core facts - read-only here, edited via the Edit modal */}
          <div style={{ fontSize:10.5, fontWeight:800, color:'var(--muted)', letterSpacing:'.06em', marginBottom:4 }}>CORE</div>
          <Row label="Type"><TypeBadge type={item.itemType} /></Row>
          <Row label="Make / Model">{[cleanField(item.make), cleanField(item.model), cleanField(item.year)].filter(Boolean).join(' ') || '-'}</Row>
          <Row label="Department">{cleanField(item.department) || '-'}</Row>
          <Row label="Location">{cleanField(item.location) || '-'}</Row>
          <Row label="Ownership">{item.ownershipType === 'permanent' ? 'Permanent' : 'Temporary'}</Row>
          <Row label="Lifecycle"><StatusBadge status={displayStatus(item)} item={item} /></Row>
          <Row label="Asset value">{Number(item.assetValue) > 0 ? fmtMoney(item.assetValue) : '-'}</Row>
          {personHeld && <Row label="Held by">{nameOf(item.assignedToEmail, item.assignedToName)}</Row>}

          {/* Operational status (Neil) */}
          <div style={{ fontSize:10.5, fontWeight:800, color:'var(--muted)', letterSpacing:'.06em', margin:'16px 0 4px' }}>OPERATIONAL STATUS</div>
          <Row label="Status">
            {canEdit ? (
              <select className="form-input" style={{ width:'100%' }} value={op} onChange={e => setOp(e.target.value)}>
                <option value="">- not set -</option>
                {OP_STATUSES.map(s => <option key={s} value={s}>{OP_STATUS_META[s]?.label || s}</option>)}
              </select>
            ) : <OpStatusBadge value={op} />}
          </Row>
          {OP_STATUS_PERSON.has(op) && (
            <Row label="Declared by">
              {canEdit
                ? <PersonTypeahead valueName={opPersonName} placeholder="Type a name…"
                    onPick={({ email, name }) => { setOpPersonEmail(email); setOpPersonName(name); }} />
                : (opPersonName || opPersonEmail || '-')}
            </Row>
          )}

          {/* Location assignment (Ankush) - only when not held by a person */}
          {canEdit && item.ownershipType === 'permanent' && !personHeld && (
            <>
              <div style={{ fontSize:10.5, fontWeight:800, color:'var(--muted)', letterSpacing:'.06em', margin:'16px 0 4px' }}>ASSIGN TO LOCATION</div>
              <Row label="Location">
                <input className="form-input" style={{ width:'100%' }} value={loc} onChange={e => setLoc(e.target.value)}
                  placeholder="e.g. GSVC Server Room - leave blank to unassign" />
                <div style={{ fontSize:11, color:'var(--muted)', marginTop:4 }}>Items assigned to a place don't appear under “Who has it”.</div>
              </Row>
            </>
          )}

          {/* Custom fields (Ankush) */}
          <div style={{ fontSize:10.5, fontWeight:800, color:'var(--muted)', letterSpacing:'.06em', margin:'16px 0 4px' }}>CUSTOM FIELDS</div>
          {applicable.length === 0 ? (
            <div style={{ fontSize:12.5, color:'var(--muted)', padding:'6px 0' }}>No custom fields defined for this item type.</div>
          ) : applicable.map(f => (
            <Row key={f.id} label={f.label}>
              {!canEdit ? <span>{String(values[f.fieldKey] ?? '') || '-'}</span>
                : f.fieldType === 'boolean' ? (
                  <label style={{ display:'inline-flex', alignItems:'center', gap:7, cursor:'pointer' }}>
                    <input type="checkbox" checked={!!values[f.fieldKey]} onChange={e => setVal(f.fieldKey, e.target.checked ? 'yes' : '')} style={{ accentColor:'var(--pine)', cursor:'pointer' }} />
                    <span style={{ fontSize:12.5, color:'var(--muted)' }}>{values[f.fieldKey] ? 'Yes' : 'No'}</span>
                  </label>
                ) : f.fieldType === 'select' ? (
                  <select className="form-input" style={{ width:'100%' }} value={values[f.fieldKey] ?? ''} onChange={e => setVal(f.fieldKey, e.target.value)}>
                    <option value="">-</option>
                    {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input className="form-input" style={{ width:'100%' }}
                    type={f.fieldType === 'number' ? 'number' : f.fieldType === 'date' ? 'date' : 'text'}
                    value={values[f.fieldKey] ?? ''} onChange={e => setVal(f.fieldKey, e.target.value)}
                    placeholder={f.fieldType === 'url' ? 'https://…' : ''} />
                )}
            </Row>
          ))}
        </div>

        {canEdit && (
          <div style={{ padding:'14px 22px', borderTop:'1px solid var(--line)', display:'flex', justifyContent:'flex-end', gap:10, flexShrink:0 }}>
            <button className="secondary-btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-btn" onClick={save} disabled={saving}
              style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:120, justifyContent:'center' }}>
              {saving ? <><Spinner size={14} /> Saving…</> : 'Save Details'}
            </button>
          </div>
        )}
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={canEdit ? guard.saveAndClose : undefined} saving={guard.saving || saving} />
      )}
    </div>
  );
}
