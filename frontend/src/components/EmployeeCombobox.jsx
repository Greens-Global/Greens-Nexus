import { useEffect, useRef, useState } from 'react';
import { Search, ChevronDown } from 'lucide-react';
import AnchoredMenu from './AnchoredMenu';
import { matchPeople } from '../lib/peopleSearch';

// The "which employee" picker on the Time Sheet (Sep 30). It replaces a native
// <select>, whose type-ahead only HIGHLIGHTED the typed name somewhere in a long
// list and left the reviewer scrolling for it ("it will be great if when we type
// a name it pops up"). Typing here FILTERS the list - first/last-name prefixes on
// top (matchPeople) - the top hit is pre-selected so Enter takes it, arrows move,
// Escape closes, and clearing the box brings the whole list back.
//
//   people   [{ email, name }]
//   value    the selected email; onChange(email) fires on a pick
//   labelFor optional (p) => text shown for an option (e.g. "Amy (2 missing)")
export default function EmployeeCombobox({ people, value, onChange, labelFor, title, placeholder = 'Search employees...', style }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [boxWidth, setBoxWidth] = useState();
  const list = people || [];
  const label = (p) => (labelFor ? labelFor(p) : (p.name || p.email));
  const current = list.find(p => p.email === value);
  const shown = matchPeople(list, q);

  const openList = () => {
    if (open) return;
    setBoxWidth(boxRef.current?.offsetWidth);
    // An empty box shows everyone, starting on the person already picked.
    setHi(Math.max(0, list.findIndex(p => p.email === value)));
    setOpen(true);
  };
  const close = () => { setOpen(false); setQ(''); };
  const pick = (p) => { if (p.email !== value) onChange(p.email); close(); inputRef.current?.blur(); };

  // Keep the keyboard-selected row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, hi, q]);

  return (
    <div ref={boxRef} style={{ position: 'relative', minWidth: 180, ...style }} title={title}>
      <div className="form-input" onMouseDown={e => { if (e.target !== inputRef.current) { e.preventDefault(); inputRef.current?.focus(); openList(); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', cursor: 'text', fontSize: 13, fontWeight: 700 }}>
        {open && <Search size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
        <input ref={inputRef} role="combobox" aria-label="Employee" aria-expanded={open} aria-autocomplete="list"
          value={open ? q : (current ? label(current) : '')}
          placeholder={open ? (current?.name || placeholder) : placeholder}
          onFocus={openList} onBlur={() => setTimeout(close, 150)}
          onChange={e => { openList(); setQ(e.target.value); setHi(0); }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) { openList(); return; } setHi(h => Math.min(h + 1, Math.max(shown.length - 1, 0))); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter') { if (open && shown[hi]) { e.preventDefault(); pick(shown[hi]); } }
            else if (e.key === 'Escape') { e.preventDefault(); close(); inputRef.current?.blur(); }
          }}
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 'inherit', fontWeight: 'inherit', fontFamily: 'inherit', color: 'var(--ink)', padding: 0, textOverflow: 'ellipsis' }} />
        <ChevronDown size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      </div>
      <AnchoredMenu anchorRef={boxRef} open={open} onClose={close} role="listbox"
        style={{ width: Math.max(boxWidth || 0, 220), maxHeight: 360, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: '4px 0' }}>
        <div ref={listRef}>
          {shown.length === 0 ? (
            <div style={{ padding: '9px 12px', fontSize: 12.5, color: 'var(--muted)' }}>No matches</div>
          ) : shown.map((p, i) => (
            <button key={p.email} type="button" role="option" aria-selected={i === hi}
              onMouseDown={ev => { ev.preventDefault(); pick(p); }} onMouseEnter={() => setHi(i)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', border: 'none', cursor: 'pointer',
                background: i === hi ? 'var(--mist)' : 'none', fontSize: 12.5, fontFamily: 'Inter,sans-serif',
                fontWeight: p.email === value ? 700 : 500, color: p.email === value ? 'var(--wk-brand, var(--ink))' : 'var(--ink)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {label(p)}
            </button>
          ))}
        </div>
      </AnchoredMenu>
    </div>
  );
}
