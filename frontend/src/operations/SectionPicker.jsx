// Operations: the dropdowns that replaced the pill rows (Visesh, Oct 20 2026:
// "in any other tabs there are different screens add it as a dropdown").
// Same look as the page's Facility picker (FacilityPicker.jsx): a label on the
// left, a compact box with an icon and a chevron.
//
// SectionPicker is a native select, so arrow keys, type-ahead and a phone's
// own list all work. MultiPicker is the same box opening a checkbox list
// (Report Builder's Group By), with an optional cap on how many may be on.
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, LayoutList } from 'lucide-react';

// `options` is [{ value, label, disabled? }]. `placeholder` adds a first,
// unpickable option shown while `value` is '' (Start From: Pick a Preset).
export function SectionPicker({ label, value, options, onChange, icon: Icon = LayoutList, placeholder, className = '' }) {
  const id = useId();
  const current = options.find((o) => o.value === value);
  return (
    <div className={`ops-facility ops-section ${className}`.trim()}>
      <label className="ops-facility-label" htmlFor={id}>{label}</label>
      <span className="ops-facility-box">
        <Icon size={14} className="ops-facility-icon" aria-hidden="true" />
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} title={current?.label || placeholder || label}>
          {placeholder && <option value="" disabled>{placeholder}</option>}
          {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        </select>
        <ChevronDown size={13} className="ops-facility-chev" aria-hidden="true" />
      </span>
    </div>
  );
}

// `value` is the list of picked option values; `max` caps it (options past
// the cap are disabled, never silently dropped).
export function MultiPicker({ label, value, options, onChange, icon: Icon = LayoutList, max, emptyText = 'None Picked' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const btn = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const full = max != null && value.length >= max;
  const words = options.filter((o) => value.includes(o.value)).map((o) => o.label).join(', ') || emptyText;
  const flip = (v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="ops-facility ops-section" ref={box}>
      <span className="ops-facility-label" id={`${id}-l`}>{label}</span>
      <span className="ops-facility-box ops-section-multi">
        <Icon size={14} className="ops-facility-icon" aria-hidden="true" />
        <button type="button" ref={btn} className="ops-section-btn" aria-haspopup="true" aria-expanded={open}
          aria-labelledby={`${id}-l ${id}-v`} onClick={() => setOpen((o) => !o)} title={words}>
          <span id={`${id}-v`}>{words}</span>
        </button>
        <ChevronDown size={13} className="ops-facility-chev" aria-hidden="true" />
        {open && (
          <div className="ops-ms-pop dash-card" role="group" aria-label={label}>
            {options.map((o) => {
              const on = value.includes(o.value);
              return (
                <label key={o.value} className="ops-ms-opt" data-off={!on && full}>
                  <input type="checkbox" checked={on} disabled={!on && full} onChange={() => flip(o.value)} />{o.label}
                </label>
              );
            })}
            {max != null && <div className="ops-note" style={{ margin: '4px 8px' }}>{full ? `Up to ${max} - clear one to pick another.` : `Pick up to ${max}.`}</div>}
          </div>
        )}
      </span>
    </div>
  );
}

export default SectionPicker;
