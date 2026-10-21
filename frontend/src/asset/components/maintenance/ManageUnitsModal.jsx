import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Modal } from '../shared/Modal.jsx';
import { genId } from '../../lib/format.js';

/** Lets a property define its named suites/units (property.tenantUnits: [{id, label}]) for
 *  multi-tenant maintenance tracking - see PropertyMaintenanceSection's unit-filter pills.
 *  No units yet = an empty state with the add row inside it; otherwise a compact list
 *  (label + remove) with the add row under it. Saves through `onSave(units)` as before. */
export function ManageUnitsModal({ units, onSave, onClose }) {
  const [list, setList] = useState(units.map((u) => ({ ...u })));
  const [initialList] = useState(list);
  const [draft, setDraft] = useState('');
  const dirty = JSON.stringify(list) !== JSON.stringify(initialList) || !!draft.trim();

  const addUnit = () => {
    if (!draft.trim()) return;
    setList((l) => [...l, { id: genId(), label: draft.trim() }]);
    setDraft('');
  };
  const save = () => onSave(list.filter((u) => u.label.trim()));

  const addRow = (
    <div style={{ display: 'flex', gap: 8, width: '100%' }}>
      <input
        className="form-input"
        value={draft}
        placeholder="e.g. Suite 100"
        aria-label="New unit or suite"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && addUnit()}
        style={{ flex: 1, minWidth: 0 }}
      />
      <button type="button" className="secondary-btn" onClick={addUnit} disabled={!draft.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        <Plus size={14} /> Add
      </button>
    </div>
  );

  return (
    <Modal
      title="Manage Units / Suites"
      onClose={onClose}
      isDirty={dirty}
      onSave={save}
      footer={
        <>
          <button className="secondary-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-btn" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: 14 }}>
        Add each suite or unit in this property. Maintenance can then be logged and filtered per unit, plus a shared Common Areas bucket.
      </div>

      {list.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '28px 20px', borderRadius: 12, border: '1px dashed var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
          <div style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>No units yet</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'center' }}>No units yet - add Suite 100 to start.</div>
          <div style={{ width: '100%', maxWidth: 420 }}>{addRow}</div>
        </div>
      ) : (
        <>
          <ul aria-label="Units" style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
            {list.map((u, ix) => (
              <li key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px 7px 12px', borderTop: ix ? '1px solid var(--border-color)' : 'none' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.label}</span>
                <button
                  type="button"
                  onClick={() => setList((l) => l.filter((x, i) => i !== ix))}
                  title="Remove"
                  aria-label={`Remove ${u.label}`}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0 }}
                >
                  <X size={15} />
                </button>
              </li>
            ))}
          </ul>
          {addRow}
        </>
      )}
    </Modal>
  );
}
