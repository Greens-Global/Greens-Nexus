// Task Module - conditional row colors: the on-screen key (Neil, Oct 22 2026).
// The state, context and row styling live in rowColorState.js; the rules
// themselves in colorRules.js.
import { useMemo, useState } from 'react';
import { ChevronDown, Palette, Pencil } from 'lucide-react';
import { NX, FONT, btn } from './theme';
import { colorHex } from './colorRules';

/** An on / off switch. `large` (touch screens) keeps the same small track but
 *  gives it a 40px hit area, so a finger does not have to land on 30x18. */
export function RowColorSwitch({ on, onChange, label, disabled = false, large = false }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!on)}
      style={{ border: 'none', background: 'transparent', padding: 0, flexShrink: 0,
        minWidth: large ? 40 : undefined, minHeight: large ? 40 : undefined,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
      <span aria-hidden="true" style={{ width: 30, height: 18, borderRadius: 999, padding: 2, boxSizing: 'border-box',
        background: on ? NX.primary : NX.border, display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', transition: 'background .15s' }}>
        <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
      </span>
    </button>
  );
}

/**
 * The key above a view: each rule in force with its swatch and how many rows
 * it colors here, the Show Row Colors switch (the person's own, remembered),
 * and Edit Rules for whoever may change them. Nothing at all when no rule can
 * color anything - an editor reaches the rules from Row Colors instead.
 */
export function RowColorLegend({ scope, onEdit, canEdit = false, compact = false }) {
  const { usable, map, show, setShow } = scope;
  // A phone starts with the key folded to one line (it would otherwise take
  // three of a short screen) and does not change the desktop's choice.
  const [phoneOpen, setPhoneOpen] = useState(false);
  const legendOpen = compact ? phoneOpen : scope.legendOpen;
  const setLegendOpen = compact ? setPhoneOpen : scope.setLegendOpen;
  const counts = useMemo(() => {
    const n = {};
    for (const e of map.values()) n[e.id] = (n[e.id] || 0) + 1;
    return n;
  }, [map]);
  if (!usable.length) return null;
  return (
    <div data-testid="row-color-legend" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: compact ? '6px 12px' : '7px 20px', borderBottom: `1px solid ${NX.border2}`, background: NX.surface, fontFamily: FONT, fontSize: 12 }}>
      <button type="button" onClick={() => setLegendOpen(!legendOpen)} aria-expanded={legendOpen}
        style={{ ...btn('ghost'), padding: '2px 4px', fontSize: 12, color: NX.dim, gap: 5, ...(compact ? { minHeight: 40 } : null) }}>
        <Palette size={13} />
        Colors
        <span style={{ color: NX.faint, fontWeight: 500 }}>{usable.length}</span>
        <ChevronDown size={13} style={{ transform: legendOpen ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} />
      </button>
      {legendOpen && (
        <ul aria-label="Row color key" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', listStyle: 'none', margin: 0, padding: 0, opacity: show ? 1 : 0.55, minWidth: 0, ...(compact ? { order: 3, flexBasis: '100%' } : null) }}>
          {usable.map((r) => (
            <li key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: NX.ink, minWidth: 0 }}>
              <span className="nx-rc-swatch" style={{ '--rc': colorHex(r.color) }} aria-hidden="true" />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{r.name}</span>
              {show && <span style={{ color: NX.faint }}>{counts[r.id] || 0}</span>}
            </li>
          ))}
        </ul>
      )}
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 12 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: NX.dim, whiteSpace: 'nowrap' }}>
          <RowColorSwitch on={show} onChange={setShow} label="Show Row Colors" large={compact} />
          {/* Always a word beside the switch - shorter on a phone, never bare. */}
          <span aria-hidden="true" onClick={() => setShow(!show)} style={{ cursor: 'pointer' }}>{compact ? 'Show Colors' : 'Show Row Colors'}</span>
        </span>
        {canEdit && onEdit && (
          <button type="button" onClick={onEdit} style={{ ...btn('ghost'), padding: '2px 6px', fontSize: 12, color: NX.dim, gap: 5, ...(compact ? { minHeight: 40 } : null) }}>
            <Pencil size={12} /> Edit Rules
          </button>
        )}
      </span>
    </div>
  );
}
