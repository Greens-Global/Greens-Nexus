// Operations: the page's ONE facility dropdown (Visesh / Neil, Oct 20 2026:
// "Clearly we don't want these different chips. This needs to be a drop down
// again, similar to accounting"). It replaces the facility chip row and the
// per-tab pickers Rate Management, ECRI Management and Reports had; every
// tab reads this one choice.
//
// The look is Accounting's entity picker (components/accounting/reportControls
// EntityPicker: building icon, chevron, brand color once one is picked).
// The list is our own listbox, not a native select (Miranda, Oct 21: "All
// Facilities" and the operator heading sat on different edges and the stores
// under them were indented differently - a native select's optgroup indent is
// the browser's, and it cannot bold an option). Here "All Facilities" (bold)
// and each TPM heading share the left edge and every facility sits one indent
// in. Keyboard: Enter / Space / arrows open it; arrows, Home / End and
// type-ahead move; Enter or Space picks; Escape or Tab closes.
// Stores another operator runs sit under their TPM heading ("TPM · CubeSmart");
// picking one shows that tag and how old its data is.
//
// StatePicker (Neil, Oct 21: CA vs TX) narrows the list - and what "All
// Facilities" means on every tab - to one state. The page hides it when the
// facilities are all in one state.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Building2, ChevronDown, MapPin } from 'lucide-react';
import { dataAsOf, isThirdParty, managedLabel, TPM } from './thirdParty';
import { SectionPicker } from './SectionPicker';

// `allowAll` false on the tabs that work on one facility at a time.
// `allLabel` is what "everything" reads as ("All CA Facilities" once a state is picked).
export default function FacilityPicker({ facilities, value, onChange, allowAll = true, allLabel = 'All Facilities' }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(value);
  const box = useRef(null);
  const btn = useRef(null);
  const list = useRef(null);
  const typed = useRef({ text: '', at: 0 });

  const { own, groups } = useMemo(() => {
    const g = [];
    facilities.filter(isThirdParty).forEach((f) => {
      const label = managedLabel(f) || TPM;
      const hit = g.find((x) => x.label === label);
      if (hit) hit.list.push(f); else g.push({ label, list: [f] });
    });
    return { own: facilities.filter((f) => !isThirdParty(f)), groups: g };
  }, [facilities]);
  const one = value === 'all' ? null : facilities.find((f) => f.id === value);
  const showAll = allowAll || !one;
  // Every pickable row, in the order it is drawn, for the keyboard.
  const options = useMemo(() => [
    ...(showAll ? [{ id: 'all', label: allLabel }] : []),
    ...own.map((f) => ({ id: f.id, label: f.shortName })),
    ...groups.flatMap((g) => g.list.map((f) => ({ id: f.id, label: f.shortName }))),
  ], [showAll, allLabel, own, groups]);
  const optId = (v) => `${id}-o-${String(v).replace(/[^A-Za-z0-9_-]/g, '_')}`;

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    list.current?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  // Keep the highlighted row in view while the arrows move it.
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(optId(active));
    el?.scrollIntoView?.({ block: 'nearest' });
  });

  const openList = () => {
    setActive(options.some((o) => o.id === value) ? value : options[0]?.id);
    setOpen(true);
  };
  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  const pick = (v) => { close(); if (v !== value) onChange(v); };
  const move = (to) => {
    if (!options.length) return;
    const i = options.findIndex((o) => o.id === active);
    const n = to === 'first' ? 0 : to === 'last' ? options.length - 1
      : Math.min(options.length - 1, Math.max(0, (i < 0 ? 0 : i) + to));
    setActive(options[n].id);
  };
  const onBtnKey = (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList(); }
  };
  const onListKey = (e) => {
    const k = e.key;
    const keys = { ArrowDown: () => move(1), ArrowUp: () => move(-1), Home: () => move('first'), End: () => move('last'),
      Enter: () => active && pick(active), ' ': () => active && pick(active), Escape: () => close() };
    if (keys[k]) { e.preventDefault(); e.stopPropagation(); keys[k](); return; }
    if (k === 'Tab') { close(false); return; }
    if (k.length === 1 && /\S/.test(k)) {
      // Type-ahead: the letters typed in the last second, matched from the start of a name.
      const now = e.timeStamp;
      const text = (now - typed.current.at < 1000 ? typed.current.text : '') + k.toLowerCase();
      typed.current = { text, at: now };
      const from = options.findIndex((o) => o.id === active) + (text.length === 1 ? 1 : 0);
      const hit = [...options.slice(from), ...options.slice(0, from)].find((o) => o.label.toLowerCase().startsWith(text));
      if (hit) setActive(hit.id);
    }
  };

  const row = (o, cls) => (
    <li key={o.id} id={optId(o.id)} role="option" aria-selected={o.id === value} className={`ops-fp-opt ${cls}`}
      data-active={o.id === active} onMouseEnter={() => setActive(o.id)}
      onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.id)}>
      {o.label}
    </li>
  );
  const shownLabel = one ? one.shortName : allLabel;
  return (
    <div className="ops-facility" ref={box}>
      <span className="ops-facility-label" id={`${id}-l`}>Facility</span>
      <span className="ops-facility-box">
        <Building2 size={14} className="ops-facility-icon" aria-hidden="true" />
        <button type="button" ref={btn} id="ops-facility-select" className="ops-facility-btn" data-active={!!one} data-value={value}
          aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
          aria-labelledby={`${id}-l ${id}-v`} title={shownLabel}
          onClick={() => (open ? close() : openList())} onKeyDown={onBtnKey}>
          <span id={`${id}-v`}>{shownLabel}</span>
        </button>
        <ChevronDown size={13} className="ops-facility-chev" aria-hidden="true" />
        {open && (
          <ul id={`${id}-list`} ref={list} role="listbox" aria-label="Facilities" tabIndex={-1}
            className="ops-fp-pop dash-card" aria-activedescendant={active ? optId(active) : undefined} onKeyDown={onListKey}>
            {showAll && row(options[0], 'ops-fp-all')}
            {own.map((f) => row({ id: f.id, label: f.shortName }, 'ops-fp-in'))}
            {groups.map((g, gi) => (
              <li key={g.label} role="presentation">
                <div className="ops-fp-head" id={`${id}-g${gi}`}>{g.label}</div>
                <ul role="group" aria-labelledby={`${id}-g${gi}`} className="ops-fp-group">
                  {g.list.map((f) => row({ id: f.id, label: f.shortName }, 'ops-fp-in'))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </span>
      {one && isThirdParty(one) && (
        <>
          <span className="ops-pill-tag">{managedLabel(one)}</span>
          <span className="ops-facility-asof">{dataAsOf(one)}</span>
        </>
      )}
    </div>
  );
}

// '' = All States.
export function StatePicker({ states, value, onChange }) {
  return (
    <SectionPicker label="State" value={value} onChange={onChange} icon={MapPin} className="ops-state"
      options={[{ value: '', label: 'All States' }, ...states.map((s) => ({ value: s, label: s }))]} />
  );
}
