// Operations > Dashboard: the filter bar and Customize (Oct 28 2026 call with
// Neil). B1: pick any set of properties (multi-select, a whole state or market
// in one click) and a preset period or a custom date range - this replaces
// the State and Facility dropdowns on the Dashboard only (where report filters
// live is still open, P1). B2: Customize adds, removes and rearranges the
// Dashboard's cards. Both are the person's own (opsPrefs.useOpsDashboard).
import { useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, LayoutGrid, RotateCcw } from 'lucide-react';
import PropertyPicker from './PropertyPicker';
import { DateField } from '../tasks/components';
import { PERIODS } from './model';
import { usePopover } from './ColumnsMenu';
import { move } from './columnControls';
import { DASH_CARDS, DEFAULT_CARDS } from './OpsTabs';
import { isThirdParty } from './thirdParty';

export const CUSTOM = 'custom';

/** The Dashboard's facilities as the property picker's properties. */
export const asProperties = (facilities) => facilities.map((f) => ({
  id: f.id, shortName: f.shortName, connected: true, state: f.state || '',
  managedBy: isThirdParty(f) ? 'TPM' : 'Greens Storage',
}));

/** The period: a preset key, or a custom range from / to (YYYY-MM-DD). */
export function DashFilterBar({ facilities, ids, onIds, period, onPeriod, from, to, onRange }) {
  const properties = asProperties(facilities);
  return (
    <div className="ops-dash-filters" role="group" aria-label="Dashboard Filters">
      <PropertyPicker properties={properties} ids={ids} onChange={onIds} note="Your Dashboard keeps this choice." />
      <label className="ops-period">
        <span>Period</span>
        <select value={period} onChange={(e) => onPeriod(e.target.value)} aria-label="Period">
          {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          <option value={CUSTOM}>Custom Range</option>
        </select>
      </label>
      {period === CUSTOM && (
        <span className="ops-dash-range">
          <span className="ops-dash-range-l">From</span>
          <DateField value={from || ''} max={to || ''} onChange={(v) => onRange(v || '', to)} placeholder="Start" />
          <span className="ops-dash-range-l">To</span>
          <DateField value={to || ''} min={from || ''} onChange={(v) => onRange(from, v || '')} placeholder="End" />
        </span>
      )}
    </div>
  );
}

/** Customize: which cards show, in what order; Reset to Default. */
export function CustomizeDashboard({ cards, onCards }) {
  const { open, setOpen, box } = usePopover();
  const [drag, setDrag] = useState(null);
  const on = cards;
  const off = DASH_CARDS.filter((c) => !on.includes(c.key));
  const byKey = Object.fromEntries(DASH_CARDS.map((c) => [c.key, c]));
  const changed = on.length !== DEFAULT_CARDS.length || on.some((k, i) => k !== DEFAULT_CARDS[i]);
  const drop = (target) => {
    if (!drag || drag === target) return;
    const next = on.filter((k) => k !== drag);
    next.splice(next.indexOf(target) + (on.indexOf(drag) < on.indexOf(target) ? 1 : 0), 0, drag);
    onCards(next);
    setDrag(null);
  };
  return (
    <div className="ops-menu" ref={box}>
      <button type="button" className="secondary-btn ops-btn-sm" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <LayoutGrid size={14} aria-hidden="true" /> Customize
      </button>
      {open && (
        <div className="ops-menu-pop ops-cols-pop dash-card" role="dialog" aria-label="Customize the Dashboard">
          <div className="ops-cols-head">
            <span>On Your Dashboard</span>
            {changed && <button type="button" className="ops-linkbtn" onClick={() => onCards([...DEFAULT_CARDS])}><RotateCcw size={12} aria-hidden="true" /> Reset to Default</button>}
          </div>
          {!on.length ? <p className="ops-rc-empty">No cards. Add one below.</p> : (
            <ul className="ops-cols-list">
              {on.map((k, i) => (
                <li key={k} draggable onDragStart={() => setDrag(k)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(k)} className={drag === k ? 'is-drag' : ''}>
                  <GripVertical size={14} className="ops-cols-grip" aria-hidden="true" />
                  <span className="ops-cols-name">{byKey[k]?.label || k}</span>
                  <span className="ops-cols-moves">
                    <button type="button" className="ops-icon-btn" aria-label={`Move ${byKey[k]?.label} up`} disabled={i === 0} onClick={() => onCards(move(on, k, -1))}><ArrowUp size={13} /></button>
                    <button type="button" className="ops-icon-btn" aria-label={`Move ${byKey[k]?.label} down`} disabled={i === on.length - 1} onClick={() => onCards(move(on, k, 1))}><ArrowDown size={13} /></button>
                    <button type="button" className="ops-linkbtn" aria-label={`Remove ${byKey[k]?.label}`} onClick={() => onCards(on.filter((x) => x !== k))}>Remove</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {off.length > 0 && (
            <div className="ops-cols-add">
              <div className="ops-cols-add-h">Add a Card</div>
              {off.map((c) => (
                <button key={c.key} type="button" className="ops-cols-preset" onClick={() => onCards([...on, c.key])} aria-label={`Add ${c.label}`}>
                  <span><strong>{c.label}</strong> <span className="ops-rd-hint">{c.about}</span></span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
