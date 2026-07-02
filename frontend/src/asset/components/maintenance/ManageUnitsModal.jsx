import { useState } from 'react';
import { Modal } from '../shared/Modal.jsx';
import { genId } from '../../lib/format.js';

/** Lets a property define its named suites/units (property.tenantUnits: [{id, label}]) for
 *  multi-tenant maintenance tracking — see PropertyMaintenanceSection's unit-filter pills. */
export function ManageUnitsModal({ units, onSave, onClose }) {
  const [list, setList] = useState(units.map((u) => ({ ...u })));
  const [draft, setDraft] = useState('');

  const addUnit = () => {
    if (!draft.trim()) return;
    setList((l) => [...l, { id: genId(), label: draft.trim() }]);
    setDraft('');
  };

  return (
    <Modal
      title="Manage Units / Suites"
      onClose={onClose}
      footer={
        <>
          <button className="secondary-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-btn" onClick={() => onSave(list.filter((u) => u.label.trim()))}>
            Save
          </button>
        </>
      }
    >
      <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: 14 }}>
        Add each suite or unit in this property. Maintenance can then be logged and filtered per unit, plus a shared Common Areas bucket.
      </div>

      <div style={{ marginBottom: 10 }}>
        {list.map((u, ix) => (
          <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input
              className="form-input"
              value={u.label}
              onChange={(e) => {
                const v = e.target.value;
                setList((l) => l.map((x, i) => (i === ix ? { ...x, label: v } : x)));
              }}
              style={{ flex: 1 }}
            />
            <button
              onClick={() => setList((l) => l.filter((x, i) => i !== ix))}
              title="Remove"
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1rem', padding: 4 }}
            >
              {'✕'}
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="form-input"
          value={draft}
          placeholder="e.g. Suite 100"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addUnit()}
          style={{ flex: 1 }}
        />
        <button className="secondary-btn" onClick={addUnit}>
          + Add
        </button>
      </div>
    </Modal>
  );
}
