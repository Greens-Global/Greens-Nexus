// Pick any set of properties (Neil, Oct 20 2026, Portfolio: "I want this
// property and this property, but I don't want this one"). The Dashboard's
// filter bar uses it too (Oct 28 2026 call, B1). An empty list = every
// connected property; Quick Pick selects a whole group (state, market, who
// manages it).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { groupsOf, selectionLabel, toggle } from './portfolioModel';
import SectionPicker from './SectionPicker';

export default function PropertyPicker({ properties, ids, onChange, note = 'Your choice is remembered on this device.' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const groups = useMemo(() => groupsOf(properties), [properties]);
  const chosen = (id) => (ids.length ? ids.includes(id) : properties.find((p) => p.id === id)?.connected);
  const sameAs = (list) => list.length === ids.length && list.every((x) => ids.includes(x));
  // The quick picks were a pill row; now one dropdown (Visesh, Oct 20).
  const quick = !ids.length ? 'all' : groups.find((g) => sameAs(g.ids))?.label || 'custom';
  const pickQuick = (v) => { if (v === 'all') onChange([]); else { const g = groups.find((x) => x.label === v); if (g) onChange(g.ids); } };
  return (
    <div className="pf-picker ops-facility" ref={box}>
      <span className="ops-facility-label">Properties</span>
      <span className="ops-facility-box">
        <SlidersHorizontal size={14} className="ops-facility-icon" aria-hidden="true" />
        <button type="button" className="ops-section-btn pf-picker-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
          {selectionLabel(ids, properties)}
        </button>
        <ChevronDown size={13} className="ops-facility-chev" aria-hidden="true" />
      </span>
      {open && (
        <div className="dash-card pf-picker-panel" role="group" aria-label="Choose properties">
          <SectionPicker label="Quick Pick" value={quick} onChange={pickQuick}
            options={[{ value: 'all', label: 'All Properties' }, ...groups.map((g) => ({ value: g.label, label: g.label })),
              ...(quick === 'custom' ? [{ value: 'custom', label: 'Custom Selection', disabled: true }] : [])]} />
          <ul className="pf-picker-list">
            {properties.map((p) => (
              <li key={p.id}>
                <label className={p.connected ? '' : 'pf-off'}>
                  <input type="checkbox" checked={!!chosen(p.id)} disabled={!p.connected}
                    onChange={() => onChange(toggle(ids, p.id, properties))} />
                  <span className="pf-picker-name">{p.shortName}</span>
                  <span className="pf-picker-meta">{p.connected ? [p.managedBy, p.market || p.state].filter(Boolean).join(' - ') : p.status}</span>
                </label>
              </li>
            ))}
          </ul>
          {note && <p className="ops-note" style={{ margin: 0 }}>{note}</p>}
        </div>
      )}
    </div>
  );
}
