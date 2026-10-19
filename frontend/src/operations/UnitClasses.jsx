// Which Cubby unit types are mailboxes, and which records are not units at
// all (Neil, Oct 20 2026). Cubby has no mailbox flag, so the server matches
// words in the unit type name (backend/ops_unit_classes.py). Everyone sees
// the rule; managers change the words here, inline - no popup.
import { useState } from 'react';
import { api } from '../api';

const words = (list) => (list || []).join(', ');
const parse = (text) => String(text || '').split(',').map((w) => w.trim()).filter(Boolean);
const quoted = (list) => (list?.length ? list.map((w) => `"${w}"`).join(' or ') : 'nothing (switched off)');

export default function UnitClasses({ rules, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [mailbox, setMailbox] = useState('');
  const [excluded, setExcluded] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!rules) return null;

  const start = () => { setMailbox(words(rules.mailbox)); setExcluded(words(rules.excluded)); setError(''); setEditing(true); };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.saveOpsUnitClasses({ mailbox: parse(mailbox), excluded: parse(excluded) });
      setEditing(false);
      onSaved?.();
    } catch (err) {
      setError(err?.message || "Couldn't save the unit type words.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dash-card" id="ops-unit-classes">
      <div className="dash-card-head">
        <div>
          <div className="dash-card-title">Mailboxes and Switched-Off Units</div>
          <div className="dash-card-sub">Cubby does not tell a mailbox from a storage unit, so Nexus reads the unit type name.</div>
        </div>
        {canEdit && !editing && <button type="button" className="secondary-btn" onClick={start}>Change</button>}
      </div>
      {editing ? (
        <form onSubmit={save} style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>Mailbox when the unit type contains (comma-separated)</span>
            <input className="form-input" value={mailbox} maxLength={600} onChange={(e) => setMailbox(e.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>Not a unit when the unit type contains (comma-separated)</span>
            <input className="form-input" value={excluded} maxLength={600} onChange={(e) => setExcluded(e.target.value)} />
          </label>
          {error && <div role="alert" style={{ color: 'var(--danger, #b42318)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="primary-btn" disabled={busy}>Save</button>
            <button type="button" className="secondary-btn" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : (
        <div style={{ display: 'grid', gap: 4, fontSize: 13.5 }}>
          <div>Mailbox: the unit type name contains {quoted(rules.mailbox)}. Mailboxes have their own occupancy and are left out of storage occupancy and off market.</div>
          <div>Not counted: the unit type name contains {quoted(rules.excluded)} (records switched off in Cubby).</div>
        </div>
      )}
    </div>
  );
}
